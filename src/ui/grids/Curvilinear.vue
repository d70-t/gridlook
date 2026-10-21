<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { onBeforeMount, onBeforeUnmount } from "vue";
import * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useIrregularStreamlines } from "./composables/useIrregularStreamlines.ts";
import { useScalarFieldCache } from "./composables/useScalarFieldCache.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";
import { useVolume } from "./composables/useVolume.ts";

import {
  getLatLonData,
  getProjectedXYLonLatData,
  isProjectedXName,
  isProjectedYName,
} from "@/lib/data/coordinateVariables.ts";
import { downsampleDataTexture } from "@/lib/data/dataTexture.ts";
import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import type { TVectorMagnitudeData } from "@/lib/data/vectorMagnitude.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  attachCurvilinearHoverValues,
  buildCurvilinearMesh,
  detectCurvilinearColumnPeriodicity,
  detectCurvilinearLongitudeFlip,
  type TCurvilinearGrid,
  type TCurvilinearHoverIndexData,
} from "@/lib/grids/curvilinearCalculations.ts";
import {
  buildCurvilinearHoverIndex,
  terminateCurvilinearWorker,
} from "@/lib/grids/curvilinearWorkerClient.ts";
import {
  getGridVariableData,
  terminateGridDataWorker,
} from "@/lib/grids/gridDataWorkerClient.ts";
import { createSerializedGeoSampleIndex } from "@/lib/grids/serializedGeoSampleIndex.ts";
import {
  createTriangleWrapProjectionGeometry,
  createWrappedProjectionMesh,
  updateProjectionMeshes,
} from "@/lib/projection/projectionEdgeQuality.ts";
import {
  makeGpuProjectedTextureMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
import { loadProjectedVolumeGrid } from "@/lib/volume/volumeData.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();
const { dimSlidersValues, colormap, varnameSelector, varinfo } =
  storeToRefs(store);
const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

type TCurvilinearGridState = {
  grid: TCurvilinearGrid;
  hoverIndexData: Promise<TCurvilinearHoverIndexData>;
};

let meshes: THREE.Mesh[] = [];
// A grid instance shows one variable (variable changes remount it), so the
// coordinates, mesh and hover index are built once and only the data texture
// changes between time steps.
let gridState: Promise<TCurvilinearGridState> | undefined;
// Bumped on datasource changes so a superseded load cannot install its mesh.
let gridRevision = 0;

const {
  getScene,
  getRenderer,
  redraw,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  fitCameraToDataset,
  getDataVar,
  fetchDimensionDetails,
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

const scalarCache = useScalarFieldCache({
  updateHistogram,
  updateColormap: () => updateColormap(meshes),
  redraw,
});

const volume = useVolume({
  getDatasources: () => props.datasources,
  getScene,
  getRenderer,
  redraw,
  projectionHelper,
  isSceneInMotion,
  onProjectionChange,
  onMotionStateChange,
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
  const state = gridState;
  if (!state) {
    return;
  }
  await scalarCache.showMagnitude(scalar, async () => {
    const { grid, hoverIndexData } = await state;
    const hoverIndex = createSerializedGeoSampleIndex(
      attachCurvilinearHoverValues(await hoverIndexData, scalar.data)
    );
    return () => {
      showData(scalar.data, grid);
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
  prepareDatasource: () => {
    gridRevision++;
    gridState = undefined;
    disposeMeshes();
  },
  updateColormap: () => updateColormap(meshes),
  refreshStreamlines: streamlines.refresh,
  suspendStreamlines: streamlines.suspend,
});

const MAX_GEO_RESOLUTION = 512;

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

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  const shaderMaterial = material as THREE.ShaderMaterial;
  shaderMaterial.uniforms?.data?.value?.dispose?.();
  shaderMaterial.dispose();
}

function disposeMeshes() {
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    disposeMaterial(mesh.material);
    getScene()?.remove(mesh);
  }
  meshes = [];
}

function createMesh(grid: TCurvilinearGrid) {
  const { positionValues, latLonValues, uvValues, indices } =
    buildCurvilinearMesh(grid, MAX_GEO_RESOLUTION, projectionHelper.value);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positionValues, 3)
  );
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvValues, 2));
  geometry.setAttribute("latLon", new THREE.BufferAttribute(latLonValues, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // Staged without data; the first data material makes it visible.
  const mesh = createWrappedProjectionMesh(
    createTriangleWrapProjectionGeometry(geometry),
    new THREE.ShaderMaterial(),
    projectionHelper.value.type
  );
  mesh.visible = false;
  mesh.frustumCulled = false;
  disposeMeshes();
  meshes = [mesh];
  getScene()?.add(mesh);
}

function createDataTexture(rawData: Float32Array, grid: TCurvilinearGrid) {
  const maxSize = getRenderer()?.capabilities.maxTextureSize ?? 4096;
  const width = Math.min(grid.ni, maxSize);
  const height = Math.min(grid.nj, maxSize);
  const data =
    width === grid.ni && height === grid.nj
      ? rawData
      : downsampleDataTexture(rawData, grid.ni, grid.nj, width, height);
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RedFormat,
    THREE.FloatType
  );
  if (grid.isPeriodicI) {
    texture.wrapS = THREE.RepeatWrapping;
  }
  texture.needsUpdate = true;
  return texture;
}

