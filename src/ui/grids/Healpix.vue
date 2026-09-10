<script lang="ts" setup>
import * as healpixGeo from "healpix-geo";
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { onBeforeMount, onBeforeUnmount, ref } from "vue";
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
  getFillValue,
  getMissingValue,
} from "@/lib/data/variableDecoding.ts";
import {
  RegularVectorField,
  resolveVectorVariablePair,
} from "@/lib/data/vectorField.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  getGridVariableData,
  terminateGridDataWorker,
} from "@/lib/grids/gridDataWorkerClient.ts";
import {
  HEALPIX_NUMCHUNKS,
  buildHealpixRegionCoordinates,
  decodeHealpixFaceXY,
  getHealpixFaceDataRect,
  getHealpixFaceRange,
  type THealpixDataRect,
} from "@/lib/grids/healpixCalculations.ts";
import {
  buildHealpixFace,
  terminateHealpixWorker,
} from "@/lib/grids/healpixWorkerClient.ts";
import type { THealpixBatch } from "@/lib/grids/healpixWorkerProtocol.ts";
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

let disposed = false;

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
    const rawCells = await fetchHealpixVariableData(
      [],
      ZarrDataManager.resolveVariablePath(varnameSelector.value, cellCoord)
    );

    return Array.from(rawCells, (cell) => Number(cell));
  } catch {
    return undefined;
  }
}

function fetchHealpixVariableData(
  selection: (number | zarr.Slice | null)[],
  variable = varnameSelector.value
) {
  return getGridVariableData({
    source: ZarrDataManager.getDatasetSource(
      props.datasources!,
      varnameSelector.value
    ),
    variable,
    format: props.datasources!.zarr_format,
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

function disposeHealpixMesh(batchIndex: number) {
  const mesh = mainMeshes[batchIndex];
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
  mainMeshes[batchIndex] = undefined;
}

function createHealpixMesh(
  batchIndex: number,
  geometry: THREE.InstancedBufferGeometry
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
  mainMeshes[batchIndex] = mesh;
  getScene()?.add(mesh);
  return mesh;
}

function updateHealpixBatch(batch: THealpixBatch) {
  if (batch.width === 0 || batch.height === 0) {
    // No cells of a regional/sparse dataset fall in this face.
    disposeHealpixMesh(batch.batchIndex);
    return;
  }
  const geometry = createGeometry(batch);
  let mesh = mainMeshes[batch.batchIndex];
  if (mesh) {
    mesh.geometry.dispose();
    setupProjectionGeometryWrap(geometry);
    mesh.geometry = geometry;
  } else {
    mesh = createHealpixMesh(batch.batchIndex, geometry);
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
  updateMeshProjectionUniforms();
}

// eslint-disable-next-line max-lines-per-function
async function processHealpixChunks(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  cells: number[] | undefined,
  grid: healpixGeo.Grid,
  indices: (number | zarr.Slice | null)[]
) {
  let dataMin = Number.POSITIVE_INFINITY;
  let dataMax = Number.NEGATIVE_INFINITY;
  const histogramSummaries: THistogramSummary[] = [];
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
  clearHoverLookup();
  // Read, transfer and render one face before fetching the next (256 MiB at level 13).
  for (let faceIndex = 0; faceIndex < HEALPIX_NUMCHUNKS; faceIndex++) {
    if (disposed) {
      return;
    }
    const range = getHealpixFaceRange(faceIndex, grid.nside, cells);
    const selection = indices.slice();
    selection[selection.length - 1] = zarr.slice(range.start, range.end);
    const data =
      range.start === range.end
        ? new Float32Array()
        : castDataVarToFloat32(await fetchHealpixVariableData(selection));
    if (disposed) {
      return;
    }
    const batch = await buildHealpixFace({
      ...options,
      faceIndex,
      data,
      cells: range.cells,
    });
    const summary = batch.histogramSummary;
    histogramSummaries.push(summary);
    dataMin = dataMin > summary.min ? summary.min : dataMin;
    dataMax = dataMax < summary.max ? summary.max : dataMax;
    updateHealpixBatch(batch);
  }
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

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const grid = unpackGrid();

  const cellCoord = await getCells();
  fitCameraToCells(grid, cellCoord);
  const { dimensionRanges, indices } = await prepareDimensionData(datavar);
  const result = await processHealpixChunks(datavar, cellCoord, grid, indices);
  if (!result) {
    return;
  }
  const { dataMin, dataMax, histogramSummaries } = result;
  setHoverLookup(healpixHoverLookup);
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

onBeforeMount(async () => {
  const grid = await getHealpixGridParameters();
  if (disposed) {
    return;
  }
  healpixGrid.value = grid;
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
