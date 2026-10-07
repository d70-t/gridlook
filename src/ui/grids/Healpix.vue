<script lang="ts" setup>
import "@/utils/disposablePolyfill.ts";

import * as healpixGeo from "healpix-geo";
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { onBeforeMount, onBeforeUnmount, ref } from "vue";
import * as zarr from "zarrita";

import {
  useGridHoverLookup,
  type TGridHoverLookupResult,
} from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useScalarFieldCache } from "./composables/useScalarFieldCache.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";
import { useStreamlineLayer } from "./composables/useStreamlineLayer.ts";
import { useVolume } from "./composables/useVolume.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import {
  coarsestLevel,
  currentLevel,
  DEFAULT_MAX_LEVEL_CELLS,
  DEFAULT_MAX_VIEW_CELLS,
  STREAMLINES_NEED_WHOLE_LEVEL,
} from "@/lib/data/levels.ts";
import { loadVectorComponents } from "@/lib/data/streamlineData.ts";
import {
  castDataVarToFloat32,
  getFillValue,
  getMissingValue,
} from "@/lib/data/variableDecoding.ts";
import {
  RegularVectorField,
  resolveVectorVariablePair,
} from "@/lib/data/vectorField.ts";
import {
  createVectorMagnitudeData,
  type TVectorMagnitudeData,
} from "@/lib/data/vectorMagnitude.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  getGridVariableData,
  terminateGridDataWorker,
} from "@/lib/grids/gridDataWorkerClient.ts";
import {
  HEALPIX_NUMCHUNKS,
  buildHealpixRegionCoordinates,
  buildHealpixTexture,
  decodeHealpixFaceXY,
  getHealpixFaceDataRect,
  getHealpixFaceRange,
  type THealpixDataRect,
} from "@/lib/grids/healpixCalculations.ts";
import {
  healpixBlockLevel,
  healpixBlockRanges,
  healpixViewBlocks,
} from "@/lib/grids/healpixWindow.ts";
import {
  buildHealpixFace,
  terminateHealpixWorker,
} from "@/lib/grids/healpixWorkerClient.ts";
import type { THealpixBatch } from "@/lib/grids/healpixWorkerProtocol.ts";
import { createSortedCells } from "@/lib/grids/sortedCells.ts";
import {
  createTriangleWrapProjectionGeometry,
  createWrappedProjectionMesh,
  setupProjectionGeometryWrap,
  updateProjectionMeshes,
} from "@/lib/projection/projectionEdgeQuality.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  getColormapScaleOffset,
  makeGpuProjectedTextureMaterial,
} from "@/lib/shaders/gridShaders.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
import { VOLUME_GRID_TYPES } from "@/lib/volume/volumeGrid.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import {
  HOVERED_GRID_POINT_STATUS,
  useGlobeControlStore,
} from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";
import type { THistogramSummary } from "@/utils/histogram.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

// By convention, HEALPIX uses -1.6375e+30 to mark invalid or unseen pixels.
const HEALPIX_UNSEEN = new Float32Array([-1.6375e30])[0];

function getHealpixMissingAndFillValues(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const missingValue = getMissingValue(datavar);
  const fillValue = getFillValue(datavar);
  if (Number.isNaN(missingValue)) {
    return { missingValue: HEALPIX_UNSEEN, fillValue };
  }
  if (Number.isNaN(fillValue)) {
    return { missingValue, fillValue: HEALPIX_UNSEEN };
  }
  return { missingValue, fillValue };
}

const store = useGlobeControlStore();
const { logError } = useLog();
const { varnameSelector, colormap, invertColormap, dimSlidersValues, varinfo } =
  storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

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
  updateLandSeaMask,
  updateColormap,
  updateHistogram,
  projectionHelper,
  isSceneInMotion,
  onProjectionChange,
  onMotionStateChange,
  onColormapChange,
  registerAnimationCallback,
  canvas,
  box,
  hoveredGeoPoint,
} = useSharedGridLogic();

const { setHoverLookup, clearHoverLookup } =
  useGridHoverLookup(hoveredGeoPoint);

const selectedDimensionNames = ref<string[]>([]);

const healpixGrid = ref<healpixGeo.Grid | null>(null);
const gridPrepared = ref<boolean>(false);

type TStreamlineContext = {
  indices: (number | null | zarr.Slice)[];
  grid: healpixGeo.Grid;
  cellCoord?: number[];
};

let lastStreamlineContext: TStreamlineContext | undefined;
let streamlineRequestRevision = 0;
let cachedMagnitude: TVectorMagnitudeData | undefined;
let cachedStreamlineKey: string | undefined;

let disposed = false;

// A view window reaches this fraction of the view's size past every edge.
const VIEW_WINDOW_MARGIN = 0.5;
// The level as stored: how many cells, and whether it can be loaded by view
// (nested, and either dense or with an ascending `cell` coordinate).
let levelCellCount = 0;
let levelWindowable = false;
let sortedCells: ReturnType<typeof createSortedCells> | undefined;
// The coordinate reader of a sparse level, kept while the level stays the
// same so that its chunks are read once.
let cellsReader:
  { key: string; cells: ReturnType<typeof createSortedCells> } | undefined;
