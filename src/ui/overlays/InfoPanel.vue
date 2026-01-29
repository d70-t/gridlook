<script lang="ts" setup>
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";
import relativeTime from "dayjs/plugin/relativeTime";
import humanizeDuration from "humanize-duration";
import { storeToRefs } from "pinia";
import { ref, watch, computed } from "vue";
import VueJsonPretty from "vue-json-pretty";
import * as zarr from "zarrita";

import "vue-json-pretty/lib/styles.css";
import CollapsibleText from "../common/CollapsibleText.vue";

import { GRID_TYPES, type T_GRID_TYPES } from "@/lib/data/gridTypeDetector";
import { decodeTime } from "@/lib/data/timeHandling";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager";
import { getLatLonData } from "@/lib/data/zarrUtils";
import type { TSources } from "@/lib/types/GlobeTypes";
import { useGlobeControlStore } from "@/store/store";
import { useLog } from "@/utils/logging";

const props = defineProps<{
  datasources?: TSources;
  gridType?: T_GRID_TYPES;
  isOpen: boolean;
}>();

const emit = defineEmits<{
  close: [];
  toggle: [];
}>();

dayjs.extend(duration);
dayjs.extend(relativeTime);

const { logError } = useLog();

const store = useGlobeControlStore();
const { varnameSelector } = storeToRefs(store);

const groupAttrs = ref<zarr.Attributes | null>(null);
const variableAttrs = ref<zarr.Attributes | null>(null);
const dimensions = ref<{ name: string; size: number }[]>([]);
const latSlice = ref<{ first10: number[]; last10: number[] } | null>(null);
const lonSlice = ref<{ first10: number[]; last10: number[] } | null>(null);
const variableUnits = ref<string | null>(null);
const variableLongName = ref<string | null>(null);
const variableStandardName = ref<string | null>(null);
const timeInfo = ref<{
  units: string;
  calendar: string;
  firstTimestamp: string;
  lastTimestamp: string;
  timestep: string | null;
  numTimesteps: number;
} | null>(null);
const error = ref<string | null>(null);

const hasLatLon = computed(
  () => latSlice.value !== null || lonSlice.value !== null
);

// Computed properties for common group attributes
const datasetTitle = computed(() => (groupAttrs.value?.title as string) || "-");

const datasetContact = computed(
  () =>
    (groupAttrs.value?.contact as string) ||
    (groupAttrs.value?.creator_email as string) ||
    "-"
);

const datasetCreationDate = computed(
  () =>
    (groupAttrs.value?.creation_date as string) ||
    (groupAttrs.value?.date_created as string) ||
    "-"
);

const datasetInstitution = computed(
  () =>
    (groupAttrs.value?.institution as string) ||
    (groupAttrs.value?.institute as string) ||
    "-"
);

const datasetLicense = computed(
  () =>
    (groupAttrs.value?.license as string) ||
    (groupAttrs.value?.licence as string) ||
    "-"
);

const datasetDescription = computed(
  () =>
    (groupAttrs.value?.description as string) ||
    (groupAttrs.value?.summary as string) ||
    "-"
);

const datasetCreators = computed(
  () =>
    (groupAttrs.value?.creators as string) ||
    (groupAttrs.value?.authors as string) ||
    "-"
);

/**
 * Converts a bigint or number to a number, handling BigInt64Array values.
 */
function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * Fetches time dimension data and decodes timestamps.
 */
async function fetchTimeData(
  varSource: { store: string; dataset: string },
  timeDimName: string
) {
  const timeVar = await ZarrDataManager.getVariableInfo(varSource, timeDimName);

  const units = (timeVar.attrs?.units as string) || "unknown";
  const calendar = (timeVar.attrs?.calendar as string) || "standard";
  const numTimesteps = timeVar.shape[0];

  // Get time values
  const timeData = await ZarrDataManager.getVariableDataFromArray(timeVar);
  const timeArray = timeData.data as
    | Float64Array
    | Float32Array
    | BigInt64Array;

  const firstValue = toNumber(timeArray[0]);
  const lastValue = toNumber(timeArray[numTimesteps - 1]);

  const firstTimestamp = decodeTime(firstValue, timeVar.attrs);
  const lastTimestamp = decodeTime(lastValue, timeVar.attrs);

  // Calculate timestep if more than 1 timestep
  let timestep: string | null = null;
  if (numTimesteps > 1) {
    const secondValue = toNumber(timeArray[1]);
    const secondTimestamp = decodeTime(secondValue, timeVar.attrs);
    const diff = secondTimestamp.diff(firstTimestamp);
    timestep = humanizeDuration(diff);
  }

  return {
    units,
    calendar,
    firstTimestamp: firstTimestamp.format("YYYY-MM-DD HH:mm:ss"),
    lastTimestamp: lastTimestamp.format("YYYY-MM-DD HH:mm:ss"),
    timestep,
    numTimesteps,
  };
}

