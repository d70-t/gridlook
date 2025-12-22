<script lang="ts" setup>
import * as healpix from "@hscmap/healpix";
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onMounted, ref, watch } from "vue";
import * as zarr from "zarrita";

import type { TSources } from "../../types/GlobeTypes.ts";
import { useUrlParameterStore } from "../store/paramStore.ts";
import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "../store/store.js";
import {
  calculateColorMapProperties,
  makeTextureMaterial,
} from "../utils/colormapShaders.ts";
import { getDimensionInfo } from "../utils/dimensionHandling.ts";
import { useLog } from "../utils/logging.ts";
import { ProjectionHelper } from "../utils/projectionUtils.ts";
import { ZarrDataManager } from "../utils/ZarrDataManager.ts";
import { castDataVarToFloat32, getDataBounds } from "../utils/zarrUtils.ts";

import { useSharedGridLogic } from "./useSharedGridLogic.ts";

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
  getTimeInfo,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
  canvas,
  box,
} = useSharedGridLogic();

const updateCount = ref(0);
const updatingData = ref(false);

const HEALPIX_NUMCHUNKS = 12;

let mainMeshes: THREE.Mesh<
  THREE.BufferGeometry<THREE.NormalBufferAttributes>,
  THREE.Material,
  THREE.Object3DEventMap
>[] = new Array(HEALPIX_NUMCHUNKS);
const healpixLatLonCache: { lat: Float32Array; lon: Float32Array }[] =
  new Array(HEALPIX_NUMCHUNKS);

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

watch(
  () => projectionHelper.value,
  () => {
    reprojectHealpixMeshes();
  }
);

const timeIndexSlider = computed(() => {
  if (varinfo.value?.dimRanges[0]?.name !== "time") {
    return 0;
  }
  return dimSlidersValues.value[0];
});

async function datasourceUpdate() {
  resetDataVars();
  if (props.datasources !== undefined) {
    if (props.datasources !== undefined) {
      await Promise.all([fetchGrid(), getData()]);
      updateLandSeaMask();
      updateColormap(mainMeshes);
    }
  }
}

