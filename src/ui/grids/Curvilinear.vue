<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onBeforeUnmount } from "vue";
import * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import {
  getLatLonData,
  getProjectedXYLonLatData,
  isProjectedXName,
  isProjectedYName,
} from "@/lib/data/coordinateVariables.ts";
import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  buildCurvilinearGrid,
  terminateCurvilinearWorker,
} from "@/lib/grids/curvilinearWorkerClient.ts";
import {
  getGridVariableData,
  terminateGridDataWorker,
} from "@/lib/grids/gridDataWorkerClient.ts";
import type { TGridGeometryBatch } from "@/lib/grids/gridWorkerTypes.ts";
import { createSerializedGeoSampleIndex } from "@/lib/grids/serializedGeoSampleIndex.ts";
import {
  createTriangleWrapProjectionGeometry,
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
  updateProjectionMeshes(meshes, {
    redraw,
    projectionHelper: projectionHelper.value,
    isSceneInMotion: isSceneInMotion.value,
  });
}

const colormapMaterial = computed(() => {
  const material = makeInvertableGpuMeshMaterial(
    colormap.value,
    invertColormap.value
  );
  material.uniforms.useTriangleWrapCull.value = 1;
  return material;
});

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  clearHoverLookup,
  updateLandSeaMask,
  updateColormap: () => updateColormap(meshes),
});

const BATCH_SIZE = 30;

function hasTrailingProjectedXYDimensions(dimensionNames: string[]) {
  if (dimensionNames.length < 2) {
    return false;
  }
  const lastDimension = dimensionNames[dimensionNames.length - 1];
  const secondLastDimension = dimensionNames[dimensionNames.length - 2];
  return (
    isProjectedXName(lastDimension) && isProjectedYName(secondLastDimension)
  );
}

async function getCurvilinearCoordinates(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  dimensionNames: string[]
) {
  try {
    return await getLatLonData(
      varnameSelector.value,
      datavar,
      props.datasources
    );
  } catch (error) {
    if (hasTrailingProjectedXYDimensions(dimensionNames)) {
      return await getProjectedXYLonLatData(
        varnameSelector.value,
        datavar,
        props.datasources,
        dimensionNames
      );
    }
    throw error;
  }
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

function createBatchGeometry(batch: TGridGeometryBatch) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(batch.positionValues, 3)
  );
  geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(batch.dataValues, 1)
  );
  geometry.setAttribute(
    "latLon",
    new THREE.BufferAttribute(batch.latLonValues, 2)
  );
  geometry.setIndex(new THREE.BufferAttribute(batch.indices, 1));
  return createTriangleWrapProjectionGeometry(geometry);
}

function updateBatchMesh(batch: TGridGeometryBatch) {
  const geometry = createBatchGeometry(batch);
  setupProjectionGeometryWrap(geometry);
  if (meshes[batch.batchIndex]) {
    meshes[batch.batchIndex].geometry.dispose();
    meshes[batch.batchIndex].geometry = geometry;
    return;
  }
  const mesh = createWrappedProjectionMesh(
    geometry,
    colormapMaterial.value,
    projectionHelper.value.type
  );
  mesh.frustumCulled = false;
  meshes.push(mesh);
  getScene()?.add(mesh);
}

async function buildGridInWorker(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  rawData: Float32Array,
  dimensionNames: string[],
  missingValue: number,
  fillValue: number
) {
  const { latitudes, longitudes } = await getCurvilinearCoordinates(
    datavar,
    dimensionNames
  );
  const [nj, ni] = latitudes.shape;
  const helper = projectionHelper.value;
  const result = await buildCurvilinearGrid(
    {
      latitudes: latitudes.data as Float32Array,
      longitudes: longitudes!.data as Float32Array,
      data: rawData,
      nj,
      ni,
      batchSize: BATCH_SIZE,
      missingValue,
      fillValue,
      projectionType: helper.type,
      projectionCenter: { lat: helper.center.lat, lon: helper.center.lon },
    },
    {
      onMetadata: ({ totalBatches }) => cleanupMeshes(totalBatches),
      onBatch: updateBatchMesh,
    }
  );
  updateMeshProjectionUniforms();
  return result.hoverIndexData;
}

async function getDimensionValues(
  dimensionRanges: TDimensionRange[],
  indices: (number | zarr.Slice | null)[]
) {
  return await fetchDimensionDetails(
    varnameSelector.value,
    props.datasources!,
    dimensionRanges,
    indices
  );
}

function fetchCurvilinearVariableData(
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

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
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
    varinfo.value?.dimRanges
  );

  const rawData = castDataVarToFloat32(
    await fetchCurvilinearVariableData(indices)
  );
  const { min, max, missingValue, fillValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );
  const hoverIndexData = await buildGridInWorker(
    datavar,
    rawData,
    dimensionNames,
    missingValue,
    fillValue
  );
  setHoverLookupFromIndex(
    createSerializedGeoSampleIndex(hoverIndexData),
    fillValue,
    missingValue
  );

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
}

onBeforeMount(async () => {
  await datasourceUpdate();
});

onBeforeUnmount(() => {
  terminateCurvilinearWorker();
  terminateGridDataWorker();
});

defineExpose({ makeSnapshot, toggleRotate, applyCameraPreset });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
