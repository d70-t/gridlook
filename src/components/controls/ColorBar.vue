<script setup lang="ts">
import { ref, computed, onMounted, watch, onUnmounted } from "vue";
import type { Ref } from "vue";
import * as THREE from "three";
import {
  makeLutMaterial,
  availableColormaps,
} from "../utils/colormapShaders.ts";

const props = withDefaults(
  defineProps<{
    colormap?: keyof typeof availableColormaps;
    invertColormap?: boolean;
  }>(),
  {
    colormap: "turbo",
    invertColormap: false,
  }
);

const box: Ref<HTMLDivElement | undefined> = ref(undefined);
const canvas: Ref<HTMLCanvasElement | undefined> = ref(undefined);

let width: number | undefined;
let height: number | undefined;
let frameId: number = 0;

let lutMesh: THREE.Mesh | undefined;
let resizeObserver: ResizeObserver | undefined;
let scene: THREE.Scene | undefined;
let renderer: THREE.WebGLRenderer | undefined;
let camera: THREE.PerspectiveCamera | undefined;

const addOffset = computed(() => {
  if (props.invertColormap) {
    return 1.0;
  } else {
    return 0.0;
  }
});

const scaleFactor = computed(() => {
  if (props.invertColormap) {
    return -1.0;
  } else {
    return 1.0;
  }
});

const lutMaterial = computed(() => {
  return makeLutMaterial(props.colormap, addOffset.value, scaleFactor.value);
});

watch(
  () => props.colormap,
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

onMounted(() => {
  init();
  resizeObserver = new ResizeObserver(onCanvasResize);
  resizeObserver.observe(box.value as Element);
  onCanvasResize();
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  scene?.clear();
  camera?.clear();
  renderer?.dispose();
  scene = undefined;
  camera = undefined;
  renderer = undefined;
});

function init() {
  console.log("Initializing ColorBar THREE.js scene");
  const lutGeometry = new THREE.PlaneGeometry(2, 2);
  lutGeometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(Float32Array.from([0, 1, 0, 1]), 1)
  );
  lutMesh = new THREE.Mesh(lutGeometry, lutMaterial.value);
  // from: https://stackoverflow.com/a/65732553
  scene = new THREE.Scene();
  renderer = new THREE.WebGLRenderer({
    canvas: canvas.value as HTMLCanvasElement,
  });
  scene.add(lutMesh);

  camera = new THREE.PerspectiveCamera(
    7.5,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  scene.add(camera!);
}

function render() {
  if (width !== undefined && height !== undefined) {
    renderer?.setSize(width, height);
  }
  renderer?.render(scene!, camera!);
  if (box.value) {
    resizeObserver?.observe(box.value as Element);
  }
}

function redraw() {
  cancelAnimationFrame(frameId);
  frameId = requestAnimationFrame(render);
}

function onCanvasResize(/*entries*/) {
  if (!box.value) {
    return;
  }
  let { width: boxWidth, height: boxHeight } =
    box.value.getBoundingClientRect();
  boxWidth = Math.round(boxWidth);
  boxHeight = Math.round(boxHeight);
  if (boxWidth !== width || boxHeight !== height) {
    resizeObserver?.unobserve(box.value);
    const aspect = boxWidth / boxHeight;
    camera!.aspect = aspect;
    camera?.updateProjectionMatrix();
    width = boxWidth;
    height = boxHeight;
    redraw();
  }
}

function updateColormap() {
  let shaderMaterial = lutMesh?.material as THREE.ShaderMaterial;
  shaderMaterial.uniforms.colormap.value = availableColormaps[props.colormap];
  shaderMaterial.uniforms.addOffset.value = addOffset.value;
  shaderMaterial.uniforms.scaleFactor.value = scaleFactor.value;
  redraw();
}
</script>

<template>
  <div ref="box">
    <canvas ref="canvas"> </canvas>
  </div>
</template>
