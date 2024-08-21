<script lang="ts">
import { defineComponent } from "vue";
import type { PropType } from "vue";
import * as THREE from "three";
import {
  make_lut_material,
  available_colormaps,
} from "./js/colormap_shaders.js";

type TColorMapData = {
  lutMesh: THREE.Mesh;
  resizeObserver: ResizeObserver;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  width?: number;
  height?: number;
  vertexValues: Float32Array;
  frameId: number;
};

export default defineComponent({
  props: {
    orientation: {
      type: String as PropType<"vertical" | "horizontal">,
      default: "vertical",
      validator(value: string) {
        return ["vertical", "horizontal"].includes(value);
      },
    },
    colormap: {
      type: String as PropType<keyof typeof available_colormaps>,
      default: "turbo",
      validator(value: string) {
        return Object.keys(available_colormaps).includes(value);
      },
    },
    invertColormap: {
      type: Boolean as PropType<boolean>,
      default: false,
    },
  },
  data() {
    return {} as TColorMapData;
  },
  computed: {
    addOffset() {
      if (this.invertColormap) {
        return 1.0;
      } else {
        return 0.0;
      }
    },
    scaleFactor() {
      if (this.invertColormap) {
        return -1.0;
      } else {
        return 1.0;
      }
    },
    lutMaterial() {
      return make_lut_material(this.colormap, this.addOffset, this.scaleFactor);
    },
    vertexValues() {
      if (this.orientation === "vertical") {
        return Float32Array.from([1, 1, 0, 0]);
      } else {
        return Float32Array.from([0, 1, 0, 1]);
      }
    },
  },
  watch: {
    vertexValues() {
      this.lutMesh.geometry.setAttribute(
        "data_value",
        new THREE.BufferAttribute(this.vertexValues, 1)
      );
    },
    colormap() {
      this.updateColormap();
    },
    invertColormap() {
      this.updateColormap();
    },
  },
  created() {
    const lut_material = this.lutMaterial;
    const lut_geometry = new THREE.PlaneGeometry(2, 2);
    lut_geometry.setAttribute(
      "data_value",
      new THREE.BufferAttribute(this.vertexValues, 1)
    );
    this.lutMesh = new THREE.Mesh(lut_geometry, lut_material);
  },
  mounted() {
    this.init();
    this.resizeObserver = new ResizeObserver(this.onCanvasResize);
    this.resizeObserver.observe(this.$refs.box as Element);
    this.onCanvasResize();
  },
  methods: {
    init() {
      // from: https://stackoverflow.com/a/65732553
      this.scene = new THREE.Scene();
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.$refs.canvas as HTMLCanvasElement,
      });
      if (this.width !== undefined && this.height !== undefined) {
        this.renderer.setSize(this.width, this.height);
      }
      this.scene.add(this.lutMesh);

      this.camera = new THREE.PerspectiveCamera(
        7.5,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
      );
      this.scene.add(this.camera);
    },
    render() {
      if (this.width !== undefined && this.height !== undefined) {
        this.renderer.setSize(this.width, this.height);
      }
      this.renderer.render(this.scene, this.camera);
      if (this.$refs.box) {
        this.resizeObserver.observe(this.$refs.box as Element);
      }
    },

    redraw() {
      cancelAnimationFrame(this.frameId);
      this.frameId = requestAnimationFrame(this.render);
    },

    onCanvasResize(/*entries*/) {
      if (!this.$refs.box) {
        return;
      }
      const box = this.$refs.box as Element;
      const { width, height } = box.getBoundingClientRect();
      if (width !== this.width || height !== this.height) {
        this.resizeObserver.unobserve(box);
        const aspect = width / height;
        this.camera.aspect = aspect;
        this.camera.updateProjectionMatrix();
        this.width = width;
        this.height = height;
        this.redraw();
      }
    },

    updateColormap() {
      let shaderMaterial = this.lutMesh.material as THREE.ShaderMaterial;
      shaderMaterial.uniforms.colormap.value =
        available_colormaps[this.colormap];
      shaderMaterial.uniforms.add_offset.value = this.addOffset;
      shaderMaterial.uniforms.scale_factor.value = this.scaleFactor;
      this.redraw();
    },
  },
});
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
