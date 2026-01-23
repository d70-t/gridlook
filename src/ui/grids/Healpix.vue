<script lang="ts" setup>
import * as healpix from "@hscmap/healpix";
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onMounted, ref, watch } from "vue";
import * as zarr from "zarrita";

import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { getDimensionInfo } from "@/lib/data/dimensionHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { castDataVarToFloat32, getDataBounds } from "@/lib/data/zarrUtils.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  getColormapScaleOffset,
  makeGpuProjectedTextureMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "@/store/store.ts";
import { useLog } from "@/utils/logging.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();
const { logError } = useLog();
const {
  varnameSelector,
  colormap,
  invertColormap,
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
  resetDataVars,
  getDataVar,
  getTime,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
  canvas,
  box,
} = useSharedGridLogic();

const pendingUpdate = ref(false);
const updatingData = ref(false);

const HEALPIX_NUMCHUNKS = 12;

let mainMeshes: THREE.Mesh<
  THREE.BufferGeometry<THREE.NormalBufferAttributes>,
  THREE.Material,
  THREE.Object3DEventMap
>[] = new Array(HEALPIX_NUMCHUNKS);

watch(
  () => varnameSelector.value,
  () => {
    getData();
  }
);

watch(
  () => dimSlidersValues.value,
  () => {
    if (isInitializingVariable.value) {
      isInitializingVariable.value = false;
      return;
    }
    getData(UPDATE_MODE.SLIDER_TOGGLE);
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
  [() => bounds.value, () => invertColormap.value, () => colormap.value],
  () => {
    updateColormap(mainMeshes);
  }
);

// GPU projection: update shader uniforms instead of rebuilding geometry
watch(
  [() => projectionMode.value, () => projectionCenter.value],
  () => {
    updateMeshProjectionUniforms();
  },
  { deep: true }
);

/**
 * Update projection uniforms on all mesh materials.
 * This is the fast path - no geometry rebuild needed.
 */
function updateMeshProjectionUniforms() {
  const helper = projectionHelper.value;
  const center = projectionCenter.value;

  for (const mesh of mainMeshes) {
    const material = mesh.material as THREE.ShaderMaterial;
    if (material.uniforms?.projectionType) {
      updateProjectionUniforms(material, helper.type, center.lon, center.lat);
    }
  }
  redraw();
}

async function datasourceUpdate() {
  resetDataVars();
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
      mainMeshes[ipix].geometry.dispose();
      mainMeshes[ipix].geometry = geometry;
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
    let cells = (
      await ZarrDataManager.getVariableData(
        ZarrDataManager.getDatasetSource(
          props.datasources!,
          varnameSelector.value
        ),
        "cell"
      )
    ).data as Int32Array | BigInt64Array | number[];
    if (typeof cells[0] === "bigint") {
      cells = Array.from(cells, Number) as number[];
    }
    return cells as number[];
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
  datavar: zarr.Array<zarr.DataType>,
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
  datavar: zarr.Array<zarr.DataType>,
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

async function getHealpixData(
  datavar: zarr.Array<zarr.DataType>,
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

  let { min, max, missingValue, fillValue } = getDataBounds(datavar, dataSlice);
  return {
    texture: data2texture(dataSlice, {}),
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
  const geometry = new THREE.BufferGeometry();
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
  return geometry;
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
        await processDataVar(datavar, updateMode);
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

function prepareDimensionData(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  updateMode: TUpdateMode
) {
  const { dimensionRanges, indices } = getDimensionInfo(
    datavar,
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

async function processDataVar(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  updateMode: TUpdateMode
) {
  const { dimensionRanges, indices } = await prepareDimensionData(
    datavar,
    updateMode
  );

  let dataMin = Number.POSITIVE_INFINITY;
  let dataMax = Number.NEGATIVE_INFINITY;
  const cellCoord = await getCells();
  const nside = await getNside();
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
        const material = mainMeshes[ipix].material as THREE.ShaderMaterial;
        material.uniforms.data.value.dispose();
        return;
      }

      // Update global data range
      dataMin = dataMin > texData.min ? texData.min : dataMin;
      dataMax = dataMax < texData.max ? texData.max : dataMax;

      const material = mainMeshes[ipix].material as THREE.ShaderMaterial;
      material.uniforms.missingValue.value = texData.missingValue;
      material.uniforms.fillValue.value = texData.fillValue;
      material.uniforms.data.value.dispose();
      material.uniforms.data.value = texData.texture;

      redraw();
    })
  );

  const timeinfo = await getTime(props.datasources!, dimensionRanges, indices);

  store.updateVarInfo(
    {
      attrs: datavar.attrs,
      timeinfo,
      bounds: { low: dataMin, high: dataMax },
      dimRanges: dimensionRanges,
    },
    indices as number[],
    updateMode
  );
}

onMounted(() => {
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    getScene()!.add(mainMeshes[ipix]);
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
    // Set initial projection uniforms
    const helper = projectionHelper.value;
    const center = projectionCenter.value;
    updateProjectionUniforms(material, helper.type, center.lon, center.lat);

    const { geometry } = makeHealpixGeometry(
      1,
      ipix,
      gridStep,
      projectionHelper.value
    );
    mainMeshes[ipix] = new THREE.Mesh(geometry, material);
    // Disable frustum culling - GPU projection changes actual positions
    mainMeshes[ipix].frustumCulled = false;
  }
  await datasourceUpdate();
});

defineExpose({ makeSnapshot, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
