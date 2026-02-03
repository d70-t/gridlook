<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, ref, watch } from "vue";
import type * as zarr from "zarrita";

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

watch([() => projectionMode.value, () => projectionCenter.value], () => {
  updateMeshProjectionUniforms();
});

function updateMeshProjectionUniforms() {
  const helper = projectionHelper.value;
  const center = projectionCenter.value;

  for (const mesh of meshes) {
    updateProjectionUniforms(
      mesh.material as THREE.ShaderMaterial,
      helper.type,
      center.lon,
      center.lat
    );
  }
  redraw();
}

const colormapMaterial = computed(() => {
  if (invertColormap.value) {
    return makeGpuProjectedMeshMaterial(colormap.value, 1.0, -1.0);
  } else {
    return makeGpuProjectedMeshMaterial(colormap.value, 0.0, 1.0);
  }
});

async function datasourceUpdate() {
  if (props.datasources !== undefined) {
    await Promise.all([getData()]);
    updateLandSeaMask();
    updateColormap(meshes);
  }
}

const BATCH_SIZE = 64; // Adjust based on memory and browser limits

function updateOrCreateMesh(
  batchIndex: number,
  geometry: THREE.BufferGeometry
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

function cleanupMeshes(totalBatches: number) {
  if (meshes.length <= totalBatches) {
    return; // No cleanup needed
  }

  for (const mesh of meshes) {
    mesh.geometry.dispose(); // Free GPU memory
    getScene()?.remove(mesh); // Remove from Three.js scene
  }
  meshes.length = 0; // Clear our mesh array
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
  geometry.computeBoundingSphere();

  return geometry;
}

function initializeArrays(totalCells: number) {
  const latLonValues = new Float32Array(totalCells * 4 * 2); // 4 vertices, 2 values (lat, lon)
  const positionValues = new Float32Array(totalCells * 4 * 3); // 4 vertices, 3 values (x, y, z)
  const dataValues = new Float32Array(totalCells * 4);
  const indices = new Uint32Array(totalCells * 6);

  return { positionValues, dataValues, latLonValues, indices };
}

const EPSILON = 0.002; // Small overlap in degrees to avoid z-fighting

function createQuadVertices(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  positionValues: Float32Array,
  latLonValues: Float32Array,
  positionOffset: number,
  latLonOffset: number
) {
  const helper = projectionHelper.value;
  // Vertex 0: top-left
  helper.projectLatLonToArrays(
    lat1,
    lon1 + EPSILON,
    positionValues,
    positionOffset,
    latLonValues,
    latLonOffset
  );

  // Vertex 1: top-right
  helper.projectLatLonToArrays(
    lat1,
    lon1 - lon2 - EPSILON,
    positionValues,
    positionOffset + 3,
    latLonValues,
    latLonOffset + 2
  );

  // Vertex 2: bottom-right
  helper.projectLatLonToArrays(
    lat2 - EPSILON,
    lon1 - lon2 - EPSILON,
    positionValues,
    positionOffset + 6,
    latLonValues,
    latLonOffset + 4
  );

  // Vertex 3: bottom-left
  helper.projectLatLonToArrays(
    lat2 - EPSILON,
    lon1 + EPSILON,
    positionValues,
    positionOffset + 9,
    latLonValues,
    latLonOffset + 6
  );
}

// Precompute total number of cells (quads) in this batch
function getTotalCellNumber(
  rows: Record<number, { lon: number; value: number }[]>,
  lStart: number,
  lEnd: number,
  uniqueLats: number[]
) {
  let totalCells = 0;
  for (let l = lStart; l < lEnd; l++) {
    totalCells += rows[uniqueLats[l]].length;
  }
  return totalCells;
}

function getCellData(row1: { lon: number; value: number }[], i: number) {
  const cell = row1[i];
  const nextCell = row1[(i + 1) % row1.length];
  const lon1 = cell.lon;
  const lon2 = nextCell.lon;
  // wrap-around adjustment
  const dLon = (lon2 - lon1 + 360) % 360;
  return { cell, lon1, lon2: dLon, nextCell };
}

function buildBatchGeometryData(
  rows: Record<number, { lon: number; value: number }[]>,
  uniqueLats: number[],
  lStart: number,
  lEnd: number
) {
  const totalCells = getTotalCellNumber(rows, lStart, lEnd, uniqueLats);
  const { positionValues, dataValues, latLonValues, indices } =
    initializeArrays(totalCells);

  let latLonOffset = 0;
  let positionOffset = 0;
  let idxOffset = 0;
  let cellIndex = 0;

  for (let l = lStart; l < lEnd; l++) {
    const lat1 = uniqueLats[l];
    const lat2 = uniqueLats[l + 1];
    const row = rows[lat1];

    for (let i = 0; i < row.length; i++) {
      const { cell, lon1, lon2 } = getCellData(row, i);

      createQuadVertices(
        lat1,
        lon1,
        lat2,
        lon2,
        positionValues,
        latLonValues,
        positionOffset,
        latLonOffset
      );

      // Data value
      dataValues.fill(cell.value, cellIndex * 4, cellIndex * 4 + 4);

      // Indices for two triangles
      const v = cellIndex * 4;
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], idxOffset);

      // Offsets
      latLonOffset += 8; // 4 vertices * 2 values each
      positionOffset += 12; // 4 vertices * 3 values each
      idxOffset += 6;
      cellIndex++;
    }
  }

  return createBatchGeometry(positionValues, dataValues, latLonValues, indices);
}

function buildGaussianReducedGeometry(
  latitudes: Float64Array,
  longitudes: Float64Array,
  data: Float32Array
) {
  const { rows, uniqueLats } = buildRows(latitudes, longitudes, data);
  const totalBatches = Math.ceil((uniqueLats.length - 1) / BATCH_SIZE);
  cleanupMeshes(totalBatches);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const lStart = batchIndex * BATCH_SIZE;
    const lEnd = Math.min(lStart + BATCH_SIZE, uniqueLats.length - 1);
    const geometry = buildBatchGeometryData(rows, uniqueLats, lStart, lEnd);

    updateOrCreateMesh(batchIndex, geometry);
  }
}

function buildRows(
  latitudes: Float64Array,
  longitudes: Float64Array,
  data: Float32Array
) {
  const rows: Record<number, { lon: number; value: number }[]> = {};
  for (let i = 0; i < latitudes.length; i++) {
    const lat = latitudes[i];
    if (!rows[lat]) {
      rows[lat] = [];
    }
    rows[lat].push({ lon: longitudes[i], value: data[i] });
  }

  const uniqueLats = Object.keys(rows)
    .map(Number)
    .sort((a, b) => b - a);
  return { rows, uniqueLats };
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
    [datavar.shape.length - 1],
    varinfo.value?.dimRanges,
    updateMode === UPDATE_MODE.SLIDER_TOGGLE
  );

  let rawData = castDataVarToFloat32(
    (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
  );

  const { latitudes, longitudes } = await getLatLonData(
    datavar,
    props.datasources
  );
  const latitudesData = latitudes.data as Float64Array;
  const longitudesData = longitudes.data as Float64Array;

  let { min, max, missingValue, fillValue } = getDataBounds(datavar, rawData);

  buildGaussianReducedGeometry(latitudesData, longitudesData, rawData);

  // Set projection uniforms on all meshes after grid creation
  updateMeshProjectionUniforms();

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
