<script lang="ts" setup>
/**
 * One Export menu for Chart and Data: the figure, the values, and what
 * reproduces the selection, each a labelled row. PNG has its size beside
 * it: Standard, a preset, or Custom… with width and height in the row.
 */
import { onClickOutside } from "@vueuse/core";
import { computed, nextTick, ref } from "vue";

import { exportGroups, type TExportFormat } from "./exportMenu.ts";
import { PNG_PRESETS } from "./exportSize.ts";
import PlotIcon from "./PlotIcon.vue";

const props = defineProps<{
  disabled: boolean;
  /** "Chart values as shown" is offered. */
  chartValues: boolean;
  /** Whether a PNG of this size can be drawn, or why not; its print size. */
  checkSize: (size: { width: number; height: number }) => {
    error: string;
    note: string;
  };
  /** Height the menu may take inside its window (it scrolls past that). */
  room: number;
  /** An icon alone (a phone's narrow bar); its name in the tooltip. */
  compact?: boolean;
}>();
const emit = defineEmits<{
  export: [format: TExportFormat, size?: { width: number; height: number }];
}>();

const host = ref<HTMLElement>();
const button = ref<HTMLButtonElement>();
const open = ref(false);
/** The PNG size: "standard", a preset's name, or "custom". */
const pngChoice = ref("standard");
const customSize = ref({ width: 3840, height: 2160 });
const groups = computed(() => exportGroups({ chartValues: props.chartValues }));
/** The size PNG saves at; undefined for Standard (960 × 540 at 2×). */
const pngSize = computed(() => {
  if (pngChoice.value === "custom") {
    return customSize.value;
  }
  const preset = PNG_PRESETS.find((p) => p.name === pngChoice.value);
  return preset ? { width: preset.width, height: preset.height } : undefined;
});
const pngCheck = computed(() =>
  pngSize.value ? props.checkSize(pngSize.value) : { error: "", note: "" }
);

onClickOutside(host, () => {
  open.value = false;
});

async function toggle() {
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    host.value?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }
}

function choose(format: TExportFormat) {
  if (format === "png" && pngCheck.value.error) {
    return;
  }
  open.value = false;
  emit(
    "export",
    format,
    format === "png" && pngSize.value ? { ...pngSize.value } : undefined
  );
  button.value?.focus();
}

function chooseSize(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value === "custom" && pngSize.value) {
    // Custom starts from the size shown.
    customSize.value = { ...pngSize.value };
  }
  pngChoice.value = value;
}

