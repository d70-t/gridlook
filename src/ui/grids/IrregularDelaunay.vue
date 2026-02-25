<script lang="ts" setup>
import { Delaunay } from "d3-delaunay";
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, ref, watch } from "vue";
import * as zarr from "zarrita";

import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  castDataVarToFloat32,
  getDataBounds,
  getLatLonData,
} from "@/lib/data/zarrUtils.ts";
import {
  makeGpuProjectedMeshMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "@/store/store.ts";
import { useLog } from "@/utils/logging.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();
const { logError } = useLog();
const {
  dimSlidersValues,
  colormap,
  varnameSelector,
  invertColormap,
  posterizeLevels,
  selection,
  isInitializingVariable,
  varinfo,
  projectionMode,
  projectionCenter,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const pendingUpdate = ref(false);
const updatingData = ref(false);

// For mesh-based rendering
const BATCH_SIZE = 1000000; // triangles per mesh
let meshes: THREE.Mesh[] = [];

// Cache triangulation indices to avoid recomputing when only data changes
let cachedTriangleIndices: Uint32Array | null = null;
let cachedNumPoints = 0;

const {
  getScene,
  makeSnapshot,
  toggleRotate,
  getDataVar,
  fetchDimensionDetails,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
  redraw,
  canvas,
  box,
  updateHistogram,
} = useSharedGridLogic();

watch(
  () => varnameSelector.value,
  () => {
    // Clear triangulation cache when variable changes (coordinates may differ)
    cachedTriangleIndices = null;
    getData();
  }
);

watch(
  () => dimSlidersValues.value,
  () => {
    if (isInitializingVariable.value) {
      isInitializingVariable.value = false;
      return;
    }
    getData(UPDATE_MODE.SLIDER_TOGGLE);
  },
  { deep: true }
);

watch(
  () => props.datasources,
  () => {
    cachedTriangleIndices = null;
    datasourceUpdate();
  }
);

const bounds = computed(() => {
  return selection.value;
});

watch(
  [
    () => bounds.value,
    () => invertColormap.value,
    () => colormap.value,
    () => posterizeLevels.value,
  ],
  () => {
    updateColormap(meshes);
  }
);

// GPU projection: update shader uniforms instead of rebuilding geometry
watch(
  [() => projectionMode.value, () => projectionCenter.value],
  () => {
    updateMeshProjectionUniforms();
  },
  { deep: true }
);

/**
 * Update projection uniforms on all mesh materials.
 * This is the fast path - no geometry rebuild needed.
 */
function updateMeshProjectionUniforms() {
  const helper = projectionHelper.value;
  const center = projectionCenter.value;

  for (const mesh of meshes) {
    const material = mesh.material as THREE.ShaderMaterial;
    if (material.uniforms?.projectionType) {
      updateProjectionUniforms(material, helper.type, center.lon, center.lat);
    }
  }
  redraw();
}

const colormapMaterial = computed(() => {
  // Use GPU-projected mesh material (same as Triangular)
  const material = invertColormap.value
    ? makeGpuProjectedMeshMaterial(colormap.value, 1.0, -1.0)
    : makeGpuProjectedMeshMaterial(colormap.value, 0.0, 1.0);

  return material;
});

async function datasourceUpdate() {
  if (props.datasources !== undefined) {
    await getData();
    updateLandSeaMask();
    updateColormap(meshes);
  }
}

/**
 * Expand 1D lat/lon arrays to match data length via meshgrid-style expansion.
 */
function expandCoordinatesToMeshgrid(
  lat: Float32Array,
  lon: Float32Array,
  dataLength: number
): { latitudes: Float32Array; longitudes: Float32Array } {
  const nj = lat.length;
  const ni = lon.length;

  if (nj * ni !== dataLength) {
    throw new Error(
      `Cannot expand coordinates: lat[${nj}] × lon[${ni}] = ${nj * ni} but data has ${dataLength} points`
    );
  }

  const latitudes = new Float32Array(dataLength);
  const longitudes = new Float32Array(dataLength);

  for (let j = 0; j < nj; j++) {
    for (let i = 0; i < ni; i++) {
      const idx = j * ni + i;
      latitudes[idx] = lat[j];
      longitudes[idx] = lon[i];
    }
  }

  return { latitudes, longitudes };
}

/**
 * Reconcile coordinate arrays with data array.
 */
function reconcileCoordinates(
  latitudesVar: zarr.Chunk<zarr.DataType>,
  longitudesVar: zarr.Chunk<zarr.DataType>,
  dataLength: number
): { latitudes: Float32Array; longitudes: Float32Array } {
  let latitudes = latitudesVar.data as Float32Array;
  let longitudes = longitudesVar.data as Float32Array;
  const latShape = latitudesVar.shape;
  const lonShape = longitudesVar.shape;

  if (latitudes.length === dataLength && longitudes.length === dataLength) {
    return { latitudes, longitudes };
  }

  if (latShape.length === 2 && lonShape.length === 2) {
    const latTotal = latShape[0] * latShape[1];
    const lonTotal = lonShape[0] * lonShape[1];
    if (latTotal === dataLength && lonTotal === dataLength) {
      return { latitudes, longitudes };
    }
  }

  if (latShape.length === 1 && lonShape.length === 1) {
    const product = latitudes.length * longitudes.length;
    if (product === dataLength) {
      return expandCoordinatesToMeshgrid(latitudes, longitudes, dataLength);
    }
  }

  const latTotal = latitudes.length;
  const lonTotal = longitudes.length;

  if (latTotal === dataLength && lonTotal === dataLength) {
    return { latitudes, longitudes };
  }

  if (latTotal * lonTotal === dataLength) {
    return expandCoordinatesToMeshgrid(latitudes, longitudes, dataLength);
  }

  throw new Error(
    `Cannot reconcile coordinates with data: lat has ${latTotal} values, ` +
      `lon has ${lonTotal} values, but data has ${dataLength} points.`
  );
}

/**
 * Create extended point set with duplicates for wrap-around at the antimeridian.
 */
function createExtendedPointSet(
  latitudes: Float32Array,
  longitudes: Float32Array,
  wrapThreshold: number
): { points: [number, number][]; indexMap: number[] } {
  const N = latitudes.length;
  const points: [number, number][] = [];
  const indexMap: number[] = [];

  for (let i = 0; i < N; i++) {
    const lon = longitudes[i];
    const lat = latitudes[i];

    points.push([lon, lat]);
    indexMap.push(i);

    if (lon < -wrapThreshold) {
      points.push([lon + 360, lat]);
      indexMap.push(i);
    }
    if (lon > wrapThreshold) {
      points.push([lon - 360, lat]);
      indexMap.push(i);
    }
  }

  return { points, indexMap };
}

/**
 * Check if a triangle should be included based on position and edge lengths.
 */
function isValidTriangle(
  lon0: number,
  lon1: number,
  lon2: number,
  lat0: number,
  lat1: number,
  lat2: number,
  maxEdgeLength: number
): boolean {
  const inRange0 = lon0 >= -180 && lon0 <= 180;
  const inRange1 = lon1 >= -180 && lon1 <= 180;
  const inRange2 = lon2 >= -180 && lon2 <= 180;
  if (!inRange0 && !inRange1 && !inRange2) {
    return false;
  }

  const edge01 = Math.sqrt((lon1 - lon0) ** 2 + (lat1 - lat0) ** 2);
  const edge12 = Math.sqrt((lon2 - lon1) ** 2 + (lat2 - lat1) ** 2);
  const edge20 = Math.sqrt((lon0 - lon2) ** 2 + (lat0 - lat2) ** 2);

  return (
    edge01 <= maxEdgeLength &&
    edge12 <= maxEdgeLength &&
    edge20 <= maxEdgeLength
  );
}

/**
 * Compute Delaunay triangulation from lat/lon coordinates with wrap-around handling.
 * Returns triangle indices as a flat Uint32Array (indices refer to original points).
 */
function computeDelaunayTriangulation(
  latitudes: Float32Array,
  longitudes: Float32Array
): Uint32Array {
  const wrapThreshold = 150;
  const maxEdgeLength = 30;

  const { points, indexMap } = createExtendedPointSet(
    latitudes,
    longitudes,
    wrapThreshold
  );
  const delaunay = Delaunay.from(points);
  const triangles = delaunay.triangles;
  const validTriangles: number[] = [];

  for (let i = 0; i < triangles.length; i += 3) {
    const ext0 = triangles[i];
    const ext1 = triangles[i + 1];
    const ext2 = triangles[i + 2];
    const [lon0, lat0] = points[ext0];
    const [lon1, lat1] = points[ext1];
    const [lon2, lat2] = points[ext2];

    if (isValidTriangle(lon0, lon1, lon2, lat0, lat1, lat2, maxEdgeLength)) {
      validTriangles.push(indexMap[ext0], indexMap[ext1], indexMap[ext2]);
    }
  }

  return new Uint32Array(validTriangles);
}

function cleanupMeshes() {
  for (const mesh of meshes) {
    getScene()?.remove(mesh);
    mesh.geometry.dispose();
  }
  meshes.length = 0;
}

/**
 * Create a single mesh batch from triangle data.
 */
function createMeshBatch(
  batchPositions: Float32Array,
  batchLatLon: Float32Array,
  batchDataValues: Float32Array,
  fillValue: number,
  missingValue: number
) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(batchPositions, 3)
  );
  geometry.setAttribute("latLon", new THREE.BufferAttribute(batchLatLon, 2));
  geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(batchDataValues, 1)
  );
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, colormapMaterial.value);
  mesh.frustumCulled = false;

  const material = mesh.material as THREE.ShaderMaterial;
  material.uniforms.fillValue.value = fillValue;
  material.uniforms.missingValue.value = missingValue;

  meshes.push(mesh);
  getScene()?.add(mesh);
}

