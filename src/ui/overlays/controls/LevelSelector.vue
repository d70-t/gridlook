<script lang="ts" setup>
import { computed } from "vue";

import {
  exceedsCellCap,
  hasLevels,
  levelHoldsVariable,
  levelLabel,
} from "@/lib/data/levels.ts";
import type { TSourceLevel } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  levels: TSourceLevel[];
}>();

const store = useGlobeControlStore();

// a variable outside the level groups has a single resolution
const disabled = computed(
  () => !hasLevels(props.levels, store.varnameSelector)
);

const options = computed(() =>
  props.levels.map((level, index) => ({
    index,
    label: levelLabel(level, index),
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

const AUTO = "auto";

// the level the camera picked, shown next to "Auto"
const autoLabel = computed(() => {
  const level = props.levels[store.selectedLevel];
  return level ? `Auto (${levelLabel(level, store.selectedLevel)})` : "Auto";
});

function onLevelChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value === AUTO) {
    store.setLevelAuto(true);
  } else {
    store.selectLevel(Number(value));
  }
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
          :value="store.levelAuto && !disabled ? AUTO : store.selectedLevel"
          :disabled="disabled"
          class="form-control"
          @change="onLevelChange"
        >
          <option v-if="!disabled" :value="AUTO">{{ autoLabel }}</option>
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
      <div
        v-else
        class="is-flex is-align-items-center is-justify-content-space-between"
        title="Visible area: a large level loads only the part in view"
      >
        <span class="is-size-7 has-text-grey">Load</span>
        <div class="buttons has-addons">
          <button
            type="button"
            class="button is-small"
            :class="
              store.levelWhole
                ? 'is-light has-text-grey'
                : 'is-info is-selected'
            "
            :aria-pressed="!store.levelWhole"
            @click="store.setLevelWhole(false)"
          >
            Visible area
          </button>
          <button
            type="button"
            class="button is-small"
            :class="
              !store.levelWhole
                ? 'is-light has-text-grey'
                : 'is-info is-selected'
            "
            :aria-pressed="store.levelWhole"
            @click="store.setLevelWhole(true)"
          >
            Whole level
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
