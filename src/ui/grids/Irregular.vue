<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onBeforeUnmount, ref } from "vue";
import * as zarr from "zarrita";

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
  getGridVariableData,
  terminateGridDataWorker,
} from "@/lib/grids/gridDataWorkerClient.ts";
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

const estimatedSpacing = ref(0);
const BATCH_SIZE = 500000;
let points: THREE.Points[] = [];

const {
  getScene,
  getCamera,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  getDataVar,
  fetchDimensionDetails,
  registerUpdateLOD,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
  onProjectionChange,
  onColormapChange,
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

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  clearHoverLookup,
  updateLandSeaMask,
  updateColormap: () => updateColormap(points),
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
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const { latitudes, longitudes, latitudesAttrs, longitudesAttrs } =
    await getLatLonData(varnameSelector.value, datavar, props.datasources);
  const dimensions = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  const geographicDimensions = getGeographicDimensionIndices(
    dimensions,
    latitudesAttrs,
    longitudesAttrs!
  );
  const config = buildDimensionRangesAndIndices(
    datavar,
    dimensions,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    geographicDimensions,
    varinfo.value?.dimRanges
  );
  return { latitudes, longitudes: longitudes!, ...config };
}

function fetchIrregularVariableData(selection: (number | null | zarr.Slice)[]) {
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

/* eslint-disable-next-line max-lines-per-function */
async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const { latitudes, longitudes, dimensionRanges, indices } =
    await buildDimensionConfig(datavar);
  const rawData = castDataVarToFloat32(
    await fetchIrregularVariableData(indices)
  );
  const { min, max, fillValue, missingValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );
  const helper = projectionHelper.value;
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
        cleanupPoints(metadata.totalBatches);
        estimatedSpacing.value = metadata.estimatedSpacing;
      },
      onBatch: updateBatch,
    }
  );
  updatePointsProjectionUniforms();
  updateLOD();
  setHoverLookupFromIndex(
    createSerializedGeoSampleIndex(result.hoverIndexData),
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
}

onBeforeMount(async () => {
  await datasourceUpdate();
  registerUpdateLOD(updateLOD);
});

onBeforeUnmount(() => {
  terminateIrregularWorker();
  terminateGridDataWorker();
});

defineExpose({ makeSnapshot, toggleRotate, applyCameraPreset });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
