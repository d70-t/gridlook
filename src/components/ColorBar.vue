<script>
    import * as THREE from 'three';
    import { make_lut_material, available_colormaps } from "./js/colormap_shaders.js";

    export default {
        props: {
            orientation: {
                type: String,
                default: "vertical",
                validator(value) {
                    return ["vertical", "horizontal"].includes(value);
                },
            },
            colormap: {
                type: String,
                default: "turbo",
                validator(value) {
                    return Object.keys(available_colormaps).includes(value);
                }
            },
            invertColormap: {
                type: Boolean,
                default: false,
            },
        },
        created() {
            const lut_material = this.lutMaterial;
            const lut_geometry = new THREE.PlaneGeometry(2., 2.);
            lut_geometry.setAttribute( 'data_value', new THREE.BufferAttribute( this.vertexValues, 1 ));
            this.lut_mesh = new THREE.Mesh( lut_geometry, lut_material );
        },
        mounted() {
            this.init();
            this.resize_observer = new ResizeObserver(this.onCanvasResize);
            this.resize_observer.observe(this.$refs.box);
            this.onCanvasResize();
        },
        computed: {
            addOffset() {
                if(this.invertColormap) {
                    return 1.0;
                } else {
                    return 0.0;
                }
            },
            scaleFactor() {
                if(this.invertColormap) {
                    return -1.0;
                } else {
                    return 1.0;
                }
            },
            lutMaterial() {
                return make_lut_material(this.colormap, this.addOffset, this.scaleFactor);
            },
            vertexValues() {
                if ( this.orientation === "vertical" ) {
                    return Float32Array.from([1, 1, 0, 0]);
                } else {
                    return Float32Array.from([0, 1, 0, 1]);
                }
            },
        },
        watch: {
            vertexValues() {
                this.lut_mesh.geometry.setAttribute( 'data_value', new THREE.BufferAttribute( this.vertexValues, 1 ) );
            },
            colormap() {
                this.updateColormap();
            },
            invertColormap() {
                this.updateColormap();
            },
        },
        methods: {
            init() {
                // from: https://stackoverflow.com/a/65732553
                this.scene = new THREE.Scene();
                this.renderer = new THREE.WebGLRenderer({canvas: this.$refs.canvas});
                if (this.width !== undefined &&  this.height !== undefined) {
                    this.renderer.setSize(this.width, this.height);
                }
                this.scene.add(this.lut_mesh);

                this.camera = new THREE.PerspectiveCamera( 7.5, window.innerWidth / window.innerHeight, 0.1, 1000 );
                this.scene.add(this.camera);
            },
            render() {
                if (this.width !== undefined &&  this.height !== undefined) {
                    this.renderer.setSize(this.width, this.height);
                }
                this.renderer.render(this.scene, this.camera);
                if (this.$refs.box) {
                    this.resize_observer.observe(this.$refs.box);
                }
            },

            redraw() {
                console.log("redrawing colorbar");
                cancelAnimationFrame(this.frameId);
                this.frameId = requestAnimationFrame(this.render);
            },

            onCanvasResize(entries) {
                if(!this.$refs.box) {
                    return;
                }
                const {width, height} = this.$refs.box.getBoundingClientRect();
                console.log(this.width, this.height, width, height);
                if (width !== this.width || height !== this.height) {
                    this.resize_observer.unobserve(this.$refs.box);
                    const aspect = width / height;
                    this.camera.aspect = aspect;
                    this.camera.updateProjectionMatrix();
                    this.width = width;
                    this.height = height;
                    this.redraw();
                }
            },

            updateColormap() {
                this.lut_mesh.material.uniforms.colormap.value = available_colormaps[this.colormap];
                this.lut_mesh.material.uniforms.add_offset.value = this.addOffset;
                this.lut_mesh.material.uniforms.scale_factor.value = this.scaleFactor;
                this.redraw();
            },
        },
    };
</script>

<template>
    <div class="colorbar_box" ref="box">
        <canvas class="colorbar_canvas" ref="canvas">
        </canvas>
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
