<script lang="ts" setup>
import Globe from "@/components/Globe.vue";
import GlobeControls from "@/components/GlobeControls.vue";
import { availableColormaps } from "@/components/utils/colormapShaders.js";

import { ref, computed, watch, onMounted, type Ref } from "vue";
import type {
  TColorMap,
  TSelection,
  TSources,
  TVarInfo,
} from "../types/GlobeTypes";

const props = defineProps<{ src: string }>();
const globe: Ref<typeof Globe | null> = ref(null);

const datasources: Ref<TSources | undefined> = ref(undefined);
const selection: Ref<Partial<TSelection>> = ref({});
const varinfo: Ref<TVarInfo | undefined> = ref(undefined);

const modelInfo = computed(() => {
  if (datasources.value === undefined) {
    return undefined;
  } else {
    return {
      title: datasources.value.name,
      vars: datasources.value.levels[0].datasources,
      defaultVar: datasources.value.default_var,
      colormaps: Object.keys(availableColormaps) as TColorMap[],
      timeRange: {
        start: 0,
        end: 1,
      },
    };
  }
});

const updateSelection = (s: TSelection) => {
  selection.value = s;
};

const updateVarinfo = (info: TVarInfo) => {
  varinfo.value = info;
};

const updateSrc = async () => {
  const src = props.src;
  const datasourcesResponse = await fetch(src).then((r) => r.json());
  if (src === props.src) {
    datasources.value = datasourcesResponse;
  }
};

const makeSnapshot = () => {
  if (globe.value) {
    globe.value.makeSnapshot();
  }
};

const makeExample = () => {
  if (globe.value) {
    globe.value.copyPythonExample();
  }
};

const toggleRotate = () => {
  if (globe.value) {
    globe.value.toggleRotate();
  }
};

watch(
  () => props.src,
  () => {
    console.log("watchSource");
    updateSrc();
  }
);

onMounted(() => {
  updateSrc();
});
</script>

<template>
  <main>
    <GlobeControls
      :model-info="modelInfo"
      :varinfo="varinfo"
      @selection="updateSelection"
      @on-snapshot="makeSnapshot"
      @on-example="makeExample"
      @on-rotate="toggleRotate"
    />
    <Globe
      ref="globe"
      :datasources="datasources"
      :colormap="selection.colormap"
      :invert-colormap="selection.invertColormap"
      :varbounds="selection.bounds"
      @varinfo="updateVarinfo"
    />
  </main>
</template>

<style>
main {
  overflow: hidden;
}
</style>
