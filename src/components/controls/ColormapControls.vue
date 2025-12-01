<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { useGlobeControlStore } from "../store/store.ts";
import ColorBar from "./ColorBar.vue";
import type { TModelInfo } from "@/types/GlobeTypes.js";

defineProps<{
  modelInfo: TModelInfo;
  autoColormap: boolean;
}>();

defineEmits<{
  "update:autoColormap": [value: boolean];
}>();

const store = useGlobeControlStore();
const { colormap, invertColormap } = storeToRefs(store);
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
      <div class="column has-text-right py-2">
        <input
          id="auto_colormap"
          :checked="autoColormap"
          type="checkbox"
          @change="
            $emit(
              'update:autoColormap',
              ($event.target as HTMLInputElement).checked
            )
          "
        />
        <label for="auto_colormap">auto</label>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use "bulma/sass/utilities" as bulmaUt;

.hcolormap {
  max-height: 2.5em;
  overflow: hidden;
  border-radius: bulmaUt.$radius;
}
</style>
