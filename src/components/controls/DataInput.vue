<script lang="ts" setup>
import { ref } from "vue";

const dataPath = ref("");

function setLocationHash() {
  if (dataPath.value) {
    location.hash = "#" + dataPath.value;
  }
}
</script>

<template>
  <div class="panel-block">
    <input
      v-model="dataPath"
      class="input"
      type="url"
      placeholder="Zarr data url"
    />
    <button
      class="button"
      type="button"
      title="Load dataset"
      @click="setLocationHash"
    >
      <span class="icon">
        <i class="fas fa-rotate"></i>
      </span>
    </button>
  </div>
</template>
