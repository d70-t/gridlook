<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { Panel } from "primevue";

import { useGlobeControlStore } from "@/store/store";

const store = useGlobeControlStore();
const { landSeaMaskChoice, landSeaMaskUseTexture } = storeToRefs(store);
</script>

<template>
  <Panel header="Masks" toggleable class="shadow-sm m-2">
    <div class="w-100 pt-2">
      <div class="columns compact-row is-flex is-align-items-center">
        <div class="column">
          <div class="control has-icons-left">
            <div class="select">
              <select id="land_sea_mask" v-model="landSeaMaskChoice">
                <option value="off">-- Mask: Off --</option>
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
      </div>
    </div>
  </Panel>
</template>
