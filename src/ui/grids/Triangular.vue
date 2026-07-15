<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onBeforeUnmount } from "vue";
import * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

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
  TGridPositionBatch,
} from "@/lib/grids/gridWorkerTypes.ts";
import { createSerializedGeoSampleIndex } from "@/lib/grids/serializedGeoSampleIndex.ts";
import {
  buildTriangularData,
  buildTriangularGeometry,
  terminateTriangularWorker,
} from "@/lib/grids/triangularWorkerClient.ts";
import {
  createWrappedProjectionMesh,
  updateProjectionMeshes,
} from "@/lib/projection/projectionEdgeQuality.ts";
import { makeInvertableGpuMeshMaterial } from "@/lib/shaders/gridShaders.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";

const props = defineProps<{ datasources?: TSources }>();

const store = useGlobeControlStore();
const { logError } = useLog();
const { dimSlidersValues, varnameSelector, colormap, invertColormap, varinfo } =
  storeToRefs(store);
const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const BATCH_SIZE = 3000000;
let meshes: THREE.Mesh[] = [];

const {
  getScene,
  redraw,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  fetchDimensionDetails,
  getDataVar,
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

const colormapMaterial = computed(() =>
  makeInvertableGpuMeshMaterial(colormap.value, invertColormap.value)
);

const gridsource = computed(() => props.datasources?.levels[0].grid);

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  clearHoverLookup,
  prepareDatasource: fetchGrid,
  updateLandSeaMask,
  updateColormap: () => updateColormap(meshes),
});

function cleanupMeshes() {
  for (const mesh of meshes) {
    getScene()?.remove(mesh);
    mesh.geometry.dispose();
    if (mesh.material instanceof THREE.Material) {
      mesh.material.dispose();
    }
  }
  meshes.length = 0;
}

function updateGeometryBatch(batch: TGridPositionBatch) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(batch.positionValues, 3)
  );
  geometry.setAttribute(
    "latLon",
    new THREE.BufferAttribute(batch.latLonValues, 2)
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
    throw new Error(`Missing triangular mesh batch ${batch.batchIndex}.`);
  }
  const dataAttribute = mesh.geometry.getAttribute("data_value");
  if (dataAttribute) {
    if (dataAttribute.count !== batch.dataValues.length) {
      throw new Error(
        `Triangular mesh batch ${batch.batchIndex} size changed.`
      );
    }
    dataAttribute.array.set(batch.dataValues);
    dataAttribute.needsUpdate = true;
    return;
  }
  mesh.geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(batch.dataValues, 1)
  );
}

function fetchGridArray(variable: string) {
  return getGridVariableData({
    source: gridsource.value!,
    variable: ZarrDataManager.resolveVariablePath(
      varnameSelector.value,
      variable
    ),
    format: props.datasources!.zarr_format,
    selection: [],
  });
}

async function fetchGrid() {
  try {
    const [vertexOfCell, vertexX, vertexY, vertexZ] = await Promise.all([
      fetchGridArray("vertex_of_cell"),
      fetchGridArray("cartesian_x_vertices"),
      fetchGridArray("cartesian_y_vertices"),
      fetchGridArray("cartesian_z_vertices"),
    ]);
    cleanupMeshes();
    const helper = projectionHelper.value;
    await buildTriangularGeometry(
      {
        vertexOfCell: vertexOfCell as Int32Array,
        vertexX: vertexX as Float32Array | Float64Array,
        vertexY: vertexY as Float32Array | Float64Array,
        vertexZ: vertexZ as Float32Array | Float64Array,
        batchSize: BATCH_SIZE,
        projectionType: helper.type,
        projectionCenter: { lat: helper.center.lat, lon: helper.center.lon },
      },
      {
        onMetadata: () => undefined,
        onBatch: (batch) => {
          if ("positionValues" in batch) {
            updateGeometryBatch(batch);
          }
        },
      }
    );
    updateMeshProjectionUniforms();
    redraw();
  } catch (error) {
    logError(error, "Could not fetch grid");
  }
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

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const { dimensionRanges, indices } = await buildDimensionConfig(datavar);
  const variableData = await fetchVariableData(indices);
  const plotData = castDataVarToFloat32(variableData);
  const { min, max, missingValue, fillValue } = decodeVariableDataAndGetBounds(
    datavar,
    plotData
  );
  const result = await buildTriangularData(
    { data: plotData, batchSize: BATCH_SIZE },
    {
      onMetadata: () => undefined,
      onBatch: (batch) => {
        if (!("positionValues" in batch)) {
          updateDataBatch(batch);
        }
      },
    }
  );
  setHoverLookupFromIndex(
    createSerializedGeoSampleIndex(result.hoverIndexData),
    fillValue,
    missingValue
  );

  const dimInfo = await getDimensionValues(dimensionRanges, indices);
  updateHistogram(plotData, min, max, missingValue, fillValue);
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
  terminateTriangularWorker();
  terminateGridDataWorker();
});

defineExpose({ makeSnapshot, toggleRotate, applyCameraPreset });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
