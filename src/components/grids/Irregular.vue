<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import { makeIrregularGridMaterial } from "../utils/colormapShaders.ts";

import { datashaderExample } from "../utils/exampleFormatters.ts";
import { computed, onBeforeMount, ref, onMounted, watch } from "vue";

import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "../store/store.js";
import { storeToRefs } from "pinia";
import type { TSources } from "../../types/GlobeTypes.ts";
import { useLog } from "../utils/logging.ts";
import { useSharedGridLogic } from "./useSharedGridLogic.ts";
import { useUrlParameterStore } from "../store/paramStore.ts";
import { getDimensionInfo } from "../utils/dimensionHandling.ts";
import { getDataBounds } from "../utils/zarrUtils.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();
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

const updateCount = ref(0);
const updatingData = ref(false);

const estimatedSpacing = ref(0);

let points: THREE.Points | undefined = undefined;

const {
  getScene,
  getCamera,
  makeSnapshot,
  toggleRotate,
  getDataVar,
  getTimeVar,
  registerUpdateLOD,
  updateLandSeaMask,
  updateColormap,
  extractTimeInfo,
  canvas,
  box,
} = useSharedGridLogic();

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
    updateColormap([points]);
  }
);

const timeIndexSlider = computed(() => {
  if (varinfo.value?.dimRanges[0]?.name !== "time") {
    return 0;
  }
  return dimSlidersValues.value[0];
});

const colormapMaterial = computed(() => {
  if (invertColormap.value) {
    return makeIrregularGridMaterial(colormap.value, 1.0, -1.0);
  } else {
    return makeIrregularGridMaterial(colormap.value, 0.0, 1.0);
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

async function datasourceUpdate() {
  if (props.datasources !== undefined) {
    await Promise.all([getData()]);
    updateLandSeaMask();
    updateColormap([points]);
  }
}

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

function estimateAverageSpacing(
  positions: Float32Array,
  sampleSize = 100000
): number {
  const numPoints = positions.length / 3;
  const samples = Math.min(sampleSize, numPoints);

  let totalDistance = 0;
  let count = 0;

  // Sample random points and find nearest neighbor distance
  for (let i = 0; i < samples; i++) {
    const idx = Math.floor(Math.random() * numPoints) * 3;
    const x1 = positions[idx];
    const y1 = positions[idx + 1];
    const z1 = positions[idx + 2];

    let minDist = Infinity;

    // Check against a subset of other points
    for (let j = 0; j < Math.min(100, numPoints); j++) {
      if (i === j) continue;

      const jdx = Math.floor(Math.random() * numPoints) * 3;
      const x2 = positions[jdx];
      const y2 = positions[jdx + 1];
      const z2 = positions[jdx + 2];

      const dx = x2 - x1;
      const dy = y2 - y1;
      const dz = z2 - z1;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist > 0 && dist < minDist) {
        minDist = dist;
      }
    }

    if (minDist !== Infinity) {
      totalDistance += minDist;
      count++;
    }
  }

  return count > 0 ? totalDistance / count : 0.01;
}

async function getGrid(grid: zarr.Group<zarr.Readable>, data: Float32Array) {
  // Load latitudes and longitudes arrays (1D)
  const latitudes = (
    await zarr.open(grid.resolve("lat"), { kind: "array" }).then(zarr.get)
  ).data as Float64Array;

  const longitudes = (
    await zarr.open(grid.resolve("lon"), { kind: "array" }).then(zarr.get)
  ).data as Float64Array;

  const N = latitudes.length;

  if (longitudes.length !== N || data.length !== N) {
    throw new Error(
      "Latitudes, longitudes, and data must have the same length"
    );
  }

  // Allocate typed arrays for positions and values
  const positions = new Float32Array(N * 3);
  const dataValues = new Float32Array(N);

  // Convert lat/lon to Cartesian positions
  for (let i = 0; i < N; i++) {
    latLonToCartesianFlat(latitudes[i], longitudes[i], positions, i * 3);
    dataValues[i] = data[i];
  }

  estimatedSpacing.value = estimateAverageSpacing(positions);

  points!.geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3)
  );
  points!.geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(dataValues, 1)
  );
  points!.geometry.computeBoundingSphere();
  const material = points!.material as THREE.ShaderMaterial;
  material.needsUpdate = true;
  updateLOD();
}

