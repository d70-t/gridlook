<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import * as healpix from "@hscmap/healpix";
import {
  availableColormaps,
  makeTextureMaterial,
} from "./utils/colormapShaders.ts";
import { decodeTime } from "./utils/timeHandling.ts";
import { datashaderExample } from "./utils/exampleFormatters.ts";
import { computed, onBeforeMount, ref, watch, type Ref } from "vue";

import { useGlobeControlStore } from "./store/store.js";
import { storeToRefs } from "pinia";
import type {
  TBounds,
  TColorMap,
  TSources,
  TVarInfo,
} from "../types/GlobeTypes.ts";
import { useToast } from "primevue/usetoast";
import { getErrorMessage } from "./utils/errorHandling.ts";
import { useSharedGlobeLogic } from "./sharedGlobe.ts";

const props = defineProps<{
  datasources?: TSources;
  varbounds?: TBounds;
  colormap?: TColorMap;
  invertColormap?: boolean;
}>();

const emit = defineEmits<{ varinfo: [TVarInfo] }>();
const store = useGlobeControlStore();
const toast = useToast();
const { timeIndexSlider, timeIndex, varnameSelector, varname } =
  storeToRefs(store);

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
} = useSharedGlobeLogic(canvas, box);

const updateCount = ref(0);
const updatingData = ref(false);

const HEALPIX_NUMCHUNKS = 12;

let mainMeshes: THREE.Mesh[] = [];

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

watch(
  () => props.varbounds,
  () => {
    updateColormap();
  }
);

watch(
  () => props.invertColormap,
  () => {
    updateColormap();
  }
);

watch(
  () => props.colormap,
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

function publishVarinfo(info: TVarInfo) {
  emit("varinfo", info);
}

async function datasourceUpdate() {
  resetDataVars();
  if (props.datasources !== undefined) {
    await getData();
    updateColormap();
  }
}

function updateColormap() {
  const low = props.varbounds?.low as number;
  const high = props.varbounds?.high as number;
  let addOffset: number;
  let scaleFactor: number;
  if (props.invertColormap) {
    scaleFactor = -1 / (high - low);
    addOffset = -high * scaleFactor;
  } else {
    scaleFactor = 1 / (high - low);
    addOffset = -low * scaleFactor;
  }
  for (const myMesh of mainMeshes) {
    const material = myMesh.material as THREE.ShaderMaterial;
    material.uniforms.colormap.value = availableColormaps[props.colormap!];
    material.uniforms.addOffset.value = addOffset;
    material.uniforms.scaleFactor.value = scaleFactor;
  }
  redraw();
}

async function getHealpixData(
  datavar: zarr.Array<zarr.DataType>,
  timeValue: number,
  ipix: number,
  numChunks: number
) {
  const unshuffleIndex: { [key: number]: Int32Array } = {};
  const chunksize = datavar.shape[datavar.shape.length - 1] / numChunks;
  // const range = [1, zarr.slice(ipix * chunksize, (ipix + 1) * chunksize)];
  // const dataSlice = (await zarr.get(z, range)).data as Int32Array;
  const dataSlice = (
    await zarr.get(datavar, [
      timeValue,
      zarr.slice(ipix * chunksize, (ipix + 1) * chunksize),
    ])
  ).data as Int32Array;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < dataSlice.length; i++) {
    //min max
    if (dataSlice[i] < min) {
      min = dataSlice[i];
    }
    if (dataSlice[i] > max) {
      max = dataSlice[i];
    }
  }
  const data = dataSlice as Int32Array;
  unshuffleMortonArray(data, unshuffleIndex);
  return { texture: data2texture(data, unshuffleIndex), min, max };
}

