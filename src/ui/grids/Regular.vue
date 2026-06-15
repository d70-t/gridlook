<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { onBeforeMount, onBeforeUnmount, ref } from "vue";
import type * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import type {
  TGeoSample,
  TGeoSampleIndex,
} from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import {
  getCRSWkt,
  isLatitudeName,
  isLongitudeName,
  isProjectedXName,
  isProjectedYName,
  projectedAxisCoordinatesToLonLat,
} from "@/lib/data/coordinateVariables.ts";
import { downsampleDataTexture } from "@/lib/data/dataTexture.ts";
import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  createWrappedProjectionMesh,
  setupProjectionGeometryWrap,
  updateProjectionMeshes,
} from "@/lib/projection/projectionEdgeQuality.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  getColormapScaleOffset,
  makeGpuProjectedTextureMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useLog } from "@/utils/logging.ts";

const props = defineProps<{
  datasources?: TSources;
  isRotated?: boolean;
}>();

const store = useGlobeControlStore();
const { logError } = useLog();
const { dimSlidersValues, colormap, varnameSelector, invertColormap, varinfo } =
  storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const {
  getScene,
  getRenderer,
  redraw,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  getDataVar,
  fetchDimensionDetails,
  updateLandSeaMask,
  updateColormap,
  updateHistogram,
  projectionHelper,
  isSceneInMotion,
  onProjectionChange,
  onMotionStateChange,
  onColormapChange,
  canvas,
  box,
  hoveredGeoPoint,
} = useSharedGridLogic();

const { setHoverLookupFromIndex, clearHoverLookup } =
  useGridHoverLookup(hoveredGeoPoint);

const longitudes = ref<Float32Array>(new Float32Array());
const latitudes = ref<Float32Array>(new Float32Array());

const BATCH_SIZE = 60;
const MAX_GEO_RESOLUTION = 512;

let meshes: THREE.Mesh[] = [];

onColormapChange(() => updateColormap(meshes));

onProjectionChange(updateMeshProjectionUniforms);
onMotionStateChange(updateMeshProjectionUniforms);

function updateMeshProjectionUniforms() {
  updateProjectionMeshes(meshes, {
    redraw,
    projectionHelper: projectionHelper.value,
    isSceneInMotion: isSceneInMotion.value,
  });
}

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  clearHoverLookup,
  prepareDatasource: async () => {
    await getDims();
    await makeGeometry();
  },
  updateLandSeaMask,
  updateColormap: () => updateColormap(meshes),
});

const isLatOnly = ref(false);

async function fetchProjectedXYDims(
  grid: TSources["levels"][0]["grid"],
  xDim: string,
  yDim: string
) {
  const [xData, yData] = await Promise.all([
    ZarrDataManager.getVariableData(
      grid,
      ZarrDataManager.resolveVariablePath(varnameSelector.value, xDim)
    ),
    ZarrDataManager.getVariableData(
      grid,
      ZarrDataManager.resolveVariablePath(varnameSelector.value, yDim)
    ),
  ]);
  const crsWkt = await getCRSWkt(props.datasources!, varnameSelector.value);
  const converted = projectedAxisCoordinatesToLonLat(
    xData.data as Float32Array,
    yData.data as Float32Array,
    crsWkt
  );
  longitudes.value = Float32Array.from(converted.longitudes);
  latitudes.value = Float32Array.from(converted.latitudes);
}

