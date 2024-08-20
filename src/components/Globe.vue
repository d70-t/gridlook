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

<script setup>
import * as THREE from "three";
import { HTTPStore, openGroup } from "zarr";
import { grid2buffer, data2value_buffer } from "./js/gridlook.js";
import {
  make_colormap_material,
  available_colormaps,
} from "./js/colormap_shaders.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
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
  onRenderTriggered,
  defineExpose,
} from "vue";

import { useGlobeControlStore } from "./store/store.js";
import { storeToRefs } from "pinia";

const store = useGlobeControlStore();
const { showCoastLines, timeIndexSlider, timeIndex } = storeToRefs(store);

const props = defineProps([
  "datasources",
  "colormap",
  "invertColormap",
  "varname",
  "varbounds",
]);

const emit = defineEmits(["varinfo"]);

const datavars = ref({});
const update_count = ref(0);
const updating_data = ref(false);
const frameId = ref(0);
const width = ref(undefined);
const height = ref(undefined);

let center = undefined;
let main_mesh = undefined;
let coast = undefined;
let scene = undefined;
let camera = undefined;
let renderer = undefined;
let orbitControls = undefined;
let resize_observer = undefined;
let mouseDown = false;

let canvas = ref();
let box = ref();

watch(
  () => props.varname,
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
    return props.datasources.levels[0].datasources[props.varname];
  } else {
    return undefined;
  }
});

function datasourceUpdate() {
  datavars.value = {};
  if (props.datasources !== undefined) {
    fetchGrid();
    getData();
  }
}

function render() {
  if (width.value !== undefined && height.value !== undefined) {
    renderer.setSize(width.value, height.value);
  }
  renderer.render(scene, camera);
  if (box.value) {
    resize_observer.observe(box.value);
  }
}

function publishVarinfo(info) {
  emit("varinfo", info);
}

function redraw() {
  if (orbitControls.autoRotate) {
    return;
  }
  cancelAnimationFrame(frameId.value);
  orbitControls.update();
  frameId.value = requestAnimationFrame(render);
}

async function fetchGrid() {
  const store = new HTTPStore(gridsource.value.store);
  const grid = await openGroup(store, gridsource.value.dataset, "r");
  const verts = await grid2buffer(grid);
  console.log("verts have nan: " + verts.some(isNaN));
  console.log("verts", verts);
  main_mesh.geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(verts, 3)
  );
  main_mesh.geometry.attributes.position.needsUpdate = true;
  main_mesh.geometry.computeBoundingBox();
  main_mesh.geometry.computeBoundingSphere();
  console.log("main mesh", main_mesh);
  redraw();
}

async function getDataVar(varname) {
  if (datavars.value[varname] === undefined) {
    console.log("fetching " + varname);
    const localDatasource = props.datasources.levels[0].datasources[varname];
    if (datasource.value === undefined) {
      return undefined;
    }
    try {
      const datastore = new HTTPStore(localDatasource.store);
      datavars.value[varname] = await openGroup(
        datastore,
        localDatasource.dataset,
        "r"
      ).then((ds) => ds.getItem(varname));
    } catch (error) {
      console.log(error);
      console.log(
        "WARNING, couldn't fetch variable " +
          varname +
          " from store: " +
          localDatasource.store +
          " and dataset: " +
          localDatasource.dataset
      );
      return undefined;
    }
  }
  return datavars.value[varname];
}

function updateColormap() {
  const low = props.varbounds.low;
  const high = props.varbounds.high;

  let add_offset;
  let scale_factor;

  if (props.invertColormap) {
    scale_factor = -1 / (high - low);
    add_offset = -high * scale_factor;
  } else {
    scale_factor = 1 / (high - low);
    add_offset = -low * scale_factor;
  }

  main_mesh.material.uniforms.colormap.value =
    available_colormaps[props.colormap];
  main_mesh.material.uniforms.add_offset.value = add_offset;
  main_mesh.material.uniforms.scale_factor.value = scale_factor;
  redraw();
}

