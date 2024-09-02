<script lang="ts" setup>
import * as THREE from "three";
import { HTTPStore, openGroup, ZarrArray } from "zarr";
import { grid2buffer, data2valueBuffer } from "./utils/gridlook.ts";
import {
  makeColormapMaterial,
  availableColormaps,
} from "./utils/colormapShaders.ts";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { geojson2geometry } from "./utils/geojson.ts";
import { decodeTime } from "./utils/timeHandling.ts";

import { datashaderExample } from "./utils/exampleFormatters.ts";
import {
  computed,
  onBeforeMount,
  ref,
  onMounted,
  watch,
  onBeforeUnmount,
  type Ref,
} from "vue";

import { useGlobeControlStore } from "./store/store.js";
import { storeToRefs } from "pinia";
import type {
  TBounds,
  TColorMap,
  TSources,
  TVarInfo,
} from "../types/GlobeTypes.ts";
import type { RawArray } from "zarr/types/rawArray/index";

const props = defineProps<{
  datasources?: TSources;
  varbounds?: TBounds;
  colormap?: TColorMap;
  invertColormap?: boolean;
}>();

const emit = defineEmits<{ varinfo: [TVarInfo] }>();
const store = useGlobeControlStore();
const { showCoastLines, timeIndexSlider, timeIndex, varnameSelector, varname } =
  storeToRefs(store);

const datavars: Ref<Record<string, ZarrArray<RequestInit>>> = ref({});
const updateCount = ref(0);
const updatingData = ref(false);
const frameId = ref(0);
const width: Ref<number | undefined> = ref(undefined);
const height: Ref<number | undefined> = ref(undefined);

// varnameSelector changes its value as soon as the JSON is read
// and triggers the getData function. This is not necessary at initialization
// time as getData is called anyway. We use a helper variable to prevent this.
let isInitialized = false;
let center = undefined;
let mainMesh: THREE.Mesh | undefined = undefined;
let coast: THREE.LineSegments | undefined = undefined;
let scene: THREE.Scene | undefined = undefined;
let camera: THREE.PerspectiveCamera | undefined = undefined;
let renderer: THREE.Renderer | undefined = undefined;
let orbitControls: OrbitControls | undefined = undefined;
let resizeObserver: ResizeObserver | undefined = undefined;
let mouseDown = false;

let canvas: Ref<HTMLCanvasElement | undefined> = ref();
let box: Ref<HTMLDivElement | undefined> = ref();

