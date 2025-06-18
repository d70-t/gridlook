<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import {
  makeColormapMaterial,
  availableColormaps,
  calculateColorMapProperties,
} from "./utils/colormapShaders.ts";
import { decodeTime } from "./utils/timeHandling.ts";

import { datashaderExample } from "./utils/exampleFormatters.ts";
import {
  computed,
  onBeforeMount,
  ref,
  shallowRef,
  onMounted,
  watch,
  type Ref,
  type ShallowRef,
} from "vue";

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

const datavars: ShallowRef<
  Record<string, zarr.Array<zarr.DataType, zarr.FetchStore>>
> = shallowRef({});
const updateCount = ref(0);
const updatingData = ref(false);

let meshes: THREE.Mesh[] = [];

let canvas: Ref<HTMLCanvasElement | undefined> = ref();
let box: Ref<HTMLDivElement | undefined> = ref();

const {
  getScene,
  getCamera,
  redraw,
  makeSnapshot,
  toggleRotate,
  getDataVar,
  getTimeVar,
} = useSharedGlobeLogic(canvas, box);

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

const colormapMaterial = computed(() => {
  if (props.invertColormap) {
    return makeColormapMaterial(props.colormap, 1.0, -1.0);
  } else {
    return makeColormapMaterial(props.colormap, 0.0, 1.0);
  }
});

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
  datavars.value = {};
  if (props.datasources !== undefined) {
    await Promise.all([getData()]);
    updateColormap();
  }
}

function updateColormap() {
  const low = props.varbounds?.low as number;
  const high = props.varbounds?.high as number;
  const { addOffset, scaleFactor } = calculateColorMapProperties(
    low,
    high,
    props.invertColormap
  );

  for (const myMesh of meshes) {
    const material = myMesh.material as THREE.ShaderMaterial;
    material.uniforms.colormap.value = availableColormaps[props.colormap!];
    material.uniforms.addOffset.value = addOffset;
    material.uniforms.scaleFactor.value = scaleFactor;
  }
  redraw();
}

const BATCH_SIZE = 64; // Adjust based on memory and browser limits

function latLonToCartesianFlat(
  lat: number,
  lon: number,
  out: Float32Array,
  offset: number,
  radius = 1
) {
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  out[offset] = radius * Math.cos(latRad) * Math.cos(lonRad);
  out[offset + 1] = radius * Math.cos(latRad) * Math.sin(lonRad);
  out[offset + 2] = radius * Math.sin(latRad);
}

async function getGrid(grid: zarr.Group<zarr.Readable>, data: Float64Array) {
  let latitudes = (
    await zarr.open(grid.resolve("lat"), { kind: "array" }).then(zarr.get)
  ).data as Float64Array;

  let longitudes = (
    await zarr.open(grid.resolve("lon"), { kind: "array" }).then(zarr.get)
  ).data as Float64Array;

  console.time("build rows");
  const { rows, uniqueLats } = buildRows(latitudes, longitudes, data);
  console.timeEnd("build rows");

  const totalBatches = Math.ceil((uniqueLats.length - 1) / BATCH_SIZE);
  console.time("mesh");

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const lStart = batchIndex * BATCH_SIZE;
    const lEnd = Math.min(lStart + BATCH_SIZE, uniqueLats.length - 1);
    let totalCells = 0;

    // Precompute total number of cells (quads) in this batch
    for (let l = lStart; l < lEnd; l++) {
      totalCells += rows[uniqueLats[l]].length;
    }

    const positions = new Float32Array(totalCells * 4 * 3);
    const dataValues = new Float32Array(totalCells * 4);
    const indices = new Uint32Array(totalCells * 6);

    let vtxOffset = 0;
    let idxOffset = 0;
    let cellIndex = 0;

    for (let l = lStart; l < lEnd; l++) {
      const lat1 = uniqueLats[l];
      const lat2 = uniqueLats[l + 1];
      const row1 = rows[lat1];

      for (let i = 0; i < row1.length; i++) {
        const cell = row1[i];
        const nextCell = row1[(i + 1) % row1.length];
        const lon1 = cell.lon;
        const lon2 = nextCell.lon;
        const dLon = (lon2 - lon1 + 360) % 360;

        // Compute 4 corners
        latLonToCartesianFlat(lat1, lon1, positions, vtxOffset);
        latLonToCartesianFlat(lat1, lon1 - dLon, positions, vtxOffset + 3);
        latLonToCartesianFlat(lat2, lon1 - dLon, positions, vtxOffset + 6);
        latLonToCartesianFlat(lat2, lon1, positions, vtxOffset + 9);

        // Data value
        dataValues.fill(cell.value, cellIndex * 4, cellIndex * 4 + 4);

        // Indices for two triangles
        const v = cellIndex * 4;
        indices.set([v, v + 1, v + 2, v, v + 2, v + 3], idxOffset);

        // Offsets
        vtxOffset += 12;
        idxOffset += 6;
        cellIndex++;
      }
    }

    // Build geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute(
      "data_value",
      new THREE.BufferAttribute(dataValues, 1)
    );
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    if (meshes[batchIndex]) {
      meshes[batchIndex].geometry.dispose();
      meshes[batchIndex].geometry = geometry;
    } else {
      const mesh = new THREE.Mesh(geometry, colormapMaterial.value);
      meshes.push(mesh);
      getScene()?.add(mesh);
    }
  }
  console.log("meshes", meshes.length);
  console.timeEnd("mesh");
}

// function latLonToCartesian(lat: number, lon: number, radius = 1) {
//   // Convert latitude and longitude from degrees to radians
//   const latRad = lat * (Math.PI / 180);
//   const lonRad = lon * (Math.PI / 180);

