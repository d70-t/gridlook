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
import {
  computed,
  onBeforeMount,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Ref,
} from "vue";

import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "./store/store.js";
import { storeToRefs } from "pinia";
import type { TSources } from "../types/GlobeTypes.ts";
import { useToast } from "primevue/usetoast";
import { useLog } from "./utils/logging";
import { useSharedGlobeLogic } from "./sharedGlobe.ts";
import { useUrlParameterStore } from "./store/paramStore.ts";
import { getDimensionInfo } from "./utils/dimensionHandling.ts";

const props = defineProps<{
  datasources?: TSources;
  isRotated?: boolean;
}>();

const store = useGlobeControlStore();
const toast = useToast();
const { logError } = useLog();
const {
  dimSlidersValues,
  colormap,
  varnameSelector,
  invertColormap,
  selection,
  isInitializingVariable,
  varinfo,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

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

const longitudes = ref(new Float64Array());
const latitudes = ref(new Float64Array());

let mainMesh: THREE.Mesh | undefined = undefined;
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
    updateColormap();
  }
);

const timeIndexSlider = computed(() => {
  if (varinfo.value?.dimRanges[0]?.name !== "time") {
    return 0;
  }
  return dimSlidersValues.value[0];
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

async function datasourceUpdate() {
  resetDataVars();
  if (props.datasources !== undefined) {
    const root = zarr.root(new zarr.FetchStore(gridsource.value!.store));
    const grid = await zarr.open(root.resolve(gridsource.value!.dataset), {
      kind: "group",
    });
    await getDims(grid);
    await Promise.all([makeGeometry(), getData()]);
    updateLandSeaMask();
    updateColormap();
  }
}

async function getDims(grid: zarr.Group<Readable>) {
  const isRotated = props.isRotated;
  const [latitudesData, longitudesData] = await Promise.all([
    zarr
      .open(grid.resolve(isRotated ? "rlat" : "lat"), {
        kind: "array",
      })
      .then(zarr.get),
    zarr
      .open(grid.resolve(isRotated ? "rlon" : "lon"), { kind: "array" })
      .then(zarr.get),
  ]);
  const myLongitudes = longitudesData.data as Float64Array;
  const myLatitudes = latitudesData.data as Float64Array;
  longitudes.value = new Float64Array(new Set(myLongitudes));
  latitudes.value = new Float64Array(new Set(myLatitudes));
}

function updateColormap() {
  const low = bounds.value?.low as number;
  const high = bounds.value?.high as number;
  const { addOffset, scaleFactor } = calculateColorMapProperties(
    low,
    high,
    invertColormap.value
  );

  if (mainMesh) {
    const material = mainMesh!.material as THREE.ShaderMaterial;
    material.uniforms.colormap.value = availableColormaps[colormap.value];
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

function isLongitudeGlobal(lons: Float64Array): boolean {
  const n = lons.length;
  if (n < 2) return false;

  const delta = lons[1] - lons[0];

  // Compute total span covered by all steps (delta * (n - 1))
  const span = Math.abs(delta * (n - 1));

  // Normalize the span to [0, 360]
  const normalizedSpan = span % 360;
  return normalizedSpan + delta > 359.5;
}

/**
 * Generates vertices and UVs for a grid of points on a sphere.
 *
 * The function returns an object with two properties: `vertices`, an array of
 * 3D coordinates (x, y, z) representing the points on the sphere, and `uvs`, an
 * array of (u, v) coordinates representing the texture coordinates for the
 * points.
 */
function generateGridVerticesAndUVs(
  lats: Float64Array,
  lons: Float64Array,
  isReversed: boolean,
  isRotated: boolean,
  poleLat?: number,
  poleLon?: number,
  radius = 1.0
) {
  const vertices: number[] = [];
  const uvs: number[] = [];
  const latCount = lats.length;
  const lonCount = lons.length;

  for (let i = 0; i < latCount; i++) {
    const rawLat = lats[i];
    for (let j = 0; j < lonCount; j++) {
      const rawLon = lons[j];

      // If the grid is rotated, convert the raw latitude and longitude values
      // to geographic coordinates.
      const { lat, lon } = isRotated
        ? rotatedToGeographic(rawLat, rawLon, poleLat!, poleLon!)
        : { lat: rawLat, lon: rawLon };

      // Convert the latitude and longitude to 3D coordinates on the sphere.
      const xyz = latLongToXYZ(lat, lon, radius);
      vertices.push(...xyz);

      // Calculate the texture coordinates for the point. The `u` coordinate
      // represents the longitude, and the `v` coordinate represents the latitude.
      // The coordinates are normalized to the range [0, 1].
      const u = j / (lonCount - 1);
      const v = isReversed
        ? (latCount - 1 - i) / (latCount - 1)
        : i / (latCount - 1);
      uvs.push(u, v);
    }
  }

  return { vertices, uvs };
}

function generateGridIndices(
  latCount: number,
  lonCount: number,
  isGlobal: boolean
) {
  const indices: number[] = [];
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

  return indices;
}

async function getGaussianGrid() {
  const isRotated = props.isRotated;

  let lats = latitudes.value;
  let lons = longitudes.value.map((lon) => (lon + 360) % 360);

  // Check if latitudes are descending and reverse if necessary
  let isLatReversed = lats[0] > lats[lats.length - 1];
  if (isLatReversed) {
    lats = Float64Array.from(lats).reverse();
  }

  const isGlobal = isLongitudeGlobal(lons);

  if (isGlobal) {
    lons = new Float64Array(new Set([...lons, 360]));
  }

  const radius = 1.0;
  let poleLat, poleLon;
  if (isRotated) {
    const rotatedNorthPole = await getRotatedNorthPole();
    poleLat = rotatedNorthPole.lat;
    poleLon = rotatedNorthPole.lon;
  }

  const { vertices, uvs } = generateGridVerticesAndUVs(
    lats,
    lons,
    isLatReversed,
    isRotated,
    poleLat,
    poleLon,
    radius
  );

  const latCount = lats.length;
  const lonCount = lons.length;
  const indices = generateGridIndices(latCount, lonCount, isGlobal);

  return { vertices, indices, uvs };
}

async function makeRegularGeometry() {
  const { vertices, indices, uvs } = await getGaussianGrid();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geometry.setIndex(indices);
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

async function makeGeometry() {
  try {
    const geometry = await makeRegularGeometry();
    mainMesh!.geometry.dispose();
    mainMesh!.geometry = geometry;
    redraw();
  } catch (error) {
    logError(error, "Could not fetch grid");
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

async function getData(updateMode: TUpdateMode = UPDATE_MODE.INITIAL_LOAD) {
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
      const { dimensionRanges, indices } = getDimensionInfo(
        datavar,
        paramDimIndices.value,
        paramDimMinBounds.value,
        paramDimMaxBounds.value,
        updateMode === UPDATE_MODE.INITIAL_LOAD ? null : dimSlidersValues.value,
        2
      );

      const rawData = await zarr.get(datavar, indices);
      // const rawData = await zarr.get(datavar, [
      //   currentTimeIndexSliderValue,
      //   ...Array(datavar.shape.length - 1).fill(null),
      // ]);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i of rawData.data as Float64Array) {
        if (isNaN(i)) {
          continue;
        }
        min = Math.min(min, i);
        max = Math.max(max, i);
      }
      const textures = await getRegularData(
        rawData.data as Float64Array,
        latitudes.value.length,
        longitudes.value.length
      );
      const low = bounds.value?.low as number;
      const high = bounds.value?.high as number;
      const { addOffset, scaleFactor } = calculateColorMapProperties(
        low,
        high,
        invertColormap.value
      );

      const material = makeTextureMaterial(
        textures,
        colormap.value,
        addOffset,
        scaleFactor
      );

      mainMesh!.material = material;
      mainMesh!.material.needsUpdate = true;

      store.updateVarInfo(
        {
          attrs: datavar.attrs,
          timeinfo,
          timeRange: { start: 0, end: datavar.shape[0] - 1 },
          bounds: { low: min, high: max },
          dimRanges: dimensionRanges,
        },
        updateMode
      );
      redraw();
    }
    updatingData.value = false;
    if (updateCount.value !== myUpdatecount) {
      await getData();
    }
  } catch (error) {
    logError(error, "Could not fetch data");
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
  getScene()?.add(mainMesh as THREE.Mesh);
});

onBeforeMount(async () => {
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.ShaderMaterial();
  mainMesh = new THREE.Mesh(geometry, material);
  await datasourceUpdate();
});

onBeforeUnmount(() => {
  console.log("before unmount");
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
