<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, ref, watch } from "vue";
import * as zarr from "zarrita";

import {
  createGeoSampleIndex,
  useGridHoverLookup,
} from "./composables/gridHoverUtils.ts";
import {
  createWrappedProjectionMesh,
  setupProjectionGeometryWrap,
  updateProjectionMeshes,
  watchProjectionEdgeQuality,
} from "./composables/useProjectionEdgeQuality.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  castDataVarToFloat32,
  createMissingOrFillPredicate,
  getDataBounds,
  getLatLonData,
  mapMissingAndFillToNaN,
} from "@/lib/data/zarrUtils.ts";
import { makeGpuProjectedMeshMaterial } from "@/lib/shaders/gridShaders.ts";
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

let meshes: THREE.Mesh[] = [];

const {
  getScene,
  redraw,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  getDataVar,
  fetchDimensionDetails,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
  isSceneInMotion,
  canvas,
  box,
  updateHistogram,
  hoveredGeoPoint,
} = useSharedGridLogic();

const { setHoverLookupFromIndex, clearHoverLookup } =
  useGridHoverLookup(hoveredGeoPoint);

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

const bounds = computed(() => {
  return selection.value;
});

watch(
  [
    () => bounds.value,
    () => invertColormap.value,
    () => colormap.value,
    () => posterizeLevels.value,
    () => store.hideLowerBound,
  ],
  () => {
    updateColormap(meshes);
  }
);

watchProjectionEdgeQuality({
  projectionMode,
  projectionCenter,
  isSceneInMotion,
  onUpdate: updateMeshProjectionUniforms,
});

/**
 * Update projection uniforms on all mesh materials.
 * This is the fast path - no geometry rebuild needed.
 */
function updateMeshProjectionUniforms() {
  updateProjectionMeshes(meshes, {
    redraw,
    projectionHelper: projectionHelper.value,
    isSceneInMotion: isSceneInMotion.value,
  });
}

const colormapMaterial = computed(() => {
  // Use GPU-projected material
  const material = invertColormap.value
    ? makeGpuProjectedMeshMaterial(colormap.value, 1.0, -1.0)
    : makeGpuProjectedMeshMaterial(colormap.value, 0.0, 1.0);
  return material;
});

async function datasourceUpdate() {
  clearHoverLookup();
  if (props.datasources !== undefined) {
    await Promise.all([getData()]);
    updateLandSeaMask();
    updateColormap(meshes);
  }
}

const BATCH_SIZE = 30;

async function getGrid(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  data: Float32Array
) {
  const { latitudes, longitudes } = await getLatLonData(
    datavar,
    props.datasources
  );
  const isMissingOrFill = createMissingOrFillPredicate(datavar);

  const latitudesData = latitudes.data as Float64Array;
  const longitudesData = longitudes!.data as Float64Array;
  const [nj, ni] = latitudes.shape;

  // Detect cell orientation by analyzing the winding order of grid cells
  const shouldFlipLongitude = detectLongitudeFlip(
    longitudesData,
    latitudesData,
    isMissingOrFill,
    nj,
    ni
  );

  buildCurvilinearGeometry(
    latitudesData,
    longitudesData,
    data,
    nj,
    ni,
    shouldFlipLongitude
  );

  return {
    latitudesData,
    longitudesData,
    nj,
    ni,
    shouldFlipLongitude,
  };
}

function detectLongitudeFlip(
  longitudes: Float64Array,
  latitudes: Float64Array,
  isMissingOrFill: (value: number) => boolean,
  nj: number,
  ni: number
): boolean {
  // Find first valid cell (2x2 region with all valid points)
  let validCellFound = false;
  let cellJ = -1,
    cellI = -1;

  for (let j = 0; j < nj - 1 && !validCellFound; j++) {
    for (let i = 0; i < Math.min(ni - 1, 10); i++) {
      const idx00 = j * ni + i;
      const idx01 = j * ni + (i + 1);
      const idx10 = (j + 1) * ni + i;
      const idx11 = (j + 1) * ni + (i + 1);

      if (
        !isMissingOrFill(longitudes[idx00]) &&
        !isMissingOrFill(longitudes[idx01]) &&
        !isMissingOrFill(longitudes[idx10]) &&
        !isMissingOrFill(longitudes[idx11])
      ) {
        cellJ = j;
        cellI = i;
        validCellFound = true;
        break;
      }
    }
  }

  if (!validCellFound) {
    return false;
  }

  // Get the cell's corner indices
  const idx00 = cellJ * ni + cellI;
  const idx01 = cellJ * ni + (cellI + 1);
  const idx10 = (cellJ + 1) * ni + cellI;

  // Calculate vectors along i and j directions
  const dlonI = longitudes[idx01] - longitudes[idx00];
  const dlatI = latitudes[idx01] - latitudes[idx00];
  const dlonJ = longitudes[idx10] - longitudes[idx00];
  const dlatJ = latitudes[idx10] - latitudes[idx00];

  // Cross product determines cell winding order:
  // positive = counterclockwise (correct), negative = clockwise (needs flip)
  const crossProduct = dlonI * dlatJ - dlatI * dlonJ;

  return crossProduct < 0;
}