/**
 * Check if triangle winding needs to be flipped so normal points outward.
 */
function shouldFlipTriangle(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number
): boolean {
  // Compute edge vectors
  const ax = x1 - x0;
  const ay = y1 - y0;
  const az = z1 - z0;
  const bx = x2 - x0;
  const by = y2 - y0;
  const bz = z2 - z0;

  // Cross product (normal)
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;

  // Centroid of the triangle
  const cx = (x0 + x1 + x2) / 3;
  const cy = (y0 + y1 + y2) / 3;
  const cz = (z0 + z1 + z2) / 3;

  // Dot product of normal with centroid (should be positive if normal points outward)
  return nx * cx + ny * cy + nz * cz < 0;
}

/**
 * Copy a single vertex's data to batch arrays.
 */
function copyVertexToBatch(
  srcIdx: number,
  dstIdx: number,
  src: { pos: Float32Array; ll: Float32Array },
  dst: { pos: Float32Array; ll: Float32Array; data: Float32Array },
  dataValue: number
) {
  dst.pos[dstIdx * 3 + 0] = src.pos[srcIdx * 3 + 0];
  dst.pos[dstIdx * 3 + 1] = src.pos[srcIdx * 3 + 1];
  dst.pos[dstIdx * 3 + 2] = src.pos[srcIdx * 3 + 2];
  dst.ll[dstIdx * 2 + 0] = src.ll[srcIdx * 2 + 0];
  dst.ll[dstIdx * 2 + 1] = src.ll[srcIdx * 2 + 1];
  dst.data[dstIdx] = dataValue;
}

