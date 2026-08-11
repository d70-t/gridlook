<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, onBeforeUnmount, ref, watch } from "vue";

import DatetimePicker from "./DatetimePicker.vue";
import { useTimeAnimation } from "./useTimeAnimation.ts";

import { verticalCoordinateScore } from "@/lib/data/dimensionData.ts";
import { decodeTime, isTimeUnits } from "@/lib/data/timeHandling.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const store = useGlobeControlStore();
const {
  varinfo,
  dimSlidersValues,
  live,
  livePaused,
  liveConnected,
  streamlineLevelIndex,
  streamlineLevelInfo,
  streamlineMagnitudeDisplayed,
} = storeToRefs(store);

const { isPlaying, canAnimate, toggle, cycleSpeed, speedLabel } =
  useTimeAnimation();

// Local slider state with debounced store updates.
const localSliders = ref<(number | null)[]>([]);
const localDisplayedMagnitudeLevel = ref(streamlineLevelIndex.value);
const MAGNITUDE_LEVEL_UPDATE = "magnitude-level";
const pendingUpdates = new Map<
  number | typeof MAGNITUDE_LEVEL_UPDATE,
  ReturnType<typeof setTimeout>
>();

function cancelPendingUpdate(key: number | typeof MAGNITUDE_LEVEL_UPDATE) {
  const pendingUpdate = pendingUpdates.get(key);
  if (pendingUpdate !== undefined) {
    clearTimeout(pendingUpdate);
    pendingUpdates.delete(key);
  }
}

function scheduleUpdate(
  key: number | typeof MAGNITUDE_LEVEL_UPDATE,
  update: () => void
) {
  cancelPendingUpdate(key);
  pendingUpdates.set(
    key,
    setTimeout(() => {
      pendingUpdates.delete(key);
      update();
    }, 550)
  );
}

function cancelAllPendingUpdates() {
  for (const key of [...pendingUpdates.keys()]) {
    cancelPendingUpdate(key);
  }
}
function getTimeUnits(index: number): string | undefined {
  const dimInfo = varinfo.value?.dimInfo[index];
  return dimInfo && "attrs" in dimInfo && isTimeUnits(dimInfo.attrs.units)
    ? dimInfo.attrs.units
    : undefined;
}

function isTimeDimension(index: number): boolean {
  return getTimeUnits(index) !== undefined;
}

const displayedMagnitudeLevelInfo = computed(() =>
  streamlineMagnitudeDisplayed.value ? streamlineLevelInfo.value : undefined
);

function scalarVerticalDimensionScore(index: number) {
  const range = varinfo.value?.dimRanges[index];
  const info = varinfo.value?.dimInfo[index];
  if (!range || !info || !("attrs" in info) || isTimeDimension(index)) {
    return -1;
  }
  return verticalCoordinateScore(range.name, info.attrs);
}

// A derived magnitude belongs to the vector components, not to the scalar
// variable that happened to be selected before it. Replace that scalar's
// vertical control with the vector level control while the magnitude is shown.
const replacedScalarLevelIndex = computed(() => {
  const levelInfo = displayedMagnitudeLevelInfo.value;
  if (!streamlineMagnitudeDisplayed.value || !varinfo.value) {
    return -1;
  }
  if (levelInfo) {
    const exactIndex = varinfo.value.dimRanges.findIndex(
      (range) => range?.name === levelInfo.dimensionName
    );
    if (exactIndex !== -1) {
      return exactIndex;
    }
  }
  const candidates = varinfo.value.dimRanges
    .map((range, index) => ({
      range,
      index,
      score: scalarVerticalDimensionScore(index),
    }))
    .filter(({ range, score }) => range !== null && score >= 0)
    .sort((a, b) => b.score - a.score);
  if (candidates[0]?.score && candidates[0].score > 0) {
    return candidates[0].index;
  }
  return candidates.length === 1 ? candidates[0].index : -1;
});

function displayedMagnitudeLevelName() {
  return displayedMagnitudeLevelInfo.value?.dimensionName ?? "Level";
}

function displayedMagnitudeLevelValue() {
  return (
    displayedMagnitudeLevelInfo.value?.values[
      localDisplayedMagnitudeLevel.value
    ] ?? "-"
  );
}

const hasValidDimensions = computed(() => {
  return (
    varinfo.value &&
    (Boolean(displayedMagnitudeLevelInfo.value) ||
      varinfo.value.dimRanges.some(
        (range, index) =>
          index !== replacedScalarLevelIndex.value &&
          range &&
          (range.maxBound > 0 || isTimeDimension(index))
      ))
  );
});

