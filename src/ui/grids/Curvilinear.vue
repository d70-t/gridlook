<script lang="ts" setup>
import { storeToRefs } from "pinia";
import proj4 from "proj4";
import * as THREE from "three";
import { onBeforeMount, onBeforeUnmount } from "vue";
import * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useIrregularStreamlines } from "./composables/useIrregularStreamlines.ts";
import { useScalarFieldCache } from "./composables/useScalarFieldCache.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";
import { useViewWindow } from "./composables/useViewWindow.ts";
import { useVolume } from "./composables/useVolume.ts";

import {
  getCRSWkt,
  getLatLonData,
  isProjectedXName,
  isProjectedYName,
  loadGridAxes,
  projectXYGridToLonLat,
} from "@/lib/data/coordinateVariables.ts";
import { downsampleDataTexture } from "@/lib/data/dataTexture.ts";
import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import {
  coarsestLevelOf,
  levelRangeOrigin,
  STREAMLINES_NEED_WHOLE_LEVEL,
  variableOnLevel,
} from "@/lib/data/levels.ts";
import {
  projectedExtent,
  projectedWindow,
  projectedWindowCovers,
  type TProjectedAxes,
  type TProjectedWindow,
} from "@/lib/data/projectedWindow.ts";
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
  BACKDROP_RENDER_ORDER,
  backdropMaterial,
  levelMaterial,
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

type TDataVar = zarr.Array<zarr.DataType, zarr.AsyncReadable>;

// Grid points as row-major lat/lon arrays of `nj` rows and `ni` columns.
type TGridPoints = {
  latitudes: Float32Array;
  longitudes: Float32Array;
  nj: number;
  ni: number;
};

// A level given as one-dimensional x/y axes with a CRS, regular in its own
// projection: it can be loaded by view, as a rectangle of the axes.
type TLevelAxes = TProjectedAxes & {
  x: Float32Array;
  y: Float32Array;
  crs: string;
};

// The coordinates of a level: its grid points, loaded whole, or its axes.
type TLevelCoordinates = { points: TGridPoints } | { axes: TLevelAxes };

type TCurvilinearGridState = {
  grid: TCurvilinearGrid;
  // Staged without data, installed with the data drawn on it.
  mesh: THREE.Mesh | undefined;
  hoverIndexData: Promise<TCurvilinearHoverIndexData>;
};

// The coarsest level of a multi-resolution dataset at the selected slice. A
// finer level takes its colour range from it and is drawn over it, so the
// range holds still and nothing is empty where the finer level has no cells.
type TBackdropFrame = {
  key: string;
  grid: TCurvilinearGrid;
  data: Float32Array;
  min: number;
  max: number;
};

let meshes: THREE.Mesh[] = [];
let backdrop: THREE.Mesh | undefined;
let backdropFrame: TBackdropFrame | undefined;
// A grid instance shows one variable (variable changes remount it). The
// coordinates, mesh and hover index are built once per level and view
// window, and only the data texture changes between time steps.
let gridState: Promise<TCurvilinearGridState> | undefined;
// Bumped on datasource changes so a superseded load cannot install its mesh.
let gridRevision = 0;
let levelCoordinates: TLevelCoordinates | undefined;
let levelCoordinatesKey: string | undefined;
// The loaded part of a level too large to load whole; null when the view
// holds none of it, undefined when the whole level is loaded.
let gridWindow: TProjectedWindow | null | undefined;

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

function drawnMeshes() {
  return backdrop ? [backdrop, ...meshes] : meshes;
}

onColormapChange(() => updateColormap(drawnMeshes()));
onProjectionChange(updateMeshProjectionUniforms);
onMotionStateChange(updateMeshProjectionUniforms);

function updateMeshProjectionUniforms() {
  updateProjectionMeshes(drawnMeshes(), {
    redraw,
    projectionHelper: projectionHelper.value,
    isSceneInMotion: isSceneInMotion.value,
  });
}