/**
 * Process a single triangle - check winding, copy vertices.
 */
function processTriangle(
  t: number,
  batchStart: number,
  triangleIndices: Uint32Array,
  src: { pos: Float32Array; ll: Float32Array; data: Float32Array },
  dst: { pos: Float32Array; ll: Float32Array; data: Float32Array }
) {
  const triIdx = (batchStart + t) * 3;
  let i0 = triangleIndices[triIdx];
  let i1 = triangleIndices[triIdx + 1];
  let i2 = triangleIndices[triIdx + 2];

  const needsFlip = shouldFlipTriangle(
    src.pos[i0 * 3],
    src.pos[i0 * 3 + 1],
    src.pos[i0 * 3 + 2],
    src.pos[i1 * 3],
    src.pos[i1 * 3 + 1],
    src.pos[i1 * 3 + 2],
    src.pos[i2 * 3],
    src.pos[i2 * 3 + 1],
    src.pos[i2 * 3 + 2]
  );
  if (needsFlip) {
    [i1, i2] = [i2, i1];
  }

  const vertBase = t * 3;
  const avgValue = (src.data[i0] + src.data[i1] + src.data[i2]) / 3;

  copyVertexToBatch(i0, vertBase, src, dst, avgValue);
  copyVertexToBatch(i1, vertBase + 1, src, dst, avgValue);
  copyVertexToBatch(i2, vertBase + 2, src, dst, avgValue);
}

