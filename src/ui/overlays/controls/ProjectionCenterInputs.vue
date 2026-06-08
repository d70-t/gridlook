<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import { clamp, PROJECTION_TYPES } from "@/lib/projection/projectionUtils.ts";
import { useGlobeControlStore } from "@/store/store.ts";

/*
 * Inputs for adjusting the projection center (longitude and latitude) for flat
 * projections.  This component has been extracted from ProjectionControls.vue
 * to avoid interferences between the constant updates to the projection center
 * and the projection mode when switching between flat and perspective
 * projections.
 *
 * By separating the projection center inputs into their own component, we can
 * ensure that the constant updates to the projection center do not cause
 * unnecessary re-renders of the entire ProjectionControls component
 *
 * Do not merge back into ProjectionControls.vue without carefully considering
 * the implications
 */
const store = useGlobeControlStore();
const { projectionMode, projectionCenter } = storeToRefs(store);
const isFlat = computed(
  () => projectionMode.value !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE
);

const centerLon = ref(projectionCenter.value.lon);
const centerLat = ref(projectionCenter.value.lat);

watch(
  () => projectionCenter.value,
  (center) => {
    centerLon.value = center.lon;
    centerLat.value = center.lat;
  },
  { deep: true }
);

const updateLon = (value: number) => {
  projectionCenter.value = {
    ...projectionCenter.value,
    lon: clamp(value, -180, 180),
  };
};

const updateLat = (value: number) => {
  projectionCenter.value = {
    ...projectionCenter.value,
    lat: clamp(value, -90, 90),
  };
};

watch(centerLon, (value) => {
  if (value !== projectionCenter.value.lon) {
    updateLon(value);
  }
});

watch(centerLat, (value) => {
  if (value !== projectionCenter.value.lat) {
    updateLat(value);
  }
});

function resetProjectionCenter() {
  projectionCenter.value = { lat: 0, lon: 0 };
}
</script>

<template>
  <div class="w-100 projection-center" :class="{ 'is-disabled': !isFlat }">
    <div class="label is-size-7 mb-1">Projection center (°)</div>
    <div class="columns is-mobile is-variable is-1 projection-columns">
      <div class="column">
        <div class="field has-addons">
          <p class="control">
            <span class="button is-static">Lon</span>
          </p>
          <p class="control is-expanded">
            <input
              v-model.number="centerLon"
              class="input projection-input"
              type="number"
              min="-180"
              max="180"
              step="1"
              :disabled="!isFlat"
            />
          </p>
        </div>
      </div>
      <div class="column">
        <div class="field has-addons">
          <p class="control">
            <span class="button is-static">Lat</span>
          </p>
          <p class="control is-expanded">
            <input
              v-model.number="centerLat"
              class="input projection-input"
              type="number"
              min="-90"
              max="90"
              step="1"
              :disabled="!isFlat"
            />
          </p>
        </div>
      </div>
      <div class="column is-narrow">
        <button
          class="button is-light"
          type="button"
          :disabled="!isFlat"
          title="Reset projection center"
          @click="resetProjectionCenter"
        >
          <span class="icon">
            <i class="fa-solid fa-arrow-rotate-left"></i>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.projection-input {
  text-align: right;
  -moz-appearance: textfield;
  appearance: textfield;
}

.projection-center .button.is-static {
  min-width: 3rem;
}

.projection-center .projection-columns {
  margin-left: 0;
  margin-right: 0;
}

.projection-center .projection-columns > .column:first-child {
  padding-left: 0;
}

.projection-center .projection-columns > .column:last-child {
  padding-right: 0;
}

.projection-center .input:disabled {
  border-color: var(--bulma-input-border-color);
  box-shadow: none;
}

.projection-center.is-disabled .button.is-static {
  border-color: var(--bulma-input-border-color);
  box-shadow: none;
}
</style>