function cleanupMeshes(totalBatches: number) {
  if (meshes.length <= totalBatches) {
    return;
  }

  for (const mesh of meshes) {
    mesh.geometry.dispose();
    getScene()?.remove(mesh);
  }
  meshes.length = 0;
}

function getNextColumnIndex(
  i: number,
  ni: number,
  flipLongitude: boolean
): number {
  if (flipLongitude) {
    return i === 0 ? ni - 1 : i - 1;
  }
  return (i + 1) % ni;
}

// Calculate the four corner indices for a grid cell
function getCellCornerIndices(
  j: number,
  i: number,
  ni: number,
  flipLongitude: boolean
) {
  const iNext = getNextColumnIndex(i, ni, flipLongitude);
  return {
    idx00: j * ni + i,
    idx01: j * ni + iNext,
    idx10: (j + 1) * ni + i,
    idx11: (j + 1) * ni + iNext,
  };
}

// Extract corner coordinates for a cell
function extractCellCorners(
  indices: { idx00: number; idx01: number; idx10: number; idx11: number },
  latitudes: Float64Array,
  longitudes: Float64Array
) {
  const { idx00, idx01, idx11, idx10 } = indices;
  return {
    latPoints: [
      latitudes[idx00],
      latitudes[idx01],
      latitudes[idx11],
      latitudes[idx10],
    ],
    lonPoints: [
      longitudes[idx00],
      longitudes[idx01],
      longitudes[idx11],
      longitudes[idx10],
    ],
  };
}