async function getTimeVar() {
  const varname = "_time";
  if (datavars.value[varname] === undefined) {
    console.log("fetching " + varname);
    const datasource = props.datasources.levels[0].time;
    if (datasource === undefined) {
      return undefined;
    }
    try {
      const datastore = new HTTPStore(datasource.store);
      datavars.value[varname] = await openGroup(
        datastore,
        datasource.dataset,
        "r"
      ).then((ds) => ds.getItem("time"));
    } catch (error) {
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
  return datavars.value[varname];
}
async function getData() {
  update_count.value += 1;
  const local_update_count = update_count.value;
  if (updating_data.value) {
    return;
  }
  updating_data.value = true;

  const localVarname = props.varname;
  const currentTimeIndexSliderValue = timeIndexSlider.value;
  const [timevar, datavar] = await Promise.all([
    getTimeVar(),
    getDataVar(localVarname),
  ]);
  let timeinfo = {};
  if (timevar !== undefined) {
    const [timeattrs, timevalues] = await Promise.all([
      timevar.attrs.asObject(),
      timevar.getRaw().then((t) => t.data),
    ]);
    timeinfo = {
      attrs: timeattrs,
      values: timevalues,
      current: decodeTime(timevalues[currentTimeIndexSliderValue], timeattrs),
    };
  }
  if (datavar !== undefined) {
    const data_buffer = await data2value_buffer(
      datavar.getRaw(currentTimeIndexSliderValue)
    );
    console.log("data buffer", data_buffer);
    main_mesh.geometry.setAttribute(
      "data_value",
      new THREE.BufferAttribute(data_buffer.data_values, 1)
    );
    publishVarinfo({
      attrs: await datavar.attrs.asObject(),
      timeinfo,
      localVarname,
      time_range: { start: 0, end: datavar.shape[0] - 1 },
      bounds: { low: data_buffer.data_min, high: data_buffer.data_max },
    });
    redraw();
    timeIndex.value = currentTimeIndexSliderValue;
  }
  updating_data.value = false;
  if (update_count.value != local_update_count) {
    await getData();
  }
}

async function updateCoastlines() {
  if (showCoastLines.value === false) {
    if (coast) {
      scene.remove(coast);
    }
  } else {
    scene.add(await getCoastlines());
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
  canvas.value.toBlob((blob) => {
    let link = document.createElement("a");
    link.download = "gridlook.png";

    link.href = URL.createObjectURL(blob);
    link.click();

    // delete the internal blob reference, to let the browser clear memory from it
    URL.revokeObjectURL(link.href);
  }, "image/png");
}

function copyPythonExample() {
  console.log(props);
  const example = datashader_example({
    camera_positon: camera.position,
    datasrc: datasource.value.store + datasource.value.dataset,
    gridsrc: gridsource.value.store + gridsource.value.dataset,
    varname: props.varname,
    timeIndex: timeIndex.value,
    varbounds: props.varbounds,
    colormap: props.colormap,
    invertColormap: props.invertColormap,
  });
  navigator.clipboard.writeText(example);
}

function toggleRotate() {
  orbitControls.autoRotate = !orbitControls.autoRotate;
  animationLoop();
}

function animationLoop() {
  if (mouseDown || orbitControls.autoRotate) {
    cancelAnimationFrame(frameId.value);
    frameId.value = requestAnimationFrame(animationLoop);
    orbitControls.update();
    render();
  }
}

function onCanvasResize() {
  if (!box.value) {
    return;
  }
  const { width: boxWidth, height: boxHeight } =
    box.value.getBoundingClientRect();
  if (boxWidth !== width.value || boxHeight !== height.value) {
    resize_observer.unobserve(box.value);
    const aspect = boxWidth / boxHeight;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
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

  scene.add(main_mesh);

  orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.update();
  coast = undefined;
  updateCoastlines();
}

onBeforeMount(() => {
  const geometry = new THREE.BufferGeometry();
  const material = colormapMaterial.value;
  main_mesh = new THREE.Mesh(geometry, material);
  datasourceUpdate();
});

onMounted(() => {
  mouseDown = false;
  canvas.value.addEventListener("mousedown", () => {
    mouseDown = true;
    animationLoop();
  });
  canvas.value.addEventListener("wheel", () => {
    mouseDown = true;
    animationLoop();
  });
  canvas.value.addEventListener("mouseup", () => {
    mouseDown = false;
  });

  init();
  resize_observer = new ResizeObserver(onCanvasResize);
  resize_observer.observe(box.value);
  onCanvasResize();
});

onRenderTriggered(() => {
  console.log("updateCoastLines");
  updateCoastlines();
});

onBeforeUnmount(() => {
  resize_observer.unobserve(box.value);
});

defineExpose({ makeSnapshot, copyPythonExample, toggleRotate });
</script>

<template>
  <div class="globe_box" ref="box">
    <canvas class="globe_canvas" ref="canvas"> </canvas>
  </div>
</template>