async function getTimeDimensionInfo(
  variable: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  if (!props.datasources) {
    return;
  }

  const arrayDims = variable.attrs?._ARRAY_DIMENSIONS as string[] | undefined;
  if (!arrayDims) {
    return;
  }

  // Find a time-like dimension
  const timeDimNames = ["time", "t", "datetime", "date", "valid_time"];
  const timeDimIndex = arrayDims.findIndex((dim) =>
    timeDimNames.includes(dim.toLowerCase())
  );

  if (timeDimIndex === -1) {
    timeInfo.value = null;
    return;
  }

  const timeDimName = arrayDims[timeDimIndex];

  try {
    const varSource = props.datasources.levels[0].time;
    timeInfo.value = await fetchTimeData(varSource, timeDimName);
  } catch (err) {
    logError(err);
    timeInfo.value = null;
  }
}

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

async function fetchInfoInfo() {
  if (
    !props.datasources ||
    !varnameSelector.value ||
    varnameSelector.value === "-"
  ) {
    return;
  }
  error.value = null;

  try {
    const varSource =
      props.datasources.levels[0].datasources[varnameSelector.value];

    const group = await ZarrDataManager.getDatasetGroup(varSource);
    groupAttrs.value = group.attrs;

    const variable = await ZarrDataManager.getVariableInfo(
      varSource,
      varnameSelector.value
    );
    variableAttrs.value = variable.attrs;

    // Get variable units and long name
    variableUnits.value = (variable.attrs?.units as string) || null;
    variableStandardName.value =
      (variable.attrs?.standard_name as string) || null;
    variableLongName.value =
      (variable.attrs?.long_name as string) ||
      (variable.attrs?.name as string) ||
      null;

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
    getTimeDimensionInfo(variable);
  } catch (err) {
    logError(err);
  }
}

