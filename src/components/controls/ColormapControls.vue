<script lang="ts" setup>
import { ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useGlobeControlStore } from "../store/store.ts";
import ColorBar from "./ColorBar.vue";
import type { TModelInfo } from "@/types/GlobeTypes.js";

const props = defineProps<{
  modelInfo: TModelInfo;
}>();

const store = useGlobeControlStore();
const { colormap, invertColormap, varnameSelector } = storeToRefs(store);

const autoColormap = ref<boolean>(true);

const setDefaultColormap = () => {
  const defaultColormap =
    props.modelInfo?.vars[varnameSelector.value]?.default_colormap;
  if (autoColormap.value && defaultColormap !== undefined) {
    invertColormap.value = defaultColormap.inverted || false;
    colormap.value = defaultColormap.name;
  }
};

watch(
  () => autoColormap.value,
  () => {
    setDefaultColormap();
  }
);

// Expose setDefaultColormap for parent component
defineExpose({
  setDefaultColormap,
});
</script>

<template>
  <div class="panel-block is-block w-100">
    <!-- Colormap Select + ColorBar -->
    <div class="columns is-mobile compact-row">
      <div class="column">
        <div class="select is-fullwidth">
          <select v-model="colormap">
            <option v-for="cm in modelInfo.colormaps" :key="cm" :value="cm">
              {{ cm }}
            </option>
          </select>
        </div>
      </div>
      <div class="column is-two-thirds">
        <ColorBar
          class="hcolormap"
          :colormap="colormap"
          :invert-colormap="invertColormap"
        />
      </div>
    </div>

    <!-- Colormap checkboxes -->
    <div class="columns is-mobile compact-row">
      <div class="column py-2">
        <input id="invert_colormap" v-model="invertColormap" type="checkbox" />
        <label for="invert_colormap">invert</label>
      </div>
      <div class="column"></div>
      <div class="column has-text-right py-2">
        <input id="auto_colormap" v-model="autoColormap" type="checkbox" />
        <label for="auto_colormap">auto</label>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use "bulma/sass/utilities" as bulmaUt;

.compact-row {
  padding-top: 0.1rem;
  padding-bottom: 0.1rem;
  margin-bottom: 0.1rem;

  & > .column {
    padding-top: 0.1rem;
    padding-bottom: 0.1rem;
  }
}

.hcolormap {
  max-height: 2.5em;
  overflow: hidden;
  border-radius: bulmaUt.$radius;
}
</style>
