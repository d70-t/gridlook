<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onBeforeUnmount, ref } from "vue";
import * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import {
  fetchScalarFrameData,
  getScalarFrameDimensions,
  type TPreparedScalarFrame,
  type TScalarFrameRequest,
} from "./composables/scalarFrame.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useIrregularStreamlines } from "./composables/useIrregularStreamlines.ts";
import { useScalarFieldCache } from "./composables/useScalarFieldCache.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { getLatLonData } from "@/lib/data/coordinateVariables.ts";
import { reconcileCoordinates } from "@/lib/data/irregularGridHelpers.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import type { TVectorMagnitudeData } from "@/lib/data/vectorMagnitude.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { terminateGridDataWorker } from "@/lib/grids/gridDataWorkerClient.ts";
import type { TGridPointBatch } from "@/lib/grids/gridWorkerTypes.ts";
import {
  buildIrregularGrid,
  terminateIrregularWorker,
} from "@/lib/grids/irregularWorkerClient.ts";
import { createSerializedGeoSampleIndex } from "@/lib/grids/serializedGeoSampleIndex.ts";
import {
  makeGpuProjectedPointMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();
const { colormap, varnameSelector, invertColormap } = storeToRefs(store);

const estimatedSpacing = ref(0);
const BATCH_SIZE = 500000;
let points: THREE.Points[] = [];
let magnitudeCoordinates:
  | {
      latitudes: Float32Array;
      longitudes: Float32Array;
      latitudeShape: number[];
      longitudeShape: number[];
    }
  | undefined;

const {
  getScene,
  getCamera,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  fitCameraToDataset,
  getDataVar,
  fetchDimensionDetails,
  registerUpdateLOD,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
  onProjectionChange,
  onColormapChange,
  registerAnimationCallback,
  redraw,
  canvas,
  box,
  updateHistogram,
  hoveredGeoPoint,
} = useSharedGridLogic();

const { setHoverLookupFromIndex, clearHoverLookup } =
  useGridHoverLookup(hoveredGeoPoint);

onColormapChange(() => updateColormap(points));
onProjectionChange(updatePointsProjectionUniforms);

function updatePointsProjectionUniforms() {
  const helper = projectionHelper.value;
  for (const pointBatch of points) {
    const material = pointBatch.material as THREE.ShaderMaterial;
    if (material.uniforms?.projectionType) {
      updateProjectionUniforms(material, helper);
    }
  }
  redraw();
}

const colormapMaterial = computed(() => {
  return invertColormap.value
    ? makeGpuProjectedPointMaterial(colormap.value, 1.0, -1.0)
    : makeGpuProjectedPointMaterial(colormap.value, 0.0, 1.0);
});

const scalarCache = useScalarFieldCache({
  updateHistogram,
  updateColormap: () => updateColormap(points),
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
    const helper = projectionHelper.value;
    const batches: TGridPointBatch[] = [];
    const result = await buildIrregularGrid(
      {
        ...coordinates,
        data: scalar.data,
        batchSize: BATCH_SIZE,
        projectionType: helper.type,
        projectionCenter: { lat: helper.center.lat, lon: helper.center.lon },
      },
      {
        onMetadata: () => undefined,
        onBatch: (batch) => batches.push(batch),
      }
    );
    const hoverIndex = createSerializedGeoSampleIndex(result.hoverIndexData);
    return () => {
      cleanupPoints(batches.length);
      batches.forEach(updateBatch);
      updatePointsProjectionUniforms();
      updateLOD();
      setHoverLookupFromIndex(hoverIndex, NaN, NaN);
    };
  });
}

const { datasourceUpdate, prepareScalarFrame, commitScalarFrame } =
  useGridDataLoader({
    getDatasources: () => props.datasources,
    getDataVar,
    prepareFrame,
    scalarCache,
    clearHoverLookup,
    updateLandSeaMask,
    updateColormap: () => updateColormap(points),
    refreshStreamlines: streamlines.refresh,
    suspendStreamlines: streamlines.suspend,
  });

function cleanupPoints(totalBatches: number) {
  if (points.length <= totalBatches) {
    return;
  }
  for (const pointBatch of points) {
    pointBatch.geometry.dispose();
    getScene()?.remove(pointBatch);
  }
  points.length = 0;
}

function updateBatch(batch: TGridPointBatch) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(batch.positionValues, 3)
  );
  geometry.setAttribute(
    "latLon",
    new THREE.BufferAttribute(batch.latLonValues, 2)
  );
  geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(batch.dataValues, 1)
  );
  geometry.computeBoundingSphere();
  if (points[batch.batchIndex]) {
    points[batch.batchIndex].geometry.dispose();
    points[batch.batchIndex].geometry = geometry;
    return;
  }
  const pointBatch = new THREE.Points(geometry, colormapMaterial.value);
  pointBatch.frustumCulled = false;
  points.push(pointBatch);
  getScene()?.add(pointBatch);
}

