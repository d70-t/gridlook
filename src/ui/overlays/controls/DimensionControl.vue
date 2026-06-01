<script lang="ts" setup>
import { useDebounceFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import DatetimePicker from "./DatetimePicker.vue";
import { useTimeAnimation } from "./useTimeAnimation.ts";

import { decodeTime, isTimeUnits } from "@/lib/data/timeHandling.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const store = useGlobeControlStore();
const { varinfo, dimSlidersValues } = storeToRefs(store);

const { isPlaying, canAnimate, toggle, cycleSpeed, speedLabel } =
  useTimeAnimation();

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
    return dimInfo.current.format();
  }
  const current = Number(dimInfo.current);
  return Number.isFinite(current)
    ? decodeTime(current, dimInfo.attrs).format()
    : "-";
}

function capitalize(str: string): string {
  return String(str[0]).toUpperCase() + String(str).slice(1);
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
              v-if="isTimeDimension(index)"
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
        />

        <div
          v-if="isTimeDimension(index) && canAnimate"
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
  </div>
  <div v-else></div>
</template>
