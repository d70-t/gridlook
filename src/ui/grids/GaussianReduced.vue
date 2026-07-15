<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onBeforeUnmount } from "vue";
import type * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { getLatLonData } from "@/lib/data/coordinateVariables.ts";
import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  buildGaussianReducedGrid,
  terminateGaussianReducedWorker,
} from "@/lib/grids/gaussianReducedWorkerClient.ts";
import {
  getGridVariableData,
  terminateGridDataWorker,
} from "@/lib/grids/gridDataWorkerClient.ts";
import type { TGridGeometryBatch } from "@/lib/grids/gridWorkerTypes.ts";
import { createSerializedGeoSampleIndex } from "@/lib/grids/serializedGeoSampleIndex.ts";
import {
  createWrappedProjectionMesh,
  setupProjectionGeometryWrap,
  updateProjectionMeshes,
} from "@/lib/projection/projectionEdgeQuality.ts";
import { makeInvertableGpuMeshMaterial } from "@/lib/shaders/gridShaders.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();

const { dimSlidersValues, colormap, varnameSelector, invertColormap, varinfo } =
  storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

let meshes: THREE.Mesh[] = [];

function logTiming(label: string, startedAt: number) {
  console.log(
    `[GaussianReduced] ${label}: ${(performance.now() - startedAt).toFixed(1)} ms`
  );
}

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
  onProjectionChange,
  onMotionStateChange,
  onColormapChange,
  canvas,
  box,
  updateHistogram,
  hoveredGeoPoint,
} = useSharedGridLogic();

const { setHoverLookupFromIndex, clearHoverLookup } =
  useGridHoverLookup(hoveredGeoPoint);

onColormapChange(() => updateColormap(meshes));

onProjectionChange(updateMeshProjectionUniforms);
onMotionStateChange(updateMeshProjectionUniforms);

function updateMeshProjectionUniforms() {
  const startedAt = performance.now();
  updateProjectionMeshes(meshes, {
    redraw,
    projectionHelper: projectionHelper.value,
    isSceneInMotion: isSceneInMotion.value,
  });
  logTiming("update projection meshes", startedAt);
}

const colormapMaterial = computed(() => {
  return makeInvertableGpuMeshMaterial(colormap.value, invertColormap.value);
});

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  clearHoverLookup,
  updateLandSeaMask,
  updateColormap: () => updateColormap(meshes),
});

const BATCH_SIZE = 64; // Adjust based on memory and browser limits

function updateOrCreateMesh(
  batchIndex: number,
  geometry: THREE.InstancedBufferGeometry
) {
  const startedAt = performance.now();
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
  logTiming(`update/create mesh batch ${batchIndex}`, startedAt);
}

function cleanupMeshes(totalBatches: number) {
  if (meshes.length <= totalBatches) {
    return; // No cleanup needed
  }

  const startedAt = performance.now();
  for (const mesh of meshes) {
    mesh.geometry.dispose(); // Free GPU memory
    getScene()?.remove(mesh); // Remove from Three.js scene
  }
  meshes.length = 0; // Clear our mesh array
  logTiming("clean up meshes", startedAt);
}