function updateLOD() {
  const camera = getCamera();
  if (!camera) {
    return;
  }
  const zoomFactor = 1 / camera.position.length();
  const normalizedSpacing = Math.max(
    0.2,
    Math.min(1.0, (Math.log10(estimatedSpacing.value) + 4) / 3)
  );
  const basePointSize =
    estimatedSpacing.value *
    window.innerHeight *
    zoomFactor *
    normalizedSpacing *
    400;
  const minPointSize = Math.max(0.8, 3.0 * zoomFactor * normalizedSpacing);
  const maxPointSize = Math.min(25.0, 80.0 * zoomFactor * normalizedSpacing);
  for (const pointBatch of points) {
    const material = pointBatch.material as THREE.ShaderMaterial;
    material.uniforms.basePointSize.value = basePointSize;
    material.uniforms.minPointSize.value = minPointSize;
    material.uniforms.maxPointSize.value = maxPointSize;
  }
}

function getGeographicDimensionIndices(
  dimensions: string[],
  latitudesAttrs: zarr.Attributes,
  longitudesAttrs: zarr.Attributes
) {
  const geographicDimensions: number[] = [];
  for (let index = 0; index < dimensions.length; index++) {
    const latitudeDimensions = latitudesAttrs.dimensionNames as string[];
    const longitudeDimensions = longitudesAttrs.dimensionNames as string[];
    if (
      latitudeDimensions.includes(dimensions[index]) ||
      longitudeDimensions.includes(dimensions[index])
    ) {
      geographicDimensions.push(index);
    }
  }
  return geographicDimensions;
}

async function buildDimensionConfig(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  request: TScalarFrameRequest
) {
  const { latitudes, longitudes, latitudesAttrs, longitudesAttrs } =
    await getLatLonData(request.variable, datavar, request.datasources);
  const dimensions = await ZarrDataManager.getDimensionNames(
    request.datasources,
    request.variable
  );
  const geographicDimensions = getGeographicDimensionIndices(
    dimensions,
    latitudesAttrs,
    longitudesAttrs!
  );
  const config = getScalarFrameDimensions(
    datavar,
    dimensions,
    geographicDimensions,
    request
  );
  return {
    latitudes,
    longitudes: longitudes!,
    dimensions,
    geographicDimensions,
    ...config,
  };
}

async function getDimensionValues(
  request: TScalarFrameRequest,
  dimensionRanges: TDimensionRange[],
  indices: (number | zarr.Slice | null)[]
) {
  return await fetchDimensionDetails(
    request.variable,
    request.datasources,
    dimensionRanges,
    indices
  );
}

/* eslint-disable-next-line max-lines-per-function */
async function prepareFrame(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  request: TScalarFrameRequest
): Promise<TPreparedScalarFrame | undefined> {
  const { isCurrent } = request;
  const {
    latitudes,
    longitudes,
    dimensionRanges,
    indices,
    dimensions,
    geographicDimensions,
  } = await buildDimensionConfig(datavar, request);
  const rawData = castDataVarToFloat32(
    await fetchScalarFrameData(request, indices)
  );
  if (!isCurrent()) {
    return;
  }
  const { min, max, fillValue, missingValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );
  const helper = projectionHelper.value;
  const batches: TGridPointBatch[] = [];
  let spacing = estimatedSpacing.value;
  const result = await buildIrregularGrid(
    {
      latitudes: latitudes.data as Float32Array,
      longitudes: longitudes.data as Float32Array,
      latitudeShape: [...latitudes.shape],
      longitudeShape: [...longitudes.shape],
      data: rawData,
      batchSize: BATCH_SIZE,
      projectionType: helper.type,
      projectionCenter: { lat: helper.center.lat, lon: helper.center.lon },
    },
    {
      onMetadata: (metadata) => {
        spacing = metadata.estimatedSpacing;
      },
      onBatch: (batch) => {
        batches.push(batch);
      },
    }
  );

  const hoverIndex = createSerializedGeoSampleIndex(result.hoverIndexData);

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
  const coordinates = reconcileCoordinates(
    latitudes,
    longitudes,
    rawData.length
  );
  const renderScalar = () => {
    cleanupPoints(batches.length);
    batches.forEach(updateBatch);
    estimatedSpacing.value = spacing;
    updatePointsProjectionUniforms();
    fitCameraToDataset(points);
    updateLOD();
    setHoverLookupFromIndex(hoverIndex, fillValue, missingValue);
  };
  if (!isCurrent()) {
    return;
  }
  return {
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
        latitudes: latitudes.data as Float32Array,
        longitudes: longitudes.data as Float32Array,
        latitudeShape: [...latitudes.shape],
        longitudeShape: [...longitudes.shape],
      };

      await streamlines.setContext({
        ...coordinates,
        dimensionNames: dimensions,
        indices,
        spatialDimensionNames: geographicDimensions.map(
          (index) => dimensions[index]
        ),
      });
    },
  };
}

onBeforeMount(async () => {
  await datasourceUpdate();
  registerUpdateLOD(updateLOD);
});

onBeforeUnmount(() => {
  terminateIrregularWorker();
  terminateGridDataWorker();
});

defineExpose({
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  prepareScalarFrame,
  commitScalarFrame,
});
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
