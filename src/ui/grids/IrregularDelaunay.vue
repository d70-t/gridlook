<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onBeforeUnmount } from "vue";
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
import type {
  TGridDataValueBatch,
  TGridPointBatch,
} from "@/lib/grids/gridWorkerTypes.ts";
import {
  buildIrregularDelaunayGrid,
  terminateIrregularDelaunayWorker,
} from "@/lib/grids/irregularDelaunayWorkerClient.ts";
import { createSerializedGeoSampleIndex } from "@/lib/grids/serializedGeoSampleIndex.ts";
import {
  createWrappedProjectionMesh,
  updateProjectionMeshes,
} from "@/lib/projection/projectionEdgeQuality.ts";
import { makeInvertableGpuMeshMaterial } from "@/lib/shaders/gridShaders.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{ datasources?: TSources }>();

const store = useGlobeControlStore();
const { dimSlidersValues, colormap, varnameSelector, invertColormap, varinfo } =
  storeToRefs(store);
const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const BATCH_SIZE = 1000000;
let meshes: THREE.Mesh[] = [];

const {
  getScene,
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
  redraw,
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

const colormapMaterial = computed(() =>
  makeInvertableGpuMeshMaterial(colormap.value, invertColormap.value)
);

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  clearHoverLookup,
  updateLandSeaMask,
  updateColormap: () => updateColormap(meshes),
});

function cleanupMeshes() {
  for (const mesh of meshes) {
    getScene()?.remove(mesh);
    mesh.geometry.dispose();
  }
  meshes.length = 0;
}

function updateGeometryBatch(batch: TGridPointBatch) {
  const geometry = new THREE.InstancedBufferGeometry();
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
  const mesh = createWrappedProjectionMesh(
    geometry,
    colormapMaterial.value,
    projectionHelper.value.type
  );
  mesh.frustumCulled = false;
  meshes[batch.batchIndex] = mesh;
  getScene()?.add(mesh);
}

function updateDataBatch(batch: TGridDataValueBatch) {
  const mesh = meshes[batch.batchIndex];
  if (!mesh) {
    throw new Error(`Missing Delaunay mesh batch ${batch.batchIndex}.`);
  }
  const dataAttribute = mesh.geometry.getAttribute("data_value");
  if (dataAttribute.count !== batch.dataValues.length) {
    throw new Error(`Delaunay mesh batch ${batch.batchIndex} size changed.`);
  }
  dataAttribute.array.set(batch.dataValues);
  dataAttribute.needsUpdate = true;
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

function fetchVariableData(selection: (number | null | zarr.Slice)[]) {
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
  const rawData = castDataVarToFloat32(await fetchVariableData(indices));
  const { min, max, fillValue, missingValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );
  const result = await buildIrregularDelaunayGrid(
    {
      latitudes: latitudes.data as Float32Array,
      longitudes: longitudes.data as Float32Array,
      latitudeShape: [...latitudes.shape],
      longitudeShape: [...longitudes.shape],
      data: rawData,
      batchSize: BATCH_SIZE,
      forceGeometryRebuild: meshes.length === 0,
    },
    {
      onMetadata: (metadata) => {
        if (metadata.rebuildGeometry) {
          cleanupMeshes();
        }
      },
      onBatch: (batch) => {
        if ("positionValues" in batch) {
          updateGeometryBatch(batch);
        } else {
          updateDataBatch(batch);
        }
      },
    }
  );
  updateMeshProjectionUniforms();
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
});

onBeforeUnmount(() => {
  terminateIrregularDelaunayWorker();
  terminateGridDataWorker();
});

defineExpose({ makeSnapshot, toggleRotate, applyCameraPreset });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
