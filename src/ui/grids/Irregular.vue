<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, ref, onMounted, watch } from "vue";
import * as zarr from "zarrita";

import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { getDimensionInfo } from "@/lib/data/dimensionHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  castDataVarToFloat32,
  getDataBounds,
  getLatLonData,
} from "@/lib/data/zarrUtils.ts";
import {
  makeGpuProjectedPointMaterial,
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
  dimSlidersValues,
  colormap,
  varnameSelector,
  invertColormap,
  selection,
  isInitializingVariable,
  varinfo,
  projectionMode,
  projectionCenter,
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
  getTime,
  registerUpdateLOD,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
  redraw,
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

// GPU projection: update shader uniforms instead of rebuilding geometry
watch(
  [() => projectionMode.value, () => projectionCenter.value],
  () => {
    updatePointsProjectionUniforms();
  },
  { deep: true }
);

/**
 * Update projection uniforms on the points material.
 * This is the fast path - no geometry rebuild needed.
 */
function updatePointsProjectionUniforms() {
  if (!points) {
    return;
  }
  const material = points.material as THREE.ShaderMaterial;
  if (!material.uniforms?.projectionType) {
    return;
  }

  const helper = projectionHelper.value;
  const center = projectionCenter.value;

  updateProjectionUniforms(material, helper.type, center.lon, center.lat);
  redraw();
}

const colormapMaterial = computed(() => {
  // Use GPU-projected material
  const material = invertColormap.value
    ? makeGpuProjectedPointMaterial(colormap.value, 1.0, -1.0)
    : makeGpuProjectedPointMaterial(colormap.value, 0.0, 1.0);

  return material;
});

async function datasourceUpdate() {
  if (props.datasources !== undefined) {
    await Promise.all([getData()]);
    updateLandSeaMask();
    updateColormap([points]);
  }
}

function estimateAverageSpacing(
  positions: Float32Array,
  sampleSize = 5000
): number {
  const numPoints = positions.length / 3;
  const stride = Math.max(1, Math.floor(numPoints / sampleSize));

  let totalDistance = 0;
  let totalWeight = 0;

  for (let i = 0; i < numPoints; i += stride) {
    const idx = i * 3;
    const x1 = positions[idx];
    const y1 = positions[idx + 1];
    const z1 = positions[idx + 2];

    // Latitude weighting
    const lat = Math.asin(z1);
    const weight = Math.cos(lat);
    if (weight < 0.1) {
      continue;
    }

    let minDist = Infinity;

    // Check local neighborhood (points before and after)
    const neighborhoodSize = 50;
    const start = Math.max(0, i - neighborhoodSize);
    const end = Math.min(numPoints, i + neighborhoodSize);

    for (let j = start; j < end; j++) {
      if (i === j) {
        continue;
      }

      const jdx = j * 3;
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
      totalDistance += minDist * weight;
      totalWeight += weight;
    }
  }

  return totalWeight > 0 ? totalDistance / totalWeight : 0.01;
}

async function getGrid(
  latitudesVar: zarr.Chunk<zarr.DataType>,
  longitudesVar: zarr.Chunk<zarr.DataType>,
  data: Float32Array
) {
  const latitudes = latitudesVar.data as Float32Array;
  const longitudes = longitudesVar.data as Float32Array;

  const N = latitudes.length;

  if (longitudes.length !== N || data.length !== N) {
    throw new Error(
      "Latitudes, longitudes, and data must have the same length"
    );
  }

  // Allocate typed arrays for positions, latLon, and values
  const positions = new Float32Array(N * 3);
  const latLonValues = new Float32Array(N * 2);
  const dataValues = new Float32Array(N);

  // Convert lat/lon to Cartesian positions and store latLon for GPU projection
  const helper = projectionHelper.value;

  for (let i = 0; i < N; i++) {
    const lat = latitudes[i];
    const lon = longitudes[i];
    const positionOffset = i * 3;
    const latLonOffset = i * 2;

    // Store lat/lon for GPU projection and compute initial positions
    helper.projectLatLonToArrays(
      lat,
      lon,
      positions,
      positionOffset,
      latLonValues,
      latLonOffset
    );
    dataValues[i] = data[i];
  }

  estimatedSpacing.value = estimateAverageSpacing(positions);

  points!.geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3)
  );
  // Add latLon attribute for GPU projection
  points!.geometry.setAttribute(
    "latLon",
    new THREE.BufferAttribute(latLonValues, 2)
  );
  points!.geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(dataValues, 1)
  );
  points!.geometry.computeBoundingSphere();
  const material = points!.material as THREE.ShaderMaterial;
  material.needsUpdate = true;
  // Update projection uniforms after geometry change
  updatePointsProjectionUniforms();
  updateLOD();
}

