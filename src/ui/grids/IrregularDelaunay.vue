<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onBeforeUnmount } from "vue";
import * as zarr from "zarrita";

import {
  createSampleIndexLookup,
  useGridHoverLookup,
} from "./composables/gridHoverUtils.ts";
import {
  fetchScalarFrameData,
  decodeScalarFrameData,
  getScalarFrameDimensions,
  type TPreparedScalarFrame,
  type TScalarFrameRequest,
} from "./composables/scalarFrame.ts";
import {
  scalarFrameMemory,
  shareScalarBuffers,
  shareScalarGeometry,
} from "./composables/scalarFrameMemory.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useIrregularStreamlines } from "./composables/useIrregularStreamlines.ts";
import { useScalarFieldCache } from "./composables/useScalarFieldCache.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { getLatLonData } from "@/lib/data/coordinateVariables.ts";
import { reconcileCoordinates } from "@/lib/data/irregularGridHelpers.ts";
import { PATHLINE_GRID } from "@/lib/data/pathlineField.ts";
import { castDataVarToFloat32 } from "@/lib/data/variableDecoding.ts";
import type { TVectorMagnitudeData } from "@/lib/data/vectorMagnitude.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { terminateGridDataWorker } from "@/lib/grids/gridDataWorkerClient.ts";
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
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{ datasources?: TSources }>();

const store = useGlobeControlStore();
const { colormap, varnameSelector, invertColormap } = storeToRefs(store);

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
  pathlineDisplay,
  getScene,
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
  redraw,
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

  const sharedCoordinates = shareScalarBuffers(
    "coordinates",
    {
      latitudesData: latitudes.data,
      longitudesData: longitudes.data,
    },
    request.geometryCache
  );
  latitudes.data = sharedCoordinates.latitudesData;
  longitudes.data = sharedCoordinates.longitudesData;
  const rawData = castDataVarToFloat32(
    await fetchScalarFrameData(request, indices)
  );
  if (!isCurrent()) {
    return;
  }
  const { min, max, fillValue, missingValue } = decodeScalarFrameData(
    datavar,
    rawData,
    request
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
        geometryPending = metadata.rebuildGeometry;
      },
      onBatch: (batch) => {
        batches.push(shareScalarGeometry(batch, request.geometryCache));
      },
    }
  );

  shareScalarBuffers("hover", result.hoverIndexData, request.geometryCache);
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
  const coordinates = shareScalarBuffers(
    "reconciled",
    reconcileCoordinates(latitudes, longitudes, rawData.length),
    request.geometryCache
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
  return {
    pathlineGrid: {
      grid: { kind: PATHLINE_GRID.POINTS, ...coordinates },
      spatialDimensionNames: geographicDimensions.map(
        (index) => dimensions[index]
      ),
      spatialShape: geographicDimensions.map((index) => datavar.shape[index]),
    },
    memory: scalarFrameMemory(
      batches,
      rawData,
      result.hoverIndexData,
      latitudes.data,
      longitudes.data,
      coordinates,
      scalarInfo
    ),
    interpolation: {
      values: batches.map((batch) => batch.dataValues),
      geometry: [
        latitudes.data as Float32Array,
        longitudes.data as Float32Array,
      ],
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
});

onBeforeUnmount(() => {
  terminateIrregularDelaunayWorker();
  terminateGridDataWorker();
});

defineExpose({
  pathlineDisplay,
  makeSnapshot,
  createSnapshotRenderer,
  toggleRotate,
  applyCameraPreset,
  prepareScalarFrame,
  commitScalarFrame,
  getScalarFrameLayout,
});
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
