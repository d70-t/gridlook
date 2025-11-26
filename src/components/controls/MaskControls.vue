<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { useGlobeControlStore } from "../store/store.ts";

defineEmits<{
  onRotate: [];
}>();

const store = useGlobeControlStore();
const { landSeaMaskChoice, landSeaMaskUseTexture } = storeToRefs(store);
</script>

<template>
  <div class="panel-block is-justify-content-space-between">
    <div>
      <input
        id="enable_coastlines"
        type="checkbox"
        :checked="store.showCoastLines"
        @change="store.toggleCoastLines"
      />
      <label for="enable_coastlines">coastlines</label>
    </div>
    <div>
      <button class="button" type="button" @click="() => $emit('onRotate')">
        <i class="fa-solid fa-rotate mr-1"></i>
        Toggle Rotation
      </button>
    </div>
  </div>
  <div class="panel-block is-justify-content-space-between">
    <div class="select">
      <select id="land_sea_mask" v-model="landSeaMaskChoice">
        <option value="off">Mask: Off</option>
        <option value="land">Mask: Land</option>
        <option value="sea">Mask: Sea</option>
        <option value="globe">Mask: Globe</option>
      </select>
    </div>
    <div class="columns is-mobile compact-row">
      <div class="column py-2">
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
          >Use Texture</label
        >
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.compact-row {
  padding-top: 0.1rem;
  padding-bottom: 0.1rem;
  margin-bottom: 0.1rem;

  & > .column {
    padding-top: 0.1rem;
    padding-bottom: 0.1rem;
  }
}
</style>
