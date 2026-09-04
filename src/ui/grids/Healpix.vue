<script lang="ts" setup>
import * as healpixGeo from "healpix-geo";
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { onBeforeMount, onBeforeUnmount, ref, watch } from "vue";
import * as zarr from "zarrita";

import {
  useGridHoverLookup,
  type TGridHoverLookupResult,
} from "./composables/gridHoverUtils.ts";
import { loadVectorComponents } from "./composables/streamlineData.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";
import { useStreamlineLayer } from "./composables/useStreamlineLayer.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
  decodeVariableDataInPlace,
  getFillValue,
  getMissingValue,
} from "@/lib/data/variableDecoding.ts";
import {
  RegularVectorField,
  resolveVectorVariablePair,
} from "@/lib/data/vectorField.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { terminateGridDataWorker } from "@/lib/grids/gridDataWorkerClient.ts";
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
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import {
  HOVERED_GRID_POINT_STATUS,
  useGlobeControlStore,
} from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";
import {
  HISTOGRAM_SUMMARY_BINS,
  buildHistogramSummary,
  type THistogramSummary,
} from "@/utils/histogram.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

// By convention, HEALPIX uses -1.6375e+30 to mark invalid or unseen pixels.
const HEALPIX_UNSEEN = -1.6375e30;

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
  redraw,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
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

const hoverData = ref<Float32Array | null>(null);
const hoverCellIndexMap = ref<Map<bigint, number> | null>(null);
const hoverNside = ref<number | null>(null);
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

const HEALPIX_NUMCHUNKS = 12;

let mainMeshes: Array<THREE.Mesh | undefined> = new Array(HEALPIX_NUMCHUNKS);

onColormapChange(() => updateColormap(mainMeshes));

onProjectionChange(updateMeshProjectionUniforms);
onMotionStateChange(updateMeshProjectionUniforms);

const streamlines = useStreamlineLayer({
  getScene,
  redraw,
  projectionHelper,
  onProjectionChange,
  registerAnimationCallback,
});

/**
 * Update projection uniforms on all mesh materials.
 * This is the fast path - no geometry rebuild needed.
 */
function updateMeshProjectionUniforms() {
  updateProjectionMeshes(mainMeshes, {
    redraw,
    projectionHelper: projectionHelper.value,
    isSceneInMotion: isSceneInMotion.value,
  });
}

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  clearHoverLookup,
  prepareDatasource: fetchGrid,
  updateLandSeaMask,
  updateColormap: () => updateColormap(mainMeshes),
  refreshStreamlines: async (reuseCached) => {
    if (reuseCached && streamlines.showCached()) {
      return;
    }
    if (lastStreamlineContext) {
      await updateStreamlines(lastStreamlineContext);
    }
  },
});

function fetchGrid() {
  const grid = unpackGrid();
  const textureGrid = grid.replace({ level: 0, scheme: "nested" });

  const gridStep = 64 + 1;
  try {
    for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ipix++) {
      const { geometry } = makeHealpixGeometry(
        textureGrid,
        BigInt(ipix),
        gridStep,
        projectionHelper.value
      );
      const mesh = mainMeshes[ipix];
      if (!mesh) {
        continue;
      }
      mesh.geometry.dispose();
      setupProjectionGeometryWrap(geometry);
      mesh.geometry = geometry;
    }
    // Update projection uniforms after geometry change
    updateMeshProjectionUniforms();
    redraw();
  } catch (error) {
    logError(error, "Could not fetch grid");
  }
}

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