function d2(
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

      const dac2 = d2(
        vertices[3 * a + 0],
        vertices[3 * a + 1],
        vertices[3 * a + 2],
        vertices[3 * c + 0],
        vertices[3 * c + 1],
        vertices[3 * c + 2]
      );
      const dbd2 = d2(
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
  unshuffleIndex: { [key: number]: Int32Array }
): Int32Array {
  if (unshuffleIndex[size] === undefined) {
    let temp = [];
    for (let i = 0; i < size; ++i) {
      for (let j = 0; j < size; ++j) {
        temp.push(healpix.bit_combine(j, i));
      }
    }
    unshuffleIndex[size] = new Int32Array(temp);
  }
  return unshuffleIndex[size];
}

function unshuffleMortonArray(
  arr: Int32Array,
  unshuffleIndex: { [key: number]: Int32Array }
): Int32Array {
  const out = arr.slice(); // makes a copy
  const size = Math.floor(Math.sqrt(arr.length));
  const uidx = getUnshuffleIndex(size, unshuffleIndex);
  for (let i = 0; i < out.length; ++i) {
    out[i] = arr[uidx[i]];
  }
  return out;
}

function data2texture(
  arr: Int32Array,
  unshuffleIndex: { [key: number]: Int32Array }
) {
  const size = Math.floor(Math.sqrt(arr.length));
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

// async function getData() {
//   store.startLoading();
//   try {
//     updateCount.value += 1;
//     const myUpdatecount = updateCount.value;
//     if (updatingData.value) {
//       return;
//     }
//     updatingData.value = true;
//     const localVarname = varnameSelector.value;
//     const currentTimeIndexSliderValue = timeIndexSlider.value;
//     const [timevar, datavar] = await Promise.all([
//       getTimeVar(props.datasources!),
//       getDataVar(localVarname, props.datasources!),
//     ]);
//     let timeinfo = {};
//     if (timevar !== undefined) {
//       const timeattrs = timevar.attrs;
//       const timevalues = (await zarr.get(timevar, [null])).data;
//       timeinfo = {
//         // attrs: timeattrs,
//         values: timevalues,
//         current: decodeTime(
//           (timevalues as number[])[currentTimeIndexSliderValue],
//           timeattrs
//         ),
//       };
//     }

//     if (datavar !== undefined) {
//       const gridStep = 64 + 1;

//       const texturePromises = [];

//       for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
//         texturePromises.push(
//           getHealpixData(
//             datavar,
//             currentTimeIndexSliderValue,
//             ipix,
//             HEALPIX_NUMCHUNKS
//           )
//         );
//       }

//       let dataMin = Number.POSITIVE_INFINITY;
//       let dataMax = Number.NEGATIVE_INFINITY;
//       const textures = await Promise.all(texturePromises);

//       for (const t of textures) {
//         const min = t.min;
//         const max = t.max;
//         dataMin = Math.min(dataMin, min);
//         dataMax = Math.max(dataMax, max);
//       }
//       const low = props.varbounds?.low as number;
//       const high = props.varbounds?.high as number;
//       let addOffset: number;
//       let scaleFactor: number;
//       if (props.invertColormap) {
//         scaleFactor = -1 / (high - low);
//         addOffset = -high * scaleFactor;
//       } else {
//         scaleFactor = 1 / (high - low);
//         addOffset = -low * scaleFactor;
//       }

//       for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
//         const geometry = makeHealpixGeometry(1, ipix, gridStep);
//         const texture = textures[ipix].texture;
//         const low = props.varbounds?.low as number;
//         const high = props.varbounds?.high as number;
//         let scaleFactor: number;
//         if (props.invertColormap) {
//           scaleFactor = -1 / (high - low);
//           addOffset = -high * scaleFactor;
//         } else {
//           scaleFactor = 1 / (high - low);
//           addOffset = -low * scaleFactor;
//         }

//         const material = makeTextureMaterial(
//           texture,
//           props.colormap!,
//           addOffset,
//           scaleFactor
//         );

//         const mesh = new THREE.Mesh(geometry, material);
//         getScene()!.add(mesh);
//         if (mainMeshes[ipix]) {
//           mainMeshes[ipix] = mesh;
//         } else {
//           mainMeshes.push(mesh);
//         }
//       }

//       publishVarinfo({
//         attrs: datavar.attrs,
//         timeinfo,
//         timeRange: { start: 0, end: datavar.shape[0] - 1 },
//         bounds: { low: dataMin, high: dataMax },
//       });
//       redraw();
//       timeIndex.value = currentTimeIndexSliderValue;
//       varname.value = localVarname;
//     }
//     updatingData.value = false;
//     if (updateCount.value !== myUpdatecount) {
//       await getData();
//     }
//   } catch (error) {
//     toast.add({
//       detail: `Couldn't fetch data: ${getErrorMessage(error)}`,
//       life: 3000,
//     });
//     updatingData.value = false;
//   } finally {
//     store.stopLoading();
//   }
// }
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

    const [timevar, datavar] = await Promise.all([
      getTimeVar(props.datasources!),
      getDataVar(localVarname, props.datasources!),
    ]);

    let timeinfo = {};
    if (timevar !== undefined) {
      const timeattrs = timevar.attrs;
      const timevalues = (await zarr.get(timevar, [null])).data;
      timeinfo = {
        values: timevalues,
        current: decodeTime(
          (timevalues as number[])[currentTimeIndexSliderValue],
          timeattrs
        ),
      };
    }

    if (datavar !== undefined) {
      const gridStep = 64 + 1;
      let dataMin = Number.POSITIVE_INFINITY;
      let dataMax = Number.NEGATIVE_INFINITY;

      const low = props.varbounds?.low as number;
      const high = props.varbounds?.high as number;
      let scaleFactor: number;
      let addOffset: number;
      if (props.invertColormap) {
        scaleFactor = -1 / (high - low);
        addOffset = -high * scaleFactor;
      } else {
        scaleFactor = 1 / (high - low);
        addOffset = -low * scaleFactor;
      }

      for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
        const texData = await getHealpixData(
          datavar,
          currentTimeIndexSliderValue,
          ipix,
          HEALPIX_NUMCHUNKS
        );

        // Update global data range
        dataMin = Math.min(dataMin, texData.min);
        dataMax = Math.max(dataMax, texData.max);

        const geometry = makeHealpixGeometry(1, ipix, gridStep);
        const material = makeTextureMaterial(
          texData.texture,
          props.colormap!,
          addOffset,
          scaleFactor
        );

        const mesh = new THREE.Mesh(geometry, material);
        getScene()!.add(mesh);

        if (mainMeshes[ipix]) {
          mainMeshes[ipix] = mesh;
        } else {
          mainMeshes.push(mesh);
        }

        // Optional: trigger a render here if using manual render loop
        redraw();
        // If your render loop is auto-updating (via requestAnimationFrame), you may skip redraw()
      }

      publishVarinfo({
        attrs: datavar.attrs,
        timeinfo,
        timeRange: { start: 0, end: datavar.shape[0] - 1 },
        bounds: { low: dataMin, high: dataMax },
      });

      timeIndex.value = currentTimeIndexSliderValue;
      varname.value = localVarname;
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
function copyPythonExample() {
  const example = datashaderExample({
    cameraPosition: getCamera()!.position,
    datasrc: datasource.value!.store + datasource.value!.dataset,
    gridsrc: gridsource.value!.store + gridsource.value!.dataset,
    varname: varname.value,
    timeIndex: timeIndex.value,
    varbounds: props.varbounds!,
    colormap: props.colormap!,
    invertColormap: props.invertColormap,
  });
  navigator.clipboard.writeText(example);
  toast.add({
    detail: `Copied into clipboard`,
    life: 3000,
    severity: "success",
  });
}

onBeforeMount(async () => {
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
