<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { useGlobeControlStore } from "../store/store";
import { PROJECTION_TYPES } from "../utils/projectionUtils";

const store = useGlobeControlStore();
const { projectionMode } = storeToRefs(store);
</script>

<template>
  <div class="panel-block is-flex is-flex-direction-column gap-2">
    <label class="label is-small mb-1">Projection</label>
    <div class="select is-fullwidth mb-2">
      <select v-model="projectionMode">
        <option :value="PROJECTION_TYPES.GLOBE">Globe</option>
        <option :value="PROJECTION_TYPES.MERCATOR">Mercator</option>
        <option :value="PROJECTION_TYPES.ROBINSON">Robinson</option>
        <option :value="PROJECTION_TYPES.MOLLWEIDE">Mollweide</option>
      </select>
    </div>
  </div>
</template>
