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
  <form class="panel-block" @submit.prevent="setLocationHash">
    <input v-model="dataPath" class="input" type="url" placeholder="Zarr URI" />
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
  </form>
</template>
