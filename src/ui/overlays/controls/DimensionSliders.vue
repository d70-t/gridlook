<script lang="ts" setup>
import debounce from "lodash.debounce";
import { storeToRefs } from "pinia";
import { Panel } from "primevue";
import { computed, ref, watch } from "vue";

import { useGlobeControlStore } from "@/store/store";

const store = useGlobeControlStore();
const { varinfo, dimSlidersValues } = storeToRefs(store);

// Local copies for debounced updates (excluding time dimension)
const localSliders = ref<(number | null)[]>([]);
const debouncedUpdaters = ref<Array<(value: number) => void>>([]);

const nonTimeRanges = computed(() => {
  if (!varinfo.value?.dimRanges) {
    return [];
  }

  return varinfo.value.dimRanges
    .slice(1)
    .filter((range) => range && range.maxBound > 0);
});

const hasNonTimeDimensions = computed(() => {
  return (
    varinfo.value &&
    varinfo.value.dimRanges.length > 1 &&
    nonTimeRanges.value.length > 0
  );
});

// Watch for changes in varinfo to update local state
watch(
  () => varinfo.value,
  () => {
    const newRanges = varinfo.value?.dimRanges;
    if (newRanges) {
      // Initialize local sliders for non-time dimensions (skip index 0 which is time)
      localSliders.value = newRanges.map((range, index) =>
        range?.name === "time"
          ? null
          : (dimSlidersValues.value[index] ?? range?.startPos ?? null)
      );

      // Create stable debounced functions for non-time dimensions
      debouncedUpdaters.value = newRanges.map((_, index) => {
        return debounce((value: number) => {
          if (
            dimSlidersValues.value[index] !== undefined &&
            newRanges[index]?.name !== "time"
          ) {
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
        varinfo.value?.dimRanges[index]?.name !== "time" &&
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
</script>

<template>
  <Panel v-if="hasNonTimeDimensions" header="Dimensions" class="shadow-sm m-2">
    <!-- Generic dimension sliders -->
    <div class="control">
      <div class="mb-1 has-text-weight-semibold is-size-7">Dimensions</div>
      <template v-for="(range, index) in varinfo!.dimRanges" :key="index">
        <div
          v-if="range && range.name !== 'time'"
          class="mb-2 w-100 is-flex is-justify-content-space-between"
        >
          <div class="my-2">
            {{
              String(range.name[0]).toUpperCase() + String(range.name).slice(1)
            }}:
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
            <div class="my-2">/ {{ range.maxBound }}</div>
          </div>
        </div>
        <input
          v-if="range && range.name !== 'time'"
          v-model.number="localSliders[index]"
          class="w-100"
          type="range"
          :min="range.minBound"
          :max="range.maxBound"
        />
      </template>
    </div>
  </Panel>
  <div v-else></div>
</template>
