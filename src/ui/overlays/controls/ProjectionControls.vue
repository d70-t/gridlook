<script lang="ts" setup>
import { storeToRefs } from "pinia";

import ProjectionCenterInputs from "./ProjectionCenterInputs.vue";

import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const store = useGlobeControlStore();
const { projectionMode } = storeToRefs(store);
</script>

<template>
  <div class="column">
    <div class="select is-fullwidth mb-2">
      <select v-model="projectionMode">
        <option :value="PROJECTION_TYPES.NEARSIDE_PERSPECTIVE">
          Nearside Perspective
        </option>
        <option :value="PROJECTION_TYPES.EQUIRECTANGULAR">
          Equirectangular
        </option>
        <option :value="PROJECTION_TYPES.MERCATOR">Mercator</option>
        <option :value="PROJECTION_TYPES.ROBINSON">Robinson</option>
        <option :value="PROJECTION_TYPES.MOLLWEIDE">Mollweide</option>
        <option :value="PROJECTION_TYPES.CYLINDRICAL_EQUAL_AREA">
          Cylindrical Equal Area
        </option>
        <option :value="PROJECTION_TYPES.AZIMUTHAL_EQUIDISTANT">
          Azimuthal Equidistant
        </option>
        <option :value="PROJECTION_TYPES.AZIMUTHAL_HYBRID">
          Azimuthal Hybrid
        </option>
      </select>
    </div>
    <ProjectionCenterInputs />
  </div>
</template>
