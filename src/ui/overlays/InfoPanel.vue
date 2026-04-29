<script lang="ts" setup>
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration.js";
import humanizeDuration from "humanize-duration";
import { storeToRefs } from "pinia";
import { ref, watch, type Ref } from "vue";
import * as zarr from "zarrita";

import AttributesSection from "./infoPanel/AttributesSection.vue";
import AvailableVariablesSection from "./infoPanel/AvailableVariablesSection.vue";
import CurrentVariableSection from "./infoPanel/CurrentVariableSection.vue";
import DatasetMetadataSection from "./infoPanel/DatasetMetadataSection.vue";
import DataStorageSection from "./infoPanel/DataStorageSection.vue";
import DimensionsSection from "./infoPanel/DimensionsSection.vue";
import GridTypeSection from "./infoPanel/GridTypeSection.vue";
import SpatialCoverageSection from "./infoPanel/SpatialCoverageSection.vue";
import TimeDimensionSection from "./infoPanel/TimeDimensionSection.vue";
import type {
  TCoordinateSlice,
  TInfoDimension,
  TTimeInfo,
} from "./infoPanel/types.ts";

import { GRID_TYPES, type T_GRID_TYPES } from "@/lib/data/gridTypeDetector.ts";
import { decodeTime } from "@/lib/data/timeHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  getLatLonData,
  getMissingValue,
  getFillValue,
} from "@/lib/data/zarrUtils.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useLog } from "@/utils/logging.ts";

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
const { varnameSelector, loading } = storeToRefs(store);

const groupAttrs = ref<zarr.Attributes | null>(null);
const dimensions = ref<TInfoDimension[]>([]);

const latSlice = ref<TCoordinateSlice | null>(null);
const latDimensions = ref<TInfoDimension[]>([]);
const latLength = ref<number | null>(null);
const latMin = ref<number | null>(null);
const latMax = ref<number | null>(null);
const lonSlice = ref<TCoordinateSlice | null>(null);
const lonDimensions = ref<TInfoDimension[]>([]);
const lonLength = ref<number | null>(null);
const lonMin = ref<number | null>(null);
const lonMax = ref<number | null>(null);

const variableUnits = ref<string | null>(null);
const variableLongName = ref<string | null>(null);
const variableStandardName = ref<string | null>(null);
const variableDtype = ref<string | null>(null);
const variableChunks = ref<readonly (number | null)[] | null>(null);
const variableMissingValue = ref<number | null>(null);
const variableFillValue = ref<number | null>(null);
const timeInfo = ref<TTimeInfo | null>(null);
const error = ref<string | null>(null);

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
  coordinateRef: Ref<TInfoDimension[]>,
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
    longitudesAttrs?.dimensionNames as string[],
    longitudes.shape
  );
  lonLength.value = lonData.length;
}

async function getLatLonInfo(
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>
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
      latitudesAttrs?.dimensionNames as string[],
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
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  variableUnits.value = (variable.attrs?.units as string) || null;
  variableStandardName.value =
    (variable.attrs?.standard_name as string) || null;
  variableLongName.value = (variable.attrs?.long_name as string) || null;
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
  () => [props.datasources, varnameSelector.value, props.isOpen, loading.value],
  () => {
    if (props.isOpen && !loading.value) {
      fetchInfo();
    }
  },
  { immediate: true }
);
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
      <GridTypeSection
        :grid-type="gridType"
        @select-grid-type="emit('selectGridType', $event)"
      />
      <CurrentVariableSection
        :varname="varnameSelector"
        :variable-long-name="variableLongName"
        :variable-standard-name="variableStandardName"
        :variable-units="variableUnits"
      />
      <DatasetMetadataSection :group-attrs="groupAttrs" />
      <DataStorageSection
        :dimensions="dimensions"
        :variable-dtype="variableDtype"
        :variable-chunks="variableChunks"
        :variable-missing-value="variableMissingValue"
        :variable-fill-value="variableFillValue"
        :zarr-format="datasources?.zarr_format ?? null"
      />
      <DimensionsSection :dimensions="dimensions" />
      <TimeDimensionSection :time-info="timeInfo" />
      <SpatialCoverageSection
        :lat-slice="latSlice"
        :lat-dimensions="latDimensions"
        :lat-length="latLength"
        :lat-min="latMin"
        :lat-max="latMax"
        :lon-slice="lonSlice"
        :lon-dimensions="lonDimensions"
        :lon-length="lonLength"
        :lon-min="lonMin"
        :lon-max="lonMax"
      />
      <AvailableVariablesSection
        :datasources="datasources"
        :varname="varnameSelector"
      />
      <AttributesSection
        title="Group Attributes"
        :attrs="groupAttrs"
        empty-label="No group attributes"
      />
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
    padding-bottom: calc(8rem + env(safe-area-inset-bottom, 0px));
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
</style>
