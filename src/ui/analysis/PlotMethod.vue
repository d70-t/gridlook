<script lang="ts" setup>
/**
 * The Method dialog's body, read-only, in two tabs: **Method** (selection,
 * calculation, weighting, coverage, statistics) and **Read diagnostics**
 * (where the read stands and what it cost). Both copy as plain text, for a
 * methods section or a notebook.
 */
import { computed, nextTick, ref } from "vue";

import type { TMethodSection, TRowAction } from "./methodFacts.ts";

const props = defineProps<{
  sections: TMethodSection[];
  diagnostics: TMethodSection["rows"];
  heading: string;
  /** The tab to open on (Read details: "diagnostics"). */
  initial?: "method" | "diagnostics";
}>();
const emit = defineEmits<{
  /** A row's way on (Change dates, Redraw on map, +N dates). */
  action: [id: TRowAction];
}>();

const tab = ref<"method" | "diagnostics">(props.initial ?? "method");
const tabsBox = ref<HTMLElement>();

const text = computed(() =>
  [
    props.heading,
    ...[
      ...props.sections,
      { title: "Read diagnostics", rows: props.diagnostics },
    ].flatMap((section) => [
      "",
      section.title,
      ...section.rows.map((row) => `  ${row.label}: ${row.value}`),
    ]),
  ].join("\n")
);

/** Arrow keys move between the two tabs (and choose). */
async function keys(event: KeyboardEvent) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
    return;
  }
  event.preventDefault();
  tab.value = tab.value === "method" ? "diagnostics" : "method";
  await nextTick();
  tabsBox.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}

const copied = ref("");
const root = ref<HTMLElement>();
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

/** Older or embedded pages refuse the Clipboard API; a selected textarea still copies there. */
function copyBySelection(value: string) {
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } finally {
    area.remove();
  }
}

/** Copy, and say so on the button; when both ways are refused, select the text to copy by hand. */
async function copy() {
  let done = false;
  try {
    await navigator.clipboard.writeText(text.value);
    done = true;
  } catch {
    done = copyBySelection(text.value);
  }
  if (done) {
    copied.value = "Copied";
  } else {
    copied.value = "Selected: press Ctrl+C";
    const body = root.value?.querySelector('[role="tabpanel"]');
    const range = document.createRange();
    if (body) {
      range.selectNodeContents(body);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
  }
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = ""), 2000);
}
defineExpose({ copy, text, copied });
</script>

<template>
  <div ref="root" class="plot-method">
    <div
      ref="tabsBox"
      class="plot-method-tabs"
      role="tablist"
      aria-label="Method or read diagnostics"
      @keydown="keys"
    >
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'method'"
        :tabindex="tab === 'method' ? 0 : -1"
        @click="tab = 'method'"
      >
        Method
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'diagnostics'"
        :tabindex="tab === 'diagnostics' ? 0 : -1"
        @click="tab = 'diagnostics'"
      >
        Read diagnostics
      </button>
    </div>
    <div v-if="tab === 'method'" class="plot-method-grid" role="tabpanel">
      <section
        v-for="section in sections"
        :key="section.title"
        class="plot-method-section"
        :data-section="section.title"
      >
        <h4>{{ section.title }}</h4>
        <dl>
          <template v-for="(row, at) in section.rows" :key="at">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </template>
        </dl>
      </section>
    </div>
    <div
      v-else
      class="plot-method-section plot-method-diagnostics"
      role="tabpanel"
      data-section="Read diagnostics"
    >
      <dl>
        <template v-for="(row, at) in diagnostics" :key="at">
          <dt>{{ row.label }}</dt>
          <dd>
            {{ row.value }}
            <span v-if="row.actions" class="plot-method-actions">
              <button
                v-for="action in row.actions"
                :key="action.id"
                type="button"
                class="plot-method-action"
                :data-action="action.id"
                @click="emit('action', action.id)"
              >
                <i
                  class="fa-solid"
                  :class="
                    {
                      dates: 'fa-calendar-days',
                      area: 'fa-pen',
                      extend: 'fa-forward',
                    }[action.id]
                  "
                  aria-hidden="true"
                ></i>
                {{ action.label }}
              </button>
            </span>
          </dd>
        </template>
      </dl>
    </div>
  </div>
</template>

<style scoped>
.plot-method {
  padding: 0 14px 10px;
}
.plot-method-tabs {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  gap: 4px;
  margin: 0 -14px 4px;
  padding: 0 10px;
  background: var(--plot-bg);
  border-bottom: 1px solid var(--plot-border);
}
.plot-method-tabs button {
  padding: 8px 8px 7px;
  font: inherit;
  font-size: 0.76rem;
  color: var(--plot-muted);
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.plot-method-tabs button[aria-selected="true"] {
  color: var(--plot-accent);
  border-bottom-color: var(--plot-accent);
  font-weight: 600;
}
.plot-method-tabs button:focus-visible {
  outline: 2px solid var(--plot-accent);
  outline-offset: -2px;
}
.plot-method-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 2px 24px;
}
@container plot-window (min-width: 640px) {
  .plot-method-grid {
    grid-template-columns: 1fr 1fr;
  }
}
.plot-method-section {
  min-width: 0;
  padding: 6px 0;
}
.plot-method-section h4 {
  margin: 0 0 4px;
  font-size: 0.66rem;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--plot-accent);
}
.plot-method-section dl {
  display: grid;
  grid-template-columns: minmax(84px, max-content) 1fr;
  gap: 4px 14px;
  margin: 0;
}
.plot-method-section dt {
  color: var(--plot-muted);
  white-space: nowrap;
}
.plot-method-section dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.plot-method-diagnostics {
  padding-top: 8px;
}
/* A row's ways on, under what it says. */
.plot-method-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0 2px;
}
.plot-method-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  font: inherit;
  font-size: 0.74rem;
  font-weight: 550;
  color: var(--plot-accent);
  background: color-mix(in srgb, var(--plot-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--plot-accent) 45%, transparent);
  border-radius: 6px;
  cursor: pointer;
}
.plot-method-action:hover {
  background: color-mix(in srgb, var(--plot-accent) 18%, transparent);
}
.plot-method-action .fa-solid {
  font-size: 0.66rem;
}
@media (pointer: coarse) {
  .plot-method-action {
    height: 44px;
  }
}
</style>
