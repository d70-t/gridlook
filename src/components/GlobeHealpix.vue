<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import * as healpix from "@hscmap/healpix";
import {
  availableColormaps,
  calculateColorMapProperties,
  makeTextureMaterial,
} from "./utils/colormapShaders.ts";
import { decodeTime } from "./utils/timeHandling.ts";
import { datashaderExample } from "./utils/exampleFormatters.ts";
import { computed, onBeforeMount, onMounted, ref, watch, type Ref } from "vue";

import { useGlobeControlStore } from "./store/store.js";
import { storeToRefs } from "pinia";
import type { TSources, TVarInfo } from "../types/GlobeTypes.ts";
import { useToast } from "primevue/usetoast";
import { getErrorMessage } from "./utils/errorHandling.ts";
import { useSharedGlobeLogic } from "./sharedGlobe.ts";
import { findCRSVar, getDataSourceStore } from "./utils/zarrUtils.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();
const toast = useToast();
const {
  timeIndexSlider,
  varnameSelector,
  colormap,
  invertColormap,
  selection,
} = storeToRefs(store);

let canvas: Ref<HTMLCanvasElement | undefined> = ref();

let box: Ref<HTMLDivElement | undefined> = ref();
const {
  getScene,
  getCamera,
  redraw,
  makeSnapshot,
  toggleRotate,
  resetDataVars,
  getDataVar,
  getTimeVar,
  updateLandSeaMask,
} = useSharedGlobeLogic(canvas, box);

const updateCount = ref(0);
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
  () => timeIndexSlider.value,
  () => {
    getData();
  }
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
    updateColormap();
  }
);

const gridsource = computed(() => {
  if (props.datasources) {
    return props.datasources.levels[0].grid;
  } else {
    return undefined;
  }
});

const datasource = computed(() => {
  if (props.datasources) {
    return props.datasources.levels[0].datasources[varnameSelector.value];
  } else {
    return undefined;
  }
});

async function datasourceUpdate() {
  resetDataVars();
  if (props.datasources !== undefined) {
    if (props.datasources !== undefined) {
      await Promise.all([fetchGrid(), getData()]);
      updateLandSeaMask();
      updateColormap();
    }
  }
}

function updateColormap() {
  const low = bounds.value?.low as number;
  const high = bounds.value?.high as number;
  const { addOffset, scaleFactor } = calculateColorMapProperties(
    low,
    high,
    invertColormap.value
  );
  for (const myMesh of mainMeshes) {
    const material = myMesh.material as THREE.ShaderMaterial;
    if (material?.uniforms.colormap) {
      material.uniforms.colormap.value = availableColormaps[colormap.value];
    }
    if (material?.uniforms.addOffset) {
      material.uniforms.addOffset.value = addOffset;
    }
    if (material?.uniforms.scaleFactor) {
      material.uniforms.scaleFactor.value = scaleFactor;
    }
  }
  redraw();
}

async function fetchGrid() {
  const gridStep = 64 + 1;
  try {
    for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ipix++) {
      const geometry = makeHealpixGeometry(1, ipix, gridStep);

      mainMeshes[ipix].geometry.dispose();
      mainMeshes[ipix].geometry = geometry;
    }
    redraw();
  } catch (error) {
    toast.add({
      detail: `Could not fetch grid: ${getErrorMessage(error)}`,
      life: 3000,
    });
  }
}

async function getNside() {
  const root = getDataSourceStore(props.datasources!, varnameSelector.value);

  const resolveRoot = root.resolve(
    await findCRSVar(root, varnameSelector.value)
  );
  const crs = await zarr.open(resolveRoot, {
    kind: "array",
  });
  // FIXME: could probably have other names
  const nside = crs.attrs["healpix_nside"] as number;
  return nside;
}

