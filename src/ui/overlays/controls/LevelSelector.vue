<script lang="ts" setup>
import { computed } from "vue";

import { exceedsCellCap } from "@/lib/data/levels.ts";
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

const options = computed(() =>
  props.levels.map((level, index) => ({
    index,
    label: `${level.name ?? index}${formatResolution(level.resolution)}`,
    // still selectable by hand; the camera never picks these
    tooManyCells: !store.loadsLevelByView(index) && exceedsCellCap(level),
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
          class="form-control"
          @change="onLevelChange"
        >
          <option
            v-for="option in options"
            :key="option.index"
            :value="option.index"
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
      <label class="checkbox is-size-7">
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