async function getDims() {
  const dimensions = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );

  const lastDim = dimensions[dimensions.length - 1];
  const secondLastDim = dimensions[dimensions.length - 2];

  const isProjectedXY =
    isProjectedXName(lastDim) && isProjectedYName(secondLastDim);

  const latOnlyCheck =
    !isProjectedXY &&
    isLatitudeName(lastDim) &&
    !isLongitudeName(secondLastDim);
  isLatOnly.value = latOnlyCheck;

  const grid = props.datasources!.levels[0].grid;
  if (isProjectedXY) {
    await fetchProjectedXYDims(grid, lastDim, secondLastDim);
  } else if (latOnlyCheck) {
    const latitudesData = await ZarrDataManager.getVariableData(
      grid,
      ZarrDataManager.resolveVariablePath(varnameSelector.value, lastDim)
    );
    latitudes.value = latitudesData.data as Float32Array;
    longitudes.value = Float32Array.from({ length: 360 }, (_, i) => i - 179.5);
  } else {
    const latName = secondLastDim;
    const lonName = lastDim;
    const [latitudesData, longitudesData] = await Promise.all([
      ZarrDataManager.getVariableData(
        grid,
        ZarrDataManager.resolveVariablePath(varnameSelector.value, latName)
      ),
      ZarrDataManager.getVariableData(
        grid,
        ZarrDataManager.resolveVariablePath(varnameSelector.value, lonName)
      ),
    ]);
    const myLongitudes = longitudesData.data as Float32Array;
    const myLatitudes = latitudesData.data as Float32Array;
    longitudes.value = new Float32Array(new Set(myLongitudes));
    latitudes.value = new Float32Array(new Set(myLatitudes));
  }
}

function rotatedToGeographic(
  latR: number,
  lonR: number,
  poleLat: number,
  poleLon: number
) {
  const latRRad = THREE.MathUtils.degToRad(latR);
  const lonRRad = THREE.MathUtils.degToRad(lonR);
  const poleLatRad = THREE.MathUtils.degToRad(poleLat);
  const poleLonRad = THREE.MathUtils.degToRad(poleLon);

  const sinPhi =
    Math.sin(poleLatRad) * Math.sin(latRRad) +
    Math.cos(poleLatRad) * Math.cos(latRRad) * Math.cos(lonRRad);
  const phi = Math.asin(sinPhi);

  const y = -Math.cos(latRRad) * Math.sin(lonRRad);
  const x =
    Math.sin(latRRad) * Math.cos(poleLatRad) -
    Math.cos(latRRad) * Math.sin(poleLatRad) * Math.cos(lonRRad);
  const lambda = poleLonRad + Math.atan2(y, x);

  // Normalize longitude to [-180, 180)
  let lon = THREE.MathUtils.radToDeg(lambda);
  if (lon > 180) {
    lon -= 360;
  }
  if (lon < -180) {
    lon += 360;
  }

  const lat = THREE.MathUtils.radToDeg(phi);
  return { lat, lon };
}

function isLongitudeGlobal(longitudes: Float32Array): boolean {
  const n = longitudes.length;
  if (n < 2) {
    return false;
  }

  // Use unwrapped longitudes to check span
  const span = Math.abs(longitudes[n - 1] - longitudes[0]);

  // Estimate the grid spacing
  const avgDelta = span / (n - 1);

  // Check if span + one grid cell covers 360°
  return span + avgDelta > 359.5;
}

function generateBatchVerticesAndUVs(
  latitudes: Float32Array,
  longitudes: Float32Array,
  latOrigIndices: Int32Array,
  lonOrigIndices: Int32Array,
  originalLatCount: number,
  textureLonCount: number,
  latStart: number,
  latEnd: number,
  isLatReversed: boolean,
  isRotated: boolean,
  poleLat?: number,
  poleLon?: number
) {
  const batchLatCount = latEnd - latStart + 1;
  const lonCount = longitudes.length;
  const vertexCount = batchLatCount * lonCount;

  const positionValues = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const latLonValues = new Float32Array(vertexCount * 2);
  const latDenominator = Math.max(originalLatCount - 1, 1);

  const helper = projectionHelper.value;

  for (let li = 0; li < batchLatCount; li++) {
    const globalLatIdx = latStart + li;
    const rawLat = latitudes[globalLatIdx];
    const latOrigIdx = latOrigIndices[globalLatIdx];
    for (let lj = 0; lj < lonCount; lj++) {
      const rawLon = longitudes[lj];

      const { lat, lon } = isRotated
        ? rotatedToGeographic(rawLat, rawLon, poleLat!, poleLon!)
        : { lat: rawLat, lon: rawLon };

      const vertexIdx = li * lonCount + lj;
      helper.projectLatLonToArrays(
        lat,
        lon,
        positionValues,
        vertexIdx * 3,
        latLonValues,
        vertexIdx * 2
      );

      const u = (lonOrigIndices[lj] + 0.5) / textureLonCount;
      const v = isLatReversed
        ? (originalLatCount - 1 - latOrigIdx) / latDenominator
        : latOrigIdx / latDenominator;
      uvs[vertexIdx * 2] = u;
      uvs[vertexIdx * 2 + 1] = v;
    }
  }

  return { positionValues, uvs, latLonValues };
}