// Watch for changes in varinfo to update local state
watch(
  () => varinfo.value,
  () => {
    const newRanges = varinfo.value?.dimRanges;
    if (newRanges) {
      cancelAllPendingUpdates();

      // Initialize local sliders from the active dimension indices.
      localSliders.value = newRanges.map(
        (range, index) =>
          dimSlidersValues.value[index] ?? range?.startPos ?? null
      );
    }
  },
  { immediate: true }
);

// Keep the controls aligned when another UI element (for example the coupled
// streamline level selector) changes a dimension directly in the store.
watch(
  () => [...dimSlidersValues.value],
  (values) => {
    values.forEach((value, index) => {
      if (localSliders.value[index] !== value) {
        cancelPendingUpdate(index);
        localSliders.value[index] = value;
      }
    });
  }
);

// Watch for local changes and update store with debouncing
watch(
  localSliders,
  (newValues) => {
    newValues.forEach((value, index) => {
      if (
        value !== null &&
        value !== undefined &&
        value !== dimSlidersValues.value[index]
      ) {
        scheduleUpdate(index, () => {
          if (dimSlidersValues.value[index] !== undefined) {
            dimSlidersValues.value[index] = value;
          }
        });
      }
    });
  },
  { deep: true }
);

watch(
  streamlineLevelIndex,
  (index) => {
    cancelPendingUpdate(MAGNITUDE_LEVEL_UPDATE);
    localDisplayedMagnitudeLevel.value = index;
  },
  { immediate: true }
);

watch(localDisplayedMagnitudeLevel, (index) => {
  if (index === streamlineLevelIndex.value) {
    return;
  }
  scheduleUpdate(MAGNITUDE_LEVEL_UPDATE, () => {
    store.setStreamlineLevelIndex(index);
  });
});

onBeforeUnmount(() => {
  cancelAllPendingUpdates();
});

// Handler for datetime picker
function onDatetimeIndexUpdate(dimensionIndex: number, index: number) {
  localSliders.value[dimensionIndex] = index;
  dimSlidersValues.value[dimensionIndex] = index;
}

function formatCurrentValue(index: number) {
  const dimInfo = varinfo.value?.dimInfo[index];
  if (!dimInfo || !("current" in dimInfo)) {
    return "-";
  }
  const selectedIndex =
    localSliders.value[index] ?? dimSlidersValues.value[index];
  const current =
    typeof selectedIndex === "number" &&
    selectedIndex >= 0 &&
    selectedIndex < dimInfo.values.length
      ? dimInfo.values[selectedIndex]
      : dimInfo.current;
  if (!isTimeDimension(index)) {
    return current;
  }
  if (typeof current === "object") {
    return current.format();
  }
  const numericCurrent = Number(current);
  return Number.isFinite(numericCurrent)
    ? decodeTime(numericCurrent, dimInfo.attrs).format()
    : "-";
}

function capitalize(str: string): string {
  return String(str[0]).toUpperCase() + String(str).slice(1);
}

// While live-following, the time dimension is driven by polling and must not be
// scrubbed manually (only the current timestep is available).
function isLiveTime(index: number): boolean {
  return live.value && isTimeDimension(index);
}
</script>