function createBatchGeometry(
  positionValues: Float32Array,
  dataValues: Float32Array,
  latLonValues: Float32Array,
  indices: Uint32Array
) {
  const startedAt = performance.now();
  const geometry = new THREE.InstancedBufferGeometry();

  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positionValues, 3)
  );
  geometry.setAttribute("data_value", new THREE.BufferAttribute(dataValues, 1));
  geometry.setAttribute("latLon", new THREE.BufferAttribute(latLonValues, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();

  logTiming("create Three.js batch geometry", startedAt);
  return geometry;
}

const EPSILON = 0.002; // Small overlap in degrees to avoid z-fighting

function updateGaussianReducedBatch(batch: TGridGeometryBatch) {
  updateOrCreateMesh(
    batch.batchIndex,
    createBatchGeometry(
      batch.positionValues,
      batch.dataValues,
      batch.latLonValues,
      batch.indices
    )
  );
}

function buildGaussianReducedGeometry(
  latitudes: Float64Array,
  longitudes: Float64Array,
  data: Float32Array
) {
  const helper = projectionHelper.value;
  return buildGaussianReducedGrid(
    {
      latitudes,
      longitudes,
      data,
      batchSize: BATCH_SIZE,
      epsilon: EPSILON,
      projectionType: helper.type,
      projectionCenter: { lat: helper.center.lat, lon: helper.center.lon },
    },
    {
      onMetadata: cleanupMeshes,
      onBatch: updateGaussianReducedBatch,
    }
  );
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

async function buildDimensionConfig(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const dimensionNames = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  return buildDimensionRangesAndIndices(
    datavar,
    dimensionNames,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    [datavar.shape.length - 1],
    varinfo.value?.dimRanges
  );
}

function fetchGaussianReducedVariableData(
  selection: (number | null | zarr.Slice)[]
) {
  return getGridVariableData({
    source: ZarrDataManager.getDatasetSource(
      props.datasources!,
      varnameSelector.value
    ),
    variable: varnameSelector.value,
    format: props.datasources!.zarr_format,
    selection,
  });
}

/* eslint-disable-next-line max-lines-per-function */
async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const startedAt = performance.now();
  let blockStartedAt = performance.now();
  const { dimensionRanges, indices } = await buildDimensionConfig(datavar);
  logTiming("build dimension configuration", blockStartedAt);

  blockStartedAt = performance.now();
  const variableData = await fetchGaussianReducedVariableData(indices);
  logTiming("fetch variable data", blockStartedAt);

  blockStartedAt = performance.now();
  const rawData = castDataVarToFloat32(variableData);
  logTiming("cast variable data to Float32", blockStartedAt);

  blockStartedAt = performance.now();
  const { latitudes, longitudes } = await getLatLonData(
    varnameSelector.value,
    datavar,
    props.datasources
  );
  logTiming("fetch latitude/longitude data", blockStartedAt);
  const latitudesData = latitudes.data as Float64Array;
  const longitudesData = longitudes!.data as Float64Array;

  blockStartedAt = performance.now();
  const { min, max, missingValue, fillValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );
  logTiming("decode data and calculate bounds", blockStartedAt);

  blockStartedAt = performance.now();
  const hoverIndexData = await buildGaussianReducedGeometry(
    latitudesData,
    longitudesData,
    rawData
  );
  logTiming("build geometry and hover index in worker", blockStartedAt);

  // Update hover lookup
  blockStartedAt = performance.now();
  setHoverLookupFromIndex(
    createSerializedGeoSampleIndex(hoverIndexData),
    fillValue,
    missingValue
  );
  logTiming("install hover lookup", blockStartedAt);

  // Set projection uniforms on all meshes after grid creation
  updateMeshProjectionUniforms();

  blockStartedAt = performance.now();
  const dimInfo = await getDimensionValues(dimensionRanges, indices);
  logTiming("fetch dimension values", blockStartedAt);

  blockStartedAt = performance.now();
  updateHistogram(rawData, min, max, missingValue, fillValue);
  logTiming("calculate histogram", blockStartedAt);

  blockStartedAt = performance.now();
  store.updateVarInfo(
    {
      attrs: datavar.attrs,
      dimInfo,
      bounds: { low: min, high: max },
      dimRanges: dimensionRanges,
    },
    indices as number[]
  );
  logTiming("update variable information", blockStartedAt);

  blockStartedAt = performance.now();
  redraw();
  logTiming("redraw", blockStartedAt);
  logTiming("fetch and render total", startedAt);
}

onBeforeMount(async () => {
  await datasourceUpdate();
});

onBeforeUnmount(() => {
  terminateGaussianReducedWorker();
  terminateGridDataWorker();
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