// The blocks loaded of a level too large to load whole; undefined when the
// whole level is loaded.
let loadedBlocks: number[] | undefined;

let mainMeshes: Array<THREE.Mesh | undefined> = new Array(HEALPIX_NUMCHUNKS);

// The coarsest level of a multi-resolution dataset at the selected slice. A
// finer level takes its colour range from it and is drawn over it, so the
// range holds still and nothing is empty where the finer level has no cells.
type TBackdropFrame = {
  key: string;
  min: number;
  max: number;
  histogramSummaries: THistogramSummary[];
  batches: THealpixBatch[];
};
let backdropFrame: TBackdropFrame | undefined;
let backdropKey: string | undefined;
const backdropMeshes: Array<THREE.Mesh | undefined> = new Array(
  HEALPIX_NUMCHUNKS
);

function drawnMeshes() {
  return [...backdropMeshes, ...mainMeshes];
}

onColormapChange(() => updateColormap(drawnMeshes()));

onProjectionChange(updateMeshProjectionUniforms);
onMotionStateChange(updateMeshProjectionUniforms);

const scalarCache = useScalarFieldCache({
  updateHistogram,
  updateColormap: () => updateColormap(drawnMeshes()),
  redraw,
});

const streamlines = useStreamlineLayer({
  getScene,
  redraw,
  projectionHelper,
  onProjectionChange,
  registerAnimationCallback,
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

/**
 * Update projection uniforms on all mesh materials.
 * This is the fast path - no geometry rebuild needed.
 */
function updateMeshProjectionUniforms() {
  updateProjectionMeshes(drawnMeshes(), {
    redraw,
    projectionHelper: projectionHelper.value,
    isSceneInMotion: isSceneInMotion.value,
  });
}

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  scalarCache,
  clearHoverLookup,
  prepareDatasource: prepareLevel,
  canLoadByView: () => levelWindowable,
  viewWindowStale,
  updateLandSeaMask,
  updateColormap: () => updateColormap(drawnMeshes()),
  refreshStreamlines: async (reuseCached) => {
    if (lastStreamlineContext) {
      await updateStreamlines(lastStreamlineContext, reuseCached);
    }
  },
  suspendStreamlines: () => {
    streamlineRequestRevision++;
    store.streamlineLoading = false;
    store.streamlineProgress = undefined;
  },
});

function coerceInteger(value: unknown): number | null {
  const cast = typeof value === "number" ? value : Number(value);

  return Number.isInteger(cast) && cast > 0 ? cast : null;
}

function coerceOrder(value: unknown): healpixGeo.IndexingScheme | null {
  const order = value === undefined || value === null ? null : String(value);

  // translate, but let healpixGeo validate
  if (order === "nest") {
    return "nested" as healpixGeo.IndexingScheme;
  } else {
    return order as healpixGeo.IndexingScheme;
  }
}

function coerceScheme(value: unknown): healpixGeo.IndexingScheme | null {
  const scheme = value === undefined || value === null ? null : String(value);

  return scheme as healpixGeo.IndexingScheme;
}

function coerceEllipsoid(value: unknown): healpixGeo.EllipsoidInput | null {
  return value === undefined || value === null
    ? null
    : (value as healpixGeo.EllipsoidInput);
}

async function gridFromEasygemsConvention(
  sources: TSources
): Promise<healpixGeo.Grid | null> {
  try {
    const crs = await ZarrDataManager.getCRSInfo(
      sources,
      varnameSelector.value
    );
    const nside = coerceInteger(crs.attrs["healpix_nside"]);
    const scheme = coerceOrder(crs.attrs["healpix_order"]);

    if (nside !== null && scheme !== null) {
      return new healpixGeo.Grid({ scheme: scheme, level: Math.log2(nside) });
    }
    // CRS variable exists but has no usable nside or order
  } catch {
    // No CRS variable
  }

  // try the next convention
  return null;
}

async function gridFromDggsConvention(
  sources: TSources
): Promise<healpixGeo.Grid | null> {
  const metadata = await ZarrDataManager.getDggsMetadata(
    sources,
    varnameSelector.value
  );
  if (metadata !== null) {
    const level = coerceInteger(metadata["refinement_level"]);
    const scheme = coerceScheme(metadata["indexing_scheme"]);
    const ellipsoid = coerceEllipsoid(metadata["ellipsoid"]);

    if (level !== null && scheme !== null) {
      // ellipsoid is optional
      return new healpixGeo.Grid({ scheme, level, ellipsoid });
    }
  }

  // try another convention
  return null;
}

/**
 * Derive nside from the length of the (last) cell dimension, assuming a global
 * grid where `ncells = 12 * nside^2`. Returns null unless that yields an exact
 * positive integer nside, so it never misfires on limited-area data.
 */