function generateGridIndices(latCount: number, lonCount: number) {
  const latIterationEnd = latCount - 1;
  const lonIterationEnd = lonCount - 1;
  const indices = new Uint32Array(latIterationEnd * lonIterationEnd * 6);
  let indexOffset = 0;

  for (let latIt = 0; latIt < latIterationEnd; latIt++) {
    for (let lonIt = 0; lonIt < lonIterationEnd; lonIt++) {
      const lowLeft = latIt * lonCount + lonIt;
      const lowRight = latIt * lonCount + lonIt + 1;
      const topLeft = (latIt + 1) * lonCount + lonIt;
      const topRight = (latIt + 1) * lonCount + lonIt + 1;

      indices[indexOffset++] = lowLeft;
      indices[indexOffset++] = topRight;
      indices[indexOffset++] = topLeft;
      indices[indexOffset++] = lowLeft;
      indices[indexOffset++] = lowRight;
      indices[indexOffset++] = topRight;
    }
  }

  return indices;
}

function normalizeLongitudes(longitudes: Float32Array): Float32Array {
  // Normalize longitudes to [0, 360)
  return Float32Array.from(longitudes, (lon) => ((lon % 360) + 360) % 360);
}

function subsampleCoords(
  values: Float32Array,
  maxCount: number
): { coords: Float32Array; origIndices: Int32Array } {
  if (values.length <= maxCount) {
    const origIndices = new Int32Array(values.length);
    for (let i = 0; i < values.length; i++) {
      origIndices[i] = i;
    }
    return { coords: values, origIndices };
  }

  const coords = new Float32Array(maxCount);
  const origIndices = new Int32Array(maxCount);
  for (let i = 0; i < maxCount; i++) {
    const sourceIdx = Math.round((i * (values.length - 1)) / (maxCount - 1));
    coords[i] = values[sourceIdx];
    origIndices[i] = sourceIdx;
  }
  return { coords, origIndices };
}

async function getRegularGridParameters() {
  const isRotated = props.isRotated;
  let longitudeValues = normalizeLongitudes(longitudes.value);
  let latitudeValues = latitudes.value;

  // Check if latitudes are descending and reverse if necessary
  const isLatReversed =
    latitudeValues[0] > latitudeValues[latitudeValues.length - 1];
  if (isLatReversed) {
    latitudeValues = Float32Array.from(latitudeValues).reverse();
  }

  const isGlobal = isLongitudeGlobal(longitudes.value);
  const textureLonCount = longitudeValues.length;
  const originalLatCount = latitudeValues.length;

  const { coords: geoLatitudes, origIndices: latOrigIndices } = subsampleCoords(
    latitudeValues,
    MAX_GEO_RESOLUTION
  );
  const { coords: geoLongitudesBase, origIndices: lonOrigIndicesBase } =
    subsampleCoords(longitudeValues, MAX_GEO_RESOLUTION);

  let geoLongitudes = geoLongitudesBase;
  let lonOrigIndices = lonOrigIndicesBase;
  if (isGlobal) {
    geoLongitudes = new Float32Array([
      ...geoLongitudesBase,
      geoLongitudesBase[0] + 360,
    ]);
    lonOrigIndices = new Int32Array(lonOrigIndicesBase.length + 1);
    lonOrigIndices.set(lonOrigIndicesBase);
    lonOrigIndices[lonOrigIndicesBase.length] = textureLonCount;
  }

  let poleLat: number | undefined, poleLon: number | undefined;
  if (isRotated) {
    const rotatedNorthPole = await getRotatedNorthPole();
    poleLat = rotatedNorthPole.lat;
    poleLon = rotatedNorthPole.lon;
  }

  return {
    geoLatitudes,
    geoLongitudes,
    latOrigIndices,
    lonOrigIndices,
    originalLatCount,
    textureLonCount,
    isLatReversed,
    isRotated,
    poleLat,
    poleLon,
    geoLatCount: geoLatitudes.length,
    geoLonCount: geoLongitudes.length,
  };
}

