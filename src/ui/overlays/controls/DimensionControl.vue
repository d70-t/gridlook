<script lang="ts" setup>
import type { Dayjs } from "dayjs";
import debounce from "lodash.debounce";
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import DatetimePicker from "./DatetimePicker.vue";

import { useGlobeControlStore } from "@/store/store";

const store = useGlobeControlStore();
const { varinfo, dimSlidersValues } = storeToRefs(store);

// Local copies for debounced updates (excluding time dimension)
const localSliders = ref<(number | null)[]>([]);
const debouncedUpdaters = ref<Array<(value: number) => void>>([]);

const timeRangeIndex = computed(() => {
  return (
    varinfo.value?.dimRanges.findIndex((range) => range?.name === "time") ?? -1
  );
});

const hasValidDimensions = computed(() => {
  return (
    varinfo.value &&
    varinfo.value.dimRanges.length > 1 &&
    varinfo.value.dimRanges.some(
      (range) => range && (range.maxBound > 0 || range.name === "time")
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
        return debounce((value: number) => {
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
function onDatetimeIndexUpdate(index: number) {
  if (timeRangeIndex.value !== -1) {
    localSliders.value[timeRangeIndex.value] = index;
    dimSlidersValues.value[timeRangeIndex.value] = index;
  }
}

function capitalize(str: string): string {
  return String(str[0]).toUpperCase() + String(str).slice(1);
}
</script>

<template>
  <div
    v-if="varinfo && hasValidDimensions"
    class="panel-block is-flex-direction-column"
    style="gap: 1.5em"
  >
    <template v-for="(range, index) in varinfo!.dimRanges" :key="index">
      <div
        v-if="range && (range.maxBound > 0 || range.name === 'time')"
        class="control"
      >
        <!-- Generic dimension sliders -->
        <div class="">
          <div
            v-if="range"
            class="mb-2 w-100 is-flex is-justify-content-space-between"
          >
            <div class="is-flex is-align-items-center" style="gap: 0.5rem">
              {{ capitalize(range.name) }}:
              <DatetimePicker
                v-if="range.name === 'time'"
                :time-values="varinfo.dimInfo[index]?.values ?? []"
                :time-attrs="varinfo.dimInfo[index]?.attrs ?? {}"
                :current-index="localSliders[index] ?? 0"
                :min-index="range?.minBound ?? 0"
                :max-index="range?.maxBound ?? 0"
                @update:index="onDatetimeIndexUpdate"
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

          <div class="w-100 is-flex is-justify-content-space-between">
            <div>Current value</div>
            <div class="has-text-right">
              <span v-if="varinfo.dimRanges[index]?.name === 'time'">
                {{
                  (varinfo.dimInfo[index]?.current as Dayjs)?.format?.() ?? "-"
                }}
              </span>
              <span v-else>{{ varinfo.dimInfo[index]?.current ?? "-" }}</span>
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
      </div>
    </template>
  </div>
  <div v-else></div>
</template>
