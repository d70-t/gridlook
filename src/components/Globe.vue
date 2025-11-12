<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import { grid2buffer, data2valueBuffer } from "./utils/gridlook.ts";
import { makeColormapMaterial } from "./utils/colormapShaders.ts";
import { decodeTime } from "./utils/timeHandling.ts";

import { datashaderExample } from "./utils/exampleFormatters.ts";
import { computed, onBeforeMount, ref, onMounted, watch } from "vue";

import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "./store/store.js";
import { storeToRefs } from "pinia";
import type { TSources } from "../types/GlobeTypes.ts";
import { useLog } from "./utils/logging";
import { useSharedGlobeLogic } from "./sharedGlobe.ts";
import { useUrlParameterStore } from "./store/paramStore.ts";
import { getDimensionInfo } from "./utils/dimensionHandling.ts";
import { getFillValue, getMissingValue } from "./utils/zarrUtils.ts";

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

let mainMesh: THREE.Mesh | undefined = undefined;

const {
  getScene,
  getCamera,
  redraw,
  makeSnapshot,
  toggleRotate,
  getDataVar,
  getTimeVar,
  updateLandSeaMask,
  updateColormap,
  canvas,
  box,
} = useSharedGlobeLogic();

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
    updateColormap([mainMesh]);
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
    await Promise.all([fetchGrid(), getData()]);
    updateLandSeaMask();
    updateColormap([mainMesh]);
  }
}

async function fetchGrid() {
  try {
    const root = zarr.root(new zarr.FetchStore(gridsource.value!.store));
    const grid = await zarr.open(root.resolve(gridsource.value!.dataset), {
      kind: "group",
    });
    const verts = await grid2buffer(grid);
    const myMesh = mainMesh as THREE.Mesh;
    myMesh.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(verts, 3)
    );
    myMesh.geometry.computeBoundingSphere();
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
          (timevalues as number[])[currentTimeIndexSliderValue as number],
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
        1
      );

      const rawData = await zarr.get(datavar, indices);
      const missingValue = getMissingValue(datavar);
      const fillValue = getFillValue(datavar);
      const dataBuffer = data2valueBuffer(rawData, missingValue, fillValue);
      mainMesh?.geometry.setAttribute(
        "data_value",
        new THREE.BufferAttribute(dataBuffer.dataValues, 1)
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

onMounted(() => {
  getScene()?.add(mainMesh as THREE.Mesh);
});

onBeforeMount(async () => {
  const geometry = new THREE.BufferGeometry();
  const material = colormapMaterial.value;
  mainMesh = new THREE.Mesh(geometry, material);
  await datasourceUpdate();
});

defineExpose({ makeSnapshot, copyPythonExample, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