async function getCells() {
  const root = getDataSourceStore(props.datasources!, varnameSelector.value);
  try {
    const cellstore = await zarr.open(root.resolve("cell"), {
      kind: "array",
    });
    let cells = (await zarr.get(cellstore)).data as
      | Int32Array
      | BigInt64Array
      | number[];
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
  timeValue: number,
  ipix: number,
  numChunks: number,
  nside: number
) {
  const chunksize = (12 * nside * nside) / numChunks;
  const pixelStart = ipix * chunksize;
  const pixelEnd = (ipix + 1) * chunksize;

  const dataSlice = new Float32Array(chunksize);

  // Global data case: cellCoord is undefined
  if (cellCoord === undefined) {
    // Fetch data directly for this chunk
    const data = (
      await zarr.get(datavar, [timeValue, zarr.slice(pixelStart, pixelEnd)])
    ).data as Float32Array;

    dataSlice.set(data);
  } else {
    // Limited-area data case: need to map cellCoord to global positions
    // dataSlice.fill(NaN);

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
      return undefined;
    }

    // Check if indices are contiguous for optimization
    const start = relevantIndices[0];
    const end = relevantIndices[relevantIndices.length - 1] + 1;
    const data = (await zarr.get(datavar, [timeValue, zarr.slice(start, end)]))
      .data as Float32Array;
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

  // Calculate min/max
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < dataSlice.length; i++) {
    if (!isNaN(dataSlice[i])) {
      if (dataSlice[i] < min) min = dataSlice[i];
      if (dataSlice[i] > max) max = dataSlice[i];
    }
  }

  return { texture: data2texture(dataSlice, {}), min, max };
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

function makeHealpixGeometry(nside: number, ipix: number, steps: number) {
  const vertices = [];
  const uv = [];
  const indices = [];

  for (let i = 0; i < steps; ++i) {
    const u = i / (steps - 1);
    for (let j = 0; j < steps; ++j) {
      const v = j / (steps - 1);
      const vec = healpix.pixcoord2vec_nest(nside, ipix, u, v);
      vertices.push(vec[0], vec[1], vec[2]);
      uv.push(u, v);
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
  return geometry;
}

function getUnshuffleIndex(
  size: number,
  unshuffleIndex: { [key: number]: Float32Array }
): Float32Array {
  if (unshuffleIndex[size] === undefined) {
    let temp = [];
    for (let i = 0; i < size; ++i) {
      for (let j = 0; j < size; ++j) {
        temp.push(healpix.bit_combine(j, i));
      }
    }
    unshuffleIndex[size] = new Float32Array(temp);
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
  if (arr instanceof Float64Array) {
    // WebGL doesn't support Float64Array textures
    // we convert it to Float32Array and accept the loss of precision
    arr = Float32Array.from(arr);
  }
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

async function getData() {
  store.startLoading();
  try {
    updateCount.value += 1;
    const myUpdatecount = updateCount.value;
    if (updatingData.value) {
      return;
    }
    updatingData.value = true;
    const localVarname = varnameSelector.value;
    const currentTimeIndexSliderValue = timeIndexSlider.value;
    const [timevar, datavar] = await loadTimeAndDataVars(localVarname);
    const timeinfo = await extractTimeInfo(
      timevar,
      currentTimeIndexSliderValue
    );
    if (datavar !== undefined) {
      await processDataVar(datavar, currentTimeIndexSliderValue, timeinfo);
    }
    updatingData.value = false;

    if (updateCount.value !== myUpdatecount) {
      await getData(); // Restart update if another one queued
    }
  } catch (error) {
    toast.add({
      detail: `Couldn't fetch data: ${getErrorMessage(error)}`,
      life: 3000,
    });
    updatingData.value = false;
  } finally {
    store.stopLoading();
  }
}

async function loadTimeAndDataVars(varname: string) {
  return await Promise.all([
    getTimeVar(props.datasources!),
    getDataVar(varname, props.datasources!),
  ]);
}

async function extractTimeInfo(
  timevar: zarr.Array<zarr.DataType, zarr.FetchStore> | undefined,
  index: number
): Promise<TVarInfo["timeinfo"]> {
  if (!timevar) return {};
  const timevalues = (await zarr.get(timevar, [null])).data as Int32Array;
  return {
    values: timevalues,
    current: decodeTime(timevalues[index], timevar.attrs),
  };
}

async function processDataVar(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  currentTimeIndexSliderValue: number,
  timeinfo: Awaited<ReturnType<typeof extractTimeInfo>>
) {
  if (datavar !== undefined) {
    let dataMin = Number.POSITIVE_INFINITY;
    let dataMax = Number.NEGATIVE_INFINITY;
    const cellCoord = await getCells();
    const nside = await getNside();
    await Promise.all(
      [...Array(HEALPIX_NUMCHUNKS).keys()].map(async (ipix) => {
        const texData = await getHealpixData(
          datavar,
          cellCoord,
          currentTimeIndexSliderValue,
          ipix,
          HEALPIX_NUMCHUNKS,
          nside
        );
        if (texData === undefined) {
          const material = mainMeshes[ipix].material as THREE.ShaderMaterial;
          material.uniforms.data.value.dispose();
          return;
        }

        // Update global data range
        dataMin = Math.min(dataMin, texData.min);
        dataMax = Math.max(dataMax, texData.max);

        const material = mainMeshes[ipix].material as THREE.ShaderMaterial;
        material.uniforms.data.value.dispose();
        material.uniforms.data.value = texData.texture;

        // Optional: trigger a render here if using manual render loop
        redraw();
        // If your render loop is auto-updating (via requestAnimationFrame), you may skip redraw()
      })
    );

    store.updateVarInfo({
      attrs: datavar.attrs,
      timeinfo,
      timeRange: { start: 0, end: datavar.shape[0] - 1 },
      bounds: { low: dataMin, high: dataMax },
    });
  }
}

function copyPythonExample() {
  const example = datashaderExample({
    cameraPosition: getCamera()!.position,
    datasrc: datasource.value!.store + datasource.value!.dataset,
    gridsrc: gridsource.value!.store + gridsource.value!.dataset,
    varname: varnameSelector.value,
    timeIndex: timeIndexSlider.value,
    varbounds: bounds.value!,
    colormap: colormap.value,
    invertColormap: invertColormap.value,
  });
  navigator.clipboard.writeText(example);
  toast.add({
    detail: `Copied into clipboard`,
    life: 3000,
    severity: "success",
  });
}

onMounted(() => {
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    getScene()!.add(mainMeshes[ipix]);
  }
});

onBeforeMount(async () => {
  const gridStep = 64 + 1;
  const low = bounds.value?.low as number;
  const high = bounds.value?.high as number;
  let scaleFactor: number;
  let addOffset: number;
  if (invertColormap.value) {
    scaleFactor = -1 / (high - low);
    addOffset = -high * scaleFactor;
  } else {
    scaleFactor = 1 / (high - low);
    addOffset = -low * scaleFactor;
  }
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    const material = makeTextureMaterial(
      new THREE.Texture(),
      colormap.value,
      addOffset,
      scaleFactor
    );
    mainMeshes[ipix] = new THREE.Mesh(
      makeHealpixGeometry(1, ipix, gridStep),
      material
    );
  }
  await datasourceUpdate();
});

defineExpose({ makeSnapshot, copyPythonExample, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>

<style>
div.globe_box {
  height: 100%;
  width: 100%;
  padding: 0;
  margin: 0;
  overflow: hidden;
  display: flex;
}
div.globe_canvas {
  padding: 0;
  margin: 0;
}
</style>
