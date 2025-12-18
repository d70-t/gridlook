<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, ref, watch } from "vue";

import type { TSources } from "../../types/GlobeTypes.ts";
import { useUrlParameterStore } from "../store/paramStore.ts";
import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "../store/store.js";
import { makeColormapMaterial } from "../utils/colormapShaders.ts";
import { getDimensionInfo } from "../utils/dimensionHandling.ts";
import { useLog } from "../utils/logging.ts";
import { ZarrDataManager } from "../utils/ZarrDataManager.ts";
import {
  castDataVarToFloat32,
  getDataBounds,
  getLatLonData,
} from "../utils/zarrUtils.ts";

import { useSharedGridLogic } from "./useSharedGridLogic.ts";

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

let meshes: THREE.Mesh[] = [];
let cachedLatitudes: Float64Array | undefined;
let cachedLongitudes: Float64Array | undefined;
let cachedData: Float32Array | undefined;

const {
  getScene,
  redraw,
  makeSnapshot,
  toggleRotate,
  getDataVar,
  getTimeInfo,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
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

const bounds = computed(() => {
  return selection.value;
});

const timeIndexSlider = computed(() => {
  if (varinfo.value?.dimRanges[0]?.name !== "time") {
    return 0;
  }
  return dimSlidersValues.value[0];
});

watch(
  [() => bounds.value, () => invertColormap.value, () => colormap.value],
  () => {
    updateColormap(meshes);
  }
);

watch(
  () => [projectionHelper.value],
  () => {
    void rebuildGaussianGridFromCache();
  }
);

const colormapMaterial = computed(() => {
  if (invertColormap) {
    return makeColormapMaterial(colormap.value, 1.0, -1.0);
  } else {
    return makeColormapMaterial(colormap.value, 0.0, 1.0);
  }
});

async function datasourceUpdate() {
  if (props.datasources !== undefined) {
    await Promise.all([getData()]);
    updateLandSeaMask();
    updateColormap(meshes);
  }
}

const BATCH_SIZE = 64; // Adjust based on memory and browser limits

function projectLatLon(
  lat: number,
  lon: number,
  out: Float32Array,
  offset: number
) {
  const helper = projectionHelper.value;
  const normalizedLon = helper.normalizeLongitude(lon);
  const [x, y, z] = helper.project(lat, normalizedLon, 1);
  out[offset] = x;
  out[offset + 1] = y;
  out[offset + 2] = z;
}

async function getGrid(
  latitudes: Float64Array,
  longitudes: Float64Array,
  data: Float32Array
) {
  cachedLatitudes = Float64Array.from(latitudes);
  cachedLongitudes = Float64Array.from(longitudes);
  cachedData = Float32Array.from(data);

  const { rows, uniqueLats } = buildRows(latitudes, longitudes, data);
  const totalBatches = Math.ceil((uniqueLats.length - 1) / BATCH_SIZE);

  if (meshes.length > totalBatches) {
    // we have more meshes than needed
    // Seems like the grid has changed to a smaller size
    for (const mesh of meshes) {
      mesh.geometry.dispose(); // Free GPU memory
      getScene()?.remove(mesh); // Remove from Three.js scene
    }
    meshes.length = 0; // Clear our mesh array
  }

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

        const EPSILON = 0.002; // Small overlap in degrees in order to avoid z-fighting
        projectLatLon(lat1, lon1 + EPSILON, positions, vtxOffset);
        projectLatLon(lat1, lon1 - dLon - EPSILON, positions, vtxOffset + 3);
        projectLatLon(
          lat2 - EPSILON,
          lon1 - dLon - EPSILON,
          positions,
          vtxOffset + 6
        );
        projectLatLon(lat2 - EPSILON, lon1 + EPSILON, positions, vtxOffset + 9);

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
}

function buildRows(lats: Float64Array, lons: Float64Array, data: Float32Array) {
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

async function rebuildGaussianGridFromCache() {
  if (!cachedLatitudes || !cachedLongitudes || !cachedData) {
    return;
  }
  await getGrid(cachedLatitudes, cachedLongitudes, cachedData);
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
    const datavar = await getDataVar(localVarname, props.datasources!);

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

      let rawData = castDataVarToFloat32(
        (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
      );

      const { latitudes, longitudes } = await getLatLonData(
        datavar,
        props.datasources
      );
      const latitudesData = latitudes.data as Float64Array;
      const longitudesData = longitudes.data as Float64Array;

      let { min, max, missingValue, fillValue } = getDataBounds(
        datavar,
        rawData
      );

      await getGrid(latitudesData, longitudesData, rawData);

      for (let mesh of meshes) {
        const material = mesh.material as THREE.ShaderMaterial;
        material.uniforms.missingValue.value = missingValue;
        material.uniforms.fillValue.value = fillValue;
      }

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
      await getData();
    }
  } catch (error) {
    logError(error, "Could not fetch data");
    updatingData.value = false;
  } finally {
    store.stopLoading();
  }
}

onBeforeMount(async () => {
  await datasourceUpdate();
});

defineExpose({ makeSnapshot, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
