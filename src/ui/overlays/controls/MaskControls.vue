<script lang="ts" setup>
import { storeToRefs } from "pinia";

import { useGlobeControlStore } from "@/store/store.ts";

const store = useGlobeControlStore();
const {
  landSeaMaskChoice,
  landSeaMaskUseTexture,
  showCoastLines,
  showGraticules,
} = storeToRefs(store);

function toggleTexture() {
  if (landSeaMaskChoice.value === "off") {
    return;
  }
  landSeaMaskUseTexture.value = !landSeaMaskUseTexture.value;
}
</script>

<template>
  <div class="column">
    <div class="grid">
      <div class="cell control has-icons-left">
        <div class="select">
          <select id="land_sea_mask" v-model="landSeaMaskChoice">
            <option value="off">Mask: Off</option>
            <option value="land">Land</option>
            <option value="sea">Sea</option>
            <option value="globe">Globe</option>
          </select>
        </div>
        <span class="icon is-medium is-left">
          <i
            class="fas"
            :class="
              landSeaMaskChoice === 'globe'
                ? 'fa-globe'
                : landSeaMaskChoice === 'land'
                  ? 'fa-mountain'
                  : landSeaMaskChoice === 'sea'
                    ? 'fa-water'
                    : 'fa-mask'
            "
          ></i>
        </span>
      </div>
      <button
        class="button cell"
        :class="{ 'is-info': landSeaMaskUseTexture }"
        :disabled="landSeaMaskChoice === 'off'"
        :title="
          landSeaMaskChoice === 'off'
            ? 'Select a mask type to enable texture option'
            : 'Earth texture credit: NASA'
        "
        type="button"
        :aria-pressed="landSeaMaskUseTexture"
        @click="toggleTexture"
      >
        <span class="icon">
          <i class="fa-solid fa-image"></i>
        </span>
        <span>Use texture</span>
      </button>
      <button
        class="button cell"
        :class="{ 'is-info': showCoastLines }"
        type="button"
        title="Toggle coastlines"
        @click="store.toggleCoastLines"
      >
        <span class="icon">
          <i class="fa-solid fa-earth-europe"></i>
        </span>
        <span>Coastlines</span>
      </button>
      <button
        class="button cell"
        :class="{ 'is-info': showGraticules }"
        type="button"
        title="Toggle lat/lon grid"
        @click="store.toggleGraticules"
      >
        <span class="icon">
          <i class="fa-solid fa-globe"></i>
        </span>
        <span>Lat/Lon Grid</span>
      </button>
    </div>
  </div>
</template>

<!--
<template>
  <div class="column">
    <div class="w-100 is-flex gap is-justify-content-space-between pb-2">
      <div class="control has-icons-left w-100">
        <div class="select w-100">
          <select id="land_sea_mask" v-model="landSeaMaskChoice">
            <option value="off">Mask: Off</option>
            <option value="land">Land</option>
            <option value="sea">Sea</option>
            <option value="globe">Globe</option>
          </select>
        </div>
        <span class="icon is-medium is-left">
          <i
            class="fas"
            :class="
              landSeaMaskChoice === 'globe'
                ? 'fa-globe'
                : landSeaMaskChoice === 'land'
                  ? 'fa-mountain'
                  : landSeaMaskChoice === 'sea'
                    ? 'fa-water'
                    : 'fa-mask'
            "
          ></i>
        </span>
      </div>
      <button
        class="button w-100"
        :class="{ 'is-info': landSeaMaskUseTexture }"
        :disabled="landSeaMaskChoice === 'off'"
        title="Earth texture credit: NASA"
        type="button"
        :aria-pressed="landSeaMaskUseTexture"
        @click="toggleTexture"
      >
        <span class="icon">
          <i class="fa-solid fa-image"></i>
        </span>
        <span>Use texture</span>
      </button>
    </div>

    <div class="w-100 is-flex gap is-justify-content-space-between py-2">
      <button
        class="button w-100"
        :class="{ 'is-info': showCoastLines }"
        type="button"
        title="Toggle coastlines"
        @click="store.toggleCoastLines"
      >
        <span class="icon">
          <i class="fa-solid fa-earth-europe"></i>
        </span>
        <span>Coastlines</span>
      </button>
      <button
        class="button w-100"
        :class="{ 'is-info': showGraticules }"
        type="button"
        title="Toggle lat/lon grid"
        @click="store.toggleGraticules"
      >
        <span class="icon">
          <i class="fa-solid fa-globe"></i>
        </span>
        <span>Lat/Lon Grid</span>
      </button>
    </div>
  </div>
</template> -->

<style lang="scss" scoped>
.gap {
  gap: 0.5em;
}
</style>