watch(
  () => varnameSelector.value,
  () => {
    if (!isInitialized) {
      isInitialized = !isInitialized;
    } else {
      getData();
    }
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

watch(
  () => showCoastLines.value,
  () => {
    updateCoastlines();
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

async function datasourceUpdate() {
  datavars.value = {};
  if (props.datasources !== undefined) {
    await Promise.all([fetchGrid(), getData()]);
  }
}

function render() {
  orbitControls?.update();
  const myRenderer = renderer as THREE.Renderer;
  if (width.value !== undefined && height.value !== undefined) {
    myRenderer.setSize(width.value, height.value);
  }
  myRenderer.render(scene!, camera!);
  if (box.value) {
    resizeObserver!.observe(box.value);
  }
}

function publishVarinfo(info: TVarInfo) {
  emit("varinfo", info);
}

function animationLoop() {
  cancelAnimationFrame(frameId.value);
  if (!mouseDown && !orbitControls?.autoRotate) {
    render();
    return;
  }
  frameId.value = requestAnimationFrame(animationLoop);
  render();
}
function redraw() {
  if (orbitControls?.autoRotate) {
    return;
  }
  render();
}

async function fetchGrid() {
  const store = new HTTPStore(gridsource.value!.store);
  const grid = await openGroup(store, gridsource?.value?.dataset, "r");
  const verts = await grid2buffer(grid);
  const myMesh = mainMesh as THREE.Mesh;
  myMesh.geometry.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  myMesh.geometry.computeBoundingSphere();
  redraw();
}

async function getDataVar(myVarname: string) {
  if (datavars.value[myVarname] === undefined) {
    console.log("fetching " + myVarname);
    const myDatasource = props.datasources!.levels[0].datasources[myVarname];
    if (datasource.value === undefined) {
      return undefined;
    }
    try {
      const datastore = new HTTPStore(myDatasource.store);
      datavars.value[myVarname] = await openGroup(
        datastore,
        myDatasource.dataset,
        "r"
      ).then((ds) => ds.getItem(myVarname) as Promise<ZarrArray<RequestInit>>);
    } catch (error) {
      console.log(error);
      console.log(
        "WARNING, couldn't fetch variable " +
          myVarname +
          " from store: " +
          myDatasource.store +
          " and dataset: " +
          myDatasource.dataset
      );
      return undefined;
    }
  }
  return datavars.value[myVarname];
}

function updateColormap() {
  const low = props.varbounds?.low as number;
  const high = props.varbounds?.high as number;

  let addOffset: number;
  let scaleFactor: number;

  if (props.invertColormap) {
    scaleFactor = -1 / (high - low);
    addOffset = -high * scaleFactor;
  } else {
    scaleFactor = 1 / (high - low);
    addOffset = -low * scaleFactor;
  }
  const myMesh = mainMesh as THREE.Mesh;
  const material = myMesh.material as THREE.ShaderMaterial;
  material.uniforms.colormap.value = availableColormaps[props.colormap!];
  material.uniforms.addOffset.value = addOffset;
  material.uniforms.scaleFactor.value = scaleFactor;
  redraw();
}

async function getTimeVar() {
  const myVarname = "_time";
  if (datavars.value[myVarname] === undefined) {
    const datasource = props.datasources?.levels[0].time;
    if (!datasource) {
      return undefined;
    }
    try {
      const datastore = new HTTPStore(datasource.store);
      datavars.value[myVarname] = await openGroup(
        datastore,
        datasource.dataset,
        "r"
      ).then((ds) => ds.getItem("time") as Promise<ZarrArray<RequestInit>>);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_) {
      console.log(
        "WARNING, couldn't fetch variable " +
          "time" +
          " from store: " +
          datasource.store +
          " and dataset: " +
          datasource.dataset
      );
      return undefined;
    }
  }
  return datavars.value[myVarname];
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
      getTimeVar(),
      getDataVar(localVarname),
    ]);
    let timeinfo = {};
    if (timevar !== undefined) {
      const [timeattrs, timevalues] = await Promise.all([
        timevar.attrs.asObject(),
        timevar.getRaw().then((t) => {
          return (t as RawArray).data;
        }),
      ]);
      timeinfo = {
        // attrs: timeattrs,
        values: timevalues,
        current: decodeTime(timevalues[currentTimeIndexSliderValue], timeattrs),
      };
    }
    if (datavar !== undefined) {
      const rawData = (await datavar.getRaw(
        currentTimeIndexSliderValue
      )) as RawArray;
      const dataBuffer = data2valueBuffer(rawData);
      mainMesh?.geometry.setAttribute(
        "data_value",
        new THREE.BufferAttribute(dataBuffer.dataValues, 1)
      );
      publishVarinfo({
        attrs: await datavar.attrs.asObject(),
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
  } finally {
    store.stopLoading();
  }
}

async function updateCoastlines() {
  if (showCoastLines.value === false) {
    if (coast) {
      scene?.remove(coast);
    }
  } else {
    scene?.add(await getCoastlines());
  }
  redraw();
}

async function getCoastlines() {
  if (coast === undefined) {
    const coastlines = await fetch("static/ne_50m_coastline.geojson").then(
      (r) => r.json()
    );
    const geometry = geojson2geometry(coastlines, 1.001);
    const material = new THREE.LineBasicMaterial({ color: "#ffffff" });
    coast = new THREE.LineSegments(geometry, material);
    coast.name = "coastlines";
  }
  return coast;
}

function makeSnapshot() {
  render();
  canvas.value?.toBlob((blob) => {
    let link = document.createElement("a");
    link.download = "gridlook.png";

    link.href = URL.createObjectURL(blob!);
    link.click();

    // delete the internal blob reference, to let the browser clear memory from it
    URL.revokeObjectURL(link.href);
  }, "image/png");
}

function copyPythonExample() {
  const example = datashaderExample({
    cameraPosition: camera!.position,
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

function toggleRotate() {
  orbitControls!.autoRotate = !orbitControls!.autoRotate;
  animationLoop();
}

function onCanvasResize() {
  if (!box.value) {
    return;
  }
  const { width: boxWidth, height: boxHeight } =
    box.value.getBoundingClientRect();
  if (boxWidth !== width.value || boxHeight !== height.value) {
    resizeObserver?.unobserve(box.value);
    const aspect = boxWidth / boxHeight;
    camera!.aspect = aspect;
    camera!.updateProjectionMatrix();
    width.value = boxWidth;
    height.value = boxHeight;
    redraw();
  }
}

function init() {
  // from: https://stackoverflow.com/a/65732553
  scene = new THREE.Scene();
  center = new THREE.Vector3();
  camera = new THREE.PerspectiveCamera(
    7.5,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  renderer = new THREE.WebGLRenderer({ canvas: canvas.value });

  camera.up = new THREE.Vector3(0, 0, 1);
  camera.position.x = 30;
  camera.lookAt(center);

  scene.add(mainMesh as THREE.Mesh);

  orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.update();
  coast = undefined;
  updateCoastlines();
}

onBeforeMount(async () => {
  const geometry = new THREE.BufferGeometry();
  const material = colormapMaterial.value;
  mainMesh = new THREE.Mesh(geometry, material);
  await datasourceUpdate();
});

onMounted(() => {
  let canvasValue = canvas.value as HTMLCanvasElement;
  mouseDown = false;
  canvasValue.addEventListener("mousedown", () => {
    mouseDown = true;
    animationLoop();
  });
  canvasValue.addEventListener("wheel", () => {
    mouseDown = true;
    animationLoop();
  });
  canvasValue.addEventListener("mouseup", () => {
    mouseDown = false;
  });
  canvasValue.addEventListener("mousedown", () => {
    mouseDown = true;
    animationLoop();
  });
  init();
  resizeObserver = new ResizeObserver(onCanvasResize);
  resizeObserver?.observe(box.value!);
  onCanvasResize();
});

onBeforeUnmount(() => {
  resizeObserver?.unobserve(box.value!);
});

defineExpose({ makeSnapshot, copyPythonExample, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box">
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
}
div.globe_canvas {
  padding: 0;
  margin: 0;
}
</style>