function disposeMaterial(material: THREE.Material) {
  const shaderMaterial = material as THREE.ShaderMaterial;
  if (shaderMaterial.uniforms?.data?.value?.dispose) {
    shaderMaterial.uniforms.data.value.dispose();
  }
  material.dispose();
}

function collectMeshMaterials(
  mesh: THREE.Mesh,
  materials: Set<THREE.Material>
) {
  if (Array.isArray(mesh.material)) {
    for (const material of mesh.material) {
      materials.add(material);
    }
    return;
  }
  materials.add(mesh.material);
}

function disposeMaterials(materials: Set<THREE.Material>) {
  for (const material of materials) {
    disposeMaterial(material);
  }
}

function disposeMeshMaterials(targetMeshes: THREE.Mesh[]) {
  const materials = new Set<THREE.Material>();
  for (const mesh of targetMeshes) {
    collectMeshMaterials(mesh, materials);
  }
  disposeMaterials(materials);
}

function cleanupMeshes(totalBatches: number) {
  if (meshes.length <= totalBatches) {
    return;
  }
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    getScene()?.remove(mesh);
  }
  disposeMeshMaterials(meshes);
  meshes.length = 0;
}

function createBatchGeometry(
  gridParams: Awaited<ReturnType<typeof getRegularGridParameters>>,
  latStart: number,
  latEnd: number
) {
  const geometry = new THREE.InstancedBufferGeometry();
  const batchLatCount = latEnd - latStart + 1;

  const { positionValues, uvs, latLonValues } = generateBatchVerticesAndUVs(
    gridParams.geoLatitudes,
    gridParams.geoLongitudes,
    gridParams.latOrigIndices,
    gridParams.lonOrigIndices,
    gridParams.originalLatCount,
    gridParams.textureLonCount,
    latStart,
    latEnd,
    gridParams.isLatReversed,
    gridParams.isRotated,
    gridParams.poleLat,
    gridParams.poleLon
  );

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positionValues, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute(latLonValues, 2)
  );

  const indices = generateGridIndices(batchLatCount, gridParams.geoLonCount);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

function applyBatchGeometry(
  batchIndex: number,
  geometry: THREE.InstancedBufferGeometry
) {
  if (meshes[batchIndex]) {
    setupProjectionGeometryWrap(geometry);
    meshes[batchIndex].geometry.dispose();
    meshes[batchIndex].geometry = geometry;
  } else {
    const mesh = createWrappedProjectionMesh(
      geometry,
      new THREE.ShaderMaterial(),
      projectionHelper.value.type
    );
    mesh.frustumCulled = false;
    meshes.push(mesh);
    getScene()?.add(mesh);
  }
}

async function makeGeometry() {
  try {
    const gridParams = await getRegularGridParameters();
    const totalBatches = Math.ceil((gridParams.geoLatCount - 1) / BATCH_SIZE);
    cleanupMeshes(totalBatches);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const latStart = batchIndex * BATCH_SIZE;
      const latEnd = Math.min(
        latStart + BATCH_SIZE,
        gridParams.geoLatCount - 1
      );
      const geometry = createBatchGeometry(gridParams, latStart, latEnd);
      applyBatchGeometry(batchIndex, geometry);
    }
    updateMeshProjectionUniforms();
  } catch (error) {
    logError(error, "Could not fetch grid");
  }
}

