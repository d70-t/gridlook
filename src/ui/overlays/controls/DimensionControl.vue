<script lang="ts" setup>
import type { Dayjs } from "dayjs";
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

// Watch for changes in varinfo to update local state
watch(
  () => varinfo.value,
  () => {
    const newRanges = varinfo.value?.dimRanges;
    if (newRanges) {
      // Initialize local sliders for non-time dimensions (skip index 0 which is time)
      localSliders.value = newRanges.map(
        (range, index) =>
          dimSlidersValues.value[index] ?? range?.startPos ?? null
      );

      // Create stable debounced functions for non-time dimensions
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

function capitalize(str: string): string {
  return String(str[0]).toUpperCase() + String(str).slice(1);
}
</script>

<template>
  <div v-if="varinfo">
    <template v-for="(range, index) in varinfo!.dimRanges" :key="index">
      <Panel
        v-if="range"
        :header="`Dimension: ${capitalize(range.name)}`"
        class="shadow-sm m-2"
      >
        <!-- Generic dimension sliders -->
        <div class="control">
          <div
            v-if="range"
            class="mb-2 w-100 is-flex is-justify-content-space-between"
          >
            <div class="my-2">Index:</div>
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
            v-if="range"
            v-model.number="localSliders[index]"
            class="w-100"
            type="range"
            :min="range.minBound"
            :max="range.maxBound"
          />
          <div class="w-100 is-flex is-justify-content-space-between">
            <div>
              Current value:<span
                :class="{ loader: store.loading === true }"
              ></span>
            </div>
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
      </Panel>
    </template>
  </div>
  <div v-else></div>
</template>