<template>
  <div v-if="varinfo && hasValidDimensions" class="section-title">
    Dimensions
  </div>
  <div
    v-if="varinfo && hasValidDimensions"
    class="column is-flex-direction-column"
    style="gap: 1.5em"
  >
    <template v-for="(range, index) in varinfo!.dimRanges" :key="index">
      <div
        v-if="
          index !== replacedScalarLevelIndex &&
          range &&
          (range.maxBound > 0 || isTimeDimension(index))
        "
        class="control"
        :class="{ 'mb-4': index + 1 < varinfo.dimInfo.length }"
      >
        <!-- Generic dimension sliders -->
        <div
          v-if="range"
          class="mb-2 w-100 is-flex is-justify-content-space-between"
        >
          <div class="is-flex is-align-items-center" style="gap: 0.5rem">
            {{ capitalize(range.name) }}:
            <DatetimePicker
              v-if="isTimeDimension(index) && !isLiveTime(index)"
              :time-values="varinfo.dimInfo[index]?.values ?? []"
              :time-attrs="varinfo.dimInfo[index]?.attrs ?? {}"
              :current-index="localSliders[index] ?? 0"
              :min-index="range?.minBound ?? 0"
              :max-index="range?.maxBound ?? 0"
              @update:index="onDatetimeIndexUpdate(index, $event)"
            />
          </div>
          <div class="is-flex">
            <input
              v-model.number="localSliders[index]"
              class="input"
              type="number"
              :min="range.minBound"
              :max="range.maxBound"
              :disabled="isLiveTime(index)"
              style="width: 8em"
            />
            <div class="my-2 ml-2">/ {{ range.maxBound }}</div>
          </div>
        </div>

        <input
          v-model.number="localSliders[index]"
          class="w-100"
          type="range"
          :min="range.minBound"
          :max="range.maxBound"
          :disabled="isLiveTime(index)"
        />

        <!-- Live-follow controls (replace playback controls for live datasets) -->
        <div
          v-if="isLiveTime(index)"
          class="is-flex is-align-items-center mt-2"
          style="gap: 0.5rem"
        >
          <span class="tag is-danger">
            <span class="icon is-small">
              <i class="fas fa-circle"></i>
            </span>
            <span>LIVE</span>
          </span>
          <button
            class="button is-small"
            :class="{ 'is-info': livePaused }"
            type="button"
            :title="livePaused ? 'Resume live updates' : 'Pause live updates'"
            @click="store.toggleLivePaused()"
          >
            <span class="icon">
              <i :class="livePaused ? 'fas fa-play' : 'fas fa-pause'"></i>
            </span>
          </button>
          <span v-if="livePaused" class="is-size-7 has-text-grey">Paused</span>
          <span v-else-if="!liveConnected" class="is-size-7 has-text-grey">
            Reconnecting…
          </span>
        </div>

        <div
          v-if="isTimeDimension(index) && canAnimate && !isLiveTime(index)"
          class="is-flex is-align-items-center mt-2"
          style="gap: 0.5rem"
        >
          <button
            class="button is-small"
            :class="{ 'is-info': isPlaying }"
            type="button"
            :title="
              isPlaying ? 'Pause animation (Space)' : 'Play animation (Space)'
            "
            @click="toggle"
          >
            <span class="icon">
              <i :class="isPlaying ? 'fas fa-pause' : 'fas fa-play'"></i>
            </span>
          </button>
          <button
            class="button is-small"
            type="button"
            title="Playback speed"
            @click="cycleSpeed"
          >
            {{ speedLabel }}
          </button>
        </div>

        <div class="w-100 is-flex is-justify-content-space-between">
          <div>Current value</div>
          <div class="has-text-right">
            <span>{{ formatCurrentValue(index) }}</span>
            <br />
          </div>
        </div>
        <div
          v-if="
            varinfo.dimInfo[index]?.longName || varinfo.dimInfo[index]?.units
          "
          class="has-text-right"
        >
          {{ varinfo.dimInfo[index]?.longName ?? "-" }} /
          {{ varinfo.dimInfo[index]?.units ?? "-" }}
        </div>
      </div>
    </template>
    <div v-if="displayedMagnitudeLevelInfo" class="control">
      <div class="mb-2 w-100 is-flex is-justify-content-space-between">
        <div class="is-flex is-align-items-center" style="gap: 0.5rem">
          {{ capitalize(displayedMagnitudeLevelName()) }}:
        </div>
        <div class="is-flex">
          <input
            v-model.number="localDisplayedMagnitudeLevel"
            class="input"
            type="number"
            min="0"
            :max="displayedMagnitudeLevelInfo.values.length - 1"
            style="width: 8em"
          />
          <div class="my-2 ml-2">
            / {{ displayedMagnitudeLevelInfo.values.length - 1 }}
          </div>
        </div>
      </div>

      <input
        v-model.number="localDisplayedMagnitudeLevel"
        class="w-100"
        type="range"
        min="0"
        :max="displayedMagnitudeLevelInfo.values.length - 1"
      />

      <div class="w-100 is-flex is-justify-content-space-between">
        <div>Current value</div>
        <div class="has-text-right">
          <span>{{ displayedMagnitudeLevelValue() }}</span>
          <br />
        </div>
      </div>
      <div
        v-if="
          displayedMagnitudeLevelInfo.longName ||
          displayedMagnitudeLevelInfo.units
        "
        class="has-text-right"
      >
        {{ displayedMagnitudeLevelInfo.longName ?? "-" }} /
        {{ displayedMagnitudeLevelInfo.units ?? "-" }}
      </div>
    </div>
  </div>
  <div v-else></div>
</template>
