<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import type { Readable } from "@zarrita/storage";
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
  isRotated?: boolean;
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
let mainMesh: THREE.Mesh | undefined = undefined;
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
    await Promise.all([fetchGrid(), getData()]);
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

  if (mainMesh) {
    const material = mainMesh!.material as THREE.ShaderMaterial;
    material.uniforms.colormap.value = availableColormaps[props.colormap!];
    material.uniforms.addOffset.value = addOffset;
    material.uniforms.scaleFactor.value = scaleFactor;
    redraw();
  }
}

function latLongToXYZ(lat: number, lon: number, radius: number) {
  // Convert latitude and longitude from degrees to radians
  const latRad = lat * (Math.PI / 180);
  const lonRad = lon * (Math.PI / 180);

  // Calculate the Cartesian coordinates
  const x = radius * Math.cos(latRad) * Math.cos(lonRad);
  const y = radius * Math.cos(latRad) * Math.sin(lonRad);
  const z = radius * Math.sin(latRad);

  return [x, y, z];
}

function rotatedToGeographic(
  latR: number,
  lonR: number,
  poleLat: number,
  poleLon: number
) {
  const latRRad = THREE.MathUtils.degToRad(latR);
  const lonRRad = THREE.MathUtils.degToRad(lonR);
  const poleLatRad = THREE.MathUtils.degToRad(poleLat);
  const poleLonRad = THREE.MathUtils.degToRad(poleLon);

  const sinPhi =
    Math.sin(poleLatRad) * Math.sin(latRRad) +
    Math.cos(poleLatRad) * Math.cos(latRRad) * Math.cos(lonRRad);
  const phi = Math.asin(sinPhi);

  const y = -Math.cos(latRRad) * Math.sin(lonRRad);
  const x =
    Math.sin(latRRad) * Math.cos(poleLatRad) -
    Math.cos(latRRad) * Math.sin(poleLatRad) * Math.cos(lonRRad);
  const lambda = poleLonRad + Math.atan2(y, x);

  // Normalize longitude to [-180, 180)
  let lon = THREE.MathUtils.radToDeg(lambda);
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;

  const lat = THREE.MathUtils.radToDeg(phi);
  return { lat, lon };
}

async function getGaussianGrid(grid: zarr.Group<Readable>) {
  const isRotated = props.isRotated;
  let latitudes = (
    await zarr
      .open(grid.resolve(isRotated ? "rlat" : "lat"), {
        kind: "array",
      })
      .then(zarr.get)
  ).data as Float64Array;

  let longitudes = (
    await zarr
      .open(grid.resolve(isRotated ? "rlon" : "lon"), { kind: "array" })
      .then(zarr.get)
  ).data as Float64Array;
  let poleLat;
  let poleLon;
  if (isRotated) {
    const rotatedNorthPole = await getRotatedNorthPole();
    poleLat = rotatedNorthPole.lat;
    poleLon = rotatedNorthPole.lon;
  }
  const isGlobal =
    longitudes[longitudes.length - 1] + (longitudes[1] - longitudes[0]) >= 360;

  if (isGlobal) {
    // the UVs are causing a seam, if a we do not close the full sphere on global data
    // as
    if (longitudes[longitudes.length - 1] !== 360) {
      longitudes = new Float64Array(new Set([...longitudes, 360]));
    }
  }

  const radius = 1.0;
  const vertices: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];

  const latCount = latitudes.length;
  const lonCount = longitudes.length;

  let latMin = Number.POSITIVE_INFINITY;
  let latMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < latitudes.length; i++) {
    if (latitudes[i] < latMin) latMin = latitudes[i];
    if (latitudes[i] > latMax) latMax = latitudes[i];
  }

  let lonMin = Number.POSITIVE_INFINITY;
  let lonMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < longitudes.length; i++) {
    if (longitudes[i] < lonMin) lonMin = longitudes[i];
    if (longitudes[i] > lonMax) lonMax = longitudes[i];
  }

  const latRange = latMax - latMin;
  const lonRange = lonMax - lonMin;

  for (let i = 0; i < latCount; i++) {
    const v = (latitudes[i] - latMin) / latRange;
    for (let j = 0; j < lonCount; j++) {
      const u = (longitudes[j] - lonMin) / lonRange;
      const vals = isRotated
        ? rotatedToGeographic(
            latitudes[i],
            longitudes[j],
            poleLat as number,
            poleLon as number
          )
        : { lat: latitudes[i], lon: longitudes[j] };

      const xyz = latLongToXYZ(vals.lat, vals.lon, radius);
      vertices.push(...xyz);
      uvs.push(u, v);
    }
  }

  const latIterationEnd = latCount - 1;
  const lonIterationEnd = isGlobal ? lonCount : lonCount - 1;
  for (let latIt = 0; latIt < latIterationEnd; latIt++) {
    for (let lonIt = 0; lonIt < lonIterationEnd; lonIt++) {
      const nextJ = isGlobal ? (lonIt + 1) % lonCount : lonIt + 1;
      const lowLeft = latIt * lonCount + lonIt;
      const lowRight = latIt * lonCount + nextJ;
      const topLeft = (latIt + 1) * lonCount + lonIt;
      const topRight = (latIt + 1) * lonCount + nextJ;

      indices.push(lowLeft, topRight, topLeft);
      indices.push(lowLeft, lowRight, topRight);
    }
  }

  return { vertices, indices, uvs };
}