watch(
  () => [props.datasources, varnameSelector.value, props.isOpen],
  () => {
    if (props.isOpen) {
      fetchInfoInfo();
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
    class="button is-small is-info"
    :title="isOpen ? 'Close info panel' : 'Open info panel'"
    @click="emit('toggle')"
  >
    <span class="icon">
      <i class="fa-solid fa-circle-info"></i>
    </span>
    <span>Dataset Info</span>
  </button>

  <!-- Backdrop for click-outside to close -->
  <div v-if="isOpen" class="info-panel-backdrop" @click="emit('close')"></div>

  <div class="info-panel" :class="[{ 'is-open': isOpen }]">
    <div class="info-panel-header">
      <h3 class="title is-5">Dataset Info</h3>
      <button
        type="button"
        class="delete"
        aria-label="close"
        @click="emit('close')"
      ></button>
    </div>

    <div v-if="error" class="info-panel-content">
      <div class="notification is-danger is-light">
        <strong>Error:</strong> {{ error }}
      </div>
    </div>

    <div v-else class="info-panel-content">
      <!-- Grid Type -->
      <section class="info-section">
        <h4
          class="title is-6 is-flex is-justify-content-space-between is-align-items-center"
        >
          <span>Grid Type</span>
          <code>{{ gridType ?? "Unknown" }}</code>
        </h4>
      </section>

      <!-- Dataset Metadata -->
      <section class="info-section">
        <h4 class="title is-6">Dataset Metadata</h4>
        <div class="content">
          <table class="table is-narrow is-fullwidth is-size-7">
            <tbody>
              <tr>
                <td><strong>Title</strong></td>
                <td>{{ datasetTitle }}</td>
              </tr>
              <tr>
                <td><strong>Description</strong></td>
                <td>
                  <CollapsibleText :text="datasetDescription" />
                </td>
              </tr>
              <tr>
                <td><strong>Institution</strong></td>
                <td>{{ datasetInstitution }}</td>
              </tr>
              <tr>
                <td><strong>Creators</strong></td>
                <td>
                  <CollapsibleText :text="datasetCreators" />
                </td>
              </tr>
              <tr>
                <td><strong>Contact</strong></td>
                <td>{{ datasetContact }}</td>
              </tr>
              <tr>
                <td><strong>Creation Date</strong></td>
                <td>{{ datasetCreationDate }}</td>
              </tr>
              <tr>
                <td><strong>License</strong></td>
                <td>
                  <CollapsibleText :text="datasetLicense" :max-length="40" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Variable Info -->
      <section class="info-section">
        <h4
          class="title is-6 is-flex is-justify-content-space-between is-align-items-center"
        >
          <span>Current Variable</span>
          <code>{{ varnameSelector }}</code>
        </h4>
        <div class="content">
          <table class="table is-narrow is-fullwidth is-size-7">
            <tbody>
              <tr>
                <td><strong>Long name</strong></td>
                <td>
                  <span v-if="variableLongName">{{ variableLongName }}</span>
                  <span v-else class="has-text-grey-light">-</span>
                </td>
              </tr>
              <tr>
                <td><strong>Standard name</strong></td>
                <td>
                  <code v-if="variableStandardName">{{
                    variableStandardName
                  }}</code>
                  <span v-else class="has-text-grey-light">-</span>
                </td>
              </tr>
              <tr>
                <td><strong>Units</strong></td>
                <td>
                  <code v-if="variableUnits">{{ variableUnits }}</code>
                  <span v-else class="has-text-grey-light">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Dimensions -->
      <section class="info-section">
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

      <!-- Time Dimension Info -->
      <section v-if="timeInfo" class="info-section">
        <h4 class="title is-6">Time Dimension</h4>
        <div class="content">
          <table class="table is-narrow is-fullwidth is-size-7">
            <tbody>
              <tr>
                <td><strong>Units</strong></td>
                <td>
                  <code>{{ timeInfo.units }}</code>
                </td>
              </tr>
              <tr>
                <td><strong>Calendar</strong></td>
                <td>
                  <code>{{ timeInfo.calendar }}</code>
                </td>
              </tr>
              <tr>
                <td><strong>Timesteps</strong></td>
                <td>{{ timeInfo.numTimesteps }}</td>
              </tr>
              <tr v-if="timeInfo.timestep">
                <td>
                  <strong>Initial interval</strong>
                  <span class="ml-1 has-text-grey is-size-7">(1st→2nd)</span>
                </td>
                <td>{{ timeInfo.timestep }}</td>
              </tr>
              <tr>
                <td><strong>First timestamp</strong></td>
                <td>
                  <code>{{ timeInfo.firstTimestamp }}</code>
                </td>
              </tr>
              <tr>
                <td><strong>Last timestamp</strong></td>
                <td>
                  <code>{{ timeInfo.lastTimestamp }}</code>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Group Attributes -->
      <section class="info-section">
        <h4 class="title is-6">Group Attributes</h4>
        <div
          v-if="groupAttrs && Object.keys(groupAttrs).length > 0"
          class="info-pre"
        >
          <VueJsonPretty :data="groupAttrs" />
        </div>
        <p v-else class="has-text-grey-light">No group attributes</p>
      </section>

      <!-- Variable Attributes -->
      <section class="info-section">
        <h4 class="title is-6">Variable Attributes</h4>
        <div
          v-if="variableAttrs && Object.keys(variableAttrs).length > 0"
          class="info-pre"
        >
          <VueJsonPretty :data="variableAttrs" />
        </div>
        <p v-else class="has-text-grey-light">No variable attributes</p>
      </section>

      <!-- Latitude Values -->
      <section v-if="latSlice" class="info-section">
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
      <section v-if="lonSlice" class="info-section">
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
      <div v-if="!hasLatLon" class="info-section">
        <div class="notification is-info is-light is-size-7">
          <strong>Note:</strong> No lat/lon coordinates found for this grid
          type.
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use "bulma/sass/utilities" as bulmaUt;

.info-panel-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: transparent;
  z-index: 1000;
}

.info-panel {
  position: fixed;
  top: 0;
  right: -400px;
  width: 400px;
  height: 100vh;
  background: var(--bulma-scheme-main);
  box-shadow: -2px 0 8px rgba(0, 0, 0, 0.15);
  z-index: 1001;
  transition: right 0.3s ease-in-out;
  display: flex;
  flex-direction: column;

  &.is-open {
    right: 0;
  }
}

@media only screen and (max-width: bulmaUt.$tablet) {
  .info-panel {
    width: 100%;
    right: -100%;
  }
}

.info-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  border-bottom: 1px solid var(--bulma-border);
  flex-shrink: 0;
  .title {
    margin-bottom: 0;
  }
}

.info-panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
}

.info-section {
  margin-bottom: 1.5rem;
  // border-bottom: 1px solid var(--bulma-border);

  &:last-child {
    border-bottom: none;
  }

  .title {
    margin-bottom: 0.5rem;
  }
}

.info-pre {
  padding: 0.75rem;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 0.75rem;
  max-height: 300px;
  overflow-y: auto;
}

.info-toggle-button {
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