function keys(event: KeyboardEvent) {
  // The size fields keep their own keys; Escape still closes.
  const field = (event.target as HTMLElement).closest("select, input");
  if (field && event.key !== "Escape") {
    if (event.key === "Enter" && field.tagName === "INPUT") {
      event.preventDefault();
      (field as HTMLInputElement).blur();
      choose("png");
    }
    return;
  }
  const items = [
    ...(host.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    // To the next row's (or the previous row's) first format.
    event.preventDefault();
    const rows = [
      ...(host.value?.querySelectorAll<HTMLElement>(".plot-export-group") ??
        []),
    ];
    const row = rows.findIndex((r) => r.contains(document.activeElement));
    const next =
      rows[
        (row + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length
      ];
    next?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    items[event.key === "Home" ? 0 : items.length - 1]?.focus();
  } else if (event.key === "Escape" && open.value) {
    event.stopPropagation();
    open.value = false;
    button.value?.focus();
  }
}

function setSide(side: "width" | "height", event: Event) {
  const value = Math.round(Number((event.target as HTMLInputElement).value));
  customSize.value = { ...customSize.value, [side]: value };
}
</script>

<template>
  <div ref="host" class="plot-export" @keydown="keys">
    <button
      ref="button"
      type="button"
      class="plot-export-button"
      aria-haspopup="menu"
      :aria-expanded="open"
      :disabled="disabled"
      :class="{ compact }"
      :title="compact ? 'Export' : undefined"
      :aria-label="compact ? 'Export' : undefined"
      @click="toggle"
    >
      <PlotIcon name="export" />
      <template v-if="!compact">
        <span>Export</span>
        <i class="fa-solid fa-caret-down" aria-hidden="true"></i>
      </template>
    </button>
    <div
      v-if="open"
      class="plot-export-menu"
      role="menu"
      aria-label="Export"
      :style="{ maxHeight: `${Math.max(160, room)}px` }"
    >
      <div
        v-for="group in groups"
        :key="group.name"
        class="plot-export-group"
        role="group"
        :aria-label="group.name"
      >
        <span class="plot-export-heading" aria-hidden="true">{{
          group.short
        }}</span>
        <span class="plot-export-chips">
          <template v-for="item in group.items" :key="item.format">
            <!-- PNG and its size, one control. -->
            <span v-if="item.format === 'png'" class="plot-export-split">
              <button
                type="button"
                role="menuitem"
                class="plot-export-chip"
                :aria-label="item.label"
                :title="pngCheck.error || `${item.label}: ${item.hint}`"
                :aria-disabled="Boolean(pngCheck.error)"
                @click="choose(item.format)"
              >
                {{ item.chip }}
              </button>
              <select
                class="plot-export-size"
                aria-label="PNG size"
                :value="pngChoice"
                :title="
                  PNG_PRESETS.find((p) => p.name === pngChoice)?.name ??
                  'PNG size'
                "
                @change="chooseSize"
              >
                <option value="standard">Standard 2×</option>
                <option
                  v-for="p in PNG_PRESETS"
                  :key="p.name"
                  :value="p.name"
                  :title="p.name"
                >
                  {{ p.short }}
                </option>
                <option value="custom">Custom…</option>
              </select>
            </span>
            <button
              v-else
              type="button"
              role="menuitem"
              class="plot-export-chip"
              :aria-label="item.label"
              :title="`${item.label}: ${item.hint}`"
              @click="choose(item.format)"
            >
              {{ item.chip }}
            </button>
          </template>
        </span>
        <!-- The PNG size in pixels (Custom) and what it prints at. -->
        <div
          v-if="group.items.some((i) => i.format === 'png') && pngSize"
          class="plot-png-row analysis-png-form"
        >
          <span v-if="pngChoice === 'custom'" class="plot-png-sides">
            <input
              type="number"
              min="200"
              step="1"
              :value="customSize.width"
              aria-label="Width in pixels"
              @change="setSide('width', $event)"
            />
            ×
            <input
              type="number"
              min="200"
              step="1"
              :value="customSize.height"
              aria-label="Height in pixels"
              @change="setSide('height', $event)"
            />
            px
          </span>
          <span
            class="plot-png-note"
            :class="{ 'plot-png-error': pngCheck.error }"
            role="status"
          >
            {{ pngCheck.error || pngCheck.note }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plot-export {
  position: relative;
}
.plot-export-button.compact {
  padding: 0 7px;
}
.plot-export-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 550;
  color: var(--plot-fg);
  background: var(--plot-raised);
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.plot-export-button:hover:not(:disabled) {
  background: var(--plot-hover);
}
.plot-export-button:disabled {
  color: var(--plot-muted);
  cursor: default;
}
.plot-export-button .fa-caret-down {
  font-size: 0.65rem;
  opacity: 0.7;
}
.plot-export-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 6;
  /* Each kind of file on one line; wraps only in a very narrow window. */
  width: max-content;
  max-width: calc(100cqw - 20px);
  overflow: auto;
  padding: 6px;
  background: var(--plot-bg);
  color: var(--plot-fg);
  border: 1px solid var(--plot-border);
  border-radius: 8px;
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.28);
}
/* One row per kind of file: its name, then its formats as chips. */
.plot-export-group {
  display: grid;
  grid-template-columns: 70px auto;
  align-items: center;
  gap: 10px;
  padding: 6px 6px 6px 8px;
}
.plot-export-group + .plot-export-group {
  border-top: 1px solid var(--plot-border);
}
.plot-export-heading {
  font-size: 0.64rem;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--plot-muted);
}
.plot-export-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.plot-export-chip {
  height: 24px;
  padding: 0 9px;
  font: inherit;
  font-size: 0.74rem;
  font-weight: 550;
  color: var(--plot-fg);
  background: var(--plot-raised);
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.plot-export-chip:hover,
.plot-export-chip:focus-visible {
  color: var(--plot-accent);
  border-color: color-mix(in srgb, var(--plot-accent) 60%, transparent);
  background: color-mix(in srgb, var(--plot-accent) 10%, transparent);
  outline: none;
}
/* PNG and its size read as one control. */
.plot-export-split {
  display: inline-flex;
}
.plot-export-split .plot-export-chip {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.plot-export-split .plot-export-chip[aria-disabled="true"] {
  color: var(--plot-muted);
  cursor: not-allowed;
}
.plot-export-size {
  field-sizing: content;
  min-width: 0;
  height: 24px;
  margin-left: -1px;
  padding: 0 4px 0 7px;
  font: inherit;
  font-size: 0.72rem;
  color: var(--plot-muted);
  background: var(--plot-bg);
  border: 1px solid var(--plot-border);
  border-radius: 0 6px 6px 0;
  cursor: pointer;
}
.plot-export-size:hover,
.plot-export-size:focus-visible {
  color: var(--plot-fg);
  border-color: color-mix(in srgb, var(--plot-accent) 60%, transparent);
  outline: none;
}
/* Under the Figure row: the custom sides and the print size. */
.plot-png-row {
  grid-column: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 0.7rem;
  color: var(--plot-muted);
}
.plot-png-sides {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.plot-png-sides input {
  width: 64px;
  height: 22px;
  padding: 0 4px;
  font: inherit;
  color: var(--plot-fg);
  background: var(--plot-bg);
  border: 1px solid var(--plot-border);
  border-radius: 5px;
}
.plot-png-note {
  max-width: 260px;
}
.plot-png-error {
  color: var(--plot-danger);
}
:focus-visible {
  outline: 2px solid var(--plot-accent);
  outline-offset: 1px;
}
/* Touch: as slim as the window's other buttons. */
@media (pointer: coarse) {
  .plot-export-button {
    min-height: 32px;
  }
  .plot-export-chip,
  .plot-export-size {
    height: 34px;
  }
}
</style>