/**
 * Populate batch arrays from triangle indices.
 */
function populateBatchArrays(
  batchStart: number,
  batchTriangleCount: number,
  triangleIndices: Uint32Array,
  positions: Float32Array,
  latLonValues: Float32Array,
  data: Float32Array,
  batchPositions: Float32Array,
  batchLatLon: Float32Array,
  batchDataValues: Float32Array
) {
  const src = { pos: positions, ll: latLonValues, data };
  const dst = { pos: batchPositions, ll: batchLatLon, data: batchDataValues };
  for (let t = 0; t < batchTriangleCount; t++) {
    processTriangle(t, batchStart, triangleIndices, src, dst);
  }
}

/**
 * Project lat/lon coordinates to 3D positions and store in arrays.
 */
function projectCoordinates(
  latitudes: Float32Array,
  longitudes: Float32Array,
  positions: Float32Array,
  latLonValues: Float32Array
) {
  const helper = projectionHelper.value;
  const N = latitudes.length;
  for (let i = 0; i < N; i++) {
    helper.projectLatLonToArrays(
      latitudes[i],
      longitudes[i],
      positions,
      i * 3,
      latLonValues,
      i * 2
    );
  }
}

/**
 * Create batched meshes from positions and triangle indices.
 */
function createBatchedMeshes(
  positions: Float32Array,
  latLonValues: Float32Array,
  data: Float32Array,
  triangleIndices: Uint32Array,
  fillValue: number,
  missingValue: number
) {
  const numTriangles = triangleIndices.length / 3;

  for (
    let batchStart = 0;
    batchStart < numTriangles;
    batchStart += BATCH_SIZE
  ) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, numTriangles);
    const batchTriangleCount = batchEnd - batchStart;
    const batchVertexCount = batchTriangleCount * 3;

    const batchPositions = new Float32Array(batchVertexCount * 3);
    const batchLatLon = new Float32Array(batchVertexCount * 2);
    const batchDataValues = new Float32Array(batchVertexCount);

    populateBatchArrays(
      batchStart,
      batchTriangleCount,
      triangleIndices,
      positions,
      latLonValues,
      data,
      batchPositions,
      batchLatLon,
      batchDataValues
    );

    createMeshBatch(
      batchPositions,
      batchLatLon,
      batchDataValues,
      fillValue,
      missingValue
    );
  }
}

/**
 * Build mesh geometry from triangulated data.
 */
function buildMeshes(
  latitudes: Float32Array,
  longitudes: Float32Array,
  data: Float32Array,
  triangleIndices: Uint32Array,
  fillValue: number,
  missingValue: number
) {
  const N = latitudes.length;
  const positions = new Float32Array(N * 3);
  const latLonValues = new Float32Array(N * 2);

  projectCoordinates(latitudes, longitudes, positions, latLonValues);
  cleanupMeshes();
  createBatchedMeshes(
    positions,
    latLonValues,
    data,
    triangleIndices,
    fillValue,
    missingValue
  );
  updateMeshProjectionUniforms();
  redraw();
}

/**
 * Update only the data values on existing meshes (when triangulation is cached).
 */
