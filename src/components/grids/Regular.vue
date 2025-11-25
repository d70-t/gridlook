<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import type { Readable } from "@zarrita/storage";
import {
  calculateColorMapProperties,
  makeTextureMaterial,
} from "../utils/colormapShaders.ts";
import { datashaderExample } from "../utils/exampleFormatters.ts";
import { computed, onBeforeMount, onMounted, ref, watch } from "vue";

import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "../store/store.js";
import { storeToRefs } from "pinia";
import type { TSources } from "../../types/GlobeTypes.ts";
import { useToast } from "primevue/usetoast";
import { useLog } from "../utils/logging.ts";
import { useSharedGridLogic } from "./useSharedGridLogic.ts";
import { useUrlParameterStore } from "../store/paramStore.ts";
import { getDimensionInfo } from "../utils/dimensionHandling.ts";
import {
  findCRSVar,
  getDataBounds,
  getDataSourceStore,
} from "../utils/zarrUtils.ts";

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

const {
  getScene,
  getCamera,
  redraw,
  makeSnapshot,
  toggleRotate,
  resetDataVars,
  getDataVar,
  getTimeInfo,
  updateLandSeaMask,
  updateColormap,
  canvas,
  box,
} = useSharedGridLogic();

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
    updateColormap([mainMesh]);
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
    updateColormap([mainMesh]);
  }
}

async function getDims(grid: zarr.Group<Readable>) {
  // Assumptions: the last two dimensions of the data array are
  // latitude and longitude (in this order)
  const root = getDataSourceStore(props.datasources!, varnameSelector.value);
  const datavar = await zarr.open(root.resolve(varnameSelector.value), {
    kind: "array",
  });
  const dimensions = datavar.attrs._ARRAY_DIMENSIONS as string[];
  const latName = dimensions[dimensions.length - 2];
  const lonName = dimensions[dimensions.length - 1];

  const [latitudesData, longitudesData] = await Promise.all([
    zarr
      .open(grid.resolve(latName), {
        kind: "array",
      })
      .then(zarr.get),
    zarr.open(grid.resolve(lonName), { kind: "array" }).then(zarr.get),
  ]);
  const myLongitudes = longitudesData.data as Float64Array;
  const myLatitudes = latitudesData.data as Float64Array;
  longitudes.value = new Float64Array(new Set(myLongitudes));
  latitudes.value = new Float64Array(new Set(myLatitudes));
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

  // Use unwrapped longitudes to check span
  const span = Math.abs(lons[n - 1] - lons[0]);

  // Estimate the grid spacing
  const avgDelta = span / (n - 1);

  // Check if span + one grid cell covers 360°
  return span + avgDelta > 359.5;
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

function normalizeLongitudes(lons: Float64Array): Float64Array {
  // Normalize longitudes to [0, 360)
  return Float64Array.from(lons, (lon) => ((lon % 360) + 360) % 360);
}

async function getGaussianGrid() {
  const isRotated = props.isRotated;
  let lons = normalizeLongitudes(longitudes.value);
  let lats = latitudes.value;

  // Check if latitudes are descending and reverse if necessary
  let isLatReversed = lats[0] > lats[lats.length - 1];
  if (isLatReversed) {
    lats = Float64Array.from(lats).reverse();
  }

  const isGlobal = isLongitudeGlobal(longitudes.value);

  if (isGlobal) {
    // Add a duplicate of the first longitude + 360 to close the globe
    const firstLon = lons[0];
    lons = new Float64Array([...lons, firstLon + 360]);
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
  arr: Float32Array,
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
  const root = getDataSourceStore(props.datasources!, varnameSelector.value);
  const crs = await zarr.open(
    root.resolve(await findCRSVar(root, varnameSelector.value)),
    {
      kind: "array",
    }
  );
  const lat = crs.attrs["grid_north_pole_latitude"] as number;
  const lon = crs.attrs["grid_north_pole_longitude"] as number;
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

    const datavar = await getDataVar(localVarname, props.datasources!);

    const currentTimeIndexSliderValue = timeIndexSlider.value as number;

    if (datavar !== undefined) {
      const { dimensionRanges, indices } = getDimensionInfo(
        datavar,
        paramDimIndices.value,
        paramDimMinBounds.value,
        paramDimMaxBounds.value,
        dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
        2,
        varinfo.value?.dimRanges,
        updateMode
      );

      let rawData = (await zarr.get(datavar, indices)).data as Float32Array;
      if (rawData instanceof Float64Array) {
        // WebGL doesn't support Float64Array textures
        // we convert it to Float32Array and accept the loss of precision
        rawData = Float32Array.from(rawData);
      }

      const textures = await getRegularData(
        rawData,
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
      const { min, max, missingValue, fillValue } = getDataBounds(
        datavar,
        rawData
      );
      // Set missing/fill values as uniforms for the shader
      material.uniforms.missingValue.value = missingValue;
      material.uniforms.fillValue.value = fillValue;

      mainMesh!.material = material;
      mainMesh!.material.needsUpdate = true;

      const timeinfo = await getTimeInfo(
        props.datasources!,
        dimensionRanges,
        currentTimeIndexSliderValue
      );

      store.updateVarInfo(
        {
          attrs: datavar.attrs,
          timeinfo,
          bounds: { low: min, high: max },
          dimRanges: dimensionRanges,
        },
        indices as number[],
        updateMode
      );
      redraw();
    }
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
function copyPythonExample() {
  const example = datashaderExample({
    cameraPosition: getCamera()!.position,
    datasrc: datasource.value!.store + datasource.value!.dataset,
    gridsrc: gridsource.value!.store + gridsource.value!.dataset,
    varname: varnameSelector.value,
    timeIndex: timeIndexSlider.value as number,
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

defineExpose({ makeSnapshot, copyPythonExample, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
    <!-- <Scale ref="scaleBarRef" /> -->
  </div>
</template>