function inferGridFromCellCount(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
): healpixGeo.Grid | null {
  const ncells = datavar.shape[datavar.shape.length - 1];
  if (!ncells) {
    return null;
  }

  const nside = coerceInteger(Math.sqrt(ncells / 12));
  if (nside !== null) {
    const level = Math.log2(nside);
    return new healpixGeo.Grid({ scheme: "nested", level: level });
  }

  // try another convention
  return null;
}

async function getHealpixGridParameters(
  sources = props.datasources!
): Promise<healpixGeo.Grid> {
  const fromEasygems = await gridFromEasygemsConvention(sources);
  if (fromEasygems !== null) {
    return fromEasygems;
  }

  const fromDggsConvention = await gridFromDggsConvention(sources);
  if (fromDggsConvention !== null) {
    return fromDggsConvention;
  }

  // last resort: assume nested / spherical and infer level from a global grid's cell count (12 * 4^level)
  const datavar = await ZarrDataManager.getVariableInfo(
    ZarrDataManager.getDatasetSource(sources, varnameSelector.value),
    varnameSelector.value
  );
  const fromShape = await inferGridFromCellCount(datavar);
  if (fromShape !== null) {
    return fromShape;
  }

  throw new Error(
    "Could not determine HEALPix grid parameters: no valid convention metadata on the grid mapping variable" +
      " or in the group metadata (tried the Easygems and dggs zarr conventions), and " +
      "the cell-dimension length is not 12 * nside^2."
  );
}

function unpackGrid(): healpixGeo.Grid {
  const grid = healpixGrid.value;
  if (grid === null) {
    throw new Error("failed to fetch grid parameters");
  }
  return grid as healpixGeo.Grid;
}

async function getCellCoordinateName(sources = props.datasources!) {
  let cellCoord = "cell";
  const dggsMetadata = await ZarrDataManager.getDggsMetadata(
    sources,
    varnameSelector.value
  );
  if (dggsMetadata !== null) {
    const coordinate = dggsMetadata["coordinate"];
    if (coordinate) {
      cellCoord = coordinate;
    }
  } else {
    // no dggs metadata found, continue with the default cell coordinate
  }
  return cellCoord as string;
}

async function getCells(sources = props.datasources!) {
  const cellCoord = await getCellCoordinateName(sources);

  try {
    const rawCells = await fetchHealpixVariableData(
      [],
      ZarrDataManager.resolveVariablePath(varnameSelector.value, cellCoord),
      sources
    );

    return Array.from(rawCells, (cell) => Number(cell));
  } catch {
    return undefined;
  }
}

/**
 * Whether the selected level is loaded by view: a large level other than the
 * coarsest, which is the backdrop of the others and is always loaded whole.
 * Streamlines and volumes read the whole level, up to the whole-level cap.
 */
function loadsByView() {
  const sources = props.datasources!;
  const wholeLevelLayers =
    store.isStreamlineLayerEnabled() || store.isVolumeLayerEnabled();
  return (
    levelWindowable &&
    (sources.selectedLevel ?? 0) !== coarsestLevel(sources.levels) &&
    levelCellCount >
      (wholeLevelLayers ? DEFAULT_MAX_LEVEL_CELLS : DEFAULT_MAX_VIEW_CELLS)
  );
}

function viewBlocks(margin: number) {
  const grid = unpackGrid();
  return store.viewFootprint
    ? healpixViewBlocks(
        grid,
        store.viewFootprint,
        margin,
        Math.floor(
          DEFAULT_MAX_VIEW_CELLS /
            4 ** (grid.level - healpixBlockLevel(grid.level))
        )
      )
    : [];
}

function viewWindowStale() {
  if (!loadsByView()) {
    return loadedBlocks !== undefined;
  }
  if (loadedBlocks === undefined) {
    return true;
  }
  const loaded = new Set(loadedBlocks);
  return viewBlocks(0).some((block) => !loaded.has(block));
}

/**
 * Read what the stored level allows: its grid, its size, and whether it can
 * be loaded by view (nested, in a pyramid with a coarsest level to draw
 * beneath, and either dense or with an ascending `cell` coordinate). Then
 * switch to it and to the blocks in view in one step.
 */
