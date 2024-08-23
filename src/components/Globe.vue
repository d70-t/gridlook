<script lang="ts" setup>
import * as THREE from "three";
import { Group, HTTPStore, openGroup, ZarrArray } from "zarr";
import { grid2buffer, data2value_buffer } from "./js/gridlook.js";
import {
  make_colormap_material,
  available_colormaps,
} from "./js/colormap_shaders.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { geojson2geometry } from "./utils/geojson.ts";
import { decodeTime } from "./utils/timeHandling.ts";

import { datashader_example } from "./js/example_formatters.js";
import {
  computed,
  onBeforeMount,
  ref,
  defineEmits,
  defineProps,
  onMounted,
  watch,
  onBeforeUnmount,
  defineExpose,
  type Ref,
} from "vue";

import { useGlobeControlStore } from "./store/store.js";
import { storeToRefs } from "pinia";
import type {
  EmptyObj,
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
// [
//   "datasources",
//   "colormap",
//   "invertColormap",
//   "varbounds",
// ]);
const emit = defineEmits<{ varinfo: [TVarInfo] }>();
const store = useGlobeControlStore();
const { showCoastLines, timeIndexSlider, timeIndex, varnameSelector, varname } =
  storeToRefs(store);

const datavars: Ref<Record<string, ZarrArray<RequestInit>>> = ref({});
const update_count = ref(0);
const updating_data = ref(false);
const frameId = ref(0);
const width: Ref<number | undefined> = ref(undefined);
const height: Ref<number | undefined> = ref(undefined);

let center = undefined;
let main_mesh: THREE.Mesh | undefined = undefined;
let coast: THREE.LineSegments | undefined = undefined;
let scene: THREE.Scene | undefined = undefined;
let camera: THREE.PerspectiveCamera | undefined = undefined;
let renderer: THREE.Renderer | undefined = undefined;
let orbitControls: OrbitControls | undefined = undefined;
let resize_observer: ResizeObserver | undefined = undefined;
let mouseDown = false;

let canvas: Ref<HTMLCanvasElement | undefined> = ref();
let box: Ref<Element | undefined> = ref();

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

watch(
  () => showCoastLines.value,
  () => {
    updateCoastlines();
  }
);

const colormapMaterial = computed(() => {
  if (props.invertColormap) {
    return make_colormap_material(props.colormap, 1.0, -1.0);
  } else {
    return make_colormap_material(props.colormap, 0.0, 1.0);
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
    await fetchGrid();
    await getData();
  }
}

function render() {
  const myRenderer = renderer as THREE.Renderer;
  if (width.value !== undefined && height.value !== undefined) {
    myRenderer.setSize(width.value, height.value);
  }
  myRenderer.render(scene!, camera!);
  if (box.value) {
    resize_observer!.observe(box.value);
  }
}

function publishVarinfo(info: TVarInfo) {
  console.log("publish var info", info);
  emit("varinfo", info);
}

function redraw() {
  if (orbitControls?.autoRotate) {
    return;
  }
  cancelAnimationFrame(frameId.value);
  orbitControls?.update();
  frameId.value = requestAnimationFrame(render);
}

async function fetchGrid() {
  const store = new HTTPStore(gridsource.value!.store);
  const grid = await openGroup(store, gridsource?.value?.dataset, "r");
  const verts = await grid2buffer(grid);
  const myMesh = main_mesh as THREE.Mesh;
  myMesh.geometry.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  myMesh.geometry.attributes.position.needsUpdate = true;
  myMesh.geometry.computeBoundingBox();
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
  console.log("DATAVARS", datavars.value);
  return datavars.value[myVarname];
}

function updateColormap() {
  const low = props.varbounds?.low as number;
  const high = props.varbounds?.high as number;

  let add_offset;
  let scale_factor;

  if (props.invertColormap) {
    scale_factor = -1 / (high - low);
    add_offset = -high * scale_factor;
  } else {
    scale_factor = 1 / (high - low);
    add_offset = -low * scale_factor;
  }
  const myMesh = main_mesh as THREE.Mesh;
  const material = myMesh.material as THREE.ShaderMaterial;
  material.uniforms.colormap.value = available_colormaps[props.colormap!];
  material.uniforms.add_offset.value = add_offset;
  material.uniforms.scale_factor.value = scale_factor;
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
    update_count.value += 1;
    const local_update_count = update_count.value;
    if (updating_data.value) {
      return;
    }
    updating_data.value = true;

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
      console.log("timevlaues", timevalues);
      timeinfo = {
        // attrs: timeattrs,
        values: timevalues,
        current: decodeTime(timevalues[currentTimeIndexSliderValue], timeattrs),
      };
    }
    if (datavar !== undefined) {
      const data_buffer = await data2value_buffer(
        datavar.getRaw(currentTimeIndexSliderValue)
      );
      console.log("data buffer", data_buffer);
      main_mesh?.geometry.setAttribute(
        "data_value",
        new THREE.BufferAttribute(data_buffer.data_values, 1)
      );
      publishVarinfo({
        attrs: await datavar.attrs.asObject(),
        timeinfo,
        time_range: { start: 0, end: datavar.shape[0] - 1 },
        bounds: { low: data_buffer.data_min, high: data_buffer.data_max },
      });
      redraw();
      timeIndex.value = currentTimeIndexSliderValue;
      varname.value = localVarname;
    }
    updating_data.value = false;
    if (update_count.value != local_update_count) {
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
  const example = datashader_example({
    camera_positon: camera!.position,
    datasrc: datasource.value!.store + datasource.value!.dataset,
    gridsrc: gridsource.value!.store + gridsource.value!.dataset,
    varname: varname.value,
    timeIndex: timeIndex.value,
    varbounds: props.varbounds,
    colormap: props.colormap,
    invertColormap: props.invertColormap,
  });
  navigator.clipboard.writeText(example);
}

function toggleRotate() {
  orbitControls!.autoRotate = !orbitControls!.autoRotate;
  animationLoop();
}

function animationLoop() {
  if (mouseDown || orbitControls?.autoRotate) {
    cancelAnimationFrame(frameId.value);
  }
  frameId.value = requestAnimationFrame(animationLoop);
  orbitControls?.update();
  render();
}

function onCanvasResize() {
  if (!box.value) {
    return;
  }
  const { width: boxWidth, height: boxHeight } =
    box.value.getBoundingClientRect();
  if (boxWidth !== width.value || boxHeight !== height.value) {
    resize_observer?.unobserve(box.value);
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

  scene.add(main_mesh as THREE.Mesh);

  orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.update();
  coast = undefined;
  updateCoastlines();
}

onBeforeMount(async () => {
  const geometry = new THREE.BufferGeometry();
  const material = colormapMaterial.value;
  main_mesh = new THREE.Mesh(geometry, material);
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
  resize_observer = new ResizeObserver(onCanvasResize);
  resize_observer?.observe(box.value!);
  onCanvasResize();
});

onBeforeUnmount(() => {
  resize_observer?.unobserve(box.value!);
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
