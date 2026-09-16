<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onBeforeUnmount } from "vue";
import * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useIrregularStreamlines } from "./composables/useIrregularStreamlines.ts";
import { useScalarFieldCache } from "./composables/useScalarFieldCache.ts";
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
import type { TVectorMagnitudeData } from "@/lib/data/vectorMagnitude.ts";
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
let magnitudeContext:
  | {
      datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>;
      dimensionNames: string[];
    }
  | undefined;

const {
  getScene,
  redraw,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  fitCameraToDataset,
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
  const material = makeInvertableGpuMeshMaterial(
    colormap.value,
    invertColormap.value
  );
  material.uniforms.useTriangleWrapCull.value = 1;
  return material;
});

const scalarCache = useScalarFieldCache({
  updateHistogram,
  updateColormap: () => updateColormap(meshes),
  redraw,
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
  restoreScalar: scalarCache.restoreScalar,
});

async function showMagnitude(scalar: TVectorMagnitudeData) {
  const context = magnitudeContext;
  if (!context) {
    return;
  }
  await scalarCache.showMagnitude(scalar, async () => {
    const { hoverIndexData, render } = await buildGridInWorker(
      context.datavar,
      scalar.data,
      context.dimensionNames,
      NaN,
      NaN,
      true
    );
    const hoverIndex = createSerializedGeoSampleIndex(hoverIndexData);
    return () => {
      render();
      setHoverLookupFromIndex(hoverIndex, NaN, NaN);
    };
  });
}

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  scalarCache,
  clearHoverLookup,
  updateLandSeaMask,
  updateColormap: () => updateColormap(meshes),
  refreshStreamlines: streamlines.refresh,
  suspendStreamlines: streamlines.suspend,
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

// eslint-disable-next-line max-lines-per-function
async function buildGridInWorker(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  rawData: Float32Array,
  dimensionNames: string[],
  missingValue: number,
  fillValue: number,
  deferDisplay = false,
  isCurrent = () => true
) {
  const { latitudes, longitudes } = await getCurvilinearCoordinates(
    datavar,
    dimensionNames
  );
  const latitudesData = latitudes.data as Float32Array;
  const longitudesData = longitudes!.data as Float32Array;
  const [nj, ni] = latitudes.shape;
  const helper = projectionHelper.value;
  const batches: TGridGeometryBatch[] = [];
  const result = await buildCurvilinearGrid(
    {
      latitudes: latitudesData,
      longitudes: longitudesData,
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
      onMetadata: ({ totalBatches }) => {
        if (!deferDisplay && isCurrent()) {
          cleanupMeshes(totalBatches);
        }
      },
      onBatch: (batch) => {
        batches.push(batch);
        if (!deferDisplay && isCurrent()) {
          updateBatchMesh(batch);
        }
      },
    }
  );
  return {
    render: () => {
      cleanupMeshes(batches.length);
      batches.forEach(updateBatchMesh);
      updateMeshProjectionUniforms();
    },
    hoverIndexData: result.hoverIndexData,
    latitudesData,
    longitudesData,
  };
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
      [datavar.shape.length - 2, datavar.shape.length - 1],
      varinfo.value?.dimRanges
    ),
    dimensionNames,
  };
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

function updateStreamlines(
  latitudes: Float32Array,
  longitudes: Float32Array,
  dimensionNames: string[],
  indices: (number | null | zarr.Slice)[]
) {
  return streamlines.setContext({
    latitudes,
    longitudes,
    dimensionNames,
    indices,
    spatialDimensionNames: dimensionNames.slice(-2),
  });
}

// eslint-disable-next-line max-lines-per-function
async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  isCurrent: () => boolean
) {
  const deferDisplay = store.isStreamlineLayerEnabled();
  const { dimensionNames, dimensionRanges, indices } =
    await buildDimensionConfig(datavar);
  magnitudeContext = { datavar, dimensionNames };

  const rawData = castDataVarToFloat32(
    await fetchCurvilinearVariableData(indices)
  );
  if (!isCurrent()) {
    return;
  }
  const { min, max, missingValue, fillValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );
  const { hoverIndexData, latitudesData, longitudesData, render } =
    await buildGridInWorker(
      datavar,
      rawData,
      dimensionNames,
      missingValue,
      fillValue,
      deferDisplay,
      isCurrent
    );
  const hoverIndex = createSerializedGeoSampleIndex(hoverIndexData);

  if (!isCurrent()) {
    return;
  }
  const dimInfo = await getDimensionValues(dimensionRanges, indices);
  const scalarInfo = {
    attrs: datavar.attrs,
    dimInfo,
    bounds: { low: min, high: max },
    dimRanges: dimensionRanges,
  };
  const renderScalar = () => {
    render();
    fitCameraToDataset(meshes);
    setHoverLookupFromIndex(hoverIndex, fillValue, missingValue);
  };
  if (!isCurrent()) {
    return;
  }
  scalarCache.captureScalar({
    render: renderScalar,
    info: scalarInfo,
    indices: indices as number[],
    data: rawData,
    missingValue,
    fillValue,
    isCurrent,
  });
  await updateStreamlines(
    latitudesData,
    longitudesData,
    dimensionNames,
    indices
  );
  if (isCurrent() && !store.streamlineMagnitudeDisplayed) {
    await scalarCache.restoreScalar();
  }
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