async function prepareLevel() {
  const sources = props.datasources!;
  const variable = varnameSelector.value;
  const grid = await getHealpixGridParameters();
  const datavar = await ZarrDataManager.getVariableInfoByDatasetSources(
    sources,
    variable
  );
  const cellCount = datavar.shape[datavar.shape.length - 1];
  let windowable = false;
  let cells: ReturnType<typeof createSortedCells> | undefined;
  if (coarsestLevel(sources.levels) !== undefined && grid.scheme === "nested") {
    const cellPath = ZarrDataManager.resolveVariablePath(
      variable,
      await getCellCoordinateName()
    );
    const coordinate = await ZarrDataManager.getVariableInfoByDatasetSources(
      sources,
      cellPath
    ).catch(() => undefined);
    if (coordinate) {
      const key = `${sources.selectedLevel ?? 0}:${cellPath}`;
      if (cellsReader?.key !== key) {
        // the reader keeps reading this level, whatever is selected later
        const level = { ...sources };
        cellsReader = {
          key,
          cells: createSortedCells(
            coordinate.shape[0],
            coordinate.chunks[0],
            async (start, end) =>
              (await fetchHealpixVariableData(
                [zarr.slice(start, end)],
                cellPath,
                level
              )) as ArrayLike<number | bigint>
          ),
        };
      }
      windowable = await cellsReader.cells.isAscending();
      cells = windowable ? cellsReader.cells : undefined;
    } else {
      windowable = cellCount === 12 * grid.nside ** 2;
    }
  }
  // Nothing below waits: a view change in between never sees half of two
  // levels.
  healpixGrid.value = grid;
  levelCellCount = cellCount;
  levelWindowable = windowable;
  sortedCells = cells;
  loadedBlocks = loadsByView() ? viewBlocks(VIEW_WINDOW_MARGIN) : undefined;
}

/** The stored cells with ids in a nested range, and their values. */
async function fetchCellRange(
  range: { start: number; end: number },
  indices: (number | zarr.Slice | null)[]
) {
  // Dense levels store cell `n` at index `n`; sparse ones are searched.
  const start = sortedCells
    ? await sortedCells.lowerBound(range.start)
    : range.start;
  const end = sortedCells ? await sortedCells.lowerBound(range.end) : range.end;
  if (start === end) {
    return { data: new Float32Array(), cells: [] as number[] };
  }
  const selection = indices.slice();
  selection[selection.length - 1] = zarr.slice(start, end);
  const cells = sortedCells
    ? await sortedCells.slice(start, end)
    : Array.from({ length: end - start }, (_, index) => start + index);
  if (cells[0] < range.start || cells[cells.length - 1] >= range.end) {
    throw new Error("The cell coordinate is not in ascending order.");
  }
  return {
    data: castDataVarToFloat32(await fetchHealpixVariableData(selection)),
    cells,
  };
}

/** The cells of one face that the loaded blocks hold, and their values. */
async function fetchFaceBlocks(
  faceIndex: number,
  grid: healpixGeo.Grid,
  indices: (number | zarr.Slice | null)[]
) {
  const blockLevel = healpixBlockLevel(grid.level);
  const ranges = healpixBlockRanges(
    loadedBlocks!.filter(
      (block) => Math.floor(block / 4 ** blockLevel) === faceIndex
    ),
    4 ** (grid.level - blockLevel)
  );
  const parts = await Promise.all(
    ranges.map((range) => fetchCellRange(range, indices))
  );
  let length = 0;
  for (const part of parts) {
    length += part.data.length;
  }
  const data = new Float32Array(length);
  const cells: number[] = [];
  for (const part of parts) {
    data.set(part.data, cells.length);
    for (const cell of part.cells) {
      cells.push(cell);
    }
  }
  return { data, cells };
}

function fetchHealpixVariableData(
  selection: (number | zarr.Slice | null)[],
  variable = varnameSelector.value,
  sources = props.datasources!
) {
  return getGridVariableData({
    source: ZarrDataManager.getDatasetSource(sources, varnameSelector.value),
    variable,
    format: sources.zarr_format,
    selection,
  });
}

function createGeometry({
  positionValues,
  uv,
  latLonValues,
  indices,
}: THealpixBatch) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positionValues, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  // Add latLon attribute for GPU projection
  geometry.setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute(latLonValues, 2)
  );
  return createTriangleWrapProjectionGeometry(geometry);
}

function fitCameraToCells(grid: healpixGeo.Grid, cells: number[] | undefined) {
  if (!cells || disposed) {
    return;
  }
  const regions = [];
  for (let face = 0; face < HEALPIX_NUMCHUNKS; face++) {
    const rect = getHealpixFaceDataRect(face, grid.nside, cells);
    if (rect) {
      regions.push({
        geometry: new THREE.BufferGeometry().setAttribute(
          "latLon",
          new THREE.BufferAttribute(
            buildHealpixRegionCoordinates(grid, face, rect),
            2
          )
        ),
      });
    }
  }
  // Cell coordinates describe the entire cutout before any face data is loaded.
  fitCameraToDataset(regions);
}

async function showMagnitude(scalar: TVectorMagnitudeData) {
  const context = lastStreamlineContext;
  if (!context) {
    return;
  }
  await scalarCache.showMagnitude(scalar, () => {
    const { grid, cellCoord } = context;
    const textures: THealpixTexture[] = [];
    for (let faceIndex = 0; faceIndex < HEALPIX_NUMCHUNKS; faceIndex++) {
      const range = getHealpixFaceRange(faceIndex, grid.nside, cellCoord);
      if (range.start === range.end) {
        continue;
      }
      textures.push({
        batchIndex: faceIndex,
        ...buildHealpixTexture(
          scalar.data.subarray(range.start, range.end),
          faceIndex,
          grid.nside,
          range.cells
        ),
      });
    }
    return () => textures.forEach((texture) => updateHealpixTexture(texture));
  });
}

