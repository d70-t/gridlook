<script lang="ts" setup>
import { computed } from "vue";

import {
  exceedsCellCap,
  hasLevels,
  levelHoldsVariable,
} from "@/lib/data/levels.ts";
import type { TSourceLevel } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  levels: TSourceLevel[];
}>();

const store = useGlobeControlStore();

const resolutionFormat = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 3,
});

function formatResolution(resolution?: number) {
  if (resolution === undefined) {
    return "";
  }
  return resolution >= 1000
    ? ` · ${resolutionFormat.format(resolution / 1000)} km`
    : ` · ${resolutionFormat.format(resolution)} m`;
}

// a variable outside the level groups has a single resolution
const disabled = computed(
  () => !hasLevels(props.levels, store.varnameSelector)
);

const options = computed(() =>
  props.levels.map((level, index) => ({
    index,
    label: `${level.name ?? index}${formatResolution(level.resolution)}`,
    // still selectable by hand; the camera never picks these
    tooManyCells: !store.loadsLevelByView(index) && exceedsCellCap(level),
    // a level without the variable shown cannot display it
    lacksVariable: !levelHoldsVariable(
      props.levels,
      store.varnameSelector,
      index
    ),
  }))
);

function onLevelChange(event: Event) {
  store.selectLevel(Number((event.target as HTMLSelectElement).value));
}

function onAutoChange(event: Event) {
  store.setLevelAuto((event.target as HTMLInputElement).checked);
}
</script>

<template>
  <div class="column">
    <div class="control">
      <div class="is-size-7 has-text-grey">Level</div>
      <div
        class="select is-fullwidth mb-2"
        :class="{ 'is-loading': store.loading }"
      >
        <select
          :value="store.selectedLevel"
          :disabled="disabled"
          class="form-control"
          @change="onLevelChange"
        >
          <option
            v-for="option in options"
            :key="option.index"
            :value="option.index"
            :disabled="option.lacksVariable"
            :title="
              option.tooManyCells
                ? 'More cells than the renderer allocates comfortably'
                : undefined
            "
          >
            {{ option.label }}
          </option>
        </select>
      </div>
      <p v-if="disabled" class="is-size-7 has-text-grey">
        This variable has no levels.
      </p>
      <label v-else class="checkbox is-size-7">
        <input
          :checked="store.levelAuto"
          type="checkbox"
          @change="onAutoChange"
        />
        Pick the level from the zoom
      </label>
    </div>
  </div>
</template>