function showData(rawData: Float32Array, grid: TCurvilinearGrid) {
  const material = makeGpuProjectedTextureMaterial(
    createDataTexture(rawData, grid),
    colormap.value,
    0,
    1
  );
  material.uniforms.useTriangleWrapCull.value = 1;
  updateProjectionUniforms(material, projectionHelper.value);
  for (const mesh of meshes) {
    disposeMaterial(mesh.material);
    mesh.material = material;
  }
  updateColormap(meshes);
  updateMeshProjectionUniforms();
}

async function loadGrid(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  dimensionNames: string[],
  missingValue: number,
  fillValue: number
): Promise<TCurvilinearGridState> {
  const revision = gridRevision;
  const { latitudes, longitudes } = await getCurvilinearCoordinates(
    datavar,
    dimensionNames
  );
  const latitudesData = latitudes.data as Float32Array;
  const longitudesData = longitudes!.data as Float32Array;
  const [nj, ni] = latitudes.shape;
  const grid: TCurvilinearGrid = {
    latitudes: latitudesData,
    longitudes: longitudesData,
    nj,
    ni,
    shouldFlipLongitude: detectCurvilinearLongitudeFlip(
      longitudesData,
      latitudesData,
      missingValue,
      fillValue,
      nj,
      ni
    ),
    isPeriodicI: detectCurvilinearColumnPeriodicity(longitudesData, nj, ni),
  };
  if (revision === gridRevision) {
    createMesh(grid);
  }
  return {
    grid,
    hoverIndexData: buildCurvilinearHoverIndex(latitudesData, longitudesData),
  };
}

function getGrid(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  dimensionNames: string[],
  missingValue: number,
  fillValue: number
) {
  gridState ??= loadGrid(datavar, dimensionNames, missingValue, fillValue);
  const state = gridState;
  // A failed load or hover index must not stick: the next time step retries.
  state
    .then(({ hoverIndexData }) => hoverIndexData)
    .catch(() => {
      if (gridState === state) {
        gridState = undefined;
      }
    });
  return state;
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
  const { dimensionNames, dimensionRanges, indices } =
    await buildDimensionConfig(datavar);

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
  const { grid, hoverIndexData } = await getGrid(
    datavar,
    dimensionNames,
    missingValue,
    fillValue
  );
  const hoverIndex = createSerializedGeoSampleIndex(
    attachCurvilinearHoverValues(await hoverIndexData, rawData)
  );

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
    showData(rawData, grid);
    fitCameraToDataset(meshes);
    setHoverLookupFromIndex(hoverIndex, fillValue, missingValue);
  };
  const projectedGrid = await loadProjectedVolumeGrid(
    props.datasources!,
    varnameSelector.value,
    dimensionNames
  );
  if (!isCurrent()) {
    return;
  }
  volume.setContext(
    projectedGrid ? { dimensionNames, indices, grid: projectedGrid } : undefined
  );
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
    grid.latitudes,
    grid.longitudes,
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
