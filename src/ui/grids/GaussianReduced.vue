<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onBeforeUnmount } from "vue";
import type * as zarr from "zarrita";

import {
  createSampleIndexLookup,
  useGridHoverLookup,
} from "./composables/gridHoverUtils.ts";
import {
  fetchScalarFrameData,
  getScalarFrameDimensions,
  type TPreparedScalarFrame,
  type TScalarFrameRequest,
} from "./composables/scalarFrame.ts";
import {
  scalarFrameMemory,
  shareScalarBuffers,
  shareScalarGeometry,
} from "./composables/scalarFrameMemory.ts";
import {
  captureScalarGeometry,
  updateScalarGeometry,
} from "./composables/scalarGeometry.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useIrregularStreamlines } from "./composables/useIrregularStreamlines.ts";
import { useScalarFieldCache } from "./composables/useScalarFieldCache.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { getLatLonData } from "@/lib/data/coordinateVariables.ts";
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
import { terminateGridDataWorker } from "@/lib/grids/gridDataWorkerClient.ts";
import type { TGridGeometryBatch } from "@/lib/grids/gridWorkerTypes.ts";
import { createSerializedGeoSampleIndex } from "@/lib/grids/serializedGeoSampleIndex.ts";
import {
  createWrappedProjectionMesh,
  setupProjectionGeometryWrap,
  updateProjectionMeshes,
} from "@/lib/projection/projectionEdgeQuality.ts";
import { makeInvertableGpuMeshMaterial } from "@/lib/shaders/gridShaders.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();

const { colormap, varnameSelector, invertColormap } = storeToRefs(store);

let meshes: THREE.Mesh[] = [];
let magnitudeCoordinates:
  { latitudes: Float64Array; longitudes: Float64Array } | undefined;

const {
  getScene,
  redraw,
  makeSnapshot,
  createSnapshotRenderer,
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

const { setHoverLookup, setHoverLookupFromIndex, clearHoverLookup } =
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
  const coordinates = magnitudeCoordinates;
  if (!coordinates) {
    return;
  }
  await scalarCache.showMagnitude(scalar, async () => {
    const { hoverIndexData, render } = await buildGaussianReducedGeometry(
      coordinates.latitudes,
      coordinates.longitudes,
      scalar.data
    );
    const hoverIndex = createSerializedGeoSampleIndex(hoverIndexData);
    return () => {
      render();
      setHoverLookupFromIndex(hoverIndex, NaN, NaN);
    };
  });
}

const {
  datasourceUpdate,
  prepareScalarFrame,
  commitScalarFrame,
  getScalarFrameLayout,
} = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  prepareFrame,
  getScalarObjects: () => meshes,
  setHoverLookup,
  scalarCache,
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
  if (updateScalarGeometry(meshes[batch.batchIndex]?.geometry, batch)) {
    return;
  }
  updateOrCreateMesh(
    batch.batchIndex,
    captureScalarGeometry(
      createBatchGeometry(
        batch.positionValues,
        batch.dataValues,
        batch.latLonValues,
        batch.indices
      ),
      batch
    )
  );
}

async function buildGaussianReducedGeometry(
  latitudes: Float64Array,
  longitudes: Float64Array,
  data: Float32Array,
  request?: TScalarFrameRequest
) {
  const helper = projectionHelper.value;
  const batches: TGridGeometryBatch[] = [];
  const hoverIndexData = await buildGaussianReducedGrid(
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
      onMetadata: () => undefined,
      onBatch: (batch) => {
        batches.push(shareScalarGeometry(batch, request?.geometryCache));
      },
    }
  );
  return {
    hoverIndexData,
    batches,
    render: () => {
      cleanupMeshes(batches.length);
      batches.forEach(updateGaussianReducedBatch);
      updateMeshProjectionUniforms();
    },
  };
}

async function getDimensionValues(
  request: TScalarFrameRequest,
  dimensionRanges: TDimensionRange[],
  indices: (number | zarr.Slice | null)[]
) {
  const dimValues = await fetchDimensionDetails(
    request.variable,
    request.datasources,
    dimensionRanges,
    indices
  );
  return dimValues;
}

async function buildDimensionConfig(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  request: TScalarFrameRequest
) {
  const dimensionNames = await ZarrDataManager.getDimensionNames(
    request.datasources,
    request.variable
  );
  return {
    ...getScalarFrameDimensions(
      datavar,
      dimensionNames,
      [datavar.shape.length - 1],
      request
    ),
    dimensionNames,
  };
}

// eslint-disable-next-line max-lines-per-function
async function prepareFrame(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  request: TScalarFrameRequest
): Promise<TPreparedScalarFrame | undefined> {
  const { isCurrent } = request;
  const { dimensionRanges, indices, dimensionNames } =
    await buildDimensionConfig(datavar, request);

  const variableData = await fetchScalarFrameData(request, indices);

  const rawData = castDataVarToFloat32(variableData);

  const { latitudes, longitudes } = await getLatLonData(
    request.variable,
    datavar,
    request.datasources
  );
  const { latitudesData, longitudesData } = shareScalarBuffers(
    "coordinates",
    {
      latitudesData: latitudes.data as Float64Array,
      longitudesData: longitudes!.data as Float64Array,
    },
    request.geometryCache
  );

  if (!isCurrent()) {
    return;
  }
  const { min, max, missingValue, fillValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );

  const { hoverIndexData, render, batches } =
    await buildGaussianReducedGeometry(
      latitudesData,
      longitudesData,
      rawData,
      request
    );

  shareScalarBuffers("hover", hoverIndexData, request.geometryCache);
  const hoverIndex = createSerializedGeoSampleIndex(hoverIndexData);

  if (!isCurrent()) {
    return;
  }
  const dimInfo = await getDimensionValues(request, dimensionRanges, indices);

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
  return {
    memory: scalarFrameMemory(
      batches,
      rawData,
      hoverIndexData,
      latitudesData,
      longitudesData,
      scalarInfo
    ),
    interpolation: {
      values: batches.map((batch) => batch.dataValues),
      geometry: batches.flatMap((batch) => [
        batch.positionValues,
        batch.latLonValues,
        batch.indices,
      ]),
      indices: batches.map((batch) => batch.indices),
      sample: createSampleIndexLookup(hoverIndex, fillValue, missingValue),
    },
    name: request.variable,
    render: renderScalar,
    info: scalarInfo,
    indices: indices as number[],
    data: rawData,
    missingValue,
    fillValue,
    isCurrent,
    updateLayers: async () => {
      magnitudeCoordinates = {
        latitudes: latitudesData,
        longitudes: longitudesData,
      };

      await streamlines.setContext({
        latitudes: Float32Array.from(latitudesData),
        longitudes: Float32Array.from(longitudesData),
        dimensionNames,
        indices,
        spatialDimensionNames: [dimensionNames.at(-1)!],
      });
    },
  };
}

onBeforeMount(async () => {
  await datasourceUpdate();
});

onBeforeUnmount(() => {
  terminateGaussianReducedWorker();
  terminateGridDataWorker();
});

defineExpose({
  prepareScalarFrame,
  commitScalarFrame,
  getScalarFrameLayout,
  makeSnapshot,
  createSnapshotRenderer,
  toggleRotate,
  applyCameraPreset,
});
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
