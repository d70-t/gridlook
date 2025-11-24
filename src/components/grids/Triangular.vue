<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import { grid2buffer, data2valueBuffer } from "../utils/gridlook.ts";
import { makeColormapMaterial } from "../utils/colormapShaders.ts";

import { datashaderExample } from "../utils/exampleFormatters.ts";
import { computed, onBeforeMount, ref, watch } from "vue";

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

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();
const { logError } = useLog();
const {
  dimSlidersValues,
  varnameSelector,
  colormap,
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

watch(
  () => props.datasources,
  () => {
    datasourceUpdate();
  }
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
  if (invertColormap.value) {
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
    await fetchGrid();
    await getData();
    updateLandSeaMask();
    updateColormap(meshes);
  }
}

// Split triangles into batches for multiple meshes
const BATCH_SIZE = 3000000; // number of triangles per mesh (tune as needed)

async function fetchGrid() {
  try {
    const root = zarr.root(new zarr.FetchStore(gridsource.value!.store));
    const grid = await zarr.open(root.resolve(gridsource.value!.dataset), {
      kind: "group",
    });
    const verts = await grid2buffer(grid);

    // Remove old meshes from scene
    for (const mesh of meshes) {
      getScene()?.remove(mesh);
      mesh.geometry.dispose();
    }
    meshes.length = 0;

    const nTriangles = verts.length / 9;
    for (let i = 0; i < nTriangles; i += BATCH_SIZE) {
      const count = Math.min(BATCH_SIZE, nTriangles - i);
      const geometry = new THREE.BufferGeometry();
      // Each triangle has 9 values (3 vertices * 3 coords)
      const batchVerts = verts.subarray(i * 9, (i + count) * 9);
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(batchVerts, 3)
      );
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, colormapMaterial.value);
      meshes.push(mesh);
      getScene()?.add(mesh);
    }
    redraw();
  } catch (error) {
    logError(error, "Could not fetch grid");
  }
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
        updateMode === UPDATE_MODE.INITIAL_LOAD ? null : dimSlidersValues.value,
        1
      );

      const rawData = await zarr.get(datavar, indices);
      const dataBuffer = data2valueBuffer(rawData, datavar);
      // Distribute data values to each mesh
      let offset = 0;
      for (const mesh of meshes) {
        const nVerts = mesh.geometry.getAttribute("position").count;
        // Each triangle has 3 vertices, each vertex has a value
        const meshData = dataBuffer.dataValues.subarray(
          offset,
          offset + nVerts
        );
        mesh.geometry.setAttribute(
          "data_value",
          new THREE.BufferAttribute(meshData, 1)
        );
        const material = mesh.material as THREE.ShaderMaterial;
        material.uniforms.missingValue.value = dataBuffer.missingValue;
        material.uniforms.fillValue.value = dataBuffer.fillValue;
        offset += nVerts;
      }

      let timeinfo = await getTimeInfo(
        props.datasources!,
        dimensionRanges,
        currentTimeIndexSliderValue
      );
      store.updateVarInfo(
        {
          attrs: datavar.attrs,
          timeinfo,
          bounds: { low: dataBuffer.dataMin, high: dataBuffer.dataMax },
          dimRanges: dimensionRanges,
        },
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
    varbounds: bounds.value,
    colormap: colormap.value,
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
