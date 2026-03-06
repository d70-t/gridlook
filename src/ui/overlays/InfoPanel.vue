<script lang="ts" setup>
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";
import humanizeDuration from "humanize-duration";
import { storeToRefs } from "pinia";
import { ref, watch, computed, type Ref } from "vue";
import VueJsonPretty from "vue-json-pretty";
import * as zarr from "zarrita";

import "vue-json-pretty/lib/styles.css";
import CollapsibleText from "../common/CollapsibleText.vue";

import {
  GRID_TYPE_DISPLAY_OVERRIDES,
  GRID_TYPES,
  type T_GRID_TYPES,
} from "@/lib/data/gridTypeDetector";
import { decodeTime } from "@/lib/data/timeHandling";
import queryVariable, { type TNercVariable } from "@/lib/data/variableQuery";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager";
import {
  getLatLonData,
  getMissingValue,
  getFillValue,
} from "@/lib/data/zarrUtils";
import type { TSources } from "@/lib/types/GlobeTypes";
import { useUrlParameterStore } from "@/store/paramStore";
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
  selectGridType: [gridType: T_GRID_TYPES];
}>();

dayjs.extend(duration);

const { logError } = useLog();

const store = useGlobeControlStore();
const { varnameSelector } = storeToRefs(store);

const paramStore = useUrlParameterStore();
const { paramGridType } = storeToRefs(paramStore);

const groupAttrs = ref<zarr.Attributes | null>(null);
const variableAttrs = ref<zarr.Attributes | null>(null);
const dimensions = ref<{ name: string; size: number }[]>([]);

const latSlice = ref<{ first10: number[]; last10: number[] } | null>(null);
const latDimensions = ref<{ name: string; size: number }[]>([]);
const latLength = ref<number | null>(null);
const latMin = ref<number | null>(null);
const latMax = ref<number | null>(null);
const lonSlice = ref<{ first10: number[]; last10: number[] } | null>(null);
const lonDimensions = ref<{ name: string; size: number }[]>([]);
const lonLength = ref<number | null>(null);
const lonMin = ref<number | null>(null);
const lonMax = ref<number | null>(null);

const variableUnits = ref<string | null>(null);
const variableLongName = ref<string | null>(null);
const variableStandardName = ref<string | null>(null);
const nercInfo = ref<TNercVariable | null>(null);
const variableDtype = ref<string | null>(null);
const variableChunks = ref<readonly (number | null)[] | null>(null);
const variableMissingValue = ref<number | null>(null);
const variableFillValue = ref<number | null>(null);
const timeInfo = ref<{
  units: string;
  calendar: string;
  firstTimestamp: string;
  lastTimestamp: string;
  timestep: string | null;
  numTimesteps: number;
} | null>(null);
const error = ref<string | null>(null);

const activeGridType = computed(() => {
  if (!props.gridType) {
    return undefined;
  }
  return paramGridType.value || props.gridType;
});

const availableGridTypes = computed(() => {
  if (!props.gridType) {
    return [];
  }
  const overrides = GRID_TYPE_DISPLAY_OVERRIDES[props.gridType];
  if (!overrides || overrides.length === 0) {
    return [props.gridType];
  }
  return [props.gridType, ...overrides];
});

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

const allVariables = computed(() => {
  if (!props.datasources) {
    return [];
  }
  return Object.entries(props.datasources.levels[0].datasources).map(
    ([name, source]) => ({ name, hidden: source.hidden ?? false })
  );
});

const availableVariables = computed(() =>
  allVariables.value.filter((v) => !v.hidden)
);

const hiddenVariables = computed(() =>
  allVariables.value.filter((v) => v.hidden)
);

function selectVariable(varName: string) {
  varnameSelector.value = varName;
}

const zarrFormat = computed(() => {
  if (!props.datasources) {
    return null;
  }
  return props.datasources.zarr_format;
});

function getDtypeBytes(dtype: string): number {
  if (dtype.includes("64")) {
    return 8;
  }
  if (dtype.includes("32")) {
    return 4;
  }
  if (dtype.includes("16")) {
    return 2;
  }
  if (dtype.includes("8")) {
    return 1;
  }
  return 4;
}

