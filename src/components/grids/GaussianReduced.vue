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
import {
  makeGpuProjectedColormapMaterial,
  updateProjectionUniforms,
} from "../utils/colormapShaders.ts";
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
  projectionMode,
  projectionCenter,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const updateCount = ref(0);
const updatingData = ref(false);

let meshes: THREE.Mesh[] = [];

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

watch([() => projectionMode.value, () => projectionCenter.value], () => {
  updateMeshProjectionUniforms();
});

function updateMeshProjectionUniforms() {
  const helper = projectionHelper.value;
  const center = projectionCenter.value;

  for (const mesh of meshes) {
    updateProjectionUniforms(
      mesh.material as THREE.ShaderMaterial,
      helper.type,
      center.lon,
      center.lat
    );
  }
}

const colormapMaterial = computed(() => {
  if (invertColormap.value) {
    return makeGpuProjectedColormapMaterial(colormap.value, 1.0, -1.0);
  } else {
    return makeGpuProjectedColormapMaterial(colormap.value, 0.0, 1.0);
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

async function getGrid(
  latitudes: Float64Array,
  longitudes: Float64Array,
  data: Float32Array
) {
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

    const latLonValues = new Float32Array(totalCells * 4 * 2); // 4 vertices, 2 values (lat, lon)
    const positionValues = new Float32Array(totalCells * 4 * 3); // 4 vertices, 3 values (x, y, z)
    const dataValues = new Float32Array(totalCells * 4);
    const indices = new Uint32Array(totalCells * 6);

    let latLonOffset = 0;
    let positionOffset = 0;
    let idxOffset = 0;
    let cellIndex = 0;

    const helper = projectionHelper.value;

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

        const EPSILON = 0.002; // Small overlap in degrees to avoid z-fighting

        // Vertex 0: top-left
        const v0Lat = lat1;
        const v0Lon = lon1 + EPSILON;
        helper.projectLatLonToArrays(
          v0Lat,
          v0Lon,
          positionValues,
          positionOffset,
          latLonValues,
          latLonOffset
        );

        // Vertex 1: top-right
        const v1Lat = lat1;
        const v1Lon = lon1 - dLon - EPSILON;
        helper.projectLatLonToArrays(
          v1Lat,
          v1Lon,
          positionValues,
          positionOffset + 3,
          latLonValues,
          latLonOffset + 2
        );

        // Vertex 2: bottom-right
        const v2Lat = lat2 - EPSILON;
        const v2Lon = lon1 - dLon - EPSILON;
        helper.projectLatLonToArrays(
          v2Lat,
          v2Lon,
          positionValues,
          positionOffset + 6,
          latLonValues,
          latLonOffset + 4
        );

        // Vertex 3: bottom-left
        const v3Lat = lat2 - EPSILON;
        const v3Lon = lon1 + EPSILON;
        helper.projectLatLonToArrays(
          v3Lat,
          v3Lon,
          positionValues,
          positionOffset + 9,
          latLonValues,
          latLonOffset + 6
        );

        // Data value
        dataValues.fill(cell.value, cellIndex * 4, cellIndex * 4 + 4);

        // Indices for two triangles
        const v = cellIndex * 4;
        indices.set([v, v + 1, v + 2, v, v + 2, v + 3], idxOffset);

        // Offsets
        latLonOffset += 8; // 4 vertices * 2 values each
        positionOffset += 12; // 4 vertices * 3 values each
        idxOffset += 6;
        cellIndex++;
      }
    }

    // Build geometry with position and latLon attributes
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positionValues, 3)
    );
    geometry.setAttribute("latLon", new THREE.BufferAttribute(latLonValues, 2));
    geometry.setAttribute(
      "data_value",
      new THREE.BufferAttribute(dataValues, 1)
    );
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();

    if (meshes[batchIndex]) {
      meshes[batchIndex].geometry.dispose();
      meshes[batchIndex].geometry = geometry;
    } else {
      const mesh = new THREE.Mesh(geometry, colormapMaterial.value);
      // Disable frustum culling - GPU projection changes actual positions
      mesh.frustumCulled = false;
      meshes.push(mesh);
      getScene()?.add(mesh);
    }
  }
}

function buildRows(
  latitudes: Float64Array,
  longitudes: Float64Array,
  data: Float32Array
) {
  const rows: Record<number, { lon: number; value: number }[]> = {};
  for (let i = 0; i < latitudes.length; i++) {
    const lat = latitudes[i];
    if (!rows[lat]) rows[lat] = [];
    rows[lat].push({ lon: longitudes[i], value: data[i] });
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

      // Set projection uniforms on all meshes after grid creation
      updateMeshProjectionUniforms();

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
