<script setup lang="ts">
import Globe from '@/components/Globe.vue'
import GlobeControls from '@/components/GlobeControls.vue'
import { available_colormaps } from "@/components/js/colormap_shaders.js";
</script>

<script lang="ts">
export default {
    props: ["src"],
    data() {
        return {
            datasources: undefined,
            timeIndex: 0,
            selection: {
                varname: "rlut",
                timeIndex: 0,
            },
            varinfo: undefined,
        }
    },
    mounted() {
        this.updateSrc();
    },
    computed: {
            modelInfo() {
                if (this.datasources === undefined) {
                    return undefined;
                } else {
                    return {
                        title: this.datasources.name,
                        vars: this.datasources.levels[0].datasources,
                        default_var: this.datasources.default_var,
                        colormaps: Object.keys(available_colormaps),
                        time_range: {
                            start: 0,
                            end: 1
                        }
                    };
                }
            },
    },
    methods: {
        updateSelection(s) {
            this.selection = s;
        },
        updateVarinfo(info) {
            this.varinfo = info;
        },
        async updateSrc() {
            const src = this.src;
            const datasources = await fetch(this.src).then(r => r.json());
            if (src == this.src) {
                this.datasources = datasources;
            }
        },
    },
    watch: {
        src() {
            this.updateSrc();
        }
    }
}
</script>

<template>
  <main>
    <GlobeControls :modelInfo="modelInfo" :varinfo="varinfo" @selection="updateSelection"/>
    <Globe :datasources="datasources"
           :varname="selection.varname"
           :timeIndex="selection.timeIndex"
           :colormap="selection.colormap"
           :invert-colormap="selection.invertColormap"
           :varbounds="selection.bounds"
           :enable-coastlines="selection.enableCoastlines"
           @varinfo="updateVarinfo"/>
  </main>
</template>

<style>
main {
    overflow: hidden;
}
</style>
