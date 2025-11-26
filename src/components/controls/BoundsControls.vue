<script lang="ts" setup>
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { useGlobeControlStore } from "../store/store.ts";
import type { TBounds, TModelInfo } from "@/types/GlobeTypes.js";

const props = defineProps<{
  modelInfo: TModelInfo;
}>();

const BOUND_MODES = {
  AUTO: "auto",
  DATA: "data",
  DEFAULT: "default",
  USER: "user",
} as const;

type TBoundModes = (typeof BOUND_MODES)[keyof typeof BOUND_MODES];

const store = useGlobeControlStore();
const { varinfo, userBoundsLow, userBoundsHigh, varnameSelector } =
  storeToRefs(store);

const pickedBounds = ref<TBoundModes>(BOUND_MODES.AUTO);
const defaultBounds = ref<TBounds>({});

const dataBounds = computed(() => {
  return varinfo.value?.bounds ?? {};
});

const activeBoundsMode = computed(() => {
  if (pickedBounds.value === BOUND_MODES.AUTO) {
    if (
      userBoundsLow.value !== undefined &&
      userBoundsHigh.value !== undefined &&
      // if the input-fields are empty, they are interpreted as "" instead of a number
      (userBoundsHigh.value as unknown as string) !== "" &&
      (userBoundsLow.value as unknown as string) !== ""
    ) {
      return BOUND_MODES.USER;
    } else if (
      defaultBounds.value.low !== undefined &&
      defaultBounds.value.high !== undefined
    ) {
      return BOUND_MODES.DEFAULT;
    } else {
      return BOUND_MODES.DATA;
    }
  } else {
    return pickedBounds.value;
  }
});

const bounds = computed(() => {
  if (activeBoundsMode.value === BOUND_MODES.DATA) {
    return dataBounds.value;
  } else if (activeBoundsMode.value === BOUND_MODES.USER) {
    return {
      low: userBoundsLow.value,
      high: userBoundsHigh.value,
    };
  } else if (activeBoundsMode.value === BOUND_MODES.DEFAULT) {
    return defaultBounds.value;
  }
  return undefined;
});

const setDefaultBounds = () => {
  const defaultConfig = props.modelInfo?.vars[varnameSelector.value];
  defaultBounds.value = defaultConfig?.default_range ?? {};
};

// Expose setDefaultBounds for parent component
defineExpose({
  setDefaultBounds,
  bounds,
});
</script>

<template>
  <div class="panel-block is-block w-100">
    <div>
      <!-- Header -->
      <div class="columns has-text-weight-bold is-mobile compact-row">
        <div class="column">range</div>
        <div class="column">low</div>
        <div class="column has-text-right">high</div>
      </div>

      <!-- Data Bounds -->
      <div
        class="columns is-mobile active-row compact-row"
        :class="{ active: activeBoundsMode === BOUND_MODES.DATA }"
      >
        <div class="column">
          <input
            id="data_bounds"
            v-model="pickedBounds"
            class="mr-1"
            type="radio"
            value="data"
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
        :class="{ active: activeBoundsMode === BOUND_MODES.DEFAULT }"
      >
        <div class="column">
          <input
            id="default_bounds"
            v-model="pickedBounds"
            type="radio"
            class="mr-1"
            value="default"
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
        :class="{ active: activeBoundsMode === BOUND_MODES.USER }"
      >
        <div class="column">
          <input
            id="user_bounds"
            v-model="pickedBounds"
            class="mr-1"
            type="radio"
            value="user"
          />
          <label for="user_bounds">user</label>
        </div>
        <div class="column">
          <input
            v-model.number="userBoundsLow"
            size="10"
            class="input"
            type="number"
          />
        </div>
        <div class="column has-text-right">
          <input
            v-model.number="userBoundsHigh"
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
            v-model="pickedBounds"
            class="mb-3 mr-1"
            type="radio"
            value="auto"
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

  & > .column {
    padding-top: 0.1rem;
    padding-bottom: 0.1rem;
  }
}

.active-row.active {
  background-color: lightgreen;
  @media (prefers-color-scheme: dark) {
    background-color: #2e7d32;
  }
}
</style>
