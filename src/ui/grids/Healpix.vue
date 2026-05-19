<script lang="ts" setup>
import * as healpix from "@hscmap/healpix";
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onMounted, ref, watch } from "vue";
import * as zarr from "zarrita";

import {
  useGridHoverLookup,
  type TGridHoverLookupResult,
} from "./composables/gridHoverUtils.ts";
import {
  createTriangleWrapProjectionGeometry,
  createWrappedProjectionMesh,
  setupProjectionGeometryWrap,
  updateProjectionMeshes,
  watchProjectionEdgeQuality,
} from "./composables/useProjectionEdgeQuality.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  castDataVarToFloat32,
  getDataBounds,
  mapMissingAndFillToNaN,
} from "@/lib/data/zarrUtils.ts";
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
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "@/store/store.ts";
import {
  HISTOGRAM_SUMMARY_BINS,
  buildHistogramSummary,
  type THistogramSummary,
} from "@/utils/histogram.ts";
import { useLog } from "@/utils/logging.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

// By convention, HEALPIX uses -1.6375e+30 to mark invalid or unseen pixels.
const HEALPIX_UNSEEN = -1.6375e30;

const store = useGlobeControlStore();
const { logError } = useLog();
const {
  varnameSelector,
  colormap,
  invertColormap,
  posterizeLevels,
  selection,
  dimSlidersValues,
  isInitializingVariable,
  varinfo,
  projectionMode,
  projectionCenter,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const {
  getScene,
  redraw,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  resetDataVars,
  getDataVar,
  fetchDimensionDetails,
  updateLandSeaMask,
  updateColormap,
  updateHistogram,
  projectionHelper,
  isSceneInMotion,
  canvas,
  box,
  hoveredGeoPoint,
} = useSharedGridLogic();

const { setHoverLookup, clearHoverLookup } =
  useGridHoverLookup(hoveredGeoPoint);

const pendingUpdate = ref(false);
const updatingData = ref(false);
const hoverData = ref<Float32Array | null>(null);
const hoverCellIndexMap = ref<Map<number, number> | null>(null);
const hoverNside = ref<number | null>(null);

const HEALPIX_NUMCHUNKS = 12;

let mainMeshes: Array<THREE.Mesh | undefined> = new Array(HEALPIX_NUMCHUNKS);

watch(
  () => varnameSelector.value,
  () => {
    getData();
  }
);

watch(
  () => dimSlidersValues.value,
  async () => {
    if (isInitializingVariable.value) {
      isInitializingVariable.value = false;
      return;
    }
    await getData(UPDATE_MODE.SLIDER_TOGGLE);
    updateColormap(mainMeshes);
  },
  { deep: true }
);

watch(
  () => props.datasources,
  () => {
    datasourceUpdate();
  }
);

const bounds = computed(() => {
  return selection.value;
});

watch(
  [
    () => bounds.value,
    () => invertColormap.value,
    () => colormap.value,
    () => posterizeLevels.value,
    () => store.hideLowerBound,
  ],
  () => {
    updateColormap(mainMeshes);
  }
);

watchProjectionEdgeQuality({
  projectionMode,
  projectionCenter,
  isSceneInMotion,
  onUpdate: updateMeshProjectionUniforms,
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

async function datasourceUpdate() {
  resetDataVars();
  clearHoverLookup();
  if (props.datasources !== undefined) {
    await Promise.all([fetchGrid(), getData()]);
    updateLandSeaMask();
    updateColormap(mainMeshes);
  }
}

function fetchGrid() {
  const gridStep = 64 + 1;
  try {
    for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ipix++) {
      const { geometry } = makeHealpixGeometry(
        1,
        ipix,
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

async function getNside() {
  const crs = await ZarrDataManager.getCRSInfo(
    props.datasources!,
    varnameSelector.value
  );
  // FIXME: could probably have other names
  const nside = crs.attrs["healpix_nside"] as number;
  return nside;
}

async function getCells() {
  try {
    const rawCells = (
      await ZarrDataManager.getVariableData(
        ZarrDataManager.getDatasetSource(
          props.datasources!,
          varnameSelector.value
        ),
        "cell"
      )
    ).data as ArrayLike<number | bigint>;

    return Array.from(rawCells, (cell) => Number(cell));
  } catch {
    return undefined;
  }
}

function getHealpixChunkRange(ipix: number, numChunks: number, nside: number) {
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
  nside: number,
  dimensionIndices: (number | zarr.Slice | null)[]
) {
  const localDimensionIndices = dimensionIndices.slice();
  const { chunksize, pixelStart, pixelEnd } = getHealpixChunkRange(
    ipix,
    numChunks,
    nside
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

  let { min, max, missingValue, fillValue } = getDataBounds(datavar, dataSlice);
  if (isNaN(missingValue)) {
    missingValue = HEALPIX_UNSEEN;
  } else if (isNaN(fillValue)) {
    fillValue = HEALPIX_UNSEEN;
  }
  mapMissingAndFillToNaN(dataSlice, missingValue, fillValue);
  ({ min, max } = getDataBounds(datavar, dataSlice));

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
  nside: number,
  ipix: number,
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

  for (let i = 0; i < steps; ++i) {
    const u = i / (steps - 1);
    for (let j = 0; j < steps; ++j) {
      const v = j / (steps - 1);
      const vec = healpix.pixcoord2vec_nest(nside, ipix, u, v);
      const { lat, lon } = ProjectionHelper.cartesianToLatLon(
        vec[0],
        vec[1],
        vec[2]
      );
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
    const len = size * size;
    const temp = new Float32Array(len);
    let idx = 0;

    for (let i = 0; i < size; ++i) {
      for (let j = 0; j < size; ++j) {
        temp[idx++] = healpix.bit_combine(j, i);
      }
    }
    unshuffleIndex[size] = temp;
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

async function getData(updateMode: TUpdateMode = UPDATE_MODE.INITIAL_LOAD) {
  store.startLoading();
  if (updatingData.value) {
    pendingUpdate.value = true;
    return;
  }

  updatingData.value = true;
  try {
    do {
      pendingUpdate.value = false;
      const datavar = await getDataVar(
        varnameSelector.value,
        props.datasources!
      );
      if (datavar) {
        await fetchAndRenderData(datavar, updateMode);
      }
      updatingData.value = false;
    } while (pendingUpdate.value);
  } catch (error) {
    logError(error, "Could not fetch data");
    updatingData.value = false;
  } finally {
    store.stopLoading();
  }
}

async function prepareDimensionData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  updateMode: TUpdateMode
) {
  const dimensionNames = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  const { dimensionRanges, indices } = buildDimensionRangesAndIndices(
    datavar,
    dimensionNames,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    [datavar.shape.length - 1],
    varinfo.value?.dimRanges,
    updateMode === UPDATE_MODE.SLIDER_TOGGLE
  );

  return { dimensionRanges, indices };
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
  nside: number,
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
        nside,
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
  if (!hoverData.value || hoverNside.value === null) {
    return null;
  }
  const theta = THREE.MathUtils.degToRad(90 - lat);
  const normalizedLon = ProjectionHelper.normalizeLongitude(lon);
  const phi = THREE.MathUtils.degToRad(
    normalizedLon < 0 ? normalizedLon + 360 : normalizedLon
  );
  const pixelIndex = healpix.ang2pix_nest(hoverNside.value, theta, phi);
  const dataIndex = hoverCellIndexMap.value
    ? hoverCellIndexMap.value.get(pixelIndex)
    : pixelIndex;
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
  const pixelAngles = healpix.pix2ang_nest(hoverNside.value, pixelIndex);
  const isMissing = !Number.isFinite(value) || value === HEALPIX_UNSEEN;
  return {
    lat: 90 - THREE.MathUtils.radToDeg(pixelAngles.theta),
    lon: ProjectionHelper.normalizeLongitude(
      THREE.MathUtils.radToDeg(pixelAngles.phi)
    ),
    value: isMissing ? null : value,
    status: isMissing
      ? HOVERED_GRID_POINT_STATUS.MISSING
      : HOVERED_GRID_POINT_STATUS.VALUE,
  };
}

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  updateMode: TUpdateMode
) {
  const { dimensionRanges, indices } = await prepareDimensionData(
    datavar,
    updateMode
  );

  const cellCoord = await getCells();
  const nside = await getNside();
  hoverNside.value = nside;
  hoverData.value = castDataVarToFloat32(
    (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
  );
  let { missingValue, fillValue } = getDataBounds(datavar, hoverData.value);
  if (isNaN(missingValue)) {
    missingValue = HEALPIX_UNSEEN;
  } else if (isNaN(fillValue)) {
    fillValue = HEALPIX_UNSEEN;
  }
  mapMissingAndFillToNaN(hoverData.value, missingValue, fillValue);
  if (cellCoord) {
    const cellIndexMap = new Map<number, number>();
    for (let index = 0; index < cellCoord.length; index++) {
      cellIndexMap.set(cellCoord[index], index);
    }
    hoverCellIndexMap.value = cellIndexMap;
  } else {
    hoverCellIndexMap.value = null;
  }
  setHoverLookup(healpixHoverLookup);
  const { dataMin, dataMax, histogramSummaries } = await processHealpixChunks(
    datavar,
    cellCoord,
    nside,
    indices
  );

  updateHistogram(histogramSummaries, dataMin, dataMax);

  const dimInfo = await getDimensionValues(dimensionRanges, indices);

  store.updateVarInfo(
    {
      attrs: datavar.attrs,
      dimInfo,
      bounds: { low: dataMin, high: dataMax },
      dimRanges: dimensionRanges,
    },
    indices as number[],
    updateMode
  );
}

onMounted(() => {
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    const mesh = mainMeshes[ipix];
    if (mesh) {
      getScene()!.add(mesh);
    }
  }
});

onBeforeMount(async () => {
  const low = bounds.value?.low as number;
  const high = bounds.value?.high as number;
  const { addOffset, scaleFactor } = getColormapScaleOffset(
    low,
    high,
    invertColormap.value
  );

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
      1,
      ipix,
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
