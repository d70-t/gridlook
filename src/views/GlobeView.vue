<script setup>
import Globe from "@/components/Globe.vue";
import GlobeControls from "@/components/GlobeControls.vue";
import { available_colormaps } from "@/components/js/colormap_shaders.js";

import { ref, computed, watch, onMounted } from "vue";

const props = defineProps({
  src: String,
});

const globe = ref(null);

const datasources = ref(undefined);
const selection = ref({});
const varinfo = ref(undefined);

const modelInfo = computed(() => {
  if (datasources.value === undefined) {
    return undefined;
  } else {
    return {
      title: datasources.value.name,
      vars: datasources.value.levels[0].datasources,
      default_var: datasources.value.default_var,
      colormaps: Object.keys(available_colormaps),
      time_range: {
        start: 0,
        end: 1,
      },
    };
  }
});

const updateSelection = (s) => {
  selection.value = s;
};

const updateVarinfo = (info) => {
  varinfo.value = info;
};

const updateSrc = async () => {
  console.log("updateSrc");
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
<!--
<script>
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
    };
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
            end: 1,
          },
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
      const datasources = await fetch(this.src).then((r) => r.json());
      if (src == this.src) {
        this.datasources = datasources;
      }
    },
    makeSnapshot() {
      if (this.$refs.globe) {
        this.$refs.globe.makeSnapshot();
      }
    },
    makeExample() {
      if (this.$refs.globe) {
        this.$refs.globe.copyPythonExample();
      }
    },
    toggleRotate() {
      if (this.$refs.globe) {
        this.$refs.globe.toggleRotate();
      }
    },
  },
  watch: {
    src() {
      this.updateSrc();
    },
  },
};
</script>
 -->
<template>
  <main>
    <GlobeControls
      :modelInfo="modelInfo"
      :varinfo="varinfo"
      @selection="updateSelection"
      @on-snapshot="makeSnapshot"
      @on-example="makeExample"
      @on-rotate="toggleRotate"
    />
    <Globe
      :datasources="datasources"
      :colormap="selection.colormap"
      :invert-colormap="selection.invertColormap"
      :varbounds="selection.bounds"
      @varinfo="updateVarinfo"
      ref="globe"
    />
  </main>
</template>

<style>
main {
  overflow: hidden;
}
</style>
