<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { Drawer } from "primevue";
import { ref, watch, computed } from "vue";
import VueJsonPretty from "vue-json-pretty";
import * as zarr from "zarrita";

import "vue-json-pretty/lib/styles.css";
import { GRID_TYPES, type T_GRID_TYPES } from "@/lib/data/gridTypeDetector";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager";
import { getLatLonData } from "@/lib/data/zarrUtils";
import type { TSources } from "@/lib/types/GlobeTypes";
import { useGlobeControlStore } from "@/store/store";
import { useLog } from "@/utils/logging";

const props = defineProps<{
  datasources?: TSources;
  gridType?: T_GRID_TYPES;
}>();

const { logError } = useLog();

const store = useGlobeControlStore();
const { varnameSelector } = storeToRefs(store);

const groupAttrs = ref<zarr.Attributes | null>(null);
const variableAttrs = ref<zarr.Attributes | null>(null);
const dimensions = ref<{ name: string; size: number }[]>([]);
const latSlice = ref<{ first10: number[]; last10: number[] } | null>(null);
const lonSlice = ref<{ first10: number[]; last10: number[] } | null>(null);
const error = ref<string | null>(null);
const isOpen = ref(false);

const hasLatLon = computed(
  () => latSlice.value !== null || lonSlice.value !== null
);

async function getLatLonSample(
  variable: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  if (
    props.gridType === GRID_TYPES.TRIANGULAR ||
    props.gridType === GRID_TYPES.HEALPIX
  ) {
    // No lat/lon for triangular grids
    return;
  }

  const { latitudes, longitudes } = await getLatLonData(
    variable,
    props.datasources,
    props.gridType === GRID_TYPES.REGULAR_ROTATED
  );

  const first10Lat = Array.from(
    latitudes.data as Float64Array | Float32Array
  ).slice(0, 10);
  const last10Lat = Array.from(
    latitudes.data as Float64Array | Float32Array
  ).slice(-10);
  const first10Lon = Array.from(
    longitudes.data as Float64Array | Float32Array
  ).slice(0, 10);
  const last10Lon = Array.from(
    longitudes.data as Float64Array | Float32Array
  ).slice(-10);
  latSlice.value = {
    first10: first10Lat,
    last10: last10Lat,
  };
  lonSlice.value = {
    first10: first10Lon,
    last10: last10Lon,
  };
}

async function fetchDebugInfo() {
  if (
    !props.datasources ||
    !varnameSelector.value ||
    varnameSelector.value === "-"
  ) {
    return;
  }

  error.value = null;

  try {
    const gridSource = props.datasources.levels[0].grid;
    const varSource =
      props.datasources.levels[0].datasources[varnameSelector.value];

    const group = await ZarrDataManager.getDatasetGroup(gridSource);
    groupAttrs.value = group.attrs;

    const variable = await ZarrDataManager.getVariableInfo(
      varSource,
      varnameSelector.value
    );
    variableAttrs.value = variable.attrs;

    // Get dimensions
    const arrayDims = variable.attrs?._ARRAY_DIMENSIONS as string[] | undefined;
    if (arrayDims && Array.isArray(arrayDims)) {
      dimensions.value = arrayDims.map((name, idx) => ({
        name,
        size: variable.shape[idx],
      }));
    } else {
      dimensions.value = variable.shape.map((size, idx) => ({
        name: `dim_${idx}`,
        size,
      }));
    }
    getLatLonSample(variable);
  } catch (err) {
    logError(err);
  }
}

watch(
  () => [props.datasources, varnameSelector.value, isOpen.value],
  () => {
    if (isOpen.value) {
      fetchDebugInfo();
    }
  },
  { immediate: true }
);

