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
import { useGlobeControlStore } from "../components/store/store";

const props = defineProps<{ src: string }>();

const store = useGlobeControlStore();

const globe: Ref<typeof Globe | null> = ref(null);
const globeKey = ref(0);
const globeControlKey = ref(0);
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
    // Rerender controls and globe and reset store
    // if new data is provided
    globeKey.value += 1;
    globeControlKey.value += 1;
    store.$reset();
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
      :key="globeControlKey"
      :model-info="modelInfo"
      :varinfo="varinfo"
      @selection="updateSelection"
      @on-snapshot="makeSnapshot"
      @on-example="makeExample"
      @on-rotate="toggleRotate"
    />
    <Globe
      ref="globe"
      :key="globeKey"
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