async function makeRegularGeometry(grid: zarr.Group<Readable>) {
  const { vertices, indices, uvs } = await getGaussianGrid(grid);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geometry.setIndex(indices);
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

async function fetchGrid() {
  try {
    const root = zarr.root(new zarr.FetchStore(gridsource.value!.store));
    const grid = await zarr.open(root.resolve(gridsource.value!.dataset), {
      kind: "group",
    });
    const geometry = await makeRegularGeometry(grid!);
    mainMesh!.geometry.dispose();
    mainMesh!.geometry = geometry;
    redraw();
  } catch (error) {
    toast.add({
      detail: `Could not fetch grid: ${getErrorMessage(error)}`,
      life: 3000,
    });
  }
}
async function getRegularData(
  arr: Float64Array,
  latCount: number,
  lonCount: number
) {
  const texture = new THREE.DataTexture(
    arr,
    lonCount,
    latCount,
    THREE.RedFormat,
    THREE.FloatType,
    THREE.UVMapping
  );
  texture.needsUpdate = true;
  return texture;
}

async function getRotatedNorthPole(): Promise<{ lat: number; lon: number }> {
  const datasource =
    props.datasources!.levels[0].datasources[varnameSelector.value];
  const root = zarr.root(new zarr.FetchStore(datasource.store));
  const info = await zarr.open(
    root.resolve(datasource.dataset + `/rotated_latitude_longitude`),
    {
      kind: "array",
    }
  );
  const lat = info.attrs["grid_north_pole_latitude"] as number;
  const lon = info.attrs["grid_north_pole_longitude"] as number;
  return { lat, lon };
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
      const rawData = await zarr.get(datavar, [
        currentTimeIndexSliderValue,
        ...Array(datavar.shape.length - 1).fill(null),
      ]);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i of rawData.data as Float64Array) {
        min = Math.min(min, i);
        max = Math.max(max, i);
      }
      const textures = await getRegularData(
        rawData.data as Float64Array,
        rawData.shape[0],
        rawData.shape[1]
      );
      const low = props.varbounds?.low as number;
      const high = props.varbounds?.high as number;
      const { addOffset, scaleFactor } = calculateColorMapProperties(
        low,
        high,
        props.invertColormap
      );

      const material = makeTextureMaterial(
        textures,
        props.colormap!,
        addOffset,
        scaleFactor
      );

      mainMesh!.material = material;
      mainMesh!.material.needsUpdate = true;

      publishVarinfo({
        attrs: datavar.attrs,
        timeinfo,
        timeRange: { start: 0, end: datavar.shape[0] - 1 },
        bounds: { low: min, high: max },
      });
      redraw();
      timeIndex.value = currentTimeIndexSliderValue;
      varname.value = localVarname;
    }
    updatingData.value = false;
    if (updateCount.value !== myUpdatecount) {
      await getData();
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
onMounted(() => {
  getScene()?.add(mainMesh as THREE.Mesh);
  // scaleBarRef.value.setContext(getCamera(), getRenderer());
});

onBeforeMount(async () => {
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.ShaderMaterial();
  mainMesh = new THREE.Mesh(geometry, material);
  await datasourceUpdate();
});

defineExpose({ makeSnapshot, copyPythonExample, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
    <!-- <Scale ref="scaleBarRef" /> -->
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
