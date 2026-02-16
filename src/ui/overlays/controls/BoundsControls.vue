<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed } from "vue";

import type { TBounds } from "@/lib/types/GlobeTypes.js";
import { useGlobeControlStore } from "@/store/store";

defineProps<{
  pickedBoundsMode: string;
  activeBoundsMode: string;
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
</script>

<template>
  <div class="panel-block w-100 no-bottom-border">
    <div class="w-100">
      <!-- Header -->
      <div class="columns has-text-weight-bold is-mobile compact-row">
        <div class="column">range</div>
        <div class="column">low</div>
        <div class="column has-text-right">high</div>
      </div>

      <!-- Data Bounds -->
      <div
        class="columns is-mobile active-row compact-row"
        :class="{ active: activeBoundsMode === boundModes.DATA }"
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
          <label for="data_bounds">data</label>
        </div>
        <div class="column">{{ Number(dataBounds.low).toPrecision(4) }}</div>
        <div class="column has-text-right">
          {{ Number(dataBounds.high).toPrecision(4) }}
        </div>
      </div>

      <!-- Default Bounds -->
      <div
        v-if="
          defaultBounds.low !== undefined && defaultBounds.high !== undefined
        "
        class="columns is-mobile active-row compact-row"
        :class="{ active: activeBoundsMode === boundModes.DEFAULT }"
      >
        <div class="column">
          <input
            id="default_bounds"
            class="mr-1"
            type="radio"
            value="default"
            :checked="pickedBoundsMode === boundModes.DEFAULT"
            @change="$emit('update:pickedBoundsMode', boundModes.DEFAULT)"
          />
          <label
            for="default_bounds"
            :class="{
              'has-text-grey-light':
                defaultBounds.low === undefined &&
                defaultBounds.high === undefined,
            }"
            >default</label
          >
        </div>
        <div
          class="column"
          :class="{
            'has-text-grey-light':
              defaultBounds.low === undefined &&
              defaultBounds.high === undefined,
          }"
        >
          {{ Number(defaultBounds.low).toPrecision(4) }}
        </div>
        <div
          class="column has-text-right"
          :class="{
            'has-text-grey-light':
              defaultBounds.low === undefined &&
              defaultBounds.high === undefined,
          }"
        >
          {{ Number(defaultBounds.high).toPrecision(4) }}
        </div>
      </div>

      <!-- User Bounds -->
      <div
        class="columns is-mobile active-row compact-row"
        :class="{ active: activeBoundsMode === boundModes.USER }"
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
          <label for="user_bounds">user</label>
        </div>
        <div class="column">
          <input
            v-model.number="lowBound"
            size="10"
            class="input"
            type="number"
          />
        </div>
        <div class="column has-text-right">
          <input
            v-model.number="highBound"
            size="10"
            class="input"
            type="number"
          />
        </div>
      </div>

      <!-- Auto Bounds -->
      <div class="columns is-mobile active-row compact-row">
        <div class="column">
          <input
            id="auto_bounds"
            class="mb-3 mr-1"
            type="radio"
            value="auto"
            :checked="pickedBoundsMode === boundModes.AUTO"
            @change="$emit('update:pickedBoundsMode', boundModes.AUTO)"
          />
          <label for="auto_bounds">auto</label>
        </div>
        <div class="column"></div>
        <div class="column has-text-right"></div>
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
