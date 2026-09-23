<script lang="ts" setup>
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration.js";
import humanizeDuration from "humanize-duration";
import { storeToRefs } from "pinia";
import { computed, ref, watch, type Ref } from "vue";
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
import {
  InfoPanelTab,
  type TCoordinateSlice,
  type TGroupInfo,
  type TInfoDimension,
  type TInfoPanelTab,
  type TTimeInfo,
} from "./infoPanel/types.ts";

import { getLatLonData } from "@/lib/data/coordinateVariables.ts";
import { GRID_TYPES, type T_GRID_TYPES } from "@/lib/data/gridTypeDetector.ts";
import { decodeTime, isTimeCoordinate } from "@/lib/data/timeHandling.ts";
import { getMissingValue, getFillValue } from "@/lib/data/variableDecoding.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import type { TDatasetSource, TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";

const props = defineProps<{
  datasources?: TSources;
  gridType?: T_GRID_TYPES;
  isOpen: boolean;
}>();

const emit = defineEmits<{
  close: [];
  selectGridType: [gridType: T_GRID_TYPES];
}>();

dayjs.extend(duration);

const { logError } = useLog();

const store = useGlobeControlStore();
const { varnameDisplay, varinfo, loading } = storeToRefs(store);
const sourceVariable = computed(
  () => varinfo.value?.derivedFrom?.u ?? varnameDisplay.value
);
const variableUnits = computed(
  () => (varinfo.value?.attrs.units as string) || null
);
const variableLongName = computed(
  () => (varinfo.value?.attrs.long_name as string) || null
);
const variableStandardName = computed(
  () => (varinfo.value?.attrs.standard_name as string) || null
);

const groupAttrs = ref<zarr.Attributes | null>(null);
const groupAttrsChain = ref<TGroupInfo[]>([]);
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

const activeTab = ref<TInfoPanelTab>(InfoPanelTab.OVERVIEW);

const variableDtype = ref<string | null>(null);
const variableChunks = ref<readonly (number | null)[] | null>(null);
const variableMissingValue = ref<number | null>(null);
const variableFillValue = ref<number | null>(null);
const timeInfo = ref<TTimeInfo | null>(null);
const noTimeCoordinate = ref(false);
let infoRequestId = 0;
let infoRefreshPending = true;
const error = ref<string | null>(null);

