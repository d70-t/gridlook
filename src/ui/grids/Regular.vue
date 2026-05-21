<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { onBeforeMount, onBeforeUnmount, ref, watch } from "vue";
import type * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import type {
  TGeoSample,
  TGeoSampleIndex,
} from "./composables/gridHoverUtils.ts";
import {
  createWrappedProjectionMesh,
  setupProjectionGeometryWrap,
  updateProjectionMeshes,
} from "./composables/useProjectionEdgeQuality.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  castDataVarToFloat32,
  getDataBoundsAndMapMissingToNaN,
  isLatitudeName,
  isLongitudeName,
} from "@/lib/data/zarrUtils.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  getColormapScaleOffset,
  makeGpuProjectedTextureMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "@/store/store.ts";
import { useLog } from "@/utils/logging.ts";

const props = defineProps<{
  datasources?: TSources;
  isRotated?: boolean;
}>();

const store = useGlobeControlStore();
const { logError } = useLog();
const {
  dimSlidersValues,
  colormap,
  varnameSelector,
  invertColormap,
  isInitializingVariable,
  varinfo,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const {
  getScene,
  redraw,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  resetDataVars,
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

const pendingUpdate = ref(false);
const updatingData = ref(false);

const { setHoverLookupFromIndex, clearHoverLookup } =
  useGridHoverLookup(hoveredGeoPoint);

const longitudes = ref(new Float64Array());
const latitudes = ref(new Float64Array());
const isLatReversed = ref(false);

const BATCH_SIZE = 60;
const MAX_TILE_SIZE = 4096;

type TTileInfo = {
  latStart: number;
  latEnd: number;
  lonStart: number;
  lonEnd: number;
};

let meshes: THREE.Mesh[] = [];
let tileInfos: TTileInfo[] = [];
watch(
  () => varnameSelector.value,
  () => {
    getData();
  }
);

watch(
  () => dimSlidersValues.value,
  async () => {
    if (isInitializingVariable.value) {
      isInitializingVariable.value = false;
      return;
    }
    await getData(UPDATE_MODE.SLIDER_TOGGLE);
    updateColormap(meshes);
  },
  { deep: true }
);

watch(
  () => props.datasources,
  () => {
    datasourceUpdate();
  }
);

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

async function datasourceUpdate() {
  resetDataVars();
  clearHoverLookup();
  if (props.datasources !== undefined) {
    await getDims();
    await makeGeometry();
    await getData();
    updateLandSeaMask();
    updateColormap(meshes);
  }
}

const isLatOnly = ref(false);

async function getDims() {
  // Assumptions: the last two dimensions of the data array are
  // latitude and longitude (in this order), or lat-only for zonally averaged data
  // FIXME: this may not always be true and probably it would be cleaner
  // to use the implemented ZarrUtils.getLatLonData function

  // We had, however, cases where we could not determine wether the grid is
  // rotated or not, which lead to failure in getLatLonData.
  // On the other hand, I didn't find any case where latitudes and longitudes were not
  // the two last dimensions of the data variable.
  const dimensions = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );

  const lastDim = dimensions[dimensions.length - 1];
  const secondLastDim = dimensions[dimensions.length - 2];

  // Check if this is a lat-only dataset (zonally averaged)
  const latOnlyCheck =
    isLatitudeName(lastDim) && !isLongitudeName(secondLastDim);
  isLatOnly.value = latOnlyCheck;

  const grid = props.datasources!.levels[0].grid;
  if (latOnlyCheck) {
    const latitudesData = await ZarrDataManager.getVariableData(grid, lastDim);
    latitudes.value = new Float64Array(latitudesData.data as Float64Array);
    // Create synthetic global longitudes for visualization
    longitudes.value = Float64Array.from({ length: 360 }, (_, i) => i - 179.5);
  } else {
    const latName = secondLastDim;
    const lonName = lastDim;
    const [latitudesData, longitudesData] = await Promise.all([
      ZarrDataManager.getVariableData(grid, latName),
      ZarrDataManager.getVariableData(grid, lonName),
    ]);
    const myLongitudes = longitudesData.data as Float64Array;
    const myLatitudes = latitudesData.data as Float64Array;
    longitudes.value = new Float64Array(new Set(myLongitudes));
    latitudes.value = new Float64Array(new Set(myLatitudes));
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

function isLongitudeGlobal(longitudes: Float64Array): boolean {
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

/**
 * Generates vertices, UVs, and lat/lon for a single 2D tile (lat band × lon band).
 * UVs are local to the tile's texture and point at texel centers.
 */
function generateTileVerticesAndUVs(
  latitudes: Float64Array,
  longitudes: Float64Array,
  latStart: number,
  latEnd: number,
  lonStart: number,
  lonEnd: number,
  poleLat?: number,
  poleLon?: number
) {
  const batchLatCount = latEnd - latStart + 1;
  const tileLonCount = lonEnd - lonStart + 1;
  const vertexCount = batchLatCount * tileLonCount;

  const positionValues = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const latLonValues = new Float32Array(vertexCount * 2);

  const helper = projectionHelper.value;

  for (let li = 0; li < batchLatCount; li++) {
    const globalLatIdx = latStart + li;
    const rawLat = latitudes[globalLatIdx];
    for (let lj = 0; lj < tileLonCount; lj++) {
      const globalLonIdx = lonStart + lj;
      const rawLon = longitudes[globalLonIdx];

      const { lat, lon } =
        poleLat !== undefined
          ? rotatedToGeographic(rawLat, rawLon, poleLat, poleLon!)
          : { lat: rawLat, lon: rawLon };

      const vertexIdx = li * tileLonCount + lj;
      helper.projectLatLonToArrays(
        lat,
        lon,
        positionValues,
        vertexIdx * 3,
        latLonValues,
        vertexIdx * 2
      );

      const u = (lj + 0.5) / tileLonCount;
      const v = (li + 0.5) / batchLatCount;
      uvs[vertexIdx * 2] = u;
      uvs[vertexIdx * 2 + 1] = v;
    }
  }

  return { positionValues, uvs, latLonValues };
}

function generateGridIndices(latCount: number, lonCount: number) {
  const indices: number[] = [];
  const latIterationEnd = latCount - 1;
  const lonIterationEnd = lonCount - 1;

  for (let latIt = 0; latIt < latIterationEnd; latIt++) {
    for (let lonIt = 0; lonIt < lonIterationEnd; lonIt++) {
      const lowLeft = latIt * lonCount + lonIt;
      const lowRight = latIt * lonCount + lonIt + 1;
      const topLeft = (latIt + 1) * lonCount + lonIt;
      const topRight = (latIt + 1) * lonCount + lonIt + 1;

      indices.push(lowLeft, topRight, topLeft);
      indices.push(lowLeft, lowRight, topRight);
    }
  }

  return indices;
}

function normalizeLongitudes(longitudes: Float64Array): Float64Array {
  // Normalize longitudes to [0, 360)
  return Float64Array.from(longitudes, (lon) => ((lon % 360) + 360) % 360);
}

async function getGridParams() {
  const isRotated = props.isRotated;
  let longitudeValues = normalizeLongitudes(longitudes.value);
  let latitudeValues = latitudes.value;

  // Check if latitudes are descending and reverse if necessary
  const latReversed =
    latitudeValues[0] > latitudeValues[latitudeValues.length - 1];
  isLatReversed.value = latReversed;
  if (latReversed) {
    latitudeValues = Float64Array.from(latitudeValues).reverse();
  }

  const isGlobal = isLongitudeGlobal(longitudes.value);

  if (isGlobal) {
    // Add a duplicate of the first longitude + 360 to close the globe
    const firstLon = longitudeValues[0];
    longitudeValues = new Float64Array([...longitudeValues, firstLon + 360]);
  }

  let poleLat, poleLon;
  if (isRotated) {
    const rotatedNorthPole = await getRotatedNorthPole();
    poleLat = rotatedNorthPole.lat;
    poleLon = rotatedNorthPole.lon;
  }

  const latCount = latitudeValues.length;
  const lonCount = longitudeValues.length;

  return {
    latitudeValues,
    longitudeValues,
    latCount,
    lonCount,
    poleLat,
    poleLon,
  };
}

function disposeMeshMaterial(mesh: THREE.Mesh) {
  const mat = mesh.material as THREE.ShaderMaterial;
  if (mat && mat.dispose) {
    if (mat.uniforms?.data?.value?.dispose) {
      mat.uniforms.data.value.dispose();
    }
    mat.dispose();
  }
}

function cleanupMeshes(totalBatches: number) {
  if (meshes.length <= totalBatches) {
    return;
  }
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    disposeMeshMaterial(mesh);
    getScene()?.remove(mesh);
  }
  meshes.length = 0;
}

function createTileGeometry(
  latitudeValues: Float64Array,
  longitudeValues: Float64Array,
  tile: TTileInfo,
  poleLat?: number,
  poleLon?: number
) {
  const geometry = new THREE.InstancedBufferGeometry();
  const batchLatCount = tile.latEnd - tile.latStart + 1;
  const tileLonCount = tile.lonEnd - tile.lonStart + 1;

  const { positionValues, uvs, latLonValues } = generateTileVerticesAndUVs(
    latitudeValues,
    longitudeValues,
    tile.latStart,
    tile.latEnd,
    tile.lonStart,
    tile.lonEnd,
    poleLat,
    poleLon
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

  const indices = generateGridIndices(batchLatCount, tileLonCount);
  geometry.setIndex(indices);
  return geometry;
}

function applyTileGeometry(
  tileIndex: number,
  geometry: THREE.InstancedBufferGeometry
) {
  if (meshes[tileIndex]) {
    setupProjectionGeometryWrap(geometry);
    meshes[tileIndex].geometry.dispose();
    meshes[tileIndex].geometry = geometry;
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

function computeTileLayout(latCount: number, geometryLonCount: number) {
  const latBatchCount = Math.ceil((latCount - 1) / BATCH_SIZE);
  const lonStep = MAX_TILE_SIZE - 1;
  const lonTileCount = Math.max(1, Math.ceil((geometryLonCount - 1) / lonStep));
  const actualLonStep = Math.ceil((geometryLonCount - 1) / lonTileCount);

  const tiles: TTileInfo[] = [];
  for (let latBatch = 0; latBatch < latBatchCount; latBatch++) {
    const latStart = latBatch * BATCH_SIZE;
    const latEnd = Math.min(latStart + BATCH_SIZE, latCount - 1);
    for (let lonTile = 0; lonTile < lonTileCount; lonTile++) {
      const lonStart = lonTile * actualLonStep;
      const lonEnd = Math.min(lonStart + actualLonStep, geometryLonCount - 1);
      tiles.push({ latStart, latEnd, lonStart, lonEnd });
    }
  }
  return tiles;
}

async function makeGeometry() {
  try {
    const {
      latitudeValues,
      longitudeValues,
      latCount,
      lonCount,
      poleLat,
      poleLon,
    } = await getGridParams();

    const tiles = computeTileLayout(latCount, lonCount);
    tileInfos = tiles;
    cleanupMeshes(tiles.length);

    for (let i = 0; i < tiles.length; i++) {
      const geometry = createTileGeometry(
        latitudeValues,
        longitudeValues,
        tiles[i],
        poleLat,
        poleLon
      );
      applyTileGeometry(i, geometry);
    }
    updateMeshProjectionUniforms();
  } catch (error) {
    logError(error, "Could not fetch grid");
  }
}

function createTileTexture(
  rawData: Float32Array,
  tile: TTileInfo,
  textureLonCount: number,
  totalLatCount: number,
  isReversed: boolean,
  latOnly: boolean
) {
  const tileLatCount = tile.latEnd - tile.latStart + 1;
  const tileLonCount = tile.lonEnd - tile.lonStart + 1;
  const tileData = new Float32Array(tileLatCount * tileLonCount);

  for (let li = 0; li < tileLatCount; li++) {
    const fileLatIdx = isReversed
      ? totalLatCount - 1 - (tile.latStart + li)
      : tile.latStart + li;
    if (latOnly) {
      const val = rawData[fileLatIdx];
      for (let lj = 0; lj < tileLonCount; lj++) {
        tileData[li * tileLonCount + lj] = val;
      }
    } else {
      for (let lj = 0; lj < tileLonCount; lj++) {
        const globalLonIdx = (tile.lonStart + lj) % textureLonCount;
        tileData[li * tileLonCount + lj] =
          rawData[fileLatIdx * textureLonCount + globalLonIdx];
      }
    }
  }

  const texture = new THREE.DataTexture(
    tileData,
    tileLonCount,
    tileLatCount,
    THREE.RedFormat,
    THREE.FloatType,
    THREE.UVMapping
  );
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

function makeTileMaterial(texture: THREE.DataTexture) {
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

function nearestIndex(sorted: Float64Array, target: number): number {
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

function nearestLonIndex(lons: Float64Array, target: number): number {
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
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  updateMode: TUpdateMode
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
    varinfo.value?.dimRanges,
    updateMode === UPDATE_MODE.SLIDER_TOGGLE
  );
}

function updateTileMaterials(rawData: Float32Array) {
  const helper = projectionHelper.value;
  const textureLonCount = longitudes.value.length;
  const totalLatCount = latitudes.value.length;
  const isReversed = isLatReversed.value;

  for (let i = 0; i < meshes.length; i++) {
    const tile = tileInfos[i];
    const texture = createTileTexture(
      rawData,
      tile,
      textureLonCount,
      totalLatCount,
      isReversed,
      isLatOnly.value
    );
    const material = makeTileMaterial(texture);
    updateProjectionUniforms(material, helper);
    disposeMeshMaterial(meshes[i]);
    meshes[i].material = material;
    material.needsUpdate = true;
  }
}

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  updateMode: TUpdateMode
) {
  const { dimensionRanges, indices } = await buildDimensionConfig(
    datavar,
    updateMode
  );

  const rawData = castDataVarToFloat32(
    (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
  );

  const { min, max, missingValue, fillValue } = getDataBoundsAndMapMissingToNaN(
    datavar,
    rawData
  );

  updateTileMaterials(rawData);

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
    indices as number[],
    updateMode
  );
  redraw();
}

async function getData(updateMode: TUpdateMode = UPDATE_MODE.INITIAL_LOAD) {
  store.startLoading();
  if (updatingData.value) {
    pendingUpdate.value = true;
    return;
  }

  try {
    do {
      pendingUpdate.value = false;
      updatingData.value = true;

      const localVarname = varnameSelector.value;

      const datavar = await getDataVar(localVarname, props.datasources!);

      if (datavar !== undefined) {
        await fetchAndRenderData(datavar, updateMode);
      }
      updatingData.value = false;
    } while (pendingUpdate.value);
  } catch (error) {
    logError(error, "Could not fetch data");
    updatingData.value = false;
  } finally {
    store.stopLoading();
  }
}

onBeforeMount(async () => {
  await datasourceUpdate();
});

onBeforeUnmount(() => {
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    disposeMeshMaterial(mesh);
    getScene()?.remove(mesh);
  }
  meshes.length = 0;
  tileInfos.length = 0;
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
