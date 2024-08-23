<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import type { Ref } from "vue";
import * as THREE from "three";
import {
  makeLutMaterial,
  availableColormaps,
} from "./utils/colormap_shaders.ts";

const props = withDefaults(
  defineProps<{
    colormap: keyof typeof availableColormaps;
    invertColormap: boolean;
  }>(),
  {
    colormap: "turbo",
    invertColormap: false,
  }
);

const box: Ref<Element | undefined> = ref(undefined);
const canvas: Ref<Element | undefined> = ref(undefined);

let width: number | undefined = undefined;
let height: number | undefined = undefined;
let frameId: number = 0;

let lutMesh: THREE.Mesh | undefined = undefined;
let resizeObserver: ResizeObserver | undefined = undefined;
let scene: THREE.Scene | undefined = undefined;
let renderer: THREE.WebGLRenderer | undefined = undefined;
let camera: THREE.PerspectiveCamera | undefined = undefined;

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

// const vertexValues = computed(() => {
//   if (props.orientation === "vertical") {
//     return Float32Array.from([1, 1, 0, 0]);
//   } else {
//     return Float32Array.from([0, 1, 0, 1]);
//   }
// });

// watch(
//   () => vertexValues.value,

//   () => {
//     console.log("VERTEX VALUES");
//     lutMesh?.geometry.setAttribute(
//       "data_value",
//       new THREE.BufferAttribute(vertexValues.value, 1)
//     );
//   }
// );
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

function init() {
  const lut_geometry = new THREE.PlaneGeometry(2, 2);
  lut_geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(Float32Array.from([0, 1, 0, 1]), 1)
  );
  lutMesh = new THREE.Mesh(lut_geometry, lutMaterial.value);
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
  const { width: boxWidth, height: boxHeight } =
    box.value.getBoundingClientRect();
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
  shaderMaterial.uniforms.add_offset.value = addOffset.value;
  shaderMaterial.uniforms.scale_factor.value = scaleFactor.value;
  console.log("update colormap");
  redraw();
}
</script>

<template>
  <div ref="box" class="colorbar_box">
    <canvas ref="canvas" class="colorbar_canvas"> </canvas>
  </div>
</template>

<style>
div.colorbar_box {
  padding: 0;
  margin: 0;
  overflow: hidden;
  display: flex;
}
div.colorbar_canvas {
  padding: 0;
  margin: 0;
  width: 0;
  height: 0;
}
</style>
