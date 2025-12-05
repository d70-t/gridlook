<script lang="ts" setup>
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useGlobeControlStore } from "../store/store.ts";
import debounce from "lodash.debounce";

const store = useGlobeControlStore();
const { varinfo, dimSlidersValues, dimSlidersDisplay } = storeToRefs(store);

// Local copy for debounced updates
const localTimeValue = ref<number | null>(null);
const debouncedTimeUpdater = ref<((value: number) => void) | null>(null);

const timeRange = computed(() => {
  return varinfo.value?.dimRanges.find((range) => range?.name === "time");
});

const timeRangeIndex = computed(() => {
  return (
    varinfo.value?.dimRanges.findIndex((range) => range?.name === "time") ?? -1
  );
});

const isTimeSlider = computed(() => {
  return timeRange.value?.name === "time";
});

const currentTimeValue = computed(() => {
  return varinfo.value?.timeinfo?.current;
});

const currentVarName = computed(() => {
  return store.varnameDisplay ?? "-";
});

const currentVarLongname = computed(() => {
  return varinfo.value?.attrs?.long_name ?? "-";
});

const currentVarUnits = computed(() => {
  return varinfo.value?.attrs?.units ?? "-";
});

// Watch for changes in varinfo to update local state
watch(
  () => varinfo.value,
  () => {
    if (timeRange.value) {
      localTimeValue.value =
        dimSlidersValues.value[timeRangeIndex.value] ??
        timeRange.value.startPos ??
        null;

      // Create debounced updater
      debouncedTimeUpdater.value = debounce((value: number) => {
        if (
          timeRangeIndex.value !== -1 &&
          dimSlidersValues.value[timeRangeIndex.value] !== undefined
        ) {
          dimSlidersValues.value[timeRangeIndex.value] = value;
        }
      }, 550);
    }
  },
  { immediate: true }
);

// Watch for local changes and update store with debouncing
watch(localTimeValue, (newValue) => {
  if (
    newValue !== null &&
    newValue !== undefined &&
    timeRangeIndex.value !== -1 &&
    newValue !== dimSlidersValues.value[timeRangeIndex.value] &&
    debouncedTimeUpdater.value
  ) {
    debouncedTimeUpdater.value(newValue);
  }
});
</script>

<template>
  <div class="panel-block">
    <div class="control">
      <div class="mb-2 w-100 is-flex is-justify-content-space-between">
        <div class="my-2">Time:</div>
        <div class="is-flex">
          <input
            v-model.number="localTimeValue"
            :disabled="!isTimeSlider"
            class="input"
            type="number"
            :min="timeRange?.minBound ?? 0"
            :max="timeRange?.maxBound ?? 0"
            style="width: 8em"
          />
          <div class="my-2">/ {{ timeRange?.maxBound ?? "-" }}</div>
        </div>
      </div>
      <input
        v-model.number="localTimeValue"
        class="w-100"
        type="range"
        :disabled="!isTimeSlider"
        :min="timeRange?.minBound ?? 0"
        :max="timeRange?.maxBound ?? 0"
      />
      <div class="w-100 is-flex is-justify-content-space-between">
        <div>
          Currently shown:<span
            :class="{ loader: store.loading === true }"
          ></span>
        </div>
        <div class="has-text-right">
          {{ currentVarName }} @
          {{ timeRangeIndex !== -1 ? dimSlidersDisplay[timeRangeIndex] : "-" }}
          <br />
          <span v-if="currentTimeValue">
            {{ isTimeSlider ? currentTimeValue.format() : "-" }}
          </span>
          <br />
        </div>
      </div>
      <div class="has-text-right">
        {{ currentVarLongname }} / {{ currentVarUnits }}
      </div>
    </div>
  </div>
</template>
