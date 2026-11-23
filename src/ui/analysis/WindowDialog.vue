<script lang="ts" setup>
/**
 * A dialog inside a chart window: it covers the window below its title
 * bar, never the map, and leaves the window's size and place alone. Focus
 * moves in and stays in (Tab wraps); Escape closes it, and the window
 * returns focus to the button that opened it.
 */
import { nextTick, onMounted, ref, useId } from "vue";

import PlotIcon from "./PlotIcon.vue";
import type { TPlotIcon } from "./viewTabs.ts";

defineProps<{ title: string; icon: TPlotIcon; subtitle?: string }>();
const emit = defineEmits<{ close: [] }>();

const box = ref<HTMLElement>();
const id = useId();

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables() {
  return [
    ...(box.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
  ].filter((element) => element.getClientRects().length > 0);
}

onMounted(async () => {
  await nextTick();
  // The first field of the body, else the dialog itself (Method reads).
  const body = box.value?.querySelector<HTMLElement>(".analysis-dialog-body");
  const first = [
    ...(body?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
  ].find((element) => element.getClientRects().length > 0);
  (first ?? box.value)?.focus();
});

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key !== "Tab") {
    return;
  }
  const items = focusables();
  if (!items.length) {
    return;
  }
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (event.shiftKey && at <= 0) {
    event.preventDefault();
    items[items.length - 1].focus();
  } else if (!event.shiftKey && at === items.length - 1) {
    event.preventDefault();
    items[0].focus();
  }
}
</script>

<template>
  <div class="analysis-dialog-layer">
    <div class="analysis-dialog-scrim" aria-hidden="true"></div>
    <div
      ref="box"
      class="analysis-dialog"
      role="dialog"
      :aria-labelledby="id"
      tabindex="-1"
      @keydown="onKey"
    >
      <header class="analysis-dialog-head">
        <PlotIcon :name="icon" :size="13" />
        <h3 :id="id">{{ title }}</h3>
        <span v-if="subtitle" class="analysis-dialog-sub">{{ subtitle }}</span>
        <button
          type="button"
          class="analysis-dialog-close"
          :aria-label="`Close ${title}`"
          :title="`Close ${title} (Esc)`"
          @click="emit('close')"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </header>
      <div class="analysis-dialog-body">
        <slot />
      </div>
      <footer v-if="$slots.footer" class="analysis-dialog-foot">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<style scoped>
.analysis-dialog-layer {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  padding: 6px 8px 8px;
}
/* The chart behind is dimmed clearly (in light and dark themes alike),
 * so the dialog reads as in front of it. */
.analysis-dialog-scrim {
  position: absolute;
  inset: 0;
  background: rgba(2, 6, 23, 0.55);
  backdrop-filter: blur(2px);
}
/* As tall as its content (Apply and Cancel right under the fields, not
 * at the foot of a tall window), at most the window; at most 640 px wide,
 * centred, so a wide window keeps its chart in view behind it. */
.analysis-dialog {
  position: relative;
  flex: 0 1 640px;
  align-self: flex-start;
  max-height: 100%;
  margin-inline: auto;
  /* Shrinks with the window; long lines wrap or end in an ellipsis. */
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--plot-bg);
  border: 1px solid var(--plot-border);
  border-radius: 8px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.22);
  outline: none;
}
.analysis-dialog:focus-visible {
  outline: 2px solid var(--plot-accent);
  outline-offset: -2px;
}
.analysis-dialog-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 6px 7px 12px;
  border-bottom: 1px solid var(--plot-border);
  color: var(--plot-fg);
}
.analysis-dialog-head h3 {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 650;
  letter-spacing: 0.01em;
}
.analysis-dialog-sub {
  flex: 1;
  min-width: 0;
  color: var(--plot-muted);
  font-size: 0.72rem;
}
.analysis-dialog-close {
  margin-left: auto;
  min-width: 24px;
  min-height: 24px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--plot-muted);
  cursor: pointer;
}
.analysis-dialog-close:hover {
  background: var(--plot-hover);
  color: var(--plot-fg);
}
.analysis-dialog-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.analysis-dialog-foot {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
  padding: 7px 10px;
  border-top: 1px solid var(--plot-border);
  background: var(--plot-raised);
  border-radius: 0 0 8px 8px;
}
@media (pointer: coarse) {
  .analysis-dialog-close {
    min-width: 44px;
    min-height: 44px;
  }
}
</style>
