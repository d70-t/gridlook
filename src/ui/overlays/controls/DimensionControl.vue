<script lang="ts" setup>
import { useDebounceFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onUnmounted, reactive, ref, watch } from "vue";

import DatetimePicker from "./DatetimePicker.vue";
import { stopAnimation, useDimensionAnimation } from "./useTimeAnimation.ts";

import { decodeTime, isTimeUnits } from "@/lib/data/timeHandling.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const store = useGlobeControlStore();
const { varinfo, dimSlidersValues, live, livePaused, liveConnected } =
  storeToRefs(store);

// Local copies for debounced updates (excluding time dimension)
const localSliders = ref<(number | null)[]>([]);
const debouncedUpdaters = ref<Array<(value: number) => void>>([]);

function getTimeUnits(index: number): string | undefined {
  const dimInfo = varinfo.value?.dimInfo[index];
  return dimInfo && "attrs" in dimInfo && isTimeUnits(dimInfo.attrs.units)
    ? dimInfo.attrs.units
    : undefined;
}

function isTimeDimension(index: number): boolean {
  return getTimeUnits(index) !== undefined;
}

function isSingleTimeStep(index: number): boolean {
  const range = varinfo.value?.dimRanges[index];
  return isTimeDimension(index) && !!range && range.maxBound <= range.minBound;
}

// One playback controller per dimension, rebuilt whenever the dimension
// layout changes (only one dimension can play back at a time; the time
// dimension is additionally paused while live-following).
const dimensionAnimations = computed(() =>
  (varinfo.value?.dimRanges ?? []).map((_, index) =>
    reactive(
      useDimensionAnimation(
        computed(() => index),
        { excludeWhileLive: isTimeDimension(index) }
      )
    )
  )
);

onUnmounted(() => {
  stopAnimation();
});

const hasValidDimensions = computed(() => {
  return (
    varinfo.value &&
    varinfo.value.dimRanges.length > 1 &&
    varinfo.value.dimRanges.some(
      (range, index) => range && (range.maxBound > 0 || isTimeDimension(index))
    )
  );
});

// Watch for changes in varinfo to update local state
watch(
  () => varinfo.value,
  () => {
    const newRanges = varinfo.value?.dimRanges;
    if (newRanges) {
      // Initialize local sliders fordimensions (skip index 0 which is time)
      localSliders.value = newRanges.map(
        (range, index) =>
          dimSlidersValues.value[index] ?? range?.startPos ?? null
      );

      // Create stable debounced functions for dimensions
      debouncedUpdaters.value = newRanges.map((_, index) => {
        return useDebounceFn((value: number) => {
          if (dimSlidersValues.value[index] !== undefined) {
            dimSlidersValues.value[index] = value;
          }
        }, 550);
      });
    }
  },
  { immediate: true }
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
        debouncedUpdaters.value[index](value);
      }
    });
  },
  { deep: true }
);

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
  if (!isTimeDimension(index)) {
    return dimInfo.current;
  }
  if (typeof dimInfo.current === "object") {
    return dimInfo.current.format("DD MMM YYYY • HH:mm:ss");
  }
  const current = Number(dimInfo.current);
  return Number.isFinite(current)
    ? decodeTime(current, dimInfo.attrs).format("DD MMM YYYY • HH:mm:ss")
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
        v-if="range && (range.maxBound > 0 || isTimeDimension(index))"
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
              v-if="
                isTimeDimension(index) &&
                !isLiveTime(index) &&
                !isSingleTimeStep(index)
              "
              :time-values="varinfo.dimInfo[index]?.values ?? []"
              :time-attrs="varinfo.dimInfo[index]?.attrs ?? {}"
              :current-index="localSliders[index] ?? 0"
              :min-index="range?.minBound ?? 0"
              :max-index="range?.maxBound ?? 0"
              @update:index="onDatetimeIndexUpdate(index, $event)"
            />
          </div>
          <div class="is-flex is-align-items-center">
            <span
              v-if="isSingleTimeStep(index)"
              class="is-size-7 has-text-grey"
            >
              Only one time step available
            </span>
            <template v-else>
              <input
                v-model.number="localSliders[index]"
                class="input dim-input index-size"
                type="number"
                :min="range.minBound"
                :max="range.maxBound"
                :disabled="isLiveTime(index)"
                style="width: 8em"
              />
              <div class="my-2 ml-2 index-size is-family-monospace">
                / {{ range.maxBound }}
              </div>
            </template>
          </div>
        </div>
        <div class="w-100 is-flex is-justify-content-space-between">
          <div>Current value</div>
          <div class="has-text-right">
            <span>{{ formatCurrentValue(index) }}</span>
            <br />
          </div>
        </div>

        <input
          v-if="!isSingleTimeStep(index)"
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
          v-if="dimensionAnimations[index]?.canAnimate"
          class="is-flex is-justify-content-space-between is-align-items-center mt-2"
        >
          <span class="is-flex is-align-items-center" style="gap: 0.5rem">
            <button
              class="button is-small"
              :class="{ 'is-info': dimensionAnimations[index].isPlaying }"
              type="button"
              :title="
                (dimensionAnimations[index].isPlaying
                  ? 'Pause animation'
                  : 'Play animation') +
                (isTimeDimension(index) ? ' (Space)' : '')
              "
              @click="dimensionAnimations[index].toggle"
            >
              <span class="icon">
                <i
                  :class="
                    dimensionAnimations[index].isPlaying
                      ? 'fas fa-pause'
                      : 'fas fa-play'
                  "
                ></i>
              </span>
            </button>
            <button
              class="button is-small"
              type="button"
              title="Playback speed"
              @click="dimensionAnimations[index].cycleSpeed"
            >
              {{ dimensionAnimations[index].speedLabel }}
            </button>
          </span>
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
      </div>
    </template>
  </div>
  <div v-else></div>
</template>

<style lang="scss" scoped>
.index-size {
  font-size: 0.72rem;
}
.dim-input {
  width: 100%;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, "SF Mono", monospace;
  padding: 2px 4px;
  line-height: 1.4;
  color: inherit;
  outline: none;
  -moz-appearance: textfield;
  appearance: textfield;
}
</style>