async function gridFromEasygemsConvention(): Promise<healpixGeo.Grid | null> {
  try {
    const crs = await ZarrDataManager.getCRSInfo(
      props.datasources!,
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

async function gridFromDggsConvention(): Promise<healpixGeo.Grid | null> {
  const metadata = await ZarrDataManager.getDggsMetadata(
    props.datasources!,
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

async function getHealpixGridParameters(): Promise<healpixGeo.Grid> {
  const fromEasygems = await gridFromEasygemsConvention();
  if (fromEasygems !== null) {
    return fromEasygems;
  }

  const fromDggsConvention = await gridFromDggsConvention();
  if (fromDggsConvention !== null) {
    return fromDggsConvention;
  }

  // last resort: assume nested / spherical and infer level from a global grid's cell count (12 * 4^level)
  const datavar = await ZarrDataManager.getVariableInfo(
    ZarrDataManager.getDatasetSource(props.datasources!, varnameSelector.value),
    varnameSelector.value
  );
  const fromShape = await inferGridFromCellCount(datavar);
  if (fromShape !== null) {
    return fromShape;
  }

  throw new Error(
    "Could not determine HEALPix grid parameters: no valid convention metdata on the grid mapping variable" +
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

async function getCells() {
  let cellCoord = "cell";
  const dggsMetadata = await ZarrDataManager.getDggsMetadata(
    props.datasources!,
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

  try {
    const rawCells = (
      await ZarrDataManager.getVariableData(
        ZarrDataManager.getDatasetSource(
          props.datasources!,
          varnameSelector.value
        ),
        ZarrDataManager.resolveVariablePath(varnameSelector.value, cellCoord)
      )
    ).data as ArrayLike<number | bigint>;

    return Array.from(rawCells, (cell) => Number(cell));
  } catch {
    return undefined;
  }
}

function getHealpixChunkRange(
  ipix: number,
  numChunks: number,
  grid: healpixGeo.Grid
) {
  const nside = grid.nside;

  const chunksize = (12 * nside * nside) / numChunks;
  const pixelStart = ipix * chunksize;
  const pixelEnd = (ipix + 1) * chunksize;

  return { chunksize, pixelStart, pixelEnd };
}

async function fillGlobalHealpixChunkData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  localDimensionIndices: (number | zarr.Slice | null)[],
  pixelStart: number,
  pixelEnd: number,
  dataSlice: Float32Array
) {
  localDimensionIndices[localDimensionIndices.length - 1] = zarr.slice(
    pixelStart,
    pixelEnd
  );
  const data = (
    await ZarrDataManager.getVariableDataFromArray(
      datavar,
      localDimensionIndices
    )
  ).data as Float32Array;

  dataSlice.set(data);
}

async function fillLimitedAreaHealpixChunkData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  cellCoord: number[],
  localDimensionIndices: (number | zarr.Slice | null)[],
  pixelStart: number,
  pixelEnd: number,
  dataSlice: Float32Array
) {
  // Limited-area data case: need to map cellCoord to global positions
  dataSlice.fill(NaN);

  // Find which indices in cellCoord fall within this chunk's range
  const relevantIndices: number[] = [];
  const localPositions: number[] = [];

  for (let i = 0; i < cellCoord.length; i++) {
    const globalPixel = cellCoord[i];
    if (globalPixel >= pixelStart && globalPixel < pixelEnd) {
      relevantIndices.push(i); // Index in the data array
      localPositions.push(globalPixel - pixelStart); // Position in chunk
    }
  }

  // Only fetch data if this chunk has any relevant cells
  if (relevantIndices.length === 0) {
    return;
  }

  // Check if indices are contiguous for optimization
  const start = relevantIndices[0];
  const end = relevantIndices[relevantIndices.length - 1] + 1;
  localDimensionIndices[localDimensionIndices.length - 1] = zarr.slice(
    start,
    end
  );
  const data = (
    await ZarrDataManager.getVariableDataFromArray(
      datavar,
      localDimensionIndices
    )
  ).data as Float32Array;
  const isContiguous =
    relevantIndices.length > 1 &&
    relevantIndices[relevantIndices.length - 1] - relevantIndices[0] ===
      relevantIndices.length - 1;

  if (isContiguous) {
    // Contiguous: use slice for efficient fetching
    for (let i = 0; i < relevantIndices.length; i++) {
      dataSlice[localPositions[i]] = data[i];
    }
  } else {
    // Non-contiguous: fetch the entire range and skip what we don't need
    for (let i = 0; i < relevantIndices.length; i++) {
      const dataIdx = relevantIndices[i] - start;
      dataSlice[localPositions[i]] = data[dataIdx];
    }
  }
}

async function fillHealpixChunkData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  cellCoord: number[] | undefined,
  localDimensionIndices: (number | zarr.Slice | null)[],
  pixelStart: number,
  pixelEnd: number,
  dataSlice: Float32Array
) {
  if (cellCoord === undefined) {
    await fillGlobalHealpixChunkData(
      datavar,
      localDimensionIndices,
      pixelStart,
      pixelEnd,
      dataSlice
    );
  } else {
    await fillLimitedAreaHealpixChunkData(
      datavar,
      cellCoord,
      localDimensionIndices,
      pixelStart,
      pixelEnd,
      dataSlice
    );
  }
}

async function getHealpixData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  cellCoord: number[] | undefined, // Optional - undefined for global data
  ipix: number,
  numChunks: number,
  grid: healpixGeo.Grid,
  dimensionIndices: (number | zarr.Slice | null)[]
) {
  const localDimensionIndices = dimensionIndices.slice();
  const { chunksize, pixelStart, pixelEnd } = getHealpixChunkRange(
    ipix,
    numChunks,
    grid
  );
  const dataSlice = new Float32Array(chunksize);

  await fillHealpixChunkData(
    datavar,
    cellCoord,
    localDimensionIndices,
    pixelStart,
    pixelEnd,
    dataSlice
  );

  const { missingValue, fillValue } = getHealpixMissingAndFillValues(datavar);
  const { min, max } = decodeVariableDataAndGetBounds(
    datavar,
    dataSlice,
    missingValue,
    fillValue
  );

  // Filter out missing and fill values before building histogram
  return {
    texture: data2texture(dataSlice, {}),
    histogramSummary: buildHistogramSummary(
      dataSlice,
      min,
      max,
      HISTOGRAM_SUMMARY_BINS,
      fillValue,
      missingValue
    ),
    min,
    max,
    missingValue,
    fillValue,
  };
}

function distanceSquared(
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number
): number {
  return (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1) + (z2 - z1) * (z2 - z1);
}

function createGeometry(
  positionValues: Float32Array,
  uv: Float32Array,
  latLonValues: Float32Array,
  indices: number[]
) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(indices);
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

function generateHealpixIndices(positionValues: Float32Array, steps: number) {
  const indices = [];
  for (let i = 0; i < steps - 1; ++i) {
    for (let j = 0; j < steps - 1; ++j) {
      const a = i * steps + (j + 1);
      const b = i * steps + j;
      const c = (i + 1) * steps + j;
      const d = (i + 1) * steps + (j + 1);
      const dac2 = distanceSquared(
        positionValues[3 * a + 0],
        positionValues[3 * a + 1],
        positionValues[3 * a + 2],
        positionValues[3 * c + 0],
        positionValues[3 * c + 1],
        positionValues[3 * c + 2]
      );
      const dbd2 = distanceSquared(
        positionValues[3 * b + 0],
        positionValues[3 * b + 1],
        positionValues[3 * b + 2],
        positionValues[3 * d + 0],
        positionValues[3 * d + 1],
        positionValues[3 * d + 2]
      );
      if (dac2 < dbd2) {
        indices.push(a, c, d);
        indices.push(b, c, a);
      } else {
        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }
  }
  return indices;
}

function makeHealpixGeometry(
  grid: healpixGeo.Grid,
  ipix: bigint,
  steps: number,
  helper: ProjectionHelper
) {
  const vertexCount = steps * steps;
  const positionValues = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const latitudes = new Float32Array(vertexCount);
  const longitudes = new Float32Array(vertexCount);
  const latLonValues = new Float32Array(vertexCount * 2);
  let vertexIndex = 0;

  const coords = grid.vertices(BigInt(ipix), steps);
  for (let index = 0; index < Math.floor(coords.length / 2); ++index) {
    let indexLon = 2 * index;
    let indexLat = 2 * index + 1;
    const lat = coords[indexLat];
    const lon = coords[indexLon];

    const u = Math.floor(index / steps) / (steps - 1);
    const v = (index % steps) / (steps - 1);

    latitudes[vertexIndex] = lat;
    longitudes[vertexIndex] = lon;

    const positionOffset = vertexIndex * 3;
    helper.projectLatLonToArrays(
      lat,
      lon,
      positionValues,
      positionOffset,
      latLonValues,
      vertexIndex * 2
    );

    const uvIndex = vertexIndex * 2;
    uv[uvIndex] = u;
    uv[uvIndex + 1] = v;

    vertexIndex++;
  }

  const indices = generateHealpixIndices(positionValues, steps);
  const geometry = createGeometry(positionValues, uv, latLonValues, indices);
  return { geometry, latitudes, longitudes };
}

function getUnshuffleIndex(
  size: number,
  unshuffleIndex: { [key: number]: Float32Array }
): Float32Array {
  if (unshuffleIndex[size] === undefined) {
    const grid = unpackGrid();

    const temp = grid.bitCombineTable(size);

    // this will fail for chunks with a size greater than 16777215, which is about a base cell at level 11-12
    const table = new Float32Array(temp.length);
    temp.forEach((value, index) => {
      table[index] = Number(value);
    });

    unshuffleIndex[size] = table;
  }
  return unshuffleIndex[size];
}

function unshuffleMortonArray(
  arr: Float32Array,
  unshuffleIndex: { [key: number]: Float32Array }
): Float32Array {
  const out = arr.slice(); // makes a copy
  const size = Math.floor(Math.sqrt(arr.length));
  const uidx = getUnshuffleIndex(size, unshuffleIndex);
  for (let i = 0; i < out.length; ++i) {
    out[i] = arr[uidx[i]];
  }
  return out;
}

function data2texture(
  arr: Float32Array,
  unshuffleIndex: { [key: number]: Float32Array }
) {
  const size = Math.floor(Math.sqrt(arr.length));
  arr = castDataVarToFloat32(arr);
  const mortonArr = unshuffleMortonArray(arr, unshuffleIndex);
  const texture = new THREE.DataTexture(
    mortonArr,
    size,
    size,
    THREE.RedFormat,
    THREE.FloatType,
    THREE.UVMapping
  );
  texture.needsUpdate = true;
  return texture;
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
async function updateStreamlines(context: TStreamlineContext) {
  const requestRevision = ++streamlineRequestRevision;
  const variableNames = Object.keys(
    props.datasources?.levels[0]?.datasources ?? {}
  );
  const pair = resolveVectorVariablePair(
    variableNames,
    varnameSelector.value,
    store.streamlineSelection
  );
  if (!pair || !props.datasources) {
    streamlines.clear();
    return;
  }
  if (!store.isStreamlineLayerEnabled()) {
    streamlines.setAvailablePair(pair);
    return;
  }
  const nside = context.grid.nside;

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
    });
    if (requestRevision !== streamlineRequestRevision) {
      return;
    }
    if (!components) {
      streamlines.clear();
      return;
    }
    streamlines.setField(
      makeHealpixVectorField(
        context.grid,
        context.cellCoord,
        components.uData,
        components.vData
      ),
      pair
    );
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

async function processHealpixChunks(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  cellCoord: number[] | undefined,
  grid: healpixGeo.Grid,
  indices: (number | zarr.Slice | null)[]
): Promise<{
  dataMin: number;
  dataMax: number;
  histogramSummaries: THistogramSummary[];
}> {
  let dataMin = Number.POSITIVE_INFINITY;
  let dataMax = Number.NEGATIVE_INFINITY;
  const histogramSummaries: THistogramSummary[] = [];

  await Promise.all(
    [...Array(HEALPIX_NUMCHUNKS).keys()].map(async (ipix) => {
      const texData = await getHealpixData(
        datavar,
        cellCoord,
        ipix,
        HEALPIX_NUMCHUNKS,
        grid,
        indices
      );
      if (texData === undefined) {
        const mesh = mainMeshes[ipix];
        if (!mesh) {
          return;
        }
        const material = mesh.material as THREE.ShaderMaterial;
        material.uniforms.data.value.dispose();
        return;
      }

      histogramSummaries.push(texData.histogramSummary);
      dataMin = dataMin > texData.min ? texData.min : dataMin;
      dataMax = dataMax < texData.max ? texData.max : dataMax;

      const mesh = mainMeshes[ipix];
      if (!mesh) {
        return;
      }
      const material = mesh.material as THREE.ShaderMaterial;
      material.uniforms.data.value.dispose();
      material.uniforms.data.value = texData.texture;

      redraw();
    })
  );

  return { dataMin, dataMax, histogramSummaries };
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

  if (!hoverData.value) {
    return null;
  }

  const normalizedLon = ProjectionHelper.normalizeLongitude(lon);
  const coords = new Float64Array([normalizedLon, lat]);
  const pixelIndices = grid.lonLatToHealpix(coords);
  const pixelIndex = pixelIndices[0];

  const dataIndex = hoverCellIndexMap.value
    ? hoverCellIndexMap.value.get(pixelIndex)
    : Number(pixelIndex);
  if (
    dataIndex === undefined ||
    dataIndex < 0 ||
    dataIndex >= hoverData.value.length
  ) {
    return {
      lat,
      lon: normalizedLon,
      value: null,
      status: HOVERED_GRID_POINT_STATUS.MISSING,
    };
  }
  const value = hoverData.value[dataIndex];
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

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const grid = unpackGrid();

  const { dimensionRanges, indices } = await prepareDimensionData(datavar);

  const cellCoord = await getCells();
  hoverNside.value = grid.nside;
  hoverData.value = castDataVarToFloat32(
    (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
  );
  const { missingValue, fillValue } = getHealpixMissingAndFillValues(datavar);
  decodeVariableDataInPlace(
    hoverData.value,
    datavar.attrs,
    missingValue,
    fillValue
  );
  if (cellCoord) {
    const cellIndexMap = new Map<bigint, number>();
    for (let index = 0; index < cellCoord.length; index++) {
      cellIndexMap.set(BigInt(cellCoord[index]), index);
    }
    hoverCellIndexMap.value = cellIndexMap;
  } else {
    hoverCellIndexMap.value = null;
  }
  setHoverLookup(healpixHoverLookup);
  const { dataMin, dataMax, histogramSummaries } = await processHealpixChunks(
    datavar,
    cellCoord,
    grid,
    indices
  );

  updateHistogram(histogramSummaries, dataMin, dataMax);

  lastStreamlineContext = { indices, grid, cellCoord };

  const dimInfo = await getDimensionValues(dimensionRanges, indices);

  store.updateVarInfo(
    {
      attrs: datavar.attrs,
      dimInfo,
      bounds: { low: dataMin, high: dataMax },
      dimRanges: dimensionRanges,
    },
    indices as number[]
  );
  void updateStreamlines(lastStreamlineContext);
}

watch(healpixGrid, async () => {
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    const mesh = mainMeshes[ipix];
    if (mesh) {
      getScene()!.add(mesh);
    }
  }
});

onBeforeMount(async () => {
  const low = store.selection?.low as number;
  const high = store.selection?.high as number;
  const { addOffset, scaleFactor } = getColormapScaleOffset(
    low,
    high,
    invertColormap.value
  );

  const grid = await getHealpixGridParameters();
  healpixGrid.value = grid;

  const textureGrid = grid.replace({ level: 0 });

  const gridStep = 64 + 1;
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    // Use GPU-projected material for instant projection center changes
    const material = makeGpuProjectedTextureMaterial(
      new THREE.Texture(),
      colormap.value,
      addOffset,
      scaleFactor
    );
    material.uniforms.useTriangleWrapCull.value = 1;
    // Set initial projection uniforms
    const helper = projectionHelper.value;
    updateProjectionUniforms(material, helper);

    const { geometry } = makeHealpixGeometry(
      textureGrid,
      BigInt(ipix),
      gridStep,
      projectionHelper.value
    );
    const mesh = createWrappedProjectionMesh(
      geometry,
      material,
      projectionHelper.value.type
    );
    mainMeshes[ipix] = mesh;
    // Disable frustum culling - GPU projection changes actual positions
    mesh.frustumCulled = false;
  }
  await datasourceUpdate();
  gridPrepared.value = true;
});

onBeforeUnmount(() => {
  streamlineRequestRevision++;
  terminateGridDataWorker();
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    const mesh = mainMeshes[ipix];
    if (!mesh) {
      continue;
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
    mainMeshes[ipix] = undefined;
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