function updateLOD() {
  const avgSpacing = estimatedSpacing.value;
  const globeRadius = 1;
  const camera = getCamera()!;
  const cameraDistance = camera.position.length();
  const viewportHeight = window.innerHeight;

  // Use logarithmic scaling for better distribution across orders of magnitude
  // This maps:
  // 0.00007 → ~0.15
  // 0.003   → ~0.70
  const logSpacing = Math.log10(avgSpacing);
  const normalizedSpacing = Math.max(0.2, Math.min(1.0, (logSpacing + 4) / 3)); // Tune these numbers

  const zoomFactor = globeRadius / cameraDistance;

  // Use avgSpacing directly in base calculation for better scaling
  const basePointSize =
    avgSpacing * viewportHeight * zoomFactor * normalizedSpacing * 400; // Tune multiplier

  // Adjust min/max with both zoom and density
  const minPointSize = Math.max(0.8, 3.0 * zoomFactor * normalizedSpacing);
  const maxPointSize = Math.min(25.0, 80.0 * zoomFactor * normalizedSpacing);

  const material: THREE.ShaderMaterial = points!
    .material as THREE.ShaderMaterial;
  material.uniforms.basePointSize.value = basePointSize;
  material.uniforms.minPointSize.value = minPointSize;
  material.uniforms.maxPointSize.value = maxPointSize;
}

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  updateMode: TUpdateMode
) {
  // Load latitudes and longitudes arrays (1D)
  const { latitudes, longitudes, latitudesAttrs, longitudesAttrs } =
    await getLatLonData(datavar, props.datasources);
  const dimensions = datavar.attrs._ARRAY_DIMENSIONS as string[];
  const geoDims: number[] = [];
  for (let i = 0; i < dimensions.length; i++) {
    let latDims = latitudesAttrs._ARRAY_DIMENSIONS as string[];
    let lonDims = longitudesAttrs._ARRAY_DIMENSIONS as string[];
    if (latDims.includes(dimensions[i])) {
      geoDims.push(i);
    } else if (lonDims.includes(dimensions[i])) {
      geoDims.push(i);
    }
  }
  const { dimensionRanges, indices } = getDimensionInfo(
    datavar,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    geoDims,
    varinfo.value?.dimRanges,
    updateMode === UPDATE_MODE.SLIDER_TOGGLE
  );

  let rawData = castDataVarToFloat32(
    (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
  );
  if (rawData instanceof Float64Array) {
    // WebGL doesn't support Float64Array textures
    // we convert it to Float32Array and accept the loss of precision
    rawData = Float32Array.from(rawData);
  }

  let { min, max, fillValue, missingValue } = getDataBounds(datavar, rawData);
  const material = points!.material as THREE.ShaderMaterial;
  material.uniforms.fillValue.value = fillValue;
  material.uniforms.missingValue.value = missingValue;
  await getGrid(latitudes, longitudes, rawData);

  const timeinfo = await getTime(props.datasources!, dimensionRanges, indices);
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
    if (datavar !== undefined) {
      await fetchAndRenderData(datavar, updateMode);
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

onMounted(() => {
  getScene()?.add(points as THREE.Points);
});

onBeforeMount(async () => {
  const geometry = new THREE.BufferGeometry();
  const material = colormapMaterial.value;
  points = new THREE.Points(geometry, material);
  // Disable frustum culling - GPU projection changes actual positions
  points.frustumCulled = false;
  await datasourceUpdate();
  registerUpdateLOD(updateLOD);
});

defineExpose({ makeSnapshot, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
