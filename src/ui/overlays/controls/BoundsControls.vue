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

<!--
<template>
  <div class="panel-block w-100 no-bottom-border">
    <div class="w-100">
      <div
        class="columns has-text-weight-bold is-mobile compact-row is-uppercase is-size-7"
      >
        <div class="column"></div>
        <div class="column">Low</div>
        <div class="column has-text-right">High</div>
      </div>

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
          <label for="data_bounds" class="has-text-weight-medium">Data</label>
        </div>
        <div class="column">{{ Number(dataBounds.low).toPrecision(4) }}</div>
        <div class="column has-text-right">
          {{ Number(dataBounds.high).toPrecision(4) }}
        </div>
      </div>

      <div
        class="columns is-mobile active-row compact-row"
        :class="{ active: pickedBoundsMode === boundModes.USER }"
      >
        <div class="column is-flex is-align-items-center">
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
-->

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

.bounds-table {
  width: 100%;
  font-size: 0.72rem; /* ~11px — dense table sizing */
}

/* Jede Zeile ist ein Flex-Container */
.bounds-row {
  display: flex;
  align-items: center;
  padding: 3px 0;
  border-bottom: 1px solid var(--bulma-border, #dbdbdb);
  transition: background 0.1s;
}
.bounds-row:last-child {
  border-bottom: none;
}
.bounds-row.is-active {
  background: hsl(var(--bulma-primary-h, 229deg), 53%, 53%, 0.07);
}
.bounds-row.is-active label {
  font-weight: 600;
}

/* Zellen */
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
  text-align: right; /* Zahlen immer rechtsbündig */
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, "SF Mono", monospace;
  color: var(--bulma-text, #363636);
}

/* Header-Zeile */
.bounds-header {
  border-bottom: 2px solid var(--bulma-border, #dbdbdb);
  padding-bottom: 3px;
}
.bounds-header .bounds-cell--num {
  // font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  // color: var(--bulma-text-light, #7a7a7a);
  font-family: inherit; /* Header kein Mono */
}

/* Radio */
// .bounds-radio {
//   margin: 0;
//   cursor: pointer;
//   accent-color: var(--bulma-primary, hsl(229deg, 53%, 53%));
// }
// label {
//   cursor: pointer;
//   user-select: none;
// }

/* Number-Input */
.bounds-input {
  width: 100%;
  text-align: right; /* Ziffern rechtsbündig */
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 0.72rem;
  padding: 2px 4px;
  // height: auto;
  line-height: 1.4;
  // border: 1px solid var(--bulma-border, #dbdbdb);
  // border-radius: 3px;
  // background: transparent;
  color: inherit;
  outline: none;
  // transition: border-color 0.15s;
  /* Pfeile ausblenden — nehmen Platz weg bei kleinen Feldern */
  -moz-appearance: textfield;
}
// .bounds-input::-webkit-outer-spin-button,
// .bounds-input::-webkit-inner-spin-button {
//   -webkit-appearance: none;
// }
// .bounds-input:focus {
//   border-color: var(--bulma-primary, hsl(229deg, 53%, 53%));
// }
// .bounds-input.is-warning {
//   border-color: var(--bulma-warning, hsl(48deg, 100%, 67%));
// }
</style>