const scalarCache = useScalarFieldCache({
  updateHistogram,
  updateColormap: () => updateColormap(drawnMeshes()),
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

/**
 * A level regular in its own CRS, of a pyramid with a coarsest level to
 * draw beneath, can be loaded by view.
 */
function canLoadByView() {
  return (
    levelCoordinates !== undefined &&
    "axes" in levelCoordinates &&
    coarsestLevelOf(props.datasources!.levels, varnameSelector.value) !==
      undefined
  );
}

const view = useViewWindow<TProjectedWindow>({
  getDatasources: () => props.datasources,
  canLoadByView,
  levelCells: () => {
    const coordinates = levelCoordinates;
    if (!coordinates) {
      return 0;
    }
    return "points" in coordinates
      ? coordinates.points.nj * coordinates.points.ni
      : coordinates.axes.x.length * coordinates.axes.y.length;
  },
  window: (footprint, margin, maxCells) =>
    projectedWindow(
      (levelCoordinates as { axes: TLevelAxes }).axes,
      footprint,
      {
        margin,
        maxCells,
      }
    ),
  covers: projectedWindowCovers,
});

/** Streamlines read a whole level: none on the window of a level. */
function refreshStreamlines(reuseCached?: boolean) {
  if (gridWindow !== undefined) {
    streamlines.clear(
      store.isStreamlineLayerEnabled()
        ? STREAMLINES_NEED_WHOLE_LEVEL
        : undefined
    );
    return;
  }
  return streamlines.refresh(reuseCached);
}

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  scalarCache,
  clearHoverLookup,
  prepareDatasource: async () => {
    // The meshes keep showing the previous grid until the next one is
    // ready to be drawn with its data.
    gridRevision++;
    gridState = undefined;
    await loadLevelCoordinates();
    gridWindow = view.applyViewWindow();
  },
  canLoadByView,
  viewWindowStale: () => view.viewWindowStale(),
  updateColormap: () => updateColormap(drawnMeshes()),
  refreshStreamlines,
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

/**
 * The coordinates of the variable on the level `sources` reads: its
 * two-dimensional lat/lon arrays where it has them, else its projected x/y
 * axes, whose lat/lon are computed through the CRS.
 */
async function loadCoordinates(
  sources: TSources,
  variable: string,
  datavar: TDataVar,
  dimensionNames: string[]
): Promise<TLevelCoordinates> {
  try {
    const { latitudes, longitudes } = await getLatLonData(
      variable,
      datavar,
      sources
    );
    const [nj, ni] = latitudes.shape;
    return {
      points: {
        latitudes: latitudes.data as Float32Array,
        longitudes: longitudes!.data as Float32Array,
        nj,
        ni,
      },
    };
  } catch (error) {
    if (!hasTrailingProjectedXYDimensions(dimensionNames)) {
      throw error;
    }
    const [{ x, y }, crs] = await Promise.all([
      loadGridAxes(sources, variable, dimensionNames),
      getCRSWkt(sources, variable),
    ]);
    if (!crs) {
      throw error;
    }
    const converter = proj4("EPSG:4326", crs);
    const projection = {
      forward: (lonLat: [number, number]) => converter.forward(lonLat),
      inverse: (xy: [number, number]) => converter.inverse(xy),
    };
    return {
      axes: {
        x,
        y,
        crs,
        projection,
        extent: projectedExtent(x, y, projection),
      },
    };
  }
}

/** Read the coordinates of the level shown; a window reload keeps them. */
async function loadLevelCoordinates() {
  const sources = props.datasources!;
  const variable = varnameSelector.value;
  const key = `${sources.selectedLevel ?? 0}:${variable}`;
  if (levelCoordinatesKey === key) {
    return;
  }
  levelCoordinates = undefined;
  levelCoordinatesKey = undefined;
  const datavar = await getDataVar(variable, sources);
  const dimensionNames = await ZarrDataManager.getDimensionNames(
    sources,
    variable
  );
  levelCoordinates = datavar
    ? await loadCoordinates(sources, variable, datavar, dimensionNames)
    : undefined;
  levelCoordinatesKey = key;
}

/** The lat/lon of every point of a level given as axes. */
function wholeLevelPoints(axes: TLevelAxes): TGridPoints {
  return windowPoints(axes, {
    y: { start: 0, end: axes.y.length },
    x: { start: 0, end: axes.x.length },
  });
}

/** The lat/lon of the points of a level given as axes that are in `window`. */
function windowPoints(
  axes: TLevelAxes,
  window: TProjectedWindow | null
): TGridPoints {
  if (window === null) {
    return {
      latitudes: new Float32Array(),
      longitudes: new Float32Array(),
      nj: 0,
      ni: 0,
    };
  }
  const columns = axes.x.subarray(window.x.start, window.x.end);
  const rows = axes.y.subarray(window.y.start, window.y.end);
  const { latitudes, longitudes } = projectXYGridToLonLat(
    columns,
    rows,
    axes.crs
  );
  return {
    latitudes: latitudes.data,
    longitudes: longitudes.data,
    nj: rows.length,
    ni: columns.length,
  };
}

function makeGrid(
  points: TGridPoints,
  missingValue: number,
  fillValue: number
): TCurvilinearGrid {
  const { latitudes, longitudes, nj, ni } = points;
  return {
    latitudes,
    longitudes,
    nj,
    ni,
    shouldFlipLongitude: detectCurvilinearLongitudeFlip(
      longitudes,
      latitudes,
      missingValue,
      fillValue,
      nj,
      ni
    ),
    isPeriodicI: detectCurvilinearColumnPeriodicity(longitudes, nj, ni),
  };
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  const shaderMaterial = material as THREE.ShaderMaterial;
  shaderMaterial.uniforms?.data?.value?.dispose?.();
  shaderMaterial.dispose();
}

function disposeMesh(mesh: THREE.Mesh) {
  mesh.geometry.dispose();
  disposeMaterial(mesh.material);
  getScene()?.remove(mesh);
}

function disposeMeshes() {
  for (const mesh of meshes) {
    disposeMesh(mesh);
  }
  meshes = [];
}

/** A mesh over the grid, staged without data; none for an empty grid. */
function buildMesh(grid: TCurvilinearGrid) {
  if (grid.nj === 0 || grid.ni === 0) {
    return undefined;
  }
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
  const mesh = createWrappedProjectionMesh(
    createTriangleWrapProjectionGeometry(geometry),
    new THREE.ShaderMaterial(),
    projectionHelper.value.type
  );
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
}

/** Replace the meshes on screen with the level's, once its data is ready. */
function installMesh(mesh: THREE.Mesh | undefined) {
  if (mesh && meshes.includes(mesh)) {
    return;
  }
  disposeMeshes();
  if (mesh) {
    meshes = [mesh];
    getScene()?.add(mesh);
  }
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

function makeMaterial(rawData: Float32Array, grid: TCurvilinearGrid) {
  const material = makeGpuProjectedTextureMaterial(
    createDataTexture(rawData, grid),
    colormap.value,
    0,
    1
  );
  material.uniforms.useTriangleWrapCull.value = 1;
  updateProjectionUniforms(material, projectionHelper.value);
  return material;
}

function showData(rawData: Float32Array, grid: TCurvilinearGrid) {
  if (meshes.length === 0) {
    return;
  }
  const material = levelMaterial(makeMaterial(rawData, grid));
  for (const mesh of meshes) {
    disposeMaterial(mesh.material);
    mesh.material = material;
  }
  updateColormap(drawnMeshes());
  updateMeshProjectionUniforms();
}

async function loadGrid(
  missingValue: number,
  fillValue: number
): Promise<TCurvilinearGridState> {
  const revision = gridRevision;
  const coordinates = levelCoordinates!;
  const points =
    "points" in coordinates
      ? coordinates.points
      : gridWindow === undefined
        ? wholeLevelPoints(coordinates.axes)
        : windowPoints(coordinates.axes, gridWindow);
  const grid = makeGrid(points, missingValue, fillValue);
  return {
    grid,
    mesh: revision === gridRevision ? buildMesh(grid) : undefined,
    hoverIndexData: buildCurvilinearHoverIndex(grid.latitudes, grid.longitudes),
  };
}

function getGrid(missingValue: number, fillValue: number) {
  gridState ??= loadGrid(missingValue, fillValue);
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

async function buildDimensionConfig(datavar: TDataVar) {
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

function fetchVariableData(
  sources: TSources,
  variable: string,
  selection: (number | null | zarr.Slice)[]
) {
  return getGridVariableData({
    source: ZarrDataManager.getDatasetSource(sources, variable),
    variable,
    format: sources.zarr_format,
    selection,
  });
}

/** The loaded cells of the selected slice, row by row. */
async function fetchLoadedData(indices: (number | null | zarr.Slice)[]) {
  if (gridWindow === null) {
    return new Float32Array();
  }
  const selection =
    gridWindow === undefined
      ? indices
      : [
          ...indices.slice(0, -2),
          zarr.slice(gridWindow.y.start, gridWindow.y.end),
          zarr.slice(gridWindow.x.start, gridWindow.x.end),
        ];
  return castDataVarToFloat32(
    await fetchVariableData(
      props.datasources!,
      varnameSelector.value,
      selection
    )
  );
}

/** Load the coarsest level at the selected slice, unless it is on screen. */
async function loadBackdrop(indices: (number | null | zarr.Slice)[]) {
  const sources = props.datasources!;
  const level = coarsestLevelOf(sources.levels, varnameSelector.value);
  if (
    level === undefined ||
    level === (sources.selectedLevel ?? 0) ||
    !canLoadByView()
  ) {
    return undefined;
  }
  const variable = variableOnLevel(
    sources.levels,
    varnameSelector.value,
    level
  );
  const key = JSON.stringify([level, variable, indices]);
  if (backdropFrame?.key === key) {
    return backdropFrame;
  }
  const coarse = { ...sources, selectedLevel: level };
  const datavar = await getDataVar(variable, coarse);
  if (!datavar) {
    return undefined;
  }
  const dimensionNames = await ZarrDataManager.getDimensionNames(
    coarse,
    variable
  );
  const [coordinates, values] = await Promise.all([
    loadCoordinates(coarse, variable, datavar, dimensionNames),
    fetchVariableData(coarse, variable, indices),
  ]);
  const data = castDataVarToFloat32(values);
  const { min, max, missingValue, fillValue } = decodeVariableDataAndGetBounds(
    datavar,
    data
  );
  const points =
    "axes" in coordinates
      ? wholeLevelPoints(coordinates.axes)
      : coordinates.points;
  backdropFrame = {
    key,
    grid: makeGrid(points, missingValue, fillValue),
    data,
    min,
    max,
  };
  return backdropFrame;
}

function removeBackdrop() {
  if (backdrop) {
    disposeMesh(backdrop);
    backdrop = undefined;
  }
}

/** Draw the coarsest level under a level that leaves part of the view empty. */
function showBackdrop(frame: TBackdropFrame | undefined) {
  if (backdrop?.userData.key === frame?.key) {
    return;
  }
  removeBackdrop();
  const mesh = frame && buildMesh(frame.grid);
  if (!frame || !mesh) {
    return;
  }
  disposeMaterial(mesh.material);
  mesh.material = backdropMaterial(makeMaterial(frame.data, frame.grid));
  mesh.renderOrder = BACKDROP_RENDER_ORDER;
  mesh.userData.key = frame.key;
  backdrop = mesh;
  getScene()?.add(mesh);
}

function updateStreamlines(
  grid: TCurvilinearGrid,
  dimensionNames: string[],
  indices: (number | null | zarr.Slice)[]
) {
  if (gridWindow !== undefined) {
    return refreshStreamlines();
  }
  return streamlines.setContext({
    latitudes: grid.latitudes,
    longitudes: grid.longitudes,
    dimensionNames,
    indices,
    spatialDimensionNames: dimensionNames.slice(-2),
  });
}

// eslint-disable-next-line max-lines-per-function
async function fetchAndRenderData(datavar: TDataVar, isCurrent: () => boolean) {
  const { dimensionNames, dimensionRanges, indices } =
    await buildDimensionConfig(datavar);

  // The backdrop (the coarsest level) is drawn and sets the range of every
  // level, unless each level is to take its own.
  const [rawData, rangeSource] = await Promise.all([
    fetchLoadedData(indices),
    store.sharesLevelRange(datavar.attrs)
      ? loadBackdrop(indices).catch(() => undefined)
      : undefined,
  ]);
  if (!isCurrent()) {
    return;
  }
  const { min, max, missingValue, fillValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );
  const { grid, mesh, hoverIndexData } = await getGrid(missingValue, fillValue);
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
    bounds: { low: rangeSource?.min ?? min, high: rangeSource?.max ?? max },
    dimRanges: dimensionRanges,
    rangeOrigin: levelRangeOrigin(
      Boolean(rangeSource),
      gridWindow !== undefined
    ),
  };
  const renderScalar = () => {
    installMesh(mesh);
    showBackdrop(rangeSource);
    showData(rawData, grid);
    fitCameraToDataset(drawnMeshes());
    setHoverLookupFromIndex(hoverIndex, fillValue, missingValue);
  };
  const projectedGrid =
    gridWindow === undefined
      ? await loadProjectedVolumeGrid(
          props.datasources!,
          varnameSelector.value,
          dimensionNames
        )
      : undefined;
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
    data: rangeSource?.data ?? rawData,
    missingValue,
    fillValue,
    isCurrent,
  });
  await updateStreamlines(grid, dimensionNames, indices);
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
  removeBackdrop();
  disposeMeshes();
});

defineExpose({ makeSnapshot, toggleRotate, applyCameraPreset });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
