<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import { grid2buffer, data2valueBuffer } from "./utils/gridlook.ts";
import {
  makeColormapMaterial,
  availableColormaps,
  calculateColorMapProperties,
} from "./utils/colormapShaders.ts";
import { decodeTime } from "./utils/timeHandling.ts";

import { datashaderExample } from "./utils/exampleFormatters.ts";
import {
  computed,
  onBeforeMount,
  ref,
  shallowRef,
  onMounted,
  watch,
  nextTick,
  type Ref,
  type ShallowRef,
} from "vue";

import { useGlobeControlStore } from "./store/store.js";
import { storeToRefs } from "pinia";
import type {
  TBounds,
  TColorMap,
  TSources,
  TVarInfo,
} from "../types/GlobeTypes.ts";
import { useToast } from "primevue/usetoast";
import { getErrorMessage } from "./utils/errorHandling.ts";
import { useSharedGlobeLogic } from "./sharedGlobe.ts";

const props = defineProps<{
  datasources?: TSources;
  varbounds?: TBounds;
  colormap?: TColorMap;
  invertColormap?: boolean;
}>();

const emit = defineEmits<{ varinfo: [TVarInfo] }>();
const store = useGlobeControlStore();
const toast = useToast();
const { timeIndexSlider, timeIndex, varnameSelector, varname } =
  storeToRefs(store);

const datavars: ShallowRef<
  Record<string, zarr.Array<zarr.DataType, zarr.FetchStore>>
> = shallowRef({});
const updateCount = ref(0);
const updatingData = ref(false);

const SKY_BLUE_COLOR = new THREE.Color(0x87CEEB);
const NIGHT_COLOR = new THREE.Color(0x000014);

let mainMesh: THREE.Mesh | undefined = undefined;
let scene: THREE.Scene | undefined = undefined;

let canvas: Ref<HTMLCanvasElement | undefined> = ref();
let box: Ref<HTMLDivElement | undefined> = ref();

const {
  getScene,
  getCamera,
  redraw,
  makeSnapshot,
  toggleRotate,
  getDataVar,
  getTimeVar,
} = useSharedGlobeLogic(canvas, box);

watch(
  () => store.isDarkTheme,
  (newValue) => {
    updateBackgroundColor(newValue);
  },
  { immediate: true }  
);

function redrawScene() {
  if (scene) {
    redraw();
  }
}

function ensureBackgroundColor() {
  if (scene) {
    const currentColor = store.isDarkTheme ? NIGHT_COLOR : SKY_BLUE_COLOR;
    if (scene.background !== currentColor) {
      scene.background = currentColor;
      console.log("Fixed background color:", currentColor);
      redrawScene();
    }
  }
}

watch(
  () => varnameSelector.value,
  () => {
    getData();
  }
);

watch(
  () => timeIndexSlider.value,
  () => {
    getData();
  }
);

watch(
  () => props.datasources,
  () => {
    datasourceUpdate();
  }
);

watch(
  () => props.varbounds,
  () => {
    updateColormap();
  }
);

watch(
  () => props.invertColormap,
  () => {
    updateColormap();
  }
);

watch(
  () => props.colormap,
  () => {
    updateColormap();
  }
);

const colormapMaterial = computed(() => {
  if (props.invertColormap) {
    return makeColormapMaterial(props.colormap, 1.0, -1.0);
  } else {
    return makeColormapMaterial(props.colormap, 0.0, 1.0);
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

function publishVarinfo(info: TVarInfo) {
  emit("varinfo", info);
}

async function datasourceUpdate() {
  datavars.value = {};
  if (props.datasources !== undefined) {
    await Promise.all([fetchGrid(), getData()]);
    updateColormap();
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
    toast.add({
      detail: `Could not fetch grid: ${getErrorMessage(error)}`,
      life: 3000,
    });
  }
}

function updateColormap() {
  const low = props.varbounds?.low as number;
  const high = props.varbounds?.high as number;
  const { addOffset, scaleFactor } = calculateColorMapProperties(
    low,
    high,
    props.invertColormap
  );

  const myMesh = mainMesh as THREE.Mesh;
  const material = myMesh.material as THREE.ShaderMaterial;
  material.uniforms.colormap.value = availableColormaps[props.colormap!];
  material.uniforms.addOffset.value = addOffset;
  material.uniforms.scaleFactor.value = scaleFactor;
  redraw();
}

function updateBackgroundColor(isDarkTheme: boolean) {
  if (scene) {
    const newColor = isDarkTheme ? NIGHT_COLOR : SKY_BLUE_COLOR;
    scene.background = newColor;
    console.log("Background color updated:", isDarkTheme ? "dark theme" : "light theme", 
                scene.background);
    redraw();
  } else {
    console.log("Scene not available yet for background update");
    setTimeout(() => updateBackgroundColor(isDarkTheme), 100);
  }
}

async function getData() {
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
      const rawData = await zarr.get(datavar, [
        currentTimeIndexSliderValue,
        null,
      ]);
      const dataBuffer = data2valueBuffer(rawData);
      mainMesh?.geometry.setAttribute(
        "data_value",
        new THREE.BufferAttribute(dataBuffer.dataValues, 1)
      );
      publishVarinfo({
        attrs: datavar.attrs,
        timeinfo,
        timeRange: { start: 0, end: datavar.shape[0] - 1 },
        bounds: { low: dataBuffer.dataMin, high: dataBuffer.dataMax },
      });
      redraw();
      timeIndex.value = currentTimeIndexSliderValue;
      varname.value = localVarname;
    }
    updatingData.value = false;
    if (updateCount.value !== myUpdatecount) {
      await getData();
    }
  } catch (error) {
    toast.add({
      detail: `Couldn't fetch data: ${getErrorMessage(error)}`,
      life: 3000,
    });
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
    varname: varname.value,
    timeIndex: timeIndex.value,
    varbounds: props.varbounds!,
    colormap: props.colormap!,
    invertColormap: props.invertColormap,
  });
  navigator.clipboard.writeText(example);
}

onMounted(() => {
  scene = getScene();
  
  if (scene) {
    scene.background = store.isDarkTheme ? NIGHT_COLOR : SKY_BLUE_COLOR;
    console.log("Initial background color set:", scene.background);
  }
  
  scene?.add(mainMesh as THREE.Mesh);
  
    nextTick(() => {
    updateBackgroundColor(store.isDarkTheme);
    

    const checkInterval = setInterval(ensureBackgroundColor, 1000);
    
    setTimeout(() => {
      clearInterval(checkInterval);
    }, 5000);
  });
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

<style>
div.globe_box {
  height: 100%;
  width: 100%;
  padding: 0;
  margin: 0;
  overflow: hidden;
  display: flex;
  z-index: 0;
}

div.globe_canvas {
  padding: 0;
  margin: 0;
}
</style>