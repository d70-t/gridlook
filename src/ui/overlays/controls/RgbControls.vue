<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed } from "vue";

import {
  chooseRgbDimension,
  clampRgbChannels,
  getRgbDimensionOptions,
  RGB_GAMMA,
  type TRgbChannels,
} from "@/lib/data/rgbComposite.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const CHANNEL_NAMES = ["R", "G", "B"] as const;

const store = useGlobeControlStore();
const { rgbSettings, rgbDataBounds, varinfo } = storeToRefs(store);

const dimensionOptions = computed(() =>
  getRgbDimensionOptions(varinfo.value?.dimRanges, varinfo.value?.dimInfo)
);

const dimension = computed(() =>
  chooseRgbDimension(dimensionOptions.value, rgbSettings.value.dimension)
);

const channels = computed(() =>
  clampRgbChannels(
    rgbSettings.value.channels,
    dimension.value?.labels.length ?? 0
  )
);

function setDimension(name: string) {
  store.updateRgbSettings({ dimension: name });
}

function setChannel(channelIndex: number, value: string) {
  const next = [...channels.value] as TRgbChannels;
  next[channelIndex] = Number(value);
  store.updateRgbSettings({ channels: next });
}

function parseBound(value: string) {
  const number = parseFloat(value);
  return value.trim() === "" || !Number.isFinite(number) ? undefined : number;
}

function formatBound(value: number | undefined) {
  return value === undefined ? "" : String(Number(value.toPrecision(4)));
}
</script>

<template>
  <div class="rgb-controls">
    <p v-if="!dimension" class="help is-warning">
      {{
        dimensionOptions.length === 0
          ? "This variable has no dimension with three or more entries."
          : `This variable has no dimension "${rgbSettings.dimension}".`
      }}
    </p>
    <label v-if="dimensionOptions.length > 0" class="rgb-row">
      <span>Dimension</span>
      <span class="select is-small">
        <select
          :value="dimension?.name ?? ''"
          aria-label="Dimension shown as RGB"
          @change="setDimension(($event.target as HTMLSelectElement).value)"
        >
          <option v-if="!dimension" value="" disabled>Choose…</option>
          <option
            v-for="option in dimensionOptions"
            :key="option.name"
            :value="option.name"
          >
            {{ option.name }}
          </option>
        </select>
      </span>
    </label>
    <template v-if="dimension">
      <label
        v-for="(name, channelIndex) in CHANNEL_NAMES"
        :key="name"
        class="rgb-row"
      >
        <span>{{ name }}</span>
        <span class="select is-small">
          <select
            :value="String(channels[channelIndex])"
            :aria-label="`${dimension.name} shown as ${name}`"
            @change="
              setChannel(
                channelIndex,
                ($event.target as HTMLSelectElement).value
              )
            "
          >
            <option
              v-for="(label, index) in dimension.labels"
              :key="index"
              :value="String(index)"
            >
              {{ label }}
            </option>
          </select>
        </span>
      </label>
      <div class="rgb-row">
        <span>Range</span>
        <div class="rgb-range">
          <input
            class="input is-small"
            type="number"
            step="any"
            aria-label="RGB lower bound"
            :value="formatBound(rgbSettings.low)"
            :placeholder="formatBound(rgbDataBounds?.low)"
            @change="
              store.updateRgbSettings({
                low: parseBound(($event.target as HTMLInputElement).value),
              })
            "
          />
          <input
            class="input is-small"
            type="number"
            step="any"
            aria-label="RGB upper bound"
            :value="formatBound(rgbSettings.high)"
            :placeholder="formatBound(rgbDataBounds?.high)"
            @change="
              store.updateRgbSettings({
                high: parseBound(($event.target as HTMLInputElement).value),
              })
            "
          />
        </div>
      </div>
      <label class="rgb-row">
        <span>Gamma</span>
        <input
          type="range"
          :min="RGB_GAMMA.MIN"
          :max="RGB_GAMMA.MAX"
          :step="RGB_GAMMA.STEP"
          :value="rgbSettings.gamma"
          aria-label="RGB gamma"
          @input="
            store.updateRgbSettings({
              gamma: ($event.target as HTMLInputElement).valueAsNumber,
            })
          "
        />
        <span class="tag is-light">{{ rgbSettings.gamma.toFixed(2) }}</span>
      </label>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.rgb-controls {
  display: grid;
  gap: 0.35rem;
  width: 100%;
}

.rgb-row {
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.75rem;

  .select,
  select {
    width: 100%;
  }
}

.rgb-range {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.35rem;
}
</style>
