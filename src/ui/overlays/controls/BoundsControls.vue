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

function formatNum(val: number | undefined) {
  const n = Number(val);
  if (isNaN(n)) {
    return "—";
  }
  return n.toPrecision(4);
}
</script>

<template>
  <div class="bounds-table">
    <!-- Header -->
    <div class="bounds-row bounds-header">
      <div class="bounds-cell bounds-cell--label"></div>
      <div class="bounds-cell bounds-cell--num">Low</div>
      <div class="bounds-cell bounds-cell--num">High</div>
    </div>

    <!-- Data Bounds -->
    <div
      class="bounds-row"
      :class="{ 'is-active': pickedBoundsMode === boundModes.DATA }"
    >
      <div class="bounds-cell bounds-cell--label">
        <input
          id="data_bounds"
          class="bounds-radio"
          type="radio"
          value="data"
          :checked="pickedBoundsMode === boundModes.DATA"
          @change="$emit('update:pickedBoundsMode', boundModes.DATA)"
        />
        <label for="data_bounds">Data</label>
      </div>
      <div class="bounds-cell bounds-cell--num">
        {{ formatNum(dataBounds.low) }}
      </div>
      <div class="bounds-cell bounds-cell--num">
        {{ formatNum(dataBounds.high) }}
      </div>
    </div>

    <!-- User Bounds -->
    <div
      class="bounds-row"
      :class="{ 'is-active': pickedBoundsMode === boundModes.USER }"
    >
      <div class="bounds-cell bounds-cell--label">
        <input
          id="user_bounds"
          class="bounds-radio"
          type="radio"
          value="user"
          :checked="pickedBoundsMode === boundModes.USER"
          @change="$emit('update:pickedBoundsMode', boundModes.USER)"
        />
        <label for="user_bounds">Custom</label>
      </div>
      <div class="bounds-cell bounds-cell--num">
        <input
          v-model.number="lowBound"
          class="bounds-input input"
          :class="{ 'is-warning': isInverted }"
          type="number"
          :step="inputStep"
        />
      </div>
      <div class="bounds-cell bounds-cell--num">
        <input
          v-model.number="highBound"
          class="bounds-input input"
          :class="{ 'is-warning': isInverted }"
          type="number"
          :step="inputStep"
        />
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use "bulma/sass/elements/table" as t;

.bounds-table {
  width: 100%;
  font-size: 0.72rem; /* ~11px — dense table sizing */
}

.bounds-row {
  display: flex;
  align-items: center;
  padding: 3px 0;
  border: t.$table-cell-border-width t.$table-cell-border-style
    t.$table-cell-border-color;
  transition: background 0.1s;
}
.bounds-row:last-child {
  border-bottom: none;
}
.bounds-row.is-active {
  background: hsl(var(--bulma-info-h, 229deg), 53%, 53%, 0.07);
}
.bounds-row.is-active label {
  font-weight: 600;
}

.bounds-cell {
  padding: 4px 6px;
}
.bounds-cell--label {
  flex: 1.2;
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--bulma-text, #363636);
  white-space: nowrap;
  font-size: 12px;
}
.bounds-cell--num {
  flex: 1;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, "SF Mono", monospace;
  color: var(--bulma-text, #363636);
}

.bounds-header {
  border-bottom: 2px solid var(--bulma-border, #dbdbdb);
  padding-bottom: 3px;
}
.bounds-header .bounds-cell--num {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-family: inherit;
}

.bounds-input {
  width: 100%;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 0.72rem;
  padding: 2px 4px;
  line-height: 1.4;
  color: inherit;
  outline: none;
  -moz-appearance: textfield;
  appearance: textfield;
}
</style>
