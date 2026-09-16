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

import { getLatLonData } from "@/lib/data/coordinateVariables.ts";
import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import { reconcileCoordinates } from "@/lib/data/irregularGridHelpers.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import type { TVectorMagnitudeData } from "@/lib/data/vectorMagnitude.ts";
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
    const batches: TGridDataValueBatch[] = [];
    const result = await buildIrregularDelaunayGrid(
      {
        ...coordinates,
        data: scalar.data,
        batchSize: BATCH_SIZE,
        forceGeometryRebuild: false,
      },
      {
        onMetadata: () => undefined,
        onBatch: (batch) => {
          if (!("positionValues" in batch)) {
            batches.push(batch);
          }
        },
      }
    );
    const hoverIndex = createSerializedGeoSampleIndex(result.hoverIndexData);
    return () => {
      batches.forEach(updateDataBatch);
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
  // Keep the cached batch immutable when later displays update this attribute.
  geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(batch.dataValues.slice(), 1)
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
  return {
    latitudes,
    longitudes: longitudes!,
    dimensions,
    geographicDimensions,
    ...config,
  };
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
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  isCurrent: () => boolean
) {
  const deferDisplay = store.isStreamlineLayerEnabled();
  const {
    latitudes,
    longitudes,
    dimensionRanges,
    indices,
    dimensions,
    geographicDimensions,
  } = await buildDimensionConfig(datavar);

  const rawData = castDataVarToFloat32(await fetchVariableData(indices));
  if (!isCurrent()) {
    return;
  }
  const { min, max, fillValue, missingValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );
  const batches: (TGridDataValueBatch | TGridPointBatch)[] = [];
  let geometryPending = false;
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
        geometryPending = metadata.rebuildGeometry && deferDisplay;
        if (metadata.rebuildGeometry && !deferDisplay && isCurrent()) {
          cleanupMeshes();
        }
      },
      onBatch: (batch) => {
        batches.push(batch);
        if (deferDisplay || !isCurrent()) {
          return;
        }
        if ("positionValues" in batch) {
          updateGeometryBatch(batch);
        } else {
          updateDataBatch(batch);
        }
      },
    }
  );
  magnitudeCoordinates = {
    latitudes: latitudes.data as Float32Array,
    longitudes: longitudes.data as Float32Array,
    latitudeShape: [...latitudes.shape],
    longitudeShape: [...longitudes.shape],
  };
  const hoverIndex = createSerializedGeoSampleIndex(result.hoverIndexData);

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
  const coordinates = reconcileCoordinates(
    latitudes,
    longitudes,
    rawData.length
  );
  const renderScalar = () => {
    if (geometryPending) {
      cleanupMeshes();
    }
    for (const batch of batches) {
      if (geometryPending && "positionValues" in batch) {
        updateGeometryBatch(batch);
      } else {
        updateDataBatch(batch);
      }
    }
    geometryPending = false;
    updateMeshProjectionUniforms();
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
  await streamlines.setContext({
    ...coordinates,
    dimensionNames: dimensions,
    indices,
    spatialDimensionNames: geographicDimensions.map(
      (index) => dimensions[index]
    ),
  });
  if (isCurrent() && !store.streamlineMagnitudeDisplayed) {
    await scalarCache.restoreScalar();
  }
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