const estimatedSizeMB = computed(() => {
  if (!dimensions.value.length || !variableDtype.value) {
    return null;
  }
  const totalElements = dimensions.value.reduce((acc, d) => acc * d.size, 1);
  const bytes = totalElements * getDtypeBytes(String(variableDtype.value));
  if (!Number.isFinite(bytes)) {
    return null;
  }
  if (bytes >= 1024 * 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2) + " TB";
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }
  return (bytes / 1024).toFixed(2) + " KB";
});

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

async function getTimeDimensionInfo() {
  if (!props.datasources) {
    return;
  }

  const arrayDims = await ZarrDataManager.getDimensionNames(
    props.datasources,
    varnameSelector.value || ""
  );
  if (!arrayDims) {
    return;
  }

  // Find a time-like dimension
  const timeDimNames = [
    "time",
    "t",
    "datetime",
    "date",
    "valid_time",
    "init_time",
  ];
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

function collectGeoCoordinateInfo(
  coordinateRef: Ref<{ name: string; size: number }[]>,
  dimensionNames: string[],
  shape: number[]
) {
  coordinateRef.value = [];
  for (let i = 0; i < dimensionNames.length; i++) {
    const dimName = dimensionNames[i];
    const dimSize = shape[i];
    coordinateRef.value.push({ name: dimName, size: dimSize });
  }
}

function processLonData(
  longitudes: zarr.Chunk<zarr.DataType>,
  longitudesAttrs: zarr.Attributes | null
) {
  const lonData = longitudes.data as Float64Array | Float32Array;
  lonSlice.value = {
    first10: Array.from(lonData.subarray(0, Math.min(10, lonData.length))),
    last10: Array.from(lonData.subarray(Math.max(0, lonData.length - 10))),
  };
  let loMin = Infinity,
    loMax = -Infinity;
  for (const v of lonData) {
    if (v < loMin) {
      loMin = v;
    }
    if (v > loMax) {
      loMax = v;
    }
  }
  lonMin.value = loMin;
  lonMax.value = loMax;
  collectGeoCoordinateInfo(
    lonDimensions,
    longitudesAttrs?._ARRAY_DIMENSIONS as string[],
    longitudes.shape
  );
  lonLength.value = lonData.length;
}

async function getLatLonInfo(
  variable: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  if (
    props.gridType === GRID_TYPES.TRIANGULAR ||
    props.gridType === GRID_TYPES.HEALPIX
  ) {
    return;
  }

  try {
    const { latitudes, latitudesAttrs, longitudes, longitudesAttrs } =
      await getLatLonData(
        variable,
        props.datasources,
        props.gridType === GRID_TYPES.REGULAR_ROTATED
      );

    const latData = latitudes.data as Float64Array | Float32Array;
    latSlice.value = {
      first10: Array.from(latData.subarray(0, Math.min(10, latData.length))),
      last10: Array.from(latData.subarray(Math.max(0, latData.length - 10))),
    };
    let lMin = Infinity,
      lMax = -Infinity;
    for (const v of latData) {
      if (v < lMin) {
        lMin = v;
      }
      if (v > lMax) {
        lMax = v;
      }
    }
    latMin.value = lMin;
    latMax.value = lMax;
    collectGeoCoordinateInfo(
      latDimensions,
      latitudesAttrs?._ARRAY_DIMENSIONS as string[],
      latitudes.shape
    );
    latLength.value = latData.length;

    if (longitudes) {
      processLonData(longitudes, longitudesAttrs);
    }
  } catch (err) {
    logError(err);
  }
}

async function loadVariableDetails(
  variable: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  variableAttrs.value = variable.attrs;
  variableUnits.value = (variable.attrs?.units as string) || null;
  variableStandardName.value =
    (variable.attrs?.standard_name as string) || null;
  if (variableStandardName.value) {
    nercInfo.value = await queryVariable(variableStandardName.value);
  }
  variableLongName.value =
    (variable.attrs?.long_name as string) ||
    (variable.attrs?.name as string) ||
    null;
  variableDtype.value = String(variable.dtype);
  variableChunks.value = variable.chunks;
  const missingVal = getMissingValue(variable);
  variableMissingValue.value = Number.isNaN(missingVal) ? null : missingVal;
  const fillVal = getFillValue(variable);
  variableFillValue.value = Number.isNaN(fillVal) ? null : fillVal;

  const arrayDims = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value || ""
  );
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
}

