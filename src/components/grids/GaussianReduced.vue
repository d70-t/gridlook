<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import { makeColormapMaterial } from "../utils/colormapShaders.ts";

import { datashaderExample } from "../utils/exampleFormatters.ts";
import { computed, onBeforeMount, onUnmounted, ref, watch } from "vue";

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
import { getDataBounds, getLatLonData } from "../utils/zarrUtils.ts";

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

const {
  getScene,
  getCamera,
  redraw,
  makeSnapshot,
  toggleRotate,
  getDataVar,
  getTimeInfo,
  updateLandSeaMask,
  updateColormap,
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

const colormapMaterial = computed(() => {
  if (invertColormap) {
    return makeColormapMaterial(colormap.value, 1.0, -1.0);
  } else {
    return makeColormapMaterial(colormap.value, 0.0, 1.0);
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
    updateColormap(meshes);
  }
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

async function getGrid(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  data: Float32Array
) {
  const [latitudesVar, longitudesVar] = await getLatLonData(
    datavar,
    props.datasources
  );
  const latitudes = latitudesVar.data as Float64Array;
  const longitudes = longitudesVar.data as Float64Array;
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
        latLonToCartesianFlat(lat1, lon1 + EPSILON, positions, vtxOffset);
        latLonToCartesianFlat(
          lat1,
          lon1 - dLon - EPSILON,
          positions,
          vtxOffset + 3
        );
        latLonToCartesianFlat(
          lat2 - EPSILON,
          lon1 - dLon - EPSILON,
          positions,
          vtxOffset + 6
        );
        latLonToCartesianFlat(
          lat2 - EPSILON,
          lon1 + EPSILON,
          positions,
          vtxOffset + 9
        );

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
        1,
        varinfo.value?.dimRanges,
        updateMode
      );

      let rawData = (await zarr.get(datavar, indices)).data as Float32Array;
      if (rawData instanceof Float64Array) {
        // WebGL doesn't support Float64Array textures
        // we convert it to Float32Array and accept the loss of precision
        rawData = Float32Array.from(rawData);
      }

      let { min, max, missingValue, fillValue } = getDataBounds(
        datavar,
        rawData
      );

      await getGrid(datavar, rawData);

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

function copyPythonExample() {
  const example = datashaderExample({
    cameraPosition: getCamera()!.position,
    datasrc: datasource.value!.store + datasource.value!.dataset,
    gridsrc: gridsource.value!.store + gridsource.value!.dataset,
    varname: varnameSelector.value,
    timeIndex: timeIndexSlider.value as number,
    varbounds: bounds.value!,
    colormap: colormap.value!,
    invertColormap: invertColormap.value,
  });
  navigator.clipboard.writeText(example);
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