function fitDataToMaxTextureSize(
  data: Float32Array<ArrayBufferLike>,
  sourceWidth: number,
  sourceHeight: number
) {
  let texWidth = sourceWidth;
  let texHeight = sourceHeight;
  let textureData = data;
  const maxTexSize = getRenderer()?.capabilities.maxTextureSize ?? 4096;
  if (texWidth > maxTexSize || texHeight > maxTexSize) {
    texWidth = Math.min(sourceWidth, maxTexSize);
    texHeight = Math.min(sourceHeight, maxTexSize);
    textureData = downsampleDataTexture(
      data,
      sourceWidth,
      sourceHeight,
      texWidth,
      texHeight
    );
  }

  return { data: textureData, texWidth, texHeight };
}

function createLatOnlyTextureData(
  rawData: Float32Array,
  latCount: number,
  lonCount: number
) {
  const data = new Float32Array(latCount * lonCount);
  for (let latIdx = 0; latIdx < latCount; latIdx++) {
    const value = rawData[latIdx];
    for (let lonIdx = 0; lonIdx < lonCount; lonIdx++) {
      data[latIdx * lonCount + lonIdx] = value;
    }
  }
  return data;
}

function createRegularTexture(rawData: Float32Array, wrapRepeat: boolean) {
  const latCount = latitudes.value.length;
  const lonCount = longitudes.value.length;
  const textureData = isLatOnly.value
    ? createLatOnlyTextureData(rawData, latCount, lonCount)
    : rawData;
  const { data, texWidth, texHeight } = fitDataToMaxTextureSize(
    textureData,
    lonCount,
    latCount
  );

  const texture = new THREE.DataTexture(
    data,
    texWidth,
    texHeight,
    THREE.RedFormat,
    THREE.FloatType,
    THREE.UVMapping
  );
  if (wrapRepeat) {
    texture.wrapS = THREE.RepeatWrapping;
  }
  texture.needsUpdate = true;
  return texture;
}

async function getRotatedNorthPole(): Promise<{ lat: number; lon: number }> {
  const crs = await ZarrDataManager.getCRSInfo(
    props.datasources!,
    varnameSelector.value
  );
  const lat = crs.attrs["grid_north_pole_latitude"] as number;
  const lon = crs.attrs["grid_north_pole_longitude"] as number;
  return { lat, lon };
}

function makeMaterial(rawData: Float32Array) {
  const texture = createRegularTexture(
    rawData,
    isLongitudeGlobal(longitudes.value)
  );
  const low = store.selection?.low as number;
  const high = store.selection?.high as number;
  const { addOffset, scaleFactor } = getColormapScaleOffset(
    low,
    high,
    invertColormap.value
  );

  return makeGpuProjectedTextureMaterial(
    texture,
    colormap.value,
    addOffset,
    scaleFactor
  );
}

async function buildHoverSamples(
  rawData: Float32Array
): Promise<TGeoSampleIndex> {
  let rotPole: { lat: number; lon: number } | null = null;
  if (props.isRotated) {
    rotPole = await getRotatedNorthPole();
  }

  const lats = latitudes.value;
  const lons = longitudes.value;
  const latCount = lats.length;
  const lonCount = lons.length;

  // For regular grids, use direct index lookup instead of building a
  // 37M-entry spatial index. The grid is regular so we can binary-search
  // the lat/lon axes to find the nearest cell in O(log n).
  return {
    findNearest(queryLat: number, queryLon: number): TGeoSample | null {
      if (latCount === 0 || lonCount === 0) {
        return null;
      }

      // Find nearest latitude index via binary search
      const latIdx = nearestIndex(lats, queryLat);

      if (isLatOnly.value) {
        return { lat: lats[latIdx], lon: 0, value: rawData[latIdx] };
      }

      // Find nearest longitude index (accounting for wrapping)
      const lonIdx = nearestLonIndex(lons, queryLon);

      const rawLat = lats[latIdx];
      const rawLon = lons[lonIdx];
      const { lat, lon } = rotPole
        ? rotatedToGeographic(rawLat, rawLon, rotPole.lat, rotPole.lon)
        : { lat: rawLat, lon: rawLon };

      return {
        lat,
        lon: ProjectionHelper.normalizeLongitude(lon),
        value: rawData[latIdx * lonCount + lonIdx],
      };
    },
  };
}

