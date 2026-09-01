<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onBeforeUnmount } from "vue";
import type * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useIrregularStreamlines } from "./composables/useIrregularStreamlines.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";
import { showVectorMagnitudeScalarInfo } from "./composables/vectorMagnitudeScalar.ts";

import { getLatLonData } from "@/lib/data/coordinateVariables.ts";
import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import type { TVectorMagnitudeData } from "@/lib/data/vectorMagnitude.ts";
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
let magnitudeCoordinates:
  | { latitudes: Float64Array; longitudes: Float64Array }
  | undefined;

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
  registerAnimationCallback,
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
  updateProjectionMeshes(meshes, {
    redraw,
    projectionHelper: projectionHelper.value,
    isSceneInMotion: isSceneInMotion.value,
  });
}

const colormapMaterial = computed(() => {
  return makeInvertableGpuMeshMaterial(colormap.value, invertColormap.value);
});

const streamlines = useIrregularStreamlines({
  getDatasources: () => props.datasources,
  getPreferredVariable: () => varnameSelector.value,
  getDataVar,
  getScene,
  redraw,
  projectionHelper,
  onProjectionChange,
  registerAnimationCallback,
  showMagnitude,
});

async function showMagnitude(scalar: TVectorMagnitudeData) {
  if (!magnitudeCoordinates) {
    return;
  }
  const hoverIndexData = await buildGaussianReducedGeometry(
    magnitudeCoordinates.latitudes,
    magnitudeCoordinates.longitudes,
    scalar.data
  );
  setHoverLookupFromIndex(
    createSerializedGeoSampleIndex(hoverIndexData),
    NaN,
    NaN
  );
  updateMeshProjectionUniforms();
  updateHistogram(scalar.data, scalar.min, scalar.max);
  showVectorMagnitudeScalarInfo(store, scalar);
  redraw();
}

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  clearHoverLookup,
  updateLandSeaMask,
  updateColormap: () => updateColormap(meshes),
  refreshStreamlines: streamlines.refresh,
  suspendStreamlines: streamlines.suspend,
});

const BATCH_SIZE = 64; // Adjust based on memory and browser limits

function updateOrCreateMesh(
  batchIndex: number,
  geometry: THREE.InstancedBufferGeometry
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
  const geometry = new THREE.InstancedBufferGeometry();

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
  return {
    ...buildDimensionRangesAndIndices(
      datavar,
      dimensionNames,
      paramDimIndices.value,
      paramDimMinBounds.value,
      paramDimMaxBounds.value,
      dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
      [datavar.shape.length - 1],
      varinfo.value?.dimRanges
    ),
    dimensionNames,
  };
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

// eslint-disable-next-line max-lines-per-function
async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const { dimensionRanges, indices, dimensionNames } =
    await buildDimensionConfig(datavar);

  const variableData = await fetchGaussianReducedVariableData(indices);

  const rawData = castDataVarToFloat32(variableData);

  const { latitudes, longitudes } = await getLatLonData(
    varnameSelector.value,
    datavar,
    props.datasources
  );
  const latitudesData = latitudes.data as Float64Array;
  const longitudesData = longitudes!.data as Float64Array;
  magnitudeCoordinates = {
    latitudes: latitudesData,
    longitudes: longitudesData,
  };

  const { min, max, missingValue, fillValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );

  const hoverIndexData = await buildGaussianReducedGeometry(
    latitudesData,
    longitudesData,
    rawData
  );

  // Update hover lookup
  setHoverLookupFromIndex(
    createSerializedGeoSampleIndex(hoverIndexData),
    fillValue,
    missingValue
  );

  // Set projection uniforms on all meshes after grid creation
  updateMeshProjectionUniforms();

  const dimInfo = await getDimensionValues(dimensionRanges, indices);

  updateHistogram(rawData, min, max, missingValue, fillValue);

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
  void streamlines.setContext({
    latitudes: Float32Array.from(latitudesData),
    longitudes: Float32Array.from(longitudesData),
    dimensionNames,
    indices,
    spatialDimensionNames: [dimensionNames.at(-1)!],
  });
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