function updateMeshDataValues(
  data: Float32Array,
  triangleIndices: Uint32Array,
  fillValue: number,
  missingValue: number
) {
  let triOffset = 0;

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const dataAttr = geometry.getAttribute("data_value");
    const vertCount = dataAttr.count;
    const triCount = vertCount / 3;

    for (let t = 0; t < triCount; t++) {
      const triIdx = (triOffset + t) * 3;
      const i0 = triangleIndices[triIdx];
      const i1 = triangleIndices[triIdx + 1];
      const i2 = triangleIndices[triIdx + 2];

      // Use average value for flat/discrete coloring
      const avgValue = (data[i0] + data[i1] + data[i2]) / 3;

      const vertBase = t * 3;
      dataAttr.array[vertBase + 0] = avgValue;
      dataAttr.array[vertBase + 1] = avgValue;
      dataAttr.array[vertBase + 2] = avgValue;
    }
    dataAttr.needsUpdate = true;

    const material = mesh.material as THREE.ShaderMaterial;
    material.uniforms.fillValue.value = fillValue;
    material.uniforms.missingValue.value = missingValue;

    triOffset += triCount;
  }

  redraw();
}

function getGrid(
  latitudesVar: zarr.Chunk<zarr.DataType>,
  longitudesVar: zarr.Chunk<zarr.DataType>,
  data: Float32Array,
  fillValue: number,
  missingValue: number
) {
  const N = data.length;
  const { latitudes, longitudes } = reconcileCoordinates(
    latitudesVar,
    longitudesVar,
    N
  );

  // Check if we can reuse cached triangulation
  const needsRetriangulation = !cachedTriangleIndices || cachedNumPoints !== N;

  if (needsRetriangulation) {
    cachedTriangleIndices = computeDelaunayTriangulation(latitudes, longitudes);
    cachedNumPoints = N;
  }

  if (needsRetriangulation || meshes.length === 0) {
    buildMeshes(
      latitudes,
      longitudes,
      data,
      cachedTriangleIndices!,
      fillValue,
      missingValue
    );
  } else {
    // Just update data values if geometry is the same
    updateMeshDataValues(data, cachedTriangleIndices!, fillValue, missingValue);
  }
}

async function getDimensionValues(
  dimensionRanges: TDimensionRange[],
  indices: (number | zarr.Slice | null)[]
) {
  const dimValues = await fetchDimensionDetails(
    varnameSelector.value,
    props.datasources!,
    dimensionRanges,
    indices
  );
  return dimValues;
}

function getGeographicDimensionIndices(
  dimensions: string[],
  latitudesAttrs: zarr.Attributes,
  longitudesAttrs: zarr.Attributes
) {
  const geoDims: number[] = [];
  for (let i = 0; i < dimensions.length; i++) {
    let latDims = latitudesAttrs._ARRAY_DIMENSIONS as string[];
    let lonDims = longitudesAttrs._ARRAY_DIMENSIONS as string[];
    if (latDims.includes(dimensions[i])) {
      geoDims.push(i);
    } else if (lonDims.includes(dimensions[i])) {
      geoDims.push(i);
    }
  }
  return geoDims;
}

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  updateMode: TUpdateMode
) {
  // Load latitudes and longitudes arrays
  const { latitudes, longitudes, latitudesAttrs, longitudesAttrs } =
    await getLatLonData(datavar, props.datasources);
  const dimensions = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  const geoDims: number[] = getGeographicDimensionIndices(
    dimensions,
    latitudesAttrs,
    longitudesAttrs!
  );

  const { dimensionRanges, indices } = buildDimensionRangesAndIndices(
    datavar,
    dimensions,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    geoDims,
    varinfo.value?.dimRanges,
    updateMode === UPDATE_MODE.SLIDER_TOGGLE
  );

  let rawData = castDataVarToFloat32(
    (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
  );

  let { min, max, fillValue, missingValue } = getDataBounds(datavar, rawData);
  getGrid(latitudes, longitudes!, rawData, fillValue, missingValue);

  const dimInfo = await getDimensionValues(dimensionRanges, indices);
  updateHistogram(rawData, min, max, missingValue, fillValue);

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
}

async function getData(updateMode: TUpdateMode = UPDATE_MODE.INITIAL_LOAD) {
  store.startLoading();
  try {
    if (updatingData.value) {
      pendingUpdate.value = true;
      return;
    }
    updatingData.value = true;
    do {
      pendingUpdate.value = false;
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

defineExpose({ makeSnapshot, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
