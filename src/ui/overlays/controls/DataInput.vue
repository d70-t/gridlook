<script lang="ts" setup>
import { Panel } from "primevue";
import { ref } from "vue";

const dataPath = ref("");

function setLocationHash() {
  if (dataPath.value) {
    location.hash = "#" + dataPath.value.trim();
  }
}
</script>

<template>
  <Panel header="Data Input" toggleable class="shadow-sm m-2">
    <form
      class="panel-block is-flex is-flex-direction-column is-align-items-flex-start"
      @submit.prevent="setLocationHash"
    >
      <div class="field has-addons w-100">
        <div class="control is-expanded">
          <input
            v-model="dataPath"
            class="input"
            type="url"
            placeholder="Zarr URI"
          />
        </div>
        <div class="control">
          <button class="button is-link" type="button" @click="setLocationHash">
            <span class="icon">
              <i class="fas fa-play"></i>
            </span>
          </button>
        </div>
      </div>
    </form>
  </Panel>
</template>
