<script lang="ts" setup>
import { storeToRefs } from "pinia";

import { useGlobeControlStore } from "@/store/store.ts";

const store = useGlobeControlStore();
const { landSeaMaskChoice, landSeaMaskUseTexture } = storeToRefs(store);
</script>

<template>
  <div class="panel-block">
    <div class="">
      <div class="columns compact-row is-flex is-align-items-center">
        <div class="column">
          <div class="control has-icons-left">
            <div class="select">
              <select id="land_sea_mask" v-model="landSeaMaskChoice">
                <option value="off">-- Land/Sea Mask --</option>
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
        </div>
        <div class="column has-text-right">
          <input
            id="use_texture"
            v-model="landSeaMaskUseTexture"
            :disabled="landSeaMaskChoice === 'off'"
            type="checkbox"
          />
          <label
            for="use_texture"
            title="Earth texture credit: NASA"
            :class="{
              'has-text-grey-light': landSeaMaskChoice === 'off',
            }"
            >Use texture</label
          >
        </div>
      </div>

      <div class="columns compact-row py-2">
        <div class="column">
          <input
            id="enable_coastlines"
            type="checkbox"
            :checked="store.showCoastLines"
            @change="store.toggleCoastLines"
          />
          <label for="enable_coastlines">Coastlines</label>
        </div>
        <div class="column">
          <input
            id="enable_graticules"
            type="checkbox"
            :checked="store.showGraticules"
            @change="store.toggleGraticules"
          />
          <label for="enable_graticules">Graticules</label>
        </div>
      </div>
    </div>
  </div>
</template>