//   // Calculate the Cartesian coordinates
//   const x = radius * Math.cos(latRad) * Math.cos(lonRad);
//   const y = radius * Math.cos(latRad) * Math.sin(lonRad);
//   const z = radius * Math.sin(latRad);

//   return new THREE.Vector3(x, y, z);
// }

function buildRows(lats: Float64Array, lons: Float64Array, data: Float64Array) {
  const rows: Record<number, { lon: number; value: number }[]> = {};
  for (let i = 0; i < lats.length; i++) {
    const lat = lats[i];
    if (!rows[lat]) rows[lat] = [];
    rows[lat].push({ lon: lons[i], value: data[i] });
  }

  const uniqueLats = Object.keys(rows)
    .map(Number)
    .sort((a, b) => b - a);
  return { rows, uniqueLats };
}

// async function getGrid(grid: zarr.Group<zarr.Readable>, data: Float64Array) {
//   let latitudes = (
//     await zarr
//       .open(grid.resolve("lat"), {
//         kind: "array",
//       })
//       .then(zarr.get)
//   ).data as Float64Array;

//   let longitudes = (
//     await zarr.open(grid.resolve("lon"), { kind: "array" }).then(zarr.get)
//   ).data as Float64Array;

//   console.time("build rows");
//   const { rows, uniqueLats } = buildRows(latitudes, longitudes, data);
//   console.timeEnd("build rows");

//   console.time("mesh");
//   for (let l = 0; l < uniqueLats.length - 1; l++) {
//     const lat1 = uniqueLats[l];
//     const lat2 = uniqueLats[l + 1];
//     const row1 = rows[lat1];
//     const estimatedVertexCount = row1.length * 4;
//     const positions = new Float32Array(estimatedVertexCount * 3);

//     const dataValues = [];
//     const indices = [];
//     let vertexCount = 0;
//     let positionIndex = 0;
//     for (let i = 0; i < row1.length; i++) {
//       const cell = row1[i];
//       const nextCell = row1[(i + 1) % row1.length];

//       const lon1 = cell.lon;
//       const lon2 = nextCell.lon;
//       const dLon = (lon2 - lon1 + 360) % 360;

//       const corners = [
//         latLonToCartesian(lat1, lon1),
//         latLonToCartesian(lat1, lon1 - dLon),
//         latLonToCartesian(lat2, lon1 - dLon),
//         latLonToCartesian(lat2, lon1),
//       ];
//       for (const corner of corners) {
//         positions[positionIndex++] = corner.x;
//         positions[positionIndex++] = corner.y;
//         positions[positionIndex++] = corner.z;
//       }

//       const v = cell.value;
//       for (let j = 0; j < 4; j++) dataValues.push(v);

//       indices.push(vertexCount, vertexCount + 1, vertexCount + 2);
//       indices.push(vertexCount, vertexCount + 2, vertexCount + 3);
//       vertexCount += 4;
//     }

//     const geometry = new THREE.BufferGeometry();
//     geometry.setAttribute(
//       "position",
//       new THREE.Float32BufferAttribute(positions, 3)
//     );
//     geometry.setAttribute(
//       "data_value",
//       new THREE.Float32BufferAttribute(dataValues, 1)
//     );
//     geometry.setIndex(indices);

//     if (meshes[l]) {
//       meshes[l].geometry.dispose();
//       meshes[l].geometry = geometry;
//     } else {
//       const mesh = new THREE.Mesh(geometry, colormapMaterial.value);
//       meshes.push(mesh);
//       getScene()?.add(mesh);
//     }
//   }
//   console.timeEnd("mesh");
// }

async function getData() {
  console.log("GET DATA");
  store.startLoading();
  try {
    updateCount.value += 1;
    const myUpdatecount = updateCount.value;
    if (updatingData.value) {
      return;
    }
    updatingData.value = true;
    console.log("GET DATA");
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
        attrs: timeattrs,
        values: timevalues,
        current: decodeTime(
          (timevalues as number[])[currentTimeIndexSliderValue],
          timeattrs
        ),
      };
    }
    if (datavar !== undefined) {
      console.time("getgrid");
      const root = zarr.root(new zarr.FetchStore(gridsource.value!.store));
      const grid = await zarr.open(root.resolve(gridsource.value!.dataset), {
        kind: "group",
      });
      const rawData = await zarr.get(datavar, [
        currentTimeIndexSliderValue,
        ...Array(datavar.shape.length - 1).fill(null),
      ]);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i of rawData.data as Float64Array) {
        if (Number.isNaN(i)) continue;
        min = Math.min(min, i);
        max = Math.max(max, i);
      }
      console.log("minmax", min, max);
      await getGrid(grid, rawData.data);
      // const low = props.varbounds?.low as number;
      // const high = props.varbounds?.high as number;
      // const { addOffset, scaleFactor } = calculateColorMapProperties(
      //   low,
      //   high,
      //   props.invertColormap
      // );
      publishVarinfo({
        attrs: datavar.attrs,
        timeinfo,
        timeRange: { start: 0, end: datavar.shape[0] - 1 },
        bounds: { low: min, high: max },
      });
      console.time("updateColormap");
      redraw();
      console.timeEnd("updateColormap");
      timeIndex.value = currentTimeIndexSliderValue;
      varname.value = localVarname;
      console.timeEnd("getgrid");
    }
    updatingData.value = false;
    if (updateCount.value !== myUpdatecount) {
      await getData();
    }
  } catch (error) {
    console.log(error);
    console.error(error);
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
}

// onMounted(() => {
//   // getScene()?.add(mainMesh as THREE.Mesh);
// });

onBeforeMount(async () => {
  console.log("IRREGULAR");
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
  z-index: 0;
}

div.globe_canvas {
  padding: 0;
  margin: 0;
}
</style>