async function fetchGrid() {
  const gridStep = 64 + 1;
  try {
    for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ipix++) {
      const { geometry, latitudes, longitudes } = makeHealpixGeometry(
        1,
        ipix,
        gridStep,
        projectionHelper.value
      );
      mainMeshes[ipix].geometry.dispose();
      mainMeshes[ipix].geometry = geometry;
      healpixLatLonCache[ipix] = { lat: latitudes, lon: longitudes };
    }
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

async function getHealpixData(
  datavar: zarr.Array<zarr.DataType>,
  cellCoord: number[] | undefined, // Optional - undefined for global data
  ipix: number,
  numChunks: number,
  nside: number,
  dimensionIndices: (number | zarr.Slice | null)[]
) {
  const localDimensionIndices = dimensionIndices.slice();
  const chunksize = (12 * nside * nside) / numChunks;
  const pixelStart = ipix * chunksize;
  const pixelEnd = (ipix + 1) * chunksize;

  const dataSlice = new Float32Array(chunksize);

  // Global data case: cellCoord is undefined
  if (cellCoord === undefined) {
    // Fetch data directly for this chunk
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
  } else {
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
      let { min, max, missingValue, fillValue } = getDataBounds(
        datavar,
        dataSlice
      );
      return {
        texture: data2texture(dataSlice, {}),
        min,
        max,
        missingValue,
        fillValue,
      };
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

function vectorToLatLon(x: number, y: number, z: number) {
  const r = Math.sqrt(x * x + y * y + z * z);
  const lat = (Math.asin(z / r) * 180) / Math.PI;
  const lon = (Math.atan2(y, x) * 180) / Math.PI;
  return { lat, lon };
}

function makeHealpixGeometry(
  nside: number,
  ipix: number,
  steps: number,
  helper: ProjectionHelper
) {
  const vertexCount = steps * steps;
  const vertices = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const latitudes = new Float32Array(vertexCount);
  const longitudes = new Float32Array(vertexCount);
  const indices = [];
  let vertexIndex = 0;

  for (let i = 0; i < steps; ++i) {
    const u = i / (steps - 1);
    for (let j = 0; j < steps; ++j) {
      const v = j / (steps - 1);
      const vec = healpix.pixcoord2vec_nest(nside, ipix, u, v);
      const { lat, lon } = vectorToLatLon(vec[0], vec[1], vec[2]);
      latitudes[vertexIndex] = lat;
      longitudes[vertexIndex] = lon;
      const [x, y, z] = helper.project(lat, lon, 1);
      const baseIndex = vertexIndex * 3;
      vertices[baseIndex] = x;
      vertices[baseIndex + 1] = y;
      vertices[baseIndex + 2] = z;
      const uvIndex = vertexIndex * 2;
      uv[uvIndex] = u;
      uv[uvIndex + 1] = v;
      vertexIndex++;
    }
  }

  for (let i = 0; i < steps - 1; ++i) {
    for (let j = 0; j < steps - 1; ++j) {
      const a = i * steps + (j + 1);
      const b = i * steps + j;
      const c = (i + 1) * steps + j;
      const d = (i + 1) * steps + (j + 1);

      const dac2 = distanceSquared(
        vertices[3 * a + 0],
        vertices[3 * a + 1],
        vertices[3 * a + 2],
        vertices[3 * c + 0],
        vertices[3 * c + 1],
        vertices[3 * c + 2]
      );
      const dbd2 = distanceSquared(
        vertices[3 * b + 0],
        vertices[3 * b + 1],
        vertices[3 * b + 2],
        vertices[3 * d + 0],
        vertices[3 * d + 1],
        vertices[3 * d + 2]
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
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return { geometry, latitudes, longitudes };
}

function reprojectHealpixMeshes() {
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ipix++) {
    const mesh = mainMeshes[ipix];
    const cache = healpixLatLonCache[ipix];
    if (!mesh || !cache) continue;
    const positionAttr = mesh.geometry.getAttribute(
      "position"
    ) as THREE.BufferAttribute;
    if (!positionAttr) continue;
    const array = positionAttr.array as Float32Array;
    for (let v = 0; v < cache.lat.length; v++) {
      const [x, y, z] = projectionHelper.value.project(
        cache.lat[v],
        cache.lon[v],
        1
      );
      const baseIndex = v * 3;
      array[baseIndex] = x;
      array[baseIndex + 1] = y;
      array[baseIndex + 2] = z;
    }
    positionAttr.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();
  }
  redraw();
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
  try {
    updateCount.value += 1;
    const myUpdatecount = updateCount.value;
    if (updatingData.value) {
      return;
    }
    updatingData.value = true;
    const datavar = await getDataVar(varnameSelector.value, props.datasources!);
    await processDataVar(datavar, updateMode);
    updatingData.value = false;

    if (updateCount.value !== myUpdatecount) {
      await getData(updateMode);
    }
  } catch (error) {
    logError(error, "Could not fetch data");
    updatingData.value = false;
  } finally {
    store.stopLoading();
  }
}

async function processDataVar(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore> | undefined,
  updateMode: TUpdateMode
) {
  if (datavar !== undefined) {
    const { dimensionRanges, indices } = getDimensionInfo(
      datavar,
      paramDimIndices.value,
      paramDimMinBounds.value,
      paramDimMaxBounds.value,
      dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
      [datavar.shape.length - 1],
      varinfo.value?.dimRanges,
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

    const currentTimeIndexSliderValue = timeIndexSlider.value as number;
    const timeinfo = await getTimeInfo(
      props.datasources!,
      dimensionRanges,
      currentTimeIndexSliderValue
    );

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
}

onMounted(() => {
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    getScene()!.add(mainMeshes[ipix]);
  }
});

onBeforeMount(async () => {
  const low = bounds.value?.low as number;
  const high = bounds.value?.high as number;
  const { addOffset, scaleFactor } = calculateColorMapProperties(
    low,
    high,
    invertColormap.value
  );

  const gridStep = 64 + 1;
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    const material = makeTextureMaterial(
      new THREE.Texture(),
      colormap.value,
      addOffset,
      scaleFactor
    );
    const { geometry, latitudes, longitudes } = makeHealpixGeometry(
      1,
      ipix,
      gridStep,
      projectionHelper.value
    );
    mainMeshes[ipix] = new THREE.Mesh(geometry, material);
    healpixLatLonCache[ipix] = { lat: latitudes, lon: longitudes };
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
