<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, ref, watch } from "vue";
import * as zarr from "zarrita";

import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import { reconcileCoordinates } from "@/lib/data/irregularGridHelpers.ts";
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
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
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
  posterizeLevels,
  selection,
  isInitializingVariable,
  varinfo,
  projectionMode,
  projectionCenter,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const pendingUpdate = ref(false);
const updatingData = ref(false);

const estimatedSpacing = ref(0);

const BATCH_SIZE = 500000;
let points: THREE.Points[] = [];

const {
  getScene,
  getCamera,
  makeSnapshot,
  toggleRotate,
  getDataVar,
  fetchDimensionDetails,
  registerUpdateLOD,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
  redraw,
  canvas,
  box,
  updateHistogram,
} = useSharedGridLogic();

watch(
  () => varnameSelector.value,
  () => {
    getData();
  }
);

watch(
  () => dimSlidersValues.value,
  async () => {
    if (isInitializingVariable.value) {
      isInitializingVariable.value = false;
      return;
    }
    await getData(UPDATE_MODE.SLIDER_TOGGLE);
    updateColormap(points);
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
  [
    () => bounds.value,
    () => invertColormap.value,
    () => colormap.value,
    () => posterizeLevels.value,
  ],
  () => {
    updateColormap(points);
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
  const helper = projectionHelper.value;
  const center = projectionCenter.value;

  for (const p of points) {
    const material = p.material as THREE.ShaderMaterial;
    if (material.uniforms?.projectionType) {
      updateProjectionUniforms(material, helper.type, center.lon, center.lat);
    }
  }
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
    updateColormap(points);
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

function cleanupPoints(totalBatches: number) {
  if (points.length <= totalBatches) {
    return;
  }
  for (const p of points) {
    p.geometry.dispose();
    getScene()?.remove(p);
  }
  points.length = 0;
}

function updateBatch(
  batchIndex: number,
  positions: Float32Array,
  latLonValues: Float32Array,
  data: Float32Array,
  start: number,
  end: number
) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array(positions.subarray(start * 3, end * 3)),
      3
    )
  );
  geometry.setAttribute(
    "latLon",
    new THREE.BufferAttribute(
      new Float32Array(latLonValues.subarray(start * 2, end * 2)),
      2
    )
  );
  geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(new Float32Array(data.subarray(start, end)), 1)
  );
  geometry.computeBoundingSphere();

  if (points[batchIndex]) {
    points[batchIndex].geometry.dispose();
    points[batchIndex].geometry = geometry;
  } else {
    const p = new THREE.Points(geometry, colormapMaterial.value);
    p.frustumCulled = false;
    points.push(p);
    getScene()?.add(p);
  }
}

function getGrid(
  latitudesVar: zarr.Chunk<zarr.DataType>,
  longitudesVar: zarr.Chunk<zarr.DataType>,
  data: Float32Array
) {
  const N = data.length;
  const { latitudes, longitudes } = reconcileCoordinates(
    latitudesVar,
    longitudesVar,
    N
  );

  const totalBatches = Math.ceil(N / BATCH_SIZE);
  cleanupPoints(totalBatches);

  const positions = new Float32Array(N * 3);
  const latLonValues = new Float32Array(N * 2);
  const helper = projectionHelper.value;

  for (let i = 0; i < N; i++) {
    helper.projectLatLonToArrays(
      latitudes[i],
      longitudes[i],
      positions,
      i * 3,
      latLonValues,
      i * 2
    );
  }

  estimatedSpacing.value = estimateAverageSpacing(positions);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, N);
    updateBatch(batchIndex, positions, latLonValues, data, start, end);
  }

  // Update projection uniforms after geometry change
  updatePointsProjectionUniforms();
  updateLOD();
}

function updateLOD() {
  const avgSpacing = estimatedSpacing.value;
  const globeRadius = 1;
  const camera = getCamera();
  if (!camera) {
    return;
  }
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

  for (const p of points) {
    const material = p.material as THREE.ShaderMaterial;
    material.uniforms.basePointSize.value = basePointSize;
    material.uniforms.minPointSize.value = minPointSize;
    material.uniforms.maxPointSize.value = maxPointSize;
  }
}

async function getDimensionValues(
  dimensionRanges: TDimensionRange[],
  indices: (number | zarr.Slice | null)[]
) {
  const dimValues = await fetchDimensionDetails(
    varnameSelector.value,
    props.datasources!,
    dimensionRanges,
    indices
  );
  return dimValues;
}

function getGeographicDimensionIndices(
  dimensions: string[],
  latitudesAttrs: zarr.Attributes,
  longitudesAttrs: zarr.Attributes
) {
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
  return geoDims;
}

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  updateMode: TUpdateMode
) {
  // Load latitudes and longitudes arrays (1D)
  const { latitudes, longitudes, latitudesAttrs, longitudesAttrs } =
    await getLatLonData(datavar, props.datasources);
  const dimensions = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  const geoDims: number[] = getGeographicDimensionIndices(
    dimensions,
    latitudesAttrs,
    longitudesAttrs!
  );

  const { dimensionRanges, indices } = buildDimensionRangesAndIndices(
    datavar,
    dimensions,
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

  let { min, max, fillValue, missingValue } = getDataBounds(datavar, rawData);
  getGrid(latitudes, longitudes!, rawData);

  for (const p of points) {
    const material = p.material as THREE.ShaderMaterial;
    material.uniforms.fillValue.value = fillValue;
    material.uniforms.missingValue.value = missingValue;
  }

  const dimInfo = await getDimensionValues(dimensionRanges, indices);
  updateHistogram(rawData, min, max, missingValue, fillValue);

  store.updateVarInfo(
    {
      attrs: datavar.attrs,
      dimInfo,
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
    if (updatingData.value) {
      pendingUpdate.value = true;
      return;
    }
    updatingData.value = true;
    do {
      pendingUpdate.value = false;
      const localVarname = varnameSelector.value;
      const datavar = await getDataVar(localVarname, props.datasources!);
      if (datavar !== undefined) {
        await fetchAndRenderData(datavar, updateMode);
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

onBeforeMount(async () => {
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
