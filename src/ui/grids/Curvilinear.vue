<script lang="ts" setup>
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
  createMissingOrFillPredicate,
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
  getDataVar,
  fetchDimensionDetails,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
  canvas,
  box,
} = useSharedGridLogic();

watch(
  () => varnameSelector.value,
  () => {
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

const bounds = computed(() => {
  return selection.value;
});

watch(
  [() => bounds.value, () => invertColormap.value, () => colormap.value],
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
  // Use GPU-projected material
  const material = invertColormap.value
    ? makeGpuProjectedMeshMaterial(colormap.value, 1.0, -1.0)
    : makeGpuProjectedMeshMaterial(colormap.value, 0.0, 1.0);
  return material;
});

async function datasourceUpdate() {
  if (props.datasources !== undefined) {
    await Promise.all([getData()]);
    updateLandSeaMask();
    updateColormap(meshes);
  }
}

const BATCH_SIZE = 30;

async function getGrid(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  data: Float32Array
) {
  const { latitudes, longitudes } = await getLatLonData(
    datavar,
    props.datasources
  );
  const isMissingOrFill = createMissingOrFillPredicate(datavar);

  const latitudesData = latitudes.data as Float64Array;
  const longitudesData = longitudes.data as Float64Array;
  const [nj, ni] = latitudes.shape;

  // Detect potential mirroring issues by analyzing longitude progression
  const shouldFlipLongitude = detectLongitudeFlip(
    longitudesData,
    isMissingOrFill
  );

  buildCurvilinearGeometry(
    latitudesData,
    longitudesData,
    data,
    nj,
    ni,
    shouldFlipLongitude
  );
}

function detectLongitudeFlip(
  longitudes: Float64Array,
  isMissingOrFill: (value: number) => boolean
): boolean {
  let previousValidLon: number | undefined;
  for (let i = 0; i < longitudes.length; i++) {
    const lon = longitudes[i];
    if (isMissingOrFill(lon)) {
      continue;
    }
    if (previousValidLon === undefined) {
      previousValidLon = lon;
      continue;
    }
    if (lon > previousValidLon) {
      return false;
    } else if (lon < previousValidLon) {
      return true;
    }
    previousValidLon = lon;
  }
  return true;
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
  const geometry = new THREE.BufferGeometry();

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
  geometry: THREE.BufferGeometry,
  meshes: THREE.Mesh[]
) {
  if (meshes[batchIndex]) {
    meshes[batchIndex].geometry.dispose();
    meshes[batchIndex].geometry = geometry;
  } else {
    const mesh = new THREE.Mesh(geometry, colormapMaterial.value);
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

  let positionOffset = 0; // Offset into positions array (increments by 12 per cell)
  let idxOffset = 0; // Offset into indices array (increments by 6 per cell)
  let cellIndex = 0; // Current cell number (used for vertex indexing)

  // Main loop: iterate through grid cells in this batch
  // j goes from jStart to jEnd-1 (we need j+1 to exist for each cell)
  // i goes from 0 to ni-1 (full width, with wraparound for last column)
  for (let j = jStart; j < jEnd; j++) {
    for (let i = 0; i < ni; i++) {
      // Convert 2D grid coordinates (j,i) to 1D array indices
      // The 2D arrays are flattened in row-major order: index = j * ni + i
      // Calculate indices for the 4 corners of this grid cell:
      // Handle longitude ordering based on flip flag
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

      positionOffset = projectCellVertices(
        latPoints,
        lonPoints,
        positionValues,
        latLonValues,
        positionOffset,
        cellIndex
      );

      // Assign data value to all 4 vertices of this cell
      // We use the data value from the bottom-left corner (idx00)
      dataValues.fill(data[idx00], cellIndex * 4, cellIndex * 4 + 4);

      // Create triangle indices to form a quad from our 4 vertices
      // Each quad is split into 2 triangles:
      // Triangle 1: vertices 0, 1, 2 (bottom-left, bottom-right, top-right)
      // Triangle 2: vertices 0, 2, 3 (bottom-left, top-right, top-left)
      // This creates counter-clockwise winding for proper rendering
      const v = cellIndex * 4; // Base vertex index for this cell
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], idxOffset);

      // Move to next position in arrays for the next cell
      idxOffset += 6; // 2 triangles × 3 indices = 6 indices
      cellIndex++; // Increment cell counter
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

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  updateMode: TUpdateMode
) {
  const { dimensionRanges, indices } = buildDimensionRangesAndIndices(
    datavar,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    [datavar.shape.length - 2, datavar.shape.length - 1],
    varinfo.value?.dimRanges,
    false
  );

  const rawData = castDataVarToFloat32(
    (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
  );
  const { min, max, missingValue, fillValue } = getDataBounds(datavar, rawData);

  await getGrid(datavar, rawData);

  for (let mesh of meshes) {
    const material = mesh.material as THREE.ShaderMaterial;
    material.uniforms.missingValue.value = missingValue;
    material.uniforms.fillValue.value = fillValue;
  }

  const dimInfo = await getDimensionValues(dimensionRanges, indices);

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

defineExpose({ makeSnapshot, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
