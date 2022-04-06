<script>
    import * as THREE from 'three';
    import { HTTPStore, openArray, openGroup } from "zarr";
    import { attachControls } from "./js/world_controls.js";
    import { grid2buffer, data2value_buffer } from "./js/gridlook.js";
    import { make_colormap_material, available_colormaps } from "./js/colormap_shaders.js";
    import { geojson2geometry } from "./js/geojson.js";

    export default {
        props: ["datasources", "colormap", "invertColormap", "varname", "timeIndex", "varbounds", "enableCoastlines"],
        emits: ["varinfo"],
        data() {
            return {
                datavars: {},
                update_count: 0,
                updating_data: false,
                frameId: 0,
                width: undefined,
                height: undefined,
            };
        },
        created() {
            const geometry = new THREE.BufferGeometry();
            const material = this.colormapMaterial;
            this.main_mesh = new THREE.Mesh( geometry, material );
            this.datasourceUpdate();
        },
        mounted() {
            this.init();
            attachControls(this.renderer, this.camera, this.center, this.redraw);
            this.resize_observer = new ResizeObserver(this.onCanvasResize);
            this.resize_observer.observe(this.$refs.box);
            this.onCanvasResize();
        },
        beforeUnmount() {
            this.resize_observer.unobserve(this.$refs.box);
        },
        watch: {
            datasources() {
                this.datasourceUpdate();
            },
            varname() {
                this.getData();
            },
            timeIndex() {
                this.getData();
            },
            colormap() {
                this.updateColormap();
            },
            invertColormap() {
                this.updateColormap();
            },
            varbounds() {
                this.updateColormap();
            },
            enableCoastlines() {
                this.updateCoastlines();
            }
        },
        computed: {
            colormapMaterial() {
                if (this.invertColormap) {
                    return make_colormap_material(this.colormap, 1.0, -1.0);
                } else {
                    return make_colormap_material(this.colormap, 0.0, 1.0);
                }
            }
        },
        methods: {
            init() {
                // from: https://stackoverflow.com/a/65732553
                this.scene = new THREE.Scene();
                this.center = new THREE.Vector3();
                this.camera = new THREE.PerspectiveCamera( 7.5, window.innerWidth / window.innerHeight, 0.1, 1000 );
                console.log("canvas", this.$refs.canvas);
                this.renderer = new THREE.WebGLRenderer({canvas: this.$refs.canvas});

                this.camera.up = new THREE.Vector3(0, 0, 1);
                this.camera.position.x = 30;
                this.camera.lookAt(this.center);

                this.scene.add(this.main_mesh);
                this.coast = undefined;
                this.updateCoastlines();
            },
            datasourceUpdate() {
                if (this.datasources !== undefined) {
                    this.fetchGrid();
                    this.getData();
                }
            },
            async fetchGrid() {
                const store = new HTTPStore(this.datasources.levels[0].grid.store);
                const grid = await openGroup(store, this.datasources.levels[0].grid.dataset, "r");
                const verts = await grid2buffer(grid);
                console.log("verts have nan: " + verts.some(isNaN));
                console.log("verts", verts);
                this.main_mesh.geometry.setAttribute( 'position', new THREE.BufferAttribute( verts, 3 ) );
                this.main_mesh.geometry.attributes.position.needsUpdate = true;
                this.main_mesh.geometry.computeBoundingBox();
                this.main_mesh.geometry.computeBoundingSphere();
                this.redraw();
            },
            async getDataVar(varname) {
                if (this.datavars[varname] === undefined) {
                    console.log("fetching " + varname);
                    const datasource = this.datasources.levels[0].datasources[varname];
                    if (datasource === undefined) {
                        return undefined;
                    }
                    try {
                        const datastore = new HTTPStore(datasource.store);
                        this.datavars[varname] = await openGroup(datastore, datasource.dataset, "r").then(ds => ds.getItem(varname));
                    } catch (error) {
                        console.log("WARNING, couldn't fetch variable " + varname + " from store: " + datasource.store + " and dataset: " + datasource.dataset);
                        return undefined;
                    }
                }
                return this.datavars[varname];
            },
            async getData() {
                this.update_count += 1;
                const update_count = this.update_count;
                if (this.updating_data) {
                    return;
                }
                this.updating_data = true;
                    
                const varname = this.varname;
                const time_index = this.timeIndex;
                const datavar = await this.getDataVar(varname);
                if (datavar !== undefined) {
                    const data_buffer = await data2value_buffer(datavar.getRaw(time_index));
                    console.log("data buffer", data_buffer);
                    this.main_mesh.geometry.setAttribute( 'data_value', new THREE.BufferAttribute( data_buffer.data_values, 1 ) );
                    this.publishVarinfo({
                        attrs: await datavar.attrs.asObject(),
                        time_index,
                        varname,
                        time_range: {start: 0, end: datavar.shape[0] - 1},
                        bounds: {low: data_buffer.data_min, high: data_buffer.data_max},
                    });
                    this.redraw();
                }
                this.updating_data = false;
                if (this.update_count != update_count) {
                    this.getData();
                }
            },

            publishVarinfo(info) {
                this.$emit("varinfo", info);
            },

            updateColormap() {
                const low = this.varbounds.low;
                const high = this.varbounds.high;

                let add_offset;
                let scale_factor;

                if (this.invertColormap) {
                    scale_factor = -1. / (high - low);
                    add_offset = -high * scale_factor;
                } else {
                    scale_factor = 1. / (high - low);
                    add_offset = -low * scale_factor;
                }

                this.main_mesh.material.uniforms.colormap.value = available_colormaps[this.colormap];
                this.main_mesh.material.uniforms.add_offset.value = add_offset;
                this.main_mesh.material.uniforms.scale_factor.value = scale_factor;
                this.redraw();
            },

            async getCoastlines() {
                if (this.coast === undefined) {
                    const coastlines = await fetch("static/ne_50m_coastline.geojson").then(r => r.json());
                    console.log(coastlines);
                    const geometry = geojson2geometry(coastlines, 1.001);
                    const material = new THREE.LineBasicMaterial( { color: "#ffffff" } );
                    this.coast = new THREE.LineSegments( geometry, material );
                    this.coast.name = "coastlines";
                }
                return this.coast;
            },

            async updateCoastlines() {
                if (this.enableCoastlines === false) {
                    if(this.coast) {
                        this.scene.remove(this.coast);
                    }
                } else {
                    this.scene.add(await this.getCoastlines());
                }
                this.redraw();
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
                console.log("redrawing");
                cancelAnimationFrame(this.frameId);
                this.frameId = requestAnimationFrame(this.render);
            },

            onCanvasResize(entries) {
                if(!this.$refs.box) {
                    return;
                }
                console.log(entries);
                console.log("resize", this.$refs.box);
                const {width, height} = this.$refs.box.getBoundingClientRect();
                console.log("box", width, height);
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

            makeSnapshot() {
                const canvas = this.$refs.canvas;
                this.render();
                canvas.toBlob((blob) => {
                    let link = document.createElement('a');
                    link.download = 'gridlook.png';

                    link.href = URL.createObjectURL(blob);
                    link.click();

                    // delete the internal blob reference, to let the browser clear memory from it
                    URL.revokeObjectURL(link.href);
                }, 'image/png');
            },
        },
    };
</script>

<template>
    <div class="globe_box" ref="box">
        <canvas class="globe_canvas" ref="canvas">
        </canvas>
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