function nearestIndex(sorted: Float32Array, target: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  // Handle both ascending and descending arrays
  const ascending = sorted[0] <= sorted[hi];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ascending ? sorted[mid] < target : sorted[mid] > target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  // Check neighbour to find actual nearest
  if (
    lo > 0 &&
    Math.abs(sorted[lo - 1] - target) < Math.abs(sorted[lo] - target)
  ) {
    return lo - 1;
  }
  return lo;
}

function nearestLonIndex(lons: Float32Array, target: number): number {
  // The lons array is monotonically sorted in its native range (either
  // [-180,180] or [0,360]). Search the raw values directly and handle
  // wrap by checking target, target+360, and target-360.
  const lo = lons[0];
  const hi = lons[lons.length - 1];

  // Shift target into the data range
  let adjustedTarget = target;
  if (adjustedTarget < lo - 180) {
    adjustedTarget += 360;
  } else if (adjustedTarget > hi + 180) {
    adjustedTarget -= 360;
  }

  const idx = nearestIndex(lons, adjustedTarget);

  // Also check the wrapped alternative for grids near the boundary
  const altTarget =
    adjustedTarget < (lo + hi) / 2
      ? adjustedTarget + 360
      : adjustedTarget - 360;
  const altIdx = nearestIndex(lons, altTarget);

  const dist = Math.abs(lons[idx] - adjustedTarget);
  let altDist = Math.abs(lons[altIdx] - altTarget);
  // Normalize distance for wrap comparison
  if (altDist > 180) {
    altDist = 360 - altDist;
  }
  return dist <= altDist ? idx : altIdx;
}

async function buildDimensionConfig(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const dimensionNames = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  const excludedDims = isLatOnly.value
    ? [datavar.shape.length - 1]
    : [datavar.shape.length - 2, datavar.shape.length - 1];
  return buildDimensionRangesAndIndices(
    datavar,
    dimensionNames,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    excludedDims,
    varinfo.value?.dimRanges
  );
}

function setMeshMaterials(material: THREE.ShaderMaterial) {
  if (meshes.length === 0) {
    disposeMaterial(material);
    return;
  }

  const previousMaterials = new Set<THREE.Material>();
  for (const mesh of meshes) {
    collectMeshMaterials(mesh, previousMaterials);
    mesh.material = material;
  }
  previousMaterials.delete(material);
  disposeMaterials(previousMaterials);
  material.needsUpdate = true;
}

function updateMeshMaterials(rawData: Float32Array) {
  const material = makeMaterial(rawData);
  updateProjectionUniforms(material, projectionHelper.value);
  setMeshMaterials(material);
}

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const { dimensionRanges, indices } = await buildDimensionConfig(datavar);

  const rawData = castDataVarToFloat32(
    (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
  );

  const { min, max, missingValue, fillValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );

  updateMeshMaterials(rawData);

  const hoverIndex = await buildHoverSamples(rawData);
  setHoverLookupFromIndex(hoverIndex, fillValue, missingValue);

  updateHistogram(rawData, min, max, missingValue, fillValue);

  const dimInfo = await fetchDimensionDetails(
    varnameSelector.value,
    props.datasources!,
    dimensionRanges,
    indices
  );

  store.updateVarInfo(
    {
      attrs: datavar.attrs,
      dimInfo,
      bounds: { low: min, high: max },
      dimRanges: dimensionRanges,
    },
    indices as number[]
  );
  redraw();
}

onBeforeMount(async () => {
  await datasourceUpdate();
});

onBeforeUnmount(() => {
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    getScene()?.remove(mesh);
  }
  disposeMeshMaterials(meshes);
  meshes.length = 0;
});

defineExpose({
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
});
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
