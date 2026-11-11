<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { onBeforeMount, onBeforeUnmount } from "vue";
import type * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useIrregularStreamlines } from "./composables/useIrregularStreamlines.ts";
import { useScalarFieldCache } from "./composables/useScalarFieldCache.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { getLatLonData } from "@/lib/data/coordinateVariables.ts";
import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import type { TVectorMagnitudeData } from "@/lib/data/vectorMagnitude.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  buildGaussianReducedGrid,
  buildGaussianReducedMesh,
  createGaussianReducedSampleIndex,
  type TGaussianReducedGrid,
} from "@/lib/grids/gaussianReducedCalculations.ts";
import {
  getGridVariableData,
  terminateGridDataWorker,
} from "@/lib/grids/gridDataWorkerClient.ts";
import {
  createTriangleWrapProjectionGeometry,
  createWrappedProjectionMesh,
  updateProjectionMeshes,
} from "@/lib/projection/projectionEdgeQuality.ts";
import {
  makeGaussianReducedMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
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

type TGaussianReducedGridState = {
  grid: TGaussianReducedGrid;
  // Shared by every time step's material; disposed with the meshes.
  rowTexture: THREE.DataTexture;
  latitudes: Float32Array;
  longitudes: Float32Array;
};

let meshes: THREE.Mesh[] = [];
// A grid instance shows one variable (variable changes remount it), so the
// row table and mesh are built once and only the data texture changes between
// time steps.
let gridState: Promise<TGaussianReducedGridState> | undefined;
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
  const pendingState = gridState;
  if (!pendingState) {
    return;
  }
  await scalarCache.showMagnitude(scalar, async () => {
    const state = await pendingState;
    const hoverIndex = createGaussianReducedSampleIndex(
      state.grid,
      scalar.data
    );
    return () => {
      showData(scalar.data, state);
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

// Cells are resolved per fragment, so this only sets how closely the mesh
// follows curved projections.
const MESH_STEP_DEGREES = 1;

function getMaxTextureSize() {
  return getRenderer()?.capabilities.maxTextureSize ?? 4096;
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  const shaderMaterial = material as THREE.ShaderMaterial;
  shaderMaterial.uniforms?.data?.value?.dispose?.();
  shaderMaterial.dispose();
}

function disposeMeshes() {
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    (mesh.material as THREE.ShaderMaterial).uniforms?.rows?.value?.dispose?.();
    disposeMaterial(mesh.material);
    getScene()?.remove(mesh);
  }
  meshes = [];
}

function createMesh() {
  const { positionValues, latLonValues, uvValues, indices } =
    buildGaussianReducedMesh(MESH_STEP_DEGREES, projectionHelper.value);
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

function createRowTexture(grid: TGaussianReducedGrid) {
  const rowCount = grid.rowLatitudes.length;
  const width = Math.min(rowCount, getMaxTextureSize());
  const height = Math.ceil(rowCount / width);
  const values = new Int32Array(width * height * 4);
  for (let row = 0; row < rowCount; row++) {
    values[row * 4] = Math.round(grid.rowLatitudes[row] * 1e6);
    values[row * 4 + 1] = Math.round(grid.rowFirstLongitudes[row] * 1e6);
    values[row * 4 + 2] = grid.rowPointCounts[row];
    values[row * 4 + 3] = grid.rowOffsets[row];
  }
  const texture = new THREE.DataTexture(
    values,
    width,
    height,
    THREE.RGBAIntegerFormat,
    THREE.IntType
  );
  texture.needsUpdate = true;
  return texture;
}

function createDataTexture(rawData: Float32Array) {
  // About 2:1, so the GeoTIFF export, which takes its size from the data
  // texture, comes out close to the grid's resolution.
  const width = Math.min(
    Math.ceil(Math.sqrt(2 * rawData.length)),
    getMaxTextureSize()
  );
  const height = Math.ceil(rawData.length / width);
  const data = new Float32Array(width * height);
  data.set(rawData);
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RedFormat,
    THREE.FloatType
  );
  texture.needsUpdate = true;
  return texture;
}

function showData(rawData: Float32Array, state: TGaussianReducedGridState) {
  const material = makeGaussianReducedMaterial(
    createDataTexture(rawData),
    state.rowTexture,
    state.grid.rowLatitudes.length,
    colormap.value
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
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
): Promise<TGaussianReducedGridState> {
  const revision = gridRevision;
  const { latitudes, longitudes } = await getLatLonData(
    varnameSelector.value,
    datavar,
    props.datasources
  );
  const latitudesData = latitudes.data as Float64Array;
  const longitudesData = longitudes!.data as Float64Array;
  const grid = buildGaussianReducedGrid(latitudesData, longitudesData);
  if (revision === gridRevision) {
    createMesh();
  }
  return {
    grid,
    rowTexture: createRowTexture(grid),
    latitudes: Float32Array.from(latitudesData),
    longitudes: Float32Array.from(longitudesData),
  };
}

function getGrid(datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>) {
  gridState ??= loadGrid(datavar);
  const state = gridState;
  // A failed load must not stick: the next time step retries.
  state.catch(() => {
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
  const dimValues = await fetchDimensionDetails(
    varnameSelector.value,
    props.datasources!,
    dimensionRanges,
    indices
  );
  return dimValues;
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
      [datavar.shape.length - 1],
      varinfo.value?.dimRanges
    ),
    dimensionNames,
  };
}

function fetchGaussianReducedVariableData(
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

// eslint-disable-next-line max-lines-per-function
async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  isCurrent: () => boolean
) {
  const { dimensionRanges, indices, dimensionNames } =
    await buildDimensionConfig(datavar);

  const rawData = castDataVarToFloat32(
    await fetchGaussianReducedVariableData(indices)
  );
  if (!isCurrent()) {
    return;
  }
  const { min, max, missingValue, fillValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );
  const state = await getGrid(datavar);
  const hoverIndex = createGaussianReducedSampleIndex(state.grid, rawData);

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
    showData(rawData, state);
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
    latitudes: state.latitudes,
    longitudes: state.longitudes,
    dimensionNames,
    indices,
    spatialDimensionNames: [dimensionNames.at(-1)!],
  });
  if (isCurrent() && !store.streamlineMagnitudeDisplayed) {
    await scalarCache.restoreScalar();
  }
}

onBeforeMount(async () => {
  await datasourceUpdate();
});

onBeforeUnmount(() => {
  terminateGridDataWorker();
});

defineExpose({
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
});
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
