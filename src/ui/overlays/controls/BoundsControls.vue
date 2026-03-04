<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed } from "vue";

import type { TBounds } from "@/lib/types/GlobeTypes.js";
import { useGlobeControlStore } from "@/store/store";

const props = defineProps<{
  pickedBoundsMode: string;
  dataBounds: TBounds;
  defaultBounds: TBounds;
  currentBounds:
    | TBounds
    | { low: number | undefined; high: number | undefined }
    | undefined;
  boundModes: Record<string, string>;
}>();

defineEmits<{
  "update:pickedBoundsMode": [value: string];
}>();

const store = useGlobeControlStore();
const { userBoundsLow, userBoundsHigh } = storeToRefs(store);

const lowBound = computed({
  get() {
    return userBoundsLow.value;
  },
  set(value: number | string | undefined) {
    store.updateLowUserBound(value);
  },
});

const highBound = computed({
  get() {
    return userBoundsHigh.value;
  },
  set(value: number | string | undefined) {
    store.updateHighUserBound(value);
  },
});

// Step size for the custom bounds inputs, derived from the data range so that
// fine-grained data (e.g. 0.00001–0.1) gets an appropriate increment.
const inputStep = computed(() => {
  const range = Math.abs(
    Number(props.dataBounds.high) - Number(props.dataBounds.low)
  );
  if (range === 0) {
    return "any";
  }
  const magnitude = Math.floor(Math.log10(range));
  return Math.pow(10, magnitude - 2);
});

// True when the user has typed a low value that is greater than the high value.
// The rendered globe will auto-swap them, but we show a clear indicator so the
// user understands what is happening.
const isInverted = computed(
  () =>
    userBoundsLow.value !== undefined &&
    userBoundsHigh.value !== undefined &&
    (userBoundsLow.value as unknown as string) !== "" &&
    (userBoundsHigh.value as unknown as string) !== "" &&
    (userBoundsLow.value as number) > (userBoundsHigh.value as number)
);
</script>

<template>
  <div class="panel-block w-100 no-bottom-border">
    <div class="w-100">
      <!-- Header -->
      <div class="columns has-text-weight-bold is-mobile compact-row">
        <div class="column">Range</div>
        <div class="column">Low</div>
        <div class="column has-text-right">High</div>
      </div>

      <!-- Data Bounds -->
      <div
        class="columns is-mobile active-row compact-row"
        :class="{ active: pickedBoundsMode === boundModes.DATA }"
      >
        <div class="column">
          <input
            id="data_bounds"
            class="mr-1"
            type="radio"
            value="data"
            :checked="pickedBoundsMode === boundModes.DATA"
            @change="$emit('update:pickedBoundsMode', boundModes.DATA)"
          />
          <label for="data_bounds">Data</label>
        </div>
        <div class="column">{{ Number(dataBounds.low).toPrecision(4) }}</div>
        <div class="column has-text-right">
          {{ Number(dataBounds.high).toPrecision(4) }}
        </div>
      </div>

      <!-- User Bounds -->
      <div
        class="columns is-mobile active-row compact-row"
        :class="{ active: pickedBoundsMode === boundModes.USER }"
      >
        <div class="column">
          <input
            id="user_bounds"
            class="mr-1"
            type="radio"
            value="user"
            :checked="pickedBoundsMode === boundModes.USER"
            @change="$emit('update:pickedBoundsMode', boundModes.USER)"
          />
          <label for="user_bounds">Custom</label>
        </div>
        <div class="column">
          <input
            v-model.number="lowBound"
            size="10"
            class="input"
            :class="[{ 'is-warning': isInverted }]"
            type="number"
            :step="inputStep"
          />
        </div>
        <div class="column has-text-right">
          <input
            v-model.number="highBound"
            size="10"
            class="input"
            :class="[{ 'is-warning': isInverted }]"
            type="number"
            :step="inputStep"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use "bulma/sass/utilities" as bulmaUt;

.compact-row {
  padding-top: 0.1rem;
  padding-bottom: 0.1rem;
  margin-bottom: 0.1rem;
  // margin-left: 0;
  // transparent border in order to prevent layout shift when active
  border-left: 3px solid transparent;

  & > .column {
    padding-top: 0.1rem;
    padding-bottom: 0.1rem;
  }
}

.active-row.active {
  background-color: lightgreen;
  border-left: #2e7d32 3px solid;
  @media (prefers-color-scheme: dark) {
    border-left: lightgreen solid;
    background-color: #2e7d32;
  }
}

.no-bottom-border {
  border-bottom: none !important;
}
</style>