async function prepareDimensionData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const dimensionNames = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  selectedDimensionNames.value = dimensionNames;
  const { dimensionRanges, indices } = buildDimensionRangesAndIndices(
    datavar,
    dimensionNames,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    [datavar.shape.length - 1],
    varinfo.value?.dimRanges
  );

  return { dimensionRanges, indices };
}

function makeHealpixVectorField(
  grid: healpixGeo.Grid,
  cellCoord: number[] | undefined,
  uValues: Float32Array,
  vValues: Float32Array
) {
  const cellIndex = cellCoord
    ? new Map(cellCoord.map((pixel, index) => [pixel, index]))
    : undefined;

  const latitudes = new Float32Array(179);
  const longitudes = new Float32Array(360);

  const nCoords = latitudes.length * longitudes.length;
  const bytesPerElement = 8;
  const pageSize = 65536;
  const memory = new WebAssembly.Memory({
    initial: Math.ceil((2 * nCoords * bytesPerElement) / pageSize),
  });
  const coords = new Float64Array(memory.buffer);

  for (let index = 0; index < nCoords; index++) {
    let y = Math.floor(index / 360);
    let x = index % 360;

    const lon = x - 180;
    const lat = y - 89;

    coords[2 * index] = lon;
    coords[2 * index + 1] = lat;

    longitudes[x] = lon;
    latitudes[y] = lat;
  }

  const nestedGrid = grid.replace({ scheme: "nested" });
  let pixels = nestedGrid.lonLatToHealpix(coords);

  const uData = new Float32Array(nCoords);
  const vData = new Float32Array(nCoords);

  for (let outputIndex = 0; outputIndex < pixels.length; outputIndex++) {
    const pixel = Number(pixels[outputIndex]); // assume this never exceeds 2^53 - 1, which is true for level < 25
    const inputIndex = cellIndex ? cellIndex.get(pixel) : pixel;
    const u = inputIndex === undefined ? NaN : uValues[inputIndex];
    const v = inputIndex === undefined ? NaN : vValues[inputIndex];
    uData[outputIndex] = u === HEALPIX_UNSEEN ? NaN : u;
    vData[outputIndex] = v === HEALPIX_UNSEEN ? NaN : v;
  }

  return new RegularVectorField(latitudes, longitudes, uData, vData);
}