function formatValue(value: unknown): string {
  if (typeof value === "number") {
    return value.toFixed(6);
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}
</script>

<template>
  <!-- Toggle button -->
  <button
    v-if="!isOpen"
    type="button"
    class="debug-toggle-button button is-small is-info"
    :title="isOpen ? 'Close debug panel' : 'Open debug panel'"
    @click="isOpen = true"
  >
    <span>Show debug</span>
  </button>

  <Drawer
    v-model:visible="isOpen"
    header="Debug Info"
    position="right"
    :style="{ width: '400px' }"
  >
    <div v-if="error" class="debug-panel-content">
      <div class="notification is-danger is-light">
        <strong>Error:</strong> {{ error }}
      </div>
    </div>

    <div v-else class="debug-panel-content">
      <!-- Grid Type -->
      <section class="debug-section">
        <h4
          class="title is-6 is-flex is-justify-content-space-between is-align-items-center"
        >
          <span>Grid Type</span>
          <code>{{ gridType ?? "Unknown" }}</code>
        </h4>
      </section>

      <!-- Variable Info -->
      <section class="debug-section">
        <h4
          class="title is-6 is-flex is-justify-content-space-between is-align-items-center"
        >
          <span>Current Variable</span>
          <code>{{ varnameSelector }}</code>
        </h4>
      </section>

      <!-- Dimensions -->
      <section class="debug-section">
        <h4 class="title is-6">Dimensions</h4>
        <div v-if="dimensions.length > 0" class="content">
          <table class="table is-narrow is-fullwidth is-size-7">
            <thead>
              <tr>
                <th>Name</th>
                <th>Shape</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="dim in dimensions" :key="dim.name">
                <td>
                  <code>{{ dim.name }}</code>
                </td>
                <td>{{ dim.size }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="has-text-grey-light">No dimension info available</p>
      </section>

      <!-- Group Attributes -->
      <section class="debug-section">
        <h4 class="title is-6">Group Attributes</h4>
        <div
          v-if="groupAttrs && Object.keys(groupAttrs).length > 0"
          class="debug-pre"
        >
          <VueJsonPretty :data="groupAttrs" />
        </div>
        <p v-else class="has-text-grey-light">No group attributes</p>
      </section>

      <!-- Variable Attributes -->
      <section class="debug-section">
        <h4 class="title is-6">Variable Attributes</h4>
        <div
          v-if="variableAttrs && Object.keys(variableAttrs).length > 0"
          class="debug-pre"
        >
          <VueJsonPretty :data="variableAttrs" />
        </div>
        <p v-else class="has-text-grey-light">No variable attributes</p>
      </section>

      <!-- Latitude Values -->
      <section v-if="latSlice" class="debug-section">
        <h4 class="title is-6">Latitude Values</h4>
        <div class="">
          <p class="is-size-7 has-text-weight-semibold mb-2">First 10:</p>
          <div class="tags">
            <span
              v-for="(val, i) in latSlice.first10"
              :key="'lat-f-' + i"
              class="tag is-info is-light is-family-monospace"
              >{{ formatValue(val) }}</span
            >
          </div>
          <p class="is-size-7 has-text-weight-semibold mb-2 mt-3">Last 10:</p>
          <div class="tags">
            <span
              v-for="(val, i) in latSlice.last10"
              :key="'lat-l-' + i"
              class="tag is-info is-light is-family-monospace"
              >{{ formatValue(val) }}</span
            >
          </div>
        </div>
      </section>

      <!-- Longitude Values -->
      <section v-if="lonSlice" class="debug-section">
        <h4 class="title is-6">Longitude Values</h4>
        <div class="">
          <p class="is-size-7 has-text-weight-semibold mb-2">First 10:</p>
          <div class="tags">
            <span
              v-for="(val, i) in lonSlice.first10"
              :key="'lon-f-' + i"
              class="tag is-info is-light is-family-monospace"
              >{{ formatValue(val) }}</span
            >
          </div>
          <p class="is-size-7 has-text-weight-semibold mb-2 mt-3">Last 10:</p>
          <div class="tags">
            <span
              v-for="(val, i) in lonSlice.last10"
              :key="'lon-l-' + i"
              class="tag is-info is-light is-family-monospace"
              >{{ formatValue(val) }}</span
            >
          </div>
        </div>
      </section>

      <!-- No Lat/Lon Notice -->
      <div v-if="!hasLatLon" class="debug-section">
        <div class="notification is-info is-light is-size-7">
          <strong>Note:</strong> No lat/lon coordinates found for this grid
          type.
        </div>
      </div>
    </div>
  </Drawer>
</template>

<style lang="scss" scoped>
@use "bulma/sass/utilities" as bulmaUt;
.panel-width {
  width: 400px;
}

.debug-panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
}

.debug-section {
  margin-bottom: 1.5rem;
  // border-bottom: 1px solid var(--bulma-border);

  &:last-child {
    border-bottom: none;
  }

  .title {
    margin-bottom: 0.5rem;
  }
}

.debug-pre {
  padding: 0.75rem;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 0.75rem;
  max-height: 300px;
  overflow-y: auto;
}

.debug-toggle-button {
  position: fixed !important;
  top: 18px;
  right: 18px;
  z-index: 1002;
  border-radius: 0.375rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);

  &:hover {
    transform: scale(1.05);
  }
}
</style>
