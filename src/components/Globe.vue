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

const SKY_BLUE_COLOR = new THREE.Color(0x87ceeb);
const NIGHT_COLOR = new THREE.Color(0x000014);

let mainMesh: THREE.Mesh | undefined = undefined;
const sceneRef = ref<THREE.Scene | null>(null);

const canvas: Ref<HTMLCanvasElement | undefined> = ref();
const box: Ref<HTMLDivElement | undefined> = ref();

const {
  getScene,
  getCamera,
  redraw,
  makeSnapshot,
  toggleRotate,
  getDataVar,
  getTimeVar,
} = useSharedGlobeLogic(canvas, box);

function updateBackgroundColor(isDarkTheme: boolean) {
  const scene = sceneRef.value;
  if (scene) {
    scene.background = isDarkTheme ? NIGHT_COLOR : SKY_BLUE_COLOR;
    if (scene.background instanceof THREE.Color) {
      scene.background.needsUpdate = true;
    }
    redraw();
    console.log('Background updated to:', isDarkTheme ? 'dark' : 'light');
  }
}

function redrawScene() {
  redraw();
}

watch(
  () => store.isDarkTheme,
  (newValue) => {
    nextTick(() => updateBackgroundColor(newValue));
  },
  { immediate: true }
);

watch(
  () => varnameSelector.value,
  () => getData()
);

watch(
  () => timeIndexSlider.value,
  () => getData()
);

watch(
  () => props.datasources,
  () => datasourceUpdate()
);

watch(
  () => props.varbounds,
  () => updateColormap()
);

watch(
  () => props.invertColormap,
  () => updateColormap()
);

watch(
  () => props.colormap,
  () => updateColormap()
);

const colormapMaterial = computed(() => {
  return makeColormapMaterial(
    props.colormap || 'viridis',
    props.invertColormap ? 1.0 : 0.0,
    props.invertColormap ? -1.0 : 1.0
  );
});

const gridsource = computed(() => {
  return props.datasources?.levels[0].grid;
});

const datasource = computed(() => {
  return props.datasources?.levels[0].datasources[varnameSelector.value];
});

function publishVarinfo(info: TVarInfo) {
  emit('varinfo', info);
}

async function datasourceUpdate() {
  datavars.value = {};
  if (props.datasources) {
    await Promise.all([fetchGrid(), getData()]);
    updateColormap();
  }
}

async function fetchGrid() {
  try {
    if (!gridsource.value) return;
    
    const root = zarr.root(new zarr.FetchStore(gridsource.value.store));
    const grid = await zarr.open(root.resolve(gridsource.value.dataset), {
      kind: "group",
    });
    const verts = await grid2buffer(grid);
    if (mainMesh) {
      mainMesh.geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(verts, 3)
      );
      mainMesh.geometry.computeBoundingSphere();
      redraw();
    }
  } catch (error) {
    toast.add({
      severity: 'error',
      summary: 'Error',
      detail: `Could not fetch grid: ${getErrorMessage(error)}`,
      life: 3000,
    });
  }
}

function updateColormap() {
  if (!mainMesh || !props.varbounds) return;
  
  const { low, high } = props.varbounds;
  const { addOffset, scaleFactor } = calculateColorMapProperties(
    low,
    high,
    props.invertColormap
  );

  const material = mainMesh.material as THREE.ShaderMaterial;
  material.uniforms.colormap.value = availableColormaps[props.colormap || 'viridis'];
  material.uniforms.addOffset.value = addOffset;
  material.uniforms.scaleFactor.value = scaleFactor;
  material.needsUpdate = true;
  redraw();
}

async function getData() {
  if (!props.datasources) return;
  
  store.startLoading();
  try {
    updateCount.value += 1;
    const myUpdateCount = updateCount.value;
    
    if (updatingData.value) return;
    updatingData.value = true;

    const localVarname = varnameSelector.value;
    const currentTimeIndex = timeIndexSlider.value;
    
    const [timevar, datavar] = await Promise.all([
      getTimeVar(props.datasources),
      getDataVar(localVarname, props.datasources),
    ]);

    let timeinfo = {};
    if (timevar) {
      const timeattrs = timevar.attrs;
      const timevalues = (await zarr.get(timevar, [null])).data;
      timeinfo = {
        values: timevalues,
        current: decodeTime(
          (timevalues as number[])[currentTimeIndex],
          timeattrs
        ),
      };
    }

    if (datavar && mainMesh) {
      const rawData = await zarr.get(datavar, [currentTimeIndex, null]);
      const dataBuffer = data2valueBuffer(rawData);
      
      mainMesh.geometry.setAttribute(
        "data_value",
        new THREE.BufferAttribute(dataBuffer.dataValues, 1)
      );
      
      publishVarinfo({
        attrs: datavar.attrs,
        timeinfo,
        timeRange: { start: 0, end: datavar.shape[0] - 1 },
        bounds: { low: dataBuffer.dataMin, high: dataBuffer.dataMax },
      });
      
      timeIndex.value = currentTimeIndex;
      varname.value = localVarname;
      redraw();
    }

    updatingData.value = false;
    if (updateCount.value !== myUpdateCount) {
      await getData();
    }
  } catch (error) {
    toast.add({
      severity: 'error',
      summary: 'Error',
      detail: `Couldn't fetch data: ${getErrorMessage(error)}`,
      life: 3000,
    });
    updatingData.value = false;
  } finally {
    store.stopLoading();
  }
}

function copyPythonExample() {
  if (!datasource.value || !gridsource.value) return;
  
  const example = datashaderExample({
    cameraPosition: getCamera()?.position || new THREE.Vector3(),
    datasrc: datasource.value.store + datasource.value.dataset,
    gridsrc: gridsource.value.store + gridsource.value.dataset,
    varname: varname.value || '',
    timeIndex: timeIndex.value || 0,
    varbounds: props.varbounds || { low: 0, high: 1 },
    colormap: props.colormap || 'viridis',
    invertColormap: props.invertColormap || false,
  });
  navigator.clipboard.writeText(example);
}

onMounted(() => {
  const scene = getScene();
  sceneRef.value = scene;
  
  if (scene && mainMesh) {
    scene.add(mainMesh);
    scene.background = store.isDarkTheme ? NIGHT_COLOR : SKY_BLUE_COLOR;
    if (scene.background instanceof THREE.Color) {
      scene.background.needsUpdate = true;
    }
    redraw();
  }
  
  datasourceUpdate();
});

onBeforeMount(() => {
  const geometry = new THREE.BufferGeometry();
  const material = colormapMaterial.value;
  mainMesh = new THREE.Mesh(geometry, material);
});

defineExpose({ 
  makeSnapshot, 
  copyPythonExample, 
  toggleRotate,
  redraw: redrawScene
});
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0">
    <canvas ref="canvas" class="globe_canvas"></canvas>
  </div>
</template>

<style>
.globe_box {
  height: 100%;
  width: 100%;
  padding: 0;
  margin: 0;
  overflow: hidden;
  display: flex;
  z-index: 0;
  background: transparent;
}

.globe_canvas {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  margin: 0;
  outline: none;
}
</style>