function isSourceDifferent(source?: TDatasetSource) {
  const current =
    props.datasources?.levels[0]?.datasources[sourceVariable.value ?? ""];
  return (
    variableDtype.value !== null &&
    !!source &&
    !!current &&
    (source.store !== current.store ||
      source.dataset !== current.dataset ||
      source.file !== current.file)
  );
}

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
  timeDimName: string,
  varname: string
) {
  const timeVar = await ZarrDataManager.getVariableInfo(
    varSource,
    ZarrDataManager.resolveVariablePath(varname, timeDimName)
  ).catch((err: unknown) => {
    if (
      (zarr.isZarritaError(err, "NotFoundError") && !err.found) ||
      (err instanceof Error &&
        err.message.startsWith("NetCDF variable not found: "))
    ) {
      return null;
    }
    throw err;
  });
  if (!timeVar) {
    return null;
  }

  const units = (timeVar.attrs?.units as string) || "unknown";
  const calendar = (timeVar.attrs?.calendar as string) || "standard";
  const numTimesteps = timeVar.shape[0];

  // Get time values
  const timeData = await ZarrDataManager.getVariableDataFromArray(timeVar);
  const timeArray = timeData.data as
    Float64Array | Float32Array | BigInt64Array;

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

const timeDimNames = [
  "time",
  "t",
  "datetime",
  "date",
  "valid_time",
  "init_time",
];

async function getTimeDimensionInfo(varname: string, requestId: number) {
  if (!props.datasources) {
    return;
  }

  const arrayDims = await ZarrDataManager.getDimensionNames(
    props.datasources,
    varname
  );
  if (
    !arrayDims ||
    requestId !== infoRequestId ||
    varname !== sourceVariable.value
  ) {
    return;
  }

  const timeDimIndex = arrayDims.findIndex((dim) => {
    const path = ZarrDataManager.resolveVariablePath(varname, dim);
    const attrs = props.datasources?.levels[0].datasources[path]?.attrs ?? {};
    return (
      timeDimNames.includes(dim.toLowerCase()) || isTimeCoordinate(dim, attrs)
    );
  });

  if (timeDimIndex === -1) {
    noTimeCoordinate.value = true;
    timeInfo.value = null;
    return;
  }

  const timeDimName = arrayDims[timeDimIndex];

  try {
    const varSource = props.datasources.levels[0].time;
    const info = varSource
      ? await fetchTimeData(varSource, timeDimName, varname)
      : null;
    if (requestId === infoRequestId && varname === sourceVariable.value) {
      timeInfo.value = info;
      noTimeCoordinate.value = info === null;
    }
  } catch (err) {
    if (requestId === infoRequestId && varname === sourceVariable.value) {
      logError(err, "Error fetching time dimension info");
      timeInfo.value = null;
    }
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

// eslint-disable-next-line max-lines-per-function
async function getLatLonInfo(
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  varname: string,
  requestId: number
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
        varname,
        variable,
        props.datasources,
        props.gridType === GRID_TYPES.REGULAR_ROTATED
      );
    if (requestId !== infoRequestId || varname !== sourceVariable.value) {
      return;
    }

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
  } catch {
    return;
  }
}

async function loadVariableDetails(
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  varname: string,
  requestId: number
) {
  const arrayDims = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varname
  );
  if (requestId !== infoRequestId || varname !== sourceVariable.value) {
    return;
  }
  variableDtype.value = String(variable.dtype);
  variableChunks.value = variable.chunks;
  const missingVal = getMissingValue(variable);
  variableMissingValue.value = Number.isNaN(missingVal) ? null : missingVal;
  const fillVal = getFillValue(variable);
  variableFillValue.value = Number.isNaN(fillVal) ? null : fillVal;

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

/**
 * Fetches attributes for the selected variable's group and every ancestor
 * group above it (root first), since each level can carry its own attrs.
 */
async function loadGroupAttrsChain(
  varSource: TDatasetSource,
  varname: string
): Promise<TGroupInfo[]> {
  const segments = varname.includes("/") ? varname.split("/").slice(0, -1) : [];
  const groupPaths = [
    "",
    ...segments.map((_, i) => segments.slice(0, i + 1).join("/")),
  ];

  const chain: TGroupInfo[] = [];
  for (const groupPath of groupPaths) {
    try {
      const group = await ZarrDataManager.getGroup(varSource, groupPath);
      chain.push({ path: groupPath || "/", attrs: group.attrs });
    } catch {
      // Ignore group issues
    }
  }
  return chain;
}

async function fetchInfo(requestId: number) {
  const varname = sourceVariable.value;
  if (!props.datasources || !varname || varname === "-") {
    return;
  }
  error.value = null;
  variableDtype.value = null;
  variableChunks.value = null;
  variableMissingValue.value = null;
  variableFillValue.value = null;
  dimensions.value = [];
  timeInfo.value = null;
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
  groupAttrsChain.value = [];

  try {
    const varSource = props.datasources.levels[0].datasources[varname];
    const groupChain = await loadGroupAttrsChain(varSource, varname);
    if (requestId !== infoRequestId || varname !== sourceVariable.value) {
      return;
    }
    groupAttrsChain.value = groupChain;
    groupAttrs.value = groupChain[0]?.attrs ?? null;
    const variable = await ZarrDataManager.getVariableInfo(varSource, varname);
    if (requestId !== infoRequestId || varname !== sourceVariable.value) {
      return;
    }
    await Promise.all([
      loadVariableDetails(variable, varname, requestId),
      getLatLonInfo(variable, varname, requestId),
      getTimeDimensionInfo(varname, requestId),
    ]);
  } catch (err) {
    if (requestId === infoRequestId) {
      logError(err);
    }
  }
}

watch(
  [() => props.datasources, sourceVariable, () => props.isOpen, loading],
  (values, previous) => {
    // Frame loading alone does not change dataset metadata.
    if (values.slice(0, 3).some((value, index) => value !== previous[index])) {
      ++infoRequestId;
      infoRefreshPending = true;
      variableDtype.value = null;
      timeInfo.value = null;
      noTimeCoordinate.value = false;
    }
    if (infoRefreshPending && props.isOpen && !loading.value) {
      infoRefreshPending = false;
      fetchInfo(infoRequestId);
    }
  },
  { immediate: true }
);
</script>

<template>
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

    <template v-else>
      <div class="tabs is-fullwidth mb-0 is-flex-shrink-0">
        <ul>
          <li :class="{ 'is-active': activeTab === InfoPanelTab.OVERVIEW }">
            <a href="#" @click.prevent="activeTab = InfoPanelTab.OVERVIEW">
              Overview
            </a>
          </li>
          <li :class="{ 'is-active': activeTab === InfoPanelTab.BROWSE }">
            <a href="#" @click.prevent="activeTab = InfoPanelTab.BROWSE">
              Browse
            </a>
          </li>
        </ul>
      </div>

      <div class="info-panel-content">
        <div v-show="activeTab === InfoPanelTab.OVERVIEW">
          <GridTypeSection
            :grid-type="gridType"
            @select-grid-type="emit('selectGridType', $event)"
          />
          <CurrentVariableSection
            :varname="varnameDisplay"
            :variable-long-name="variableLongName"
            :variable-standard-name="variableStandardName"
            :variable-units="variableUnits"
            :derived-from="varinfo?.derivedFrom"
          />
          <DatasetMetadataSection :group-attrs="groupAttrs" />
          <DataStorageSection
            v-if="!varinfo?.derivedFrom"
            :dimensions="dimensions"
            :variable-dtype="variableDtype"
            :variable-chunks="variableChunks"
            :variable-missing-value="variableMissingValue"
            :variable-fill-value="variableFillValue"
            :zarr-format="datasources?.zarr_format ?? null"
          />
          <DimensionsSection :dimensions="dimensions" />
          <p
            v-if="timeInfo && isSourceDifferent(datasources?.levels[0]?.time)"
            class="is-size-7 has-text-danger mb-2"
          >
            Time variable is from a different file and may not be correctly
            recognized.
          </p>
          <TimeDimensionSection
            :time-info="timeInfo"
            :no-time-coordinate="noTimeCoordinate"
          />
          <p
            v-if="isSourceDifferent(datasources?.levels[0]?.grid)"
            class="is-size-7 has-text-danger mb-2"
          >
            Grid related dimensions are from a different file and may not be
            correctly recognized.
          </p>
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
          <template v-for="group in groupAttrsChain" :key="group.path">
            <AttributesSection
              :title="
                group.path === '/'
                  ? 'Global Attributes'
                  : `Group Attributes (${group.path})`
              "
              :attrs="group.attrs"
              empty-label="No group attributes"
            />
          </template>
        </div>

        <div v-show="activeTab === InfoPanelTab.BROWSE">
          <AvailableVariablesSection :datasources="datasources" />
        </div>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
@use "bulma/sass/utilities" as bulmaUt;

.info-panel {
  position: fixed;
  top: 0;
  right: -500px;
  width: 500px;
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