async function fetchInfo() {
  if (
    !props.datasources ||
    !varnameSelector.value ||
    varnameSelector.value === "-"
  ) {
    return;
  }
  error.value = null;
  variableDtype.value = null;
  variableChunks.value = null;
  variableMissingValue.value = null;
  variableFillValue.value = null;
  nercInfo.value = null;
  latSlice.value = null;
  latDimensions.value = [];
  latLength.value = null;
  latMin.value = null;
  latMax.value = null;
  lonSlice.value = null;
  lonDimensions.value = [];
  lonLength.value = null;
  lonMin.value = null;
  lonMax.value = null;

  try {
    const varSource =
      props.datasources.levels[0].datasources[varnameSelector.value];
    const group = await ZarrDataManager.getDatasetGroup(varSource);
    groupAttrs.value = group.attrs;
    const variable = await ZarrDataManager.getVariableInfo(
      varSource,
      varnameSelector.value
    );
    await loadVariableDetails(variable);
    await getLatLonInfo(variable);
    await getTimeDimensionInfo();
  } catch (err) {
    logError(err);
  }
}

watch(
  () => [props.datasources, varnameSelector.value, props.isOpen],
  () => {
    if (props.isOpen) {
      fetchInfo();
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
          <span class="is-flex is-align-items-center gap-2">
            Grid Type
            <span
              v-if="zarrFormat"
              class="tag is-light is-small ml-2 is-family-monospace"
              >zarr v{{ zarrFormat }}</span
            >
          </span>
          <div v-if="availableGridTypes.length > 1" class="select is-small">
            <select
              :value="activeGridType"
              class="grid-type-select"
              @change="
                emit(
                  'selectGridType',
                  ($event.target as HTMLSelectElement).value as T_GRID_TYPES
                )
              "
            >
              <option
                v-for="typeOption in availableGridTypes"
                :key="typeOption"
                :value="typeOption"
              >
                {{ typeOption }}
              </option>
            </select>
          </div>
          <button
            v-else
            type="button"
            class="button is-small is-light grid-type-button"
            disabled
          >
            {{ activeGridType ?? "Unknown" }}
          </button>
        </h4>
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
                  <div
                    class="is-flex is-align-items-baseline is-justify-content-space-between"
                    style="gap: 0.25rem"
                  >
                    <span
                      v-if="variableStandardName"
                      style="word-break: break-all; min-width: 0"
                    >
                      <a
                        v-if="nercInfo"
                        :href="nercInfo.variable.Url.value"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <code>{{ variableStandardName }}</code>
                      </a>
                      <code v-else>{{ variableStandardName }}</code>
                    </span>
                    <span v-else class="has-text-grey-light">-</span>
                    <span
                      v-if="nercInfo"
                      class="tag is-success is-light is-size-7 is-flex-shrink-0"
                      title="Recognised CF standard name"
                      >CF</span
                    >
                  </div>
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

        <!-- NERC vocabulary info -->
        <details v-if="nercInfo" class="is-size-7 mt-2">
          <summary class="has-text-grey coord-details-summary">
            CF standard name info (NERC)
            <span
              v-if="nercInfo.variable.Deprecated.value === 'true'"
              class="tag is-danger is-light is-size-7 ml-1"
              >DEPRECATED</span
            >
          </summary>
          <div class="mt-2">
            <div v-if="nercInfo.variable.Definition?.value" class="mb-2">
              <CollapsibleText :text="nercInfo.variable.Definition.value" />
            </div>
            <table
              v-if="
                nercInfo.replacedBy.length ||
                nercInfo.replaces.length ||
                nercInfo.alternatives.length
              "
              class="table is-narrow is-fullwidth is-size-7"
            >
              <tbody>
                <tr v-if="nercInfo.replacedBy.length">
                  <td><strong>Replaced by</strong></td>
                  <td>
                    <span
                      v-for="v in nercInfo.replacedBy"
                      :key="v.Url.value"
                      class="mr-2"
                    >
                      <a
                        :href="v.Url.value"
                        target="_blank"
                        rel="noopener noreferrer"
                        >{{ v.PrefLabel.value }}</a
                      >
                    </span>
                  </td>
                </tr>
                <tr v-if="nercInfo.replaces.length">
                  <td><strong>Replaces</strong></td>
                  <td>
                    <span
                      v-for="v in nercInfo.replaces"
                      :key="v.Url.value"
                      class="mr-2"
                    >
                      <a
                        :href="v.Url.value"
                        target="_blank"
                        rel="noopener noreferrer"
                        >{{ v.PrefLabel.value }}</a
                      >
                    </span>
                  </td>
                </tr>
                <tr v-if="nercInfo.alternatives.length">
                  <td><strong>Alternatives</strong></td>
                  <td>
                    <span
                      v-for="v in nercInfo.alternatives"
                      :key="v.Url.value"
                      class="mr-2"
                    >
                      <a
                        :href="v.Url.value"
                        target="_blank"
                        rel="noopener noreferrer"
                        >{{ v.PrefLabel.value }}</a
                      >
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="is-size-7 is-italic has-text-grey-light">
              Variable information provided by The NERC Vocabulary Server (NVS),
              National Oceanography Centre – BODC,
              <a
                href="https://vocab.nerc.ac.uk"
                target="_blank"
                rel="noopener noreferrer"
                >vocab.nerc.ac.uk</a
              >
            </p>
          </div>
        </details>
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
                  <CollapsibleText :text="datasetLicense" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <!-- Data Type & Storage -->
      <section v-if="variableDtype" class="info-section">
        <h4 class="title is-6">Data Type &amp; Storage</h4>
        <div class="content">
          <table class="table is-narrow is-fullwidth is-size-7">
            <tbody>
              <tr>
                <td><strong>Data type</strong></td>
                <td>
                  <code>{{ variableDtype }}</code>
                </td>
              </tr>
              <tr v-if="variableChunks && variableChunks.length > 0">
                <td><strong>Chunk shape</strong></td>
                <td>
                  <code>{{ variableChunks.join(" × ") }}</code>
                </td>
              </tr>
              <tr v-if="variableMissingValue !== null">
                <td><strong>Missing value</strong></td>
                <td>
                  <code>{{ variableMissingValue }}</code>
                </td>
              </tr>
              <tr v-if="variableFillValue !== null">
                <td><strong>Fill value</strong></td>
                <td>
                  <code>{{ variableFillValue }}</code>
                </td>
              </tr>
              <tr v-if="estimatedSizeMB">
                <td>
                  <strong>Estimated size</strong>
                  <span class="ml-1 has-text-grey is-size-7"
                    >(uncompressed)</span
                  >
                </td>
                <td>{{ estimatedSizeMB }}</td>
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
                <td>{{ dim.size.toLocaleString() }}</td>
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
                <td>{{ timeInfo.numTimesteps.toLocaleString() }}</td>
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

      <!-- Spatial Coverage -->
      <section v-if="hasLatLon" class="info-section">
        <h4 class="title is-6">Spatial Coverage</h4>

        <!-- Latitude -->
        <div v-if="latSlice" class="mb-4">
          <p class="is-size-7 has-text-weight-semibold mb-2">
            Latitude
            <span class="has-text-grey-light has-text-weight-normal"
              >({{ latLength?.toLocaleString() }} values)</span
            >
          </p>
          <div class="mb-2">
            <code> min {{ formatValue(latMin ?? 0) }} </code>
            →
            <code> max {{ formatValue(latMax ?? 0) }} </code>
          </div>
          <div v-if="latDimensions && latDimensions.length > 0" class="content">
            <table class="table is-narrow is-fullwidth is-size-7">
              <thead>
                <tr>
                  <th>Dimension</th>
                  <th>Shape</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="dim in latDimensions" :key="dim.name">
                  <td>
                    <code>{{ dim.name }}</code>
                  </td>
                  <td>{{ dim.size.toLocaleString() }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <details class="is-size-7">
            <summary class="has-text-grey coord-details-summary">
              Raw sample values
            </summary>
            <p class="has-text-weight-semibold mt-2 mb-1">First 10:</p>
            <div class="tags">
              <span
                v-for="(val, i) in latSlice.first10"
                :key="'lat-f-' + i"
                class="tag is-info is-light is-family-monospace"
                >{{ formatValue(val) }}</span
              >
            </div>
            <p class="has-text-weight-semibold mt-2 mb-1">Last 10:</p>
            <div class="tags">
              <span
                v-for="(val, i) in latSlice.last10"
                :key="'lat-l-' + i"
                class="tag is-info is-light is-family-monospace"
                >{{ formatValue(val) }}</span
              >
            </div>
          </details>
        </div>

        <!-- Longitude -->
        <div v-if="lonSlice">
          <p class="is-size-7 has-text-weight-semibold mb-2">
            Longitude
            <span class="has-text-grey-light has-text-weight-normal"
              >({{ lonLength?.toLocaleString() }} values)</span
            >
          </p>
          <div class="mb-2">
            <code> min {{ formatValue(lonMin ?? 0) }} </code>
            →
            <code> max {{ formatValue(lonMax ?? 0) }} </code>
          </div>
          <div v-if="lonDimensions && lonDimensions.length > 0" class="content">
            <table class="table is-narrow is-fullwidth is-size-7">
              <thead>
                <tr>
                  <th>Dimension</th>
                  <th>Shape</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="dim in lonDimensions" :key="dim.name">
                  <td>
                    <code>{{ dim.name }}</code>
                  </td>
                  <td>{{ dim.size.toLocaleString() }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <details class="is-size-7">
            <summary class="has-text-grey coord-details-summary">
              Raw sample values
            </summary>
            <p class="has-text-weight-semibold mt-2 mb-1">First 10:</p>
            <div class="tags">
              <span
                v-for="(val, i) in lonSlice.first10"
                :key="'lon-f-' + i"
                class="tag is-warning is-light is-family-monospace"
                >{{ formatValue(val) }}</span
              >
            </div>
            <p class="has-text-weight-semibold mt-2 mb-1">Last 10:</p>
            <div class="tags">
              <span
                v-for="(val, i) in lonSlice.last10"
                :key="'lon-l-' + i"
                class="tag is-warning is-light is-family-monospace"
                >{{ formatValue(val) }}</span
              >
            </div>
          </details>
        </div>
      </section>

      <!-- No Lat/Lon Notice -->
      <div v-if="!hasLatLon" class="info-section">
        <div class="notification is-info is-light is-size-7">
          <strong>Note:</strong> No lat/lon coordinates found for this grid
          type.
        </div>
      </div>

      <!-- Available Variables -->
      <section v-if="allVariables.length > 0" class="info-section">
        <h4 class="title is-6">
          Available Variables
          <span
            class="has-text-grey-light is-size-7 has-text-weight-normal ml-1"
            >({{ availableVariables.length }})</span
          >
        </h4>
        <div class="tags">
          <button
            v-for="v in availableVariables"
            :key="v.name"
            class="tag is-family-monospace is-clickable"
            :class="v.name === varnameSelector ? 'is-info' : 'is-light'"
            :title="'Select ' + v.name"
            type="button"
            @click="selectVariable(v.name)"
          >
            {{ v.name }}
          </button>
        </div>
        <div v-if="hiddenVariables.length > 0" class="mt-2">
          <p class="is-size-7 has-text-grey mb-1">
            Dimensions &amp; coordinates
            <span class="has-text-grey-light"
              >({{ hiddenVariables.length }})</span
            >
          </p>
          <div class="tags">
            <span
              v-for="v in hiddenVariables"
              :key="v.name"
              class="tag is-family-monospace is-light has-text-grey-light"
              title="This is a dimension or coordinate variable and cannot be selected"
              style="cursor: not-allowed; opacity: 0.6"
              >{{ v.name }}</span
            >
          </div>
        </div>
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
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use "bulma/sass/utilities" as bulmaUt;

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

.grid-type-select {
  background-color: var(--bulma-light);
  color: var(--bulma-code);
  font-family: var(--bulma-family-code);
  border: 1px solid var(--bulma-border);
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    border-color: var(--bulma-link);
  }
}

.grid-type-button {
  color: var(--bulma-code);
  font-family: var(--bulma-family-code);
  cursor: not-allowed;
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

details {
  cursor: pointer;
}
</style>