function createBatchGeometry(
  positionValues: Float32Array,
  dataValues: Float32Array,
  latLonValues: Float32Array,
  indices: Uint32Array
) {
  const geometry = new THREE.InstancedBufferGeometry();

  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positionValues, 3)
  );
  geometry.setAttribute("data_value", new THREE.BufferAttribute(dataValues, 1));
  geometry.setAttribute("latLon", new THREE.BufferAttribute(latLonValues, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  return geometry;
}

function updateBatchMesh(
  batchIndex: number,
  geometry: THREE.InstancedBufferGeometry,
  meshes: THREE.Mesh[]
) {
  setupProjectionGeometryWrap(geometry);
  if (meshes[batchIndex]) {
    meshes[batchIndex].geometry.dispose();
    meshes[batchIndex].geometry = geometry;
  } else {
    const mesh = createWrappedProjectionMesh(
      geometry,
      colormapMaterial.value,
      projectionHelper.value.type
    );
    mesh.frustumCulled = false;
    meshes.push(mesh);
    getScene()?.add(mesh);
  }
}

function initializeArrays(jEnd: number, jStart: number, ni: number) {
  // Calculate cells in this batch
  const batchCells = (jEnd - jStart) * ni;

  // Pre-allocate arrays for this batch's Three.js geometry
  // Each cell becomes a quad (4 vertices), each vertex has 3 coordinates (x,y,z)
  const positionValues = new Float32Array(batchCells * 4 * 3);
  // Each vertex gets a data value for the colormap shader
  const dataValues = new Float32Array(batchCells * 4);
  // Each vertex gets lat/lon for GPU projection (2 values per vertex)
  const latLonValues = new Float32Array(batchCells * 4 * 2);
  // Each quad is made of 2 triangles, each triangle needs 3 indices
  const indices = new Uint32Array(batchCells * 6);
  return { positionValues, dataValues, latLonValues, indices };
}

// Project all 4 vertices of a cell and update offsets
function projectCellVertices(
  latPoints: number[],
  lonPoints: number[],
  positionValues: Float32Array,
  latLonValues: Float32Array,
  positionOffset: number,
  cellIndex: number
): number {
  const helper = projectionHelper.value;
  let latLonOffset = cellIndex * 8;
  let currentOffset = positionOffset;

  for (let k = 0; k < 4; k++) {
    helper.projectLatLonToArrays(
      latPoints[k],
      lonPoints[k],
      positionValues,
      currentOffset,
      latLonValues,
      latLonOffset
    );
    currentOffset += 3;
    latLonOffset += 2;
  }

  return currentOffset;
}

// Skip cells whose coordinate corners contain NaN/Infinity – projecting
// such values (especially on the globe) produces NaN positions that
// break THREE.js's computeBoundingSphere. The pre-allocated zeros in
// positionValues / latLonValues are valid fallbacks, and setting the
// data value to NaN causes the fragment shader to discard the fragment.
function fillCellPositionAndData(
  latPoints: number[],
  lonPoints: number[],
  data: Float32Array,
  idx00: number,
  positionValues: Float32Array,
  dataValues: Float32Array,
  latLonValues: Float32Array,
  positionOffset: number,
  cellIndex: number
): number {
  const hasInvalidCoords =
    latPoints.some((v) => !Number.isFinite(v)) ||
    lonPoints.some((v) => !Number.isFinite(v));
  if (hasInvalidCoords) {
    positionOffset += 12; // 4 vertices × 3 coords, already zeroed
    dataValues.fill(NaN, cellIndex * 4, cellIndex * 4 + 4);
  } else {
    positionOffset = projectCellVertices(
      latPoints,
      lonPoints,
      positionValues,
      latLonValues,
      positionOffset,
      cellIndex
    );
    dataValues.fill(data[idx00], cellIndex * 4, cellIndex * 4 + 4);
  }
  return positionOffset;
}

function buildBatchGeometryData(
  latitudes: Float64Array,
  longitudes: Float64Array,
  data: Float32Array,
  jStart: number,
  jEnd: number,
  ni: number,
  flipLongitude: boolean
) {
  const { positionValues, dataValues, latLonValues, indices } =
    initializeArrays(jEnd, jStart, ni);

  let positionOffset = 0;
  let idxOffset = 0;
  let cellIndex = 0;

  for (let j = jStart; j < jEnd; j++) {
    for (let i = 0; i < ni; i++) {
      const { idx00, idx01, idx10, idx11 } = getCellCornerIndices(
        j,
        i,
        ni,
        flipLongitude
      );
      const { latPoints, lonPoints } = extractCellCorners(
        { idx00, idx01, idx10, idx11 },
        latitudes,
        longitudes
      );
      positionOffset = fillCellPositionAndData(
        latPoints,
        lonPoints,
        data,
        idx00,
        positionValues,
        dataValues,
        latLonValues,
        positionOffset,
        cellIndex
      );
      const v = cellIndex * 4;
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], idxOffset);
      idxOffset += 6;
      cellIndex++;
    }
  }

  return createBatchGeometry(positionValues, dataValues, latLonValues, indices);
}

function buildCurvilinearGeometry(
  latitudes: Float64Array, // 2D array flattened: lat values at each (j,i) grid point
  longitudes: Float64Array, // 2D array flattened: lon values at each (j,i) grid point
  data: Float32Array, // 2D array flattened: data values at each (j,i) grid point
  nj: number, // Number of rows in the grid (j dimension)
  ni: number, // Number of columns in the grid (i dimension)
  flipLongitude: boolean = false // Whether to flip longitude ordering
) {
  const totalBatches = Math.ceil((nj - 1) / BATCH_SIZE);
  cleanupMeshes(totalBatches);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const jStart = batchIndex * BATCH_SIZE;
    const jEnd = Math.min(jStart + BATCH_SIZE, nj - 1);

    const geometry = buildBatchGeometryData(
      latitudes,
      longitudes,
      data,
      jStart,
      jEnd,
      ni,
      flipLongitude
    );
    updateBatchMesh(batchIndex, geometry, meshes);
  }
  // Update projection uniforms after geometry is built
  updateMeshProjectionUniforms();
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

