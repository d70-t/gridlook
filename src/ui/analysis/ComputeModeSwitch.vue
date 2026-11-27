<script lang="ts" setup>
/**
 * How large reads start, like an agent's ask/auto mode: **Ask first** waits
 * for Compute (or Read beside a plot); **Automatic** starts them at once,
 * sized in the bar and stoppable, up to a cap above which it still asks.
 * One choice for every plot, remembered in this browser.
 */
import { computed } from "vue";

import {
  AUTO_COMPUTE_BYTES,
  useAnalysisStore,
  type TComputeMode,
} from "@/store/analysisStore.ts";

const analysis = useAnalysisStore();
const cap = `${AUTO_COMPUTE_BYTES / 2 ** 30} GiB`;
const modes = computed(() => [
  {
    mode: "ask" as TComputeMode,
    label: "Ask first",
    title: "Large reads wait for Compute",
  },
  {
    mode: "auto" as TComputeMode,
    label: "Automatic",
    title: `Large reads start by themselves, up to ${cap} each (larger ones still ask); Stop is always there`,
  },
]);
</script>

<template>
  <div
    class="compute-mode"
    role="radiogroup"
    aria-label="Large reads"
    :title="`Large reads: ask first, or start them automatically (up to ${cap})`"
  >
    <span class="compute-mode-label" aria-hidden="true">Large reads</span>
    <button
      v-for="item in modes"
      :key="item.mode"
      type="button"
      role="radio"
      :aria-checked="analysis.computeMode === item.mode"
      :title="item.title"
      @click="analysis.setComputeMode(item.mode)"
    >
      <i
        class="fa-solid"
        :class="item.mode === 'auto' ? 'fa-bolt' : 'fa-hand'"
        aria-hidden="true"
      ></i>
      {{ item.label }}
    </button>
  </div>
</template>

<style scoped>
.compute-mode {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  font-size: 0.72rem;
  background: var(--plot-raised);
  border: 1px solid var(--plot-border);
  border-radius: 7px;
}
.compute-mode-label {
  white-space: nowrap;
  padding: 0 6px 0 4px;
  color: var(--plot-muted);
  font-size: 0.66rem;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.compute-mode button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  height: 22px;
  padding: 0 9px;
  font: inherit;
  color: var(--plot-muted);
  background: none;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}
.compute-mode button .fa-solid {
  font-size: 0.6rem;
}
.compute-mode button[aria-checked="true"] {
  color: var(--plot-fg);
  font-weight: 600;
  background: var(--plot-bg);
  box-shadow: 0 0 0 1px var(--plot-border);
}
.compute-mode button[aria-checked="true"] .fa-bolt {
  color: var(--plot-warn);
}
.compute-mode button[aria-checked="true"] .fa-hand {
  color: var(--plot-accent);
}
.compute-mode button:focus-visible {
  outline: 2px solid var(--plot-accent);
  outline-offset: -1px;
}
/* Touch: 30 px drawn; the switch's own padding adds to the target. */
@media (pointer: coarse) {
  .compute-mode button {
    height: 30px;
  }
}
</style>