function updateLOD() {
  const avgSpacing = estimatedSpacing.value;
  const globeRadius = 1;
  const camera = getCamera()!;
  const cameraDistance = camera.position.length();

  // Calculate field of view factor
  const fov = (camera as THREE.PerspectiveCamera).fov || 50;
  const fovFactor = Math.tan((fov * Math.PI) / 360);

  // Base point size calculation:
  // - Proportional to average spacing to prevent overlap
  // - Adjusted for camera distance
  // - Scaled by viewport size
  const viewportHeight = window.innerHeight;

  // This is the key formula: converts world-space spacing to screen pixels
  // The magic number 0.8 prevents excessive overlap (tune between 0.5-1.5)
  const basePointSize = (avgSpacing * viewportHeight * 0.8) / (2 * fovFactor);

  // Define reasonable bounds based on zoom level
  const zoomFactor = globeRadius / cameraDistance;
  const minPointSize = Math.max(1.0, 2.0 * zoomFactor);
  const maxPointSize = Math.min(10.0, 50.0 * zoomFactor);
  const material: THREE.ShaderMaterial = points!
    .material as THREE.ShaderMaterial;
  // Update shader uniforms
  material.uniforms.basePointSize.value = basePointSize;
  material.uniforms.minPointSize.value = minPointSize;
  material.uniforms.maxPointSize.value = maxPointSize;
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
    const currentTimeIndexSliderValue = timeIndexSlider.value as number;
    const [timevar, datavar] = await Promise.all([
      getTimeVar(props.datasources!),
      getDataVar(localVarname, props.datasources!),
    ]);
    let timeinfo = await extractTimeInfo(timevar, currentTimeIndexSliderValue);

    if (datavar !== undefined) {
      const { dimensionRanges, indices } = getDimensionInfo(
        datavar,
        paramDimIndices.value,
        paramDimMinBounds.value,
        paramDimMaxBounds.value,
        updateMode === UPDATE_MODE.INITIAL_LOAD ? null : dimSlidersValues.value,
        1
      );

      const root = zarr.root(new zarr.FetchStore(gridsource.value!.store));
      const grid = await zarr.open(root.resolve(gridsource.value!.dataset), {
        kind: "group",
      });
      let rawData = (await zarr.get(datavar, indices)).data as Float32Array;
      if (rawData instanceof Float64Array) {
        // WebGL doesn't support Float64Array textures
        // we convert it to Float32Array and accept the loss of precision
        rawData = Float32Array.from(rawData);
      }

      let { min, max } = getDataBounds(datavar, rawData);
      await getGrid(grid, rawData);
      store.updateVarInfo(
        {
          attrs: datavar.attrs,
          timeinfo,
          bounds: { low: min, high: max },
          dimRanges: dimensionRanges,
        },
        updateMode
      );
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
}

onMounted(() => {
  let sphereGeometry = new THREE.SphereGeometry(0.999, 64, 64);
  const earthMat = new THREE.MeshBasicMaterial({ color: 0x000000 }); // black color

  // it is quite likely that the data points do not cover the whole globe
  // in order to avoid some ugly transparency issues, we add an opaque black
  // sphere underneath
  const globeMesh = new THREE.Mesh(sphereGeometry, earthMat);
  globeMesh.geometry.attributes.position.needsUpdate = true;
  globeMesh.rotation.x = Math.PI / 2;
  globeMesh.geometry.computeBoundingBox();
  globeMesh.geometry.computeBoundingSphere();

  getScene()?.add(points as THREE.Points);
  getScene()?.add(globeMesh);
});

onBeforeMount(async () => {
  const geometry = new THREE.BufferGeometry();
  const material = colormapMaterial.value;
  points = new THREE.Points(geometry, material);
  await datasourceUpdate();
  registerUpdateLOD(updateLOD);
});

defineExpose({ makeSnapshot, copyPythonExample, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