function getCircularMeanLongitude(
  lonA: number,
  lonB: number,
  lonC: number,
  lonD: number
) {
  const lonRadA = THREE.MathUtils.degToRad(lonA);
  const lonRadB = THREE.MathUtils.degToRad(lonB);
  const lonRadC = THREE.MathUtils.degToRad(lonC);
  const lonRadD = THREE.MathUtils.degToRad(lonD);

  const sinLon =
    Math.sin(lonRadA) +
    Math.sin(lonRadB) +
    Math.sin(lonRadC) +
    Math.sin(lonRadD);
  const cosLon =
    Math.cos(lonRadA) +
    Math.cos(lonRadB) +
    Math.cos(lonRadC) +
    Math.cos(lonRadD);

  return THREE.MathUtils.radToDeg(Math.atan2(sinLon / 4, cosLon / 4));
}

function getCellCenter(
  latitudes: Float64Array,
  longitudes: Float64Array,
  idx00: number,
  idx01: number,
  idx10: number,
  idx11: number
) {
  const latA = latitudes[idx00];
  const latB = latitudes[idx01];
  const latC = latitudes[idx10];
  const latD = latitudes[idx11];
  const lonA = longitudes[idx00];
  const lonB = longitudes[idx01];
  const lonC = longitudes[idx10];
  const lonD = longitudes[idx11];

  return {
    lat: (latA + latB + latC + latD) / 4,
    lon: getCircularMeanLongitude(lonA, lonB, lonC, lonD),
  };
}

function buildCurvilinearHoverSamples(
  rawData: Float32Array,
  latitudes: Float64Array,
  longitudes: Float64Array,
  nj: number,
  ni: number,
  flipLongitude: boolean
) {
  const samples: { lat: number; lon: number; value: number }[] = [];

  for (let j = 0; j < nj - 1; j++) {
    for (let i = 0; i < ni; i++) {
      const { idx00, idx01, idx10, idx11 } = getCellCornerIndices(
        j,
        i,
        ni,
        flipLongitude
      );
      // Keep hover sampling colocated with rendered quads by using a cell center.
      const { lat, lon } = getCellCenter(
        latitudes,
        longitudes,
        idx00,
        idx01,
        idx10,
        idx11
      );

      samples.push({
        lat,
        lon,
        value: rawData[idx00],
      });
    }
  }

  return samples;
}

function setHoverData(
  rawData: Float32Array,
  latitudes: Float64Array,
  longitudes: Float64Array,
  nj: number,
  ni: number,
  flipLongitude: boolean,
  fillValue: number,
  missingValue: number
) {
  const samples = buildCurvilinearHoverSamples(
    rawData,
    latitudes,
    longitudes,
    nj,
    ni,
    flipLongitude
  );

  setHoverLookupFromIndex(
    createGeoSampleIndex(samples),
    fillValue,
    missingValue
  );
}

async function renderGridAndHover(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  rawData: Float32Array,
  fillValue: number,
  missingValue: number
) {
  const { latitudesData, longitudesData, nj, ni, shouldFlipLongitude } =
    await getGrid(datavar, rawData);
  setHoverData(
    rawData,
    latitudesData,
    longitudesData,
    nj,
    ni,
    shouldFlipLongitude,
    fillValue,
    missingValue
  );
}

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  updateMode: TUpdateMode
) {
  const dimensionNames = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  const { dimensionRanges, indices } = buildDimensionRangesAndIndices(
    datavar,
    dimensionNames,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    [datavar.shape.length - 2, datavar.shape.length - 1],
    varinfo.value?.dimRanges,
    false
  );

  let rawData = castDataVarToFloat32(
    (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
  );
  const { min, max, missingValue, fillValue } = getDataBounds(datavar, rawData);
  rawData = mapMissingAndFillToNaN(rawData, missingValue, fillValue);

  await renderGridAndHover(datavar, rawData, fillValue, missingValue);

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

  redraw();
}

async function getData(updateMode: TUpdateMode = UPDATE_MODE.INITIAL_LOAD) {
  store.startLoading();
  if (updatingData.value) {
    pendingUpdate.value = true;
    return;
  }
  updatingData.value = true;

  try {
    do {
      pendingUpdate.value = false;
      const localVarname = varnameSelector.value;
      const datavar = await getDataVar(localVarname, props.datasources!);
      if (datavar) {
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

defineExpose({ makeSnapshot, toggleRotate, applyCameraPreset });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