// eslint-disable-next-line max-lines-per-function
async function updateStreamlines(
  context: TStreamlineContext,
  reuseCached = false
) {
  const requestRevision = ++streamlineRequestRevision;
  const variableNames = Object.keys(
    (props.datasources && currentLevel(props.datasources)?.datasources) ?? {}
  );
  const pair = resolveVectorVariablePair(
    variableNames,
    varnameSelector.value,
    store.streamlineSelection,
    store.isStreamlineLayerEnabled() ? store.streamlinePair : undefined
  );
  if (!pair || !props.datasources) {
    cachedMagnitude = undefined;
    cachedStreamlineKey = undefined;
    store.setStreamlineMagnitudeInfo(undefined);
    streamlines.clear();
    return;
  }
  const requestKey = JSON.stringify({
    indices: context.indices,
    nside: context.grid.nside,
    cells: context.cellCoord
      ? [
          context.cellCoord.length,
          context.cellCoord[0],
          context.cellCoord.at(-1),
        ]
      : undefined,
    pair: [pair.u, pair.v],
    level: store.streamlineLevelIndex,
  });
  if (
    reuseCached &&
    requestKey === cachedStreamlineKey &&
    streamlines.showCached()
  ) {
    if (store.streamlineMagnitudeDisplayed && cachedMagnitude) {
      await showMagnitude(cachedMagnitude);
    }
    return;
  }
  const nside = context.grid.nside;

  if (!store.isStreamlineLayerEnabled()) {
    if (requestKey === cachedStreamlineKey) {
      store.setStreamlinePair(pair);
    } else {
      cachedMagnitude = undefined;
      cachedStreamlineKey = undefined;
      store.setStreamlineMagnitudeInfo(undefined);
      streamlines.setAvailablePair(pair);
    }
    return;
  }
  if (loadedBlocks) {
    // only a level picked by hand that is over the whole-level cap gets here
    cachedMagnitude = undefined;
    cachedStreamlineKey = undefined;
    store.setStreamlineMagnitudeInfo(undefined);
    streamlines.clear(STREAMLINES_NEED_WHOLE_LEVEL);
    return;
  }
  streamlines.startLoading();
  try {
    const expectedDataLength = context.cellCoord?.length ?? 12 * nside * nside;
    const components = await loadVectorComponents({
      pair,
      datasources: props.datasources,
      getDataVar,
      currentDimensionNames: selectedDimensionNames.value,
      currentIndices: context.indices,
      spatialDimensionNames: [selectedDimensionNames.value.at(-1)!],
      expectedDataLength,
      selectedLevelIndex: store.streamlineLevelIndex,
    });
    if (requestRevision !== streamlineRequestRevision) {
      return;
    }
    store.setStreamlineLevelInfo(components?.levelInfo);
    store.setStreamlineMagnitudeInfo(
      components?.magnitudeInfo,
      components?.canDeriveMagnitude
    );
    if (!components || components.incompatibility !== undefined) {
      cachedMagnitude = undefined;
      cachedStreamlineKey = undefined;
      streamlines.clear(components?.incompatibility);
      return;
    }
    if (
      !(await streamlines.prepareField(
        () => requestRevision === streamlineRequestRevision
      ))
    ) {
      return;
    }
    const magnitude =
      components.magnitudeInfo && components.canDeriveMagnitude
        ? createVectorMagnitudeData(
            components.uData,
            components.vData,
            components.magnitudeInfo
          )
        : undefined;
    const rendered = await streamlines.setField(
      makeHealpixVectorField(
        context.grid,
        context.cellCoord,
        components.uData,
        components.vData
      ),
      pair,
      () => requestRevision === streamlineRequestRevision,
      async () => {
        if (store.streamlineMagnitudeDisplayed && magnitude) {
          await showMagnitude(magnitude);
        } else {
          await scalarCache.restoreScalar();
        }
      }
    );
    if (!rendered || requestRevision !== streamlineRequestRevision) {
      return;
    }
    cachedMagnitude = magnitude;
    cachedStreamlineKey = requestKey;
  } catch (error) {
    if (requestRevision === streamlineRequestRevision) {
      streamlines.clear();
      logError(error, "Could not render vector streamlines");
    }
  }
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

function disposeHealpixMesh(batchIndex: number, target = mainMeshes) {
  const mesh = target[batchIndex];
  if (!mesh) {
    return;
  }
  mesh.geometry.dispose();
  const mat = mesh.material as THREE.ShaderMaterial;
  if (mat) {
    if (mat.uniforms?.data?.value?.dispose) {
      mat.uniforms.data.value.dispose();
    }
    mat.dispose();
  }
  getScene()?.remove(mesh);
  target[batchIndex] = undefined;
}

function createHealpixMesh(
  batchIndex: number,
  geometry: THREE.InstancedBufferGeometry,
  target = mainMeshes
) {
  const { addOffset, scaleFactor } = getColormapScaleOffset(
    store.selection?.low as number,
    store.selection?.high as number,
    invertColormap.value
  );
  const material = makeGpuProjectedTextureMaterial(
    new THREE.Texture(),
    colormap.value,
    addOffset,
    scaleFactor
  );
  material.uniforms.useTriangleWrapCull.value = 1;
  const mesh = createWrappedProjectionMesh(
    geometry,
    material,
    projectionHelper.value.type
  );
  mesh.frustumCulled = false;
  if (target === backdropMeshes) {
    // after the layers stacked below the grid (-1 and down), before the grid
    mesh.renderOrder = -0.5;
  }
  target[batchIndex] = mesh;
  getScene()?.add(mesh);
  return mesh;
}

function updateHealpixBatch(batch: THealpixBatch, target = mainMeshes) {
  if (batch.width === 0 || batch.height === 0) {
    // No cells of a regional/sparse dataset fall in this face.
    disposeHealpixMesh(batch.batchIndex, target);
    return;
  }
  const geometry = createGeometry(batch);
  let mesh = target[batch.batchIndex];
  if (mesh) {
    mesh.geometry.dispose();
    setupProjectionGeometryWrap(geometry);
    mesh.geometry = geometry;
  } else {
    mesh = createHealpixMesh(batch.batchIndex, geometry, target);
  }
  updateHealpixTexture(batch, target);
  updateMeshProjectionUniforms();
}

type THealpixTexture = Pick<
  THealpixBatch,
  "batchIndex" | "dataValues" | "width" | "height" | "dataRect"
>;

function updateHealpixTexture(batch: THealpixTexture, target = mainMeshes) {
  const mesh = target[batch.batchIndex];
  if (!mesh) {
    return;
  }
  mesh.userData.dataRect = batch.dataRect;
  const material = mesh.material as THREE.ShaderMaterial;
  material.uniforms.data.value.dispose();
  const texture = new THREE.DataTexture(
    batch.dataValues,
    batch.width,
    batch.height,
    THREE.RedFormat,
    THREE.FloatType,
    THREE.UVMapping
  );
  texture.needsUpdate = true;
  material.uniforms.data.value = texture;
  material.uniforms.dataUvOffset.value.set(batch.dataRect.u, batch.dataRect.v);
  material.uniforms.dataUvScale.value.set(
    batch.dataRect.width,
    batch.dataRect.height
  );
  // Only crop to the rect when it's a genuine sub-region of the face (a
  // regional/sparse dataset); a full face has nothing to discard around.
  material.uniforms.clipToDataRect.value =
    batch.dataRect.width < 1 || batch.dataRect.height < 1 ? 1 : 0;
}

// eslint-disable-next-line max-lines-per-function
async function processHealpixChunks(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  cells: number[] | undefined,
  grid: healpixGeo.Grid,
  indices: (number | zarr.Slice | null)[],
  deferDisplay: boolean,
  isCurrent: () => boolean,
  // the backdrop reads another level, whole
  sources = props.datasources!,
  byView = loadedBlocks !== undefined
) {
  let dataMin = Number.POSITIVE_INFINITY;
  let dataMax = Number.NEGATIVE_INFINITY;
  const histogramSummaries: THistogramSummary[] = [];
  const textures: THealpixTexture[] = [];
  const batches: THealpixBatch[] = [];
  const helper = projectionHelper.value;
  const options = {
    grid: {
      scheme: grid.scheme,
      level: grid.level,
      ellipsoid: {
        // eslint-disable-next-line camelcase
        semi_major_axis: grid.semiMajorAxis,
        // eslint-disable-next-line camelcase
        semi_minor_axis: grid.semiMajorAxis * (1 - grid.flattening),
      },
    },
    attributes: datavar.attrs,
    ...getHealpixMissingAndFillValues(datavar),
    projectionType: helper.type,
    projectionCenter: { lat: helper.center.lat, lon: helper.center.lon },
  };
  if (!deferDisplay) {
    clearHoverLookup();
  }
  // Read one face at a time; with streamlines, stage the complete replacement.
  for (let faceIndex = 0; faceIndex < HEALPIX_NUMCHUNKS; faceIndex++) {
    if (disposed || !isCurrent()) {
      return;
    }
    const range = getHealpixFaceRange(faceIndex, grid.nside, cells);
    const selection = indices.slice();
    selection[selection.length - 1] = zarr.slice(range.start, range.end);
    const face = byView
      ? await fetchFaceBlocks(faceIndex, grid, indices)
      : {
          data:
            range.start === range.end
              ? new Float32Array()
              : castDataVarToFloat32(
                  await fetchHealpixVariableData(selection, undefined, sources)
                ),
          cells: range.cells,
        };
    if (disposed || !isCurrent()) {
      return;
    }
    const batch = await buildHealpixFace({ ...options, faceIndex, ...face });
    const summary = batch.histogramSummary;
    histogramSummaries.push(summary);
    dataMin = dataMin > summary.min ? summary.min : dataMin;
    dataMax = dataMax < summary.max ? summary.max : dataMax;
    textures.push({
      batchIndex: batch.batchIndex,
      dataValues: batch.dataValues,
      width: batch.width,
      height: batch.height,
      dataRect: batch.dataRect,
    });
    if (!isCurrent()) {
      return;
    }
    if (deferDisplay) {
      batches.push(batch);
    } else {
      updateHealpixBatch(batch);
    }
  }
  return { dataMin, dataMax, histogramSummaries, textures, batches };
}

/** Load the coarsest level at the selected slice, unless it is on screen. */
async function loadBackdrop(
  indices: (number | zarr.Slice | null)[],
  isCurrent: () => boolean
) {
  const sources = props.datasources!;
  const level = coarsestLevel(sources.levels);
  if (level === undefined || level === (sources.selectedLevel ?? 0)) {
    return undefined;
  }
  const key = JSON.stringify([level, varnameSelector.value, indices]);
  if (backdropFrame?.key === key) {
    return backdropFrame;
  }
  const coarse = { ...sources, selectedLevel: level };
  const datavar = await getDataVar(varnameSelector.value, coarse);
  if (!datavar) {
    return undefined;
  }
  const result = await processHealpixChunks(
    datavar,
    await getCells(coarse),
    await getHealpixGridParameters(coarse),
    indices,
    true,
    isCurrent,
    coarse,
    false
  );
  if (!result) {
    return undefined;
  }
  backdropFrame = {
    key,
    min: result.dataMin,
    max: result.dataMax,
    histogramSummaries: result.histogramSummaries,
    batches: result.batches,
  };
  return backdropFrame;
}

/** Draw the coarsest level under a level that leaves part of the view empty. */
function showBackdrop(frame: TBackdropFrame | undefined) {
  const dense = levelCellCount === 12 * unpackGrid().nside ** 2;
  const wanted = frame && (loadedBlocks || !dense) ? frame : undefined;
  if (backdropKey === wanted?.key) {
    return;
  }
  backdropKey = wanted?.key;
  for (let face = 0; face < HEALPIX_NUMCHUNKS; face++) {
    disposeHealpixMesh(face, backdropMeshes);
  }
  wanted?.batches.forEach((batch) => updateHealpixBatch(batch, backdropMeshes));
}

/**
 * A level is drawn after its backdrop and over it whatever the depth says:
 * up close the two surfaces are nearer than float32 positions can order.
 */
function drawOverBackdrop() {
  for (const mesh of mainMeshes) {
    if (mesh) {
      (mesh.material as THREE.ShaderMaterial).depthFunc = backdropKey
        ? THREE.AlwaysDepth
        : THREE.LessEqualDepth;
    }
  }
}

function healpixHoverLookup(
  lat: number,
  lon: number
): TGridHoverLookupResult | null {
  let grid;
  try {
    grid = unpackGrid();
  } catch {
    return null;
  }

  const normalizedLon = ProjectionHelper.normalizeLongitude(lon);
  const coords = new Float64Array([normalizedLon, lat]);
  const pixelIndices = grid.lonLatToHealpix(coords);
  const pixelIndex = pixelIndices[0];

  const pixel = Number(pixelIndex);
  const faceSize = grid.nside * grid.nside;
  const mesh = mainMeshes[Math.floor(pixel / faceSize)];
  if (!mesh) {
    return null;
  }
  const texture = (mesh.material as THREE.ShaderMaterial).uniforms.data
    .value as THREE.DataTexture;
  // Hover reads the same array as the texture, without retaining a second 3 GiB grid.
  const data = texture.image.data as Float32Array;
  const dataRect = mesh.userData.dataRect as THealpixDataRect;
  const { x, y } = decodeHealpixFaceXY(pixel % faceSize);
  const localX = x - Math.round(dataRect.u * grid.nside);
  const localY = y - Math.round(dataRect.v * grid.nside);
  const value =
    localX < 0 ||
    localX >= texture.image.width ||
    localY < 0 ||
    localY >= texture.image.height
      ? NaN
      : data[localY * texture.image.width + localX];
  const pixelAngles = grid.healpixToLonLat(pixelIndices);

  const isMissing = !Number.isFinite(value) || value === HEALPIX_UNSEEN;
  return {
    lat: pixelAngles[1],
    lon: ProjectionHelper.normalizeLongitude(pixelAngles[0]),
    value: isMissing ? null : value,
    status: isMissing
      ? HOVERED_GRID_POINT_STATUS.MISSING
      : HOVERED_GRID_POINT_STATUS.VALUE,
  };
}

// eslint-disable-next-line max-lines-per-function
async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  isCurrent: () => boolean,
  stageDisplay: boolean
) {
  const deferDisplay = store.isStreamlineLayerEnabled() || stageDisplay;
  const grid = unpackGrid();

  // A level loaded by view never reads its whole `cell` coordinate.
  const cellCoord = loadedBlocks ? undefined : await getCells();
  fitCameraToCells(grid, cellCoord);
  const { dimensionRanges, indices } = await prepareDimensionData(datavar);
  // One after the other: the face worker runs a single build at a time.
  const backdropData = await loadBackdrop(indices, isCurrent).catch(
    () => undefined
  );
  const result = await processHealpixChunks(
    datavar,
    cellCoord,
    grid,
    indices,
    deferDisplay,
    isCurrent
  );
  if (!result) {
    return;
  }
  const { dataMin, dataMax, histogramSummaries, textures, batches } = result;

  lastStreamlineContext = { indices, grid, cellCoord };
  volume.setContext(
    loadedBlocks
      ? undefined
      : {
          dimensionNames: selectedDimensionNames.value,
          indices,
          grid: {
            kind: VOLUME_GRID_TYPES.HEALPIX,
            nside: grid.nside,
            cellCoordinates: cellCoord
              ? Float64Array.from(cellCoord)
              : undefined,
            options: {
              scheme: grid.scheme,
              level: grid.level,
              ellipsoid: {
                // eslint-disable-next-line camelcase
                semi_major_axis: grid.semiMajorAxis,
                // eslint-disable-next-line camelcase
                semi_minor_axis: grid.semiMajorAxis * (1 - grid.flattening),
              },
            },
          },
        }
  );

  if (!isCurrent()) {
    return;
  }
  const dimInfo = await getDimensionValues(dimensionRanges, indices);

  const scalarInfo = {
    attrs: datavar.attrs,
    dimInfo,
    bounds: {
      low: backdropData?.min ?? dataMin,
      high: backdropData?.max ?? dataMax,
    },
    dimRanges: dimensionRanges,
  };
  let geometryPending = deferDisplay;
  const renderScalar = () => {
    showBackdrop(backdropData);
    if (geometryPending) {
      batches.forEach((batch) => updateHealpixBatch(batch));
      batches.length = 0;
      geometryPending = false;
    } else {
      textures.forEach((texture) => updateHealpixTexture(texture));
    }
    drawOverBackdrop();
    setHoverLookup(healpixHoverLookup);
  };
  if (!isCurrent()) {
    return;
  }
  scalarCache.captureScalar({
    render: renderScalar,
    info: scalarInfo,
    indices: indices as number[],
    data: backdropData?.histogramSummaries ?? histogramSummaries,
    isCurrent,
  });
  await updateStreamlines(lastStreamlineContext);
  if (isCurrent() && !store.streamlineMagnitudeDisplayed) {
    await scalarCache.restoreScalar();
  }
}

onBeforeMount(async () => {
  await datasourceUpdate();
  gridPrepared.value = true;
});

onBeforeUnmount(() => {
  disposed = true;
  streamlineRequestRevision++;
  terminateHealpixWorker();
  terminateGridDataWorker();
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    disposeHealpixMesh(ipix);
    disposeHealpixMesh(ipix, backdropMeshes);
  }
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
