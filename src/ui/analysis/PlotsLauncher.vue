<script lang="ts" setup>
import { useEventListener, useMediaQuery } from "@vueuse/core";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";

import ComputeModeSwitch from "./ComputeModeSwitch.vue";
import {
  describeGeometry,
  displayedSummary,
  humanStatus,
  focusPlotWindow,
  idMeaning,
  isReading,
  levelText,
  minimizedStatus,
  pendingChanges,
} from "./plotLayout.ts";
import { launcherBox } from "./plotMotion.ts";

import { timeLabelAt } from "@/lib/analysis/calendar.ts";
import {
  ANALYSIS_KINDS,
  FIXED_LEVEL_KINDS,
  TIME_RANGE_KINDS,
} from "@/lib/analysis/types.ts";
import {
  PLOT_KIND_NAMES,
  useAnalysisStore,
  type TPlotWindow,
} from "@/store/analysisStore.ts";
import { useToast } from "@/ui/common/useToast.ts";
import { formatValue } from "@/utils/formatValue.ts";

const props = defineProps<{
  /** Compact layout with a plot in view: the plot has Back to map. */
  hidden: boolean;
  /** The Orbit dial is open from this button. */
  dialOpen: boolean;
  /** Why Compare cannot start ("" when it can). */
  compareReason?: string;
}>();
const emit = defineEmits<{
  /** Open (or fold away) the Orbit dial, growing out of the chart icon. */
  newPlot: [];
}>();

const analysis = useAnalysisStore();
const root = ref<HTMLElement>();
const panel = ref<HTMLElement>();
const button = ref<HTMLButtonElement>();
const open = ref(false);
const coarse = useMediaQuery("(pointer: coarse)");

/** Every retained plot counts, visible or minimized; none: no badge. */
const count = computed(() => analysis.windows.length);

/**
 * With retained plots, Open plots (with one New plot action); with none,
 * the Orbit dial opens straight away.
 */
function toggle() {
  if (open.value) {
    close();
    return;
  }
  if (!count.value || props.dialOpen) {
    newPlot();
    return;
  }
  open.value = true;
  void focusFirst();
}

function newPlot() {
  close();
  emit("newPlot");
}

function close(returnFocus = false) {
  open.value = false;
  if (returnFocus) {
    button.value?.focus();
  }
}

async function focusFirst() {
  await nextTick();
  panel.value
    ?.querySelector<HTMLElement>("button:not([aria-disabled='true'])")
    ?.focus();
}

/** A minimized plot grows back out of this button into its saved bounds. */
function restore(w: TPlotWindow) {
  if (w.minimized) {
    const from = launcherBox();
    if (from) {
      analysis.patchWindow(w.id, { emergeFrom: from });
    }
  }
  analysis.setMinimized(w.id, false);
  analysis.focus(w.id);
  close();
  // Restoring P2 puts keyboard focus in P2, not only raises it.
  void focusPlotWindow(w.id);
}

/** Finished time series: two or more can be compared. */
const comparable = computed(() =>
  analysis.windows.filter(
    (w) =>
      w.result?.time &&
      !w.result.partial &&
      (w.kind === ANALYSIS_KINDS.POINT_SERIES ||
        w.kind === ANALYSIS_KINDS.REGION_SERIES)
  )
);

/**
 *  Locked when nothing here can make a time series (a minimized Compare
 * still reopens).
 */
const compareLocked = computed(() =>
  analysis.compare ? "" : (props.compareReason ?? "")
);

/** Compare them all; the first opened is the reference to begin with. */
function openCompare() {
  if (analysis.compare?.minimized) {
    restoreCompare();
    return;
  }
  if (compareLocked.value) {
    return;
  }
  analysis.openCompare();
  close();
}

/** Compare, minimized here with the plots (25 Nov), opens again. */
function restoreCompare() {
  if (analysis.compare) {
    analysis.compare = { ...analysis.compare, minimized: false };
  }
  close();
}
const compareText = computed(() => {
  const compare = analysis.compare;
  const reference = analysis.windows.find((w) => w.id === compare?.reference);
  const n = compare?.ids.length ?? 0;
  return reference
    ? `${n} series against ${reference.label}`
    : "Places or areas to compare";
});

/**
 * Close a plot from the list without opening it. A finished one closes at
 * once (Undo is offered); one still reading or with unapplied edits asks
 * first: the button turns into "Close?" until it is clicked again or left.
 */
const confirming = ref<string>();

function needsConfirm(w: TPlotWindow) {
  return isReading(w) || pendingChanges(w).length > 0;
}

function closeLabel(w: TPlotWindow) {
  if (confirming.value !== w.id) {
    return `Close ${w.label}`;
  }
  return isReading(w)
    ? `Confirm: close ${w.label} and stop reading its data`
    : `Confirm: close ${w.label} and discard its unapplied changes`;
}

async function closeFromList(w: TPlotWindow) {
  if (needsConfirm(w) && confirming.value !== w.id) {
    confirming.value = w.id;
    return;
  }
  confirming.value = undefined;
  const at = analysis.windows.findIndex((entry) => entry.id === w.id);
  analysis.close(w.id, true);
  if (!analysis.windows.length) {
    close(true);
    return;
  }
  // Focus stays in the list: the next row's close button, or the last.
  await nextTick();
  const buttons = panel.value?.querySelectorAll<HTMLButtonElement>(
    ".analysis-open-close"
  );
  buttons?.[Math.min(at, buttons.length - 1)]?.focus();
}

/** Delete or Backspace on a row closes that plot, like its × button. */
function rowKey(event: KeyboardEvent, w: TPlotWindow) {
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    void closeFromList(w);
  }
}

/**
 * The plot in words as it is displayed: the shown result's own query (a
 * new selection is named only once its result arrives), else the commit.
 */
function rowText(w: TPlotWindow) {
  const query = w.result?.query ?? w.committed;
  const summary = displayedSummary(w);
  const name = (query?.variable ?? w.draft.variable).split("/").pop();
  const quantity = w.result?.longName || name;
  const where = query ? describeGeometry(query.geometry) : "";
  const time = summary?.time;
  const range = query?.time;
  let when = "";
  if (time && range) {
    when = TIME_RANGE_KINDS.includes(w.kind)
      ? `${timeLabelAt(time, range.start)} – ${timeLabelAt(time, range.stop - 1)}`
      : timeLabelAt(time, range.start);
  }
  // The level only where it is fixed; profiles span the vertical.
  const level = FIXED_LEVEL_KINDS.includes(w.kind)
    ? levelText(summary?.vertical, query?.level, formatValue)
    : "";
  return {
    title: `${quantity} — ${PLOT_KIND_NAMES[w.kind]}`,
    place: [where, level, when].filter(Boolean).join(" — "),
  };
}

function keys(event: KeyboardEvent) {
  if (!open.value) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    close(true);
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  const items = [
    ...(panel.value?.querySelectorAll<HTMLElement>("button") ?? []),
  ];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0 && !panel.value?.contains(document.activeElement)) {
    return;
  }
  event.preventDefault();
  const step = event.key === "ArrowDown" ? 1 : -1;
  items[(at + step + items.length) % items.length]?.focus();
}

useEventListener(window, "keydown", keys);
useEventListener(window, "pointerdown", (event: PointerEvent) => {
  if (
    open.value &&
    !(event.target as HTMLElement).closest?.(".analysis-plots")
  ) {
    close();
  }
});

// Minimize returns focus to Plots (the window asks for it by class).
watch(
  () => props.hidden,
  (hidden) => hidden && close()
);

// The button keeps its place: nothing it does not own moves it (the distance
// scale has its own corner).
onMounted(firstVisitTip);

/**
 * First visit (with a mouse): one brief tip at the top right on starting a
 * plot from the globe. It is not shown again.
 */
function firstVisitTip() {
  if (analysis.hintSeen || coarse.value) {
    return;
  }
  addToast("Tip: right-click on the globe to plot that spot.", {
    duration: 8000,
    compact: true,
    icon: "right-click",
  });
  analysis.markHintSeen();
}

// Undo for a finished plot that was closed: a brief toast at the top right
// (the app's notifications), one at a time.
const UNDO_MS = 5000;
const { addToast, removeToast } = useToast();
let undoTimer: ReturnType<typeof setTimeout> | undefined;
let undoToast: number | undefined;
watch(
  () => analysis.recentlyClosed,
  (closed) => {
    clearTimeout(undoTimer);
    if (undoToast !== undefined) {
      removeToast(undoToast);
      undoToast = undefined;
    }
    if (closed) {
      undoToast = addToast(`${closed.window.label} closed.`, {
        duration: UNDO_MS,
        compact: true,
        action: { label: "Undo", run: () => analysis.undoClose() },
      });
      undoTimer = setTimeout(
        () => (analysis.recentlyClosed = undefined),
        UNDO_MS
      );
    }
  }
);
onBeforeUnmount(() => clearTimeout(undoTimer));
</script>

<template>
  <div
    v-show="!hidden"
    ref="root"
    class="analysis-plots"
    :class="{ 'is-coarse': coarse }"
  >
    <div
      v-if="open"
      ref="panel"
      class="analysis-panel analysis-plots-menu"
      role="dialog"
      aria-label="Open plots"
    >
      <div class="analysis-launcher-head">
        <span class="analysis-group-title">Open plots</span>
        <span class="analysis-launcher-actions">
          <!-- Always there: with fewer than two series it asks for them. -->
          <button
            type="button"
            class="analysis-new analysis-compare-open"
            data-open-compare
            :title="
              compareLocked
                ? `Compare places: ${compareLocked}`
                : comparable.length >= 2
                  ? `Compare ${comparable.length} time series against a reference: Taylor diagram, bias over time, scatter, Q–Q`
                  : 'Compare places or areas: pick two (or more) and see how their time series differ'
            "
            :aria-disabled="Boolean(compareLocked)"
            @click="openCompare"
          >
            <i
              class="fa-solid mr-1"
              :class="compareLocked ? 'fa-lock' : 'fa-scale-balanced'"
              aria-hidden="true"
            ></i
            >Compare<span class="analysis-compare-count">{{
              comparable.length >= 2 ? comparable.length : "places"
            }}</span>
          </button>
          <button type="button" class="analysis-new" @click="newPlot">
            <i class="fa-solid fa-plus mr-1" aria-hidden="true"></i>New plot
          </button>
        </span>
      </div>
      <div v-if="analysis.compare?.minimized" class="analysis-open-line">
        <button
          type="button"
          class="analysis-menu-item analysis-open-row"
          data-restore-compare
          :aria-label="`Compare plots: ${compareText}, minimized`"
          @click="restoreCompare"
        >
          <span class="analysis-open-id" title="Compare plots">
            <i class="fa-solid fa-scale-balanced" aria-hidden="true"></i>
          </span>
          <span class="analysis-open-text">
            <span class="analysis-open-name">Compare plots</span>
            <span class="analysis-open-place">{{ compareText }}</span>
          </span>
          <span class="analysis-open-state">Minimized</span>
        </button>
        <button
          type="button"
          class="analysis-open-close"
          aria-label="Close Compare plots"
          title="Close Compare plots"
          @click="analysis.compare = undefined"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>
      <div
        v-for="w in analysis.windows"
        :key="w.id"
        class="analysis-open-line"
        @pointerleave="confirming === w.id && (confirming = undefined)"
      >
        <button
          type="button"
          class="analysis-menu-item analysis-open-row"
          :aria-label="`${w.label}: ${rowText(w).title}, ${w.minimized ? minimizedStatus(w) : humanStatus(w)}`"
          @click="restore(w)"
          @keydown="rowKey($event, w)"
        >
          <span
            class="analysis-open-id"
            :title="idMeaning(w.label, PLOT_KIND_NAMES[w.kind])"
            >{{ w.label }}</span
          >
          <span class="analysis-open-text">
            <span class="analysis-open-name">{{ rowText(w).title }}</span>
            <span class="analysis-open-place">{{ rowText(w).place }}</span>
          </span>
          <span class="analysis-open-state">{{
            w.minimized ? minimizedStatus(w) : humanStatus(w)
          }}</span>
        </button>
        <button
          type="button"
          class="analysis-open-close"
          :class="{ 'is-confirming': confirming === w.id }"
          :aria-label="closeLabel(w)"
          :title="closeLabel(w)"
          @click="closeFromList(w)"
          @blur="confirming === w.id && (confirming = undefined)"
        >
          <span v-if="confirming === w.id">Close?</span>
          <i v-else class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>
      <!-- How large reads start, for every plot. -->
      <div class="analysis-launcher-foot">
        <ComputeModeSwitch />
      </div>
    </div>

    <button
      ref="button"
      type="button"
      class="analysis-plots-button"
      :class="{ 'is-open': open || dialOpen }"
      :aria-expanded="open || dialOpen"
      :aria-label="
        count ? `Plotting tools, ${count} open` : 'Plotting tools: new plot'
      "
      @click="toggle"
    >
      <i
        class="fa-solid fa-chart-line analysis-plots-icon"
        aria-hidden="true"
      ></i>
      <span>Plotting tools</span>
      <span v-if="count" class="analysis-badge" aria-hidden="true">{{
        count
      }}</span>
      <i
        class="fa-solid analysis-chevron"
        :class="open || dialOpen ? 'fa-chevron-down' : 'fa-chevron-up'"
        aria-hidden="true"
      ></i>
    </button>
  </div>
</template>

<style scoped>
.analysis-launcher-foot {
  display: flex;
  justify-content: flex-end;
  padding: 8px 10px 6px;
  border-top: 1px solid var(--plot-border);
}
.analysis-plots {
  position: absolute;
  left: max(18px, env(safe-area-inset-left, 0px));
  bottom: max(18px, env(safe-area-inset-bottom, 0px));
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  z-index: 21;
}
.analysis-plots-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  /* Bulma's info colour, as on About: the two map corners read as a set. */
  background: var(--bulma-info);
  color: var(--bulma-info-invert);
  border: 1px solid transparent;
  border-radius: 6px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.analysis-plots-button:hover {
  background: color-mix(in srgb, var(--bulma-info) 90%, black);
}
.is-coarse .analysis-plots-button {
  height: 36px;
  padding: 0 14px;
}
.analysis-plots-button i:first-child {
  font-size: 16px;
}
.analysis-plots-button.is-open {
  background: color-mix(in srgb, var(--bulma-info) 80%, black);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.25);
}
.analysis-plots-button:focus-visible {
  outline: 2px solid var(--plot-accent);
  outline-offset: 2px;
}
.analysis-badge {
  min-width: 1.4em;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bulma-info-invert);
  color: var(--bulma-info);
  font-size: 0.72rem;
  line-height: 1.5;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.analysis-chevron {
  font-size: 0.7rem;
  opacity: 0.7;
}
.analysis-plots-menu {
  width: 340px;
  max-width: calc(100vw - 36px);
  max-height: 60vh;
  overflow: hidden auto;
  padding: 0 0 8px;
}
.analysis-launcher-head {
  position: sticky;
  top: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 4px 0;
  background: var(--plot-bg);
  border-bottom: 1px solid var(--plot-border);
}
/* One line each, icon beside the words (never stacked over them). */
.analysis-new {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
  min-height: 28px;
  padding: 2px 10px;
  border: 1px solid var(--plot-border);
  border-radius: 4px;
  background: none;
  color: var(--plot-accent);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.is-coarse .analysis-new,
.is-coarse .analysis-menu-item {
  min-height: 32px;
}
.analysis-menu-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  min-height: 32px;
  text-align: left;
  padding: 6px 16px;
  background: none;
  border: none;
  color: var(--plot-fg);
  cursor: pointer;
  font: inherit;
}
.analysis-menu-item:hover:not([aria-disabled="true"]),
.analysis-menu-item:focus-visible,
.analysis-new:hover:not([aria-disabled="true"]),
.analysis-new:focus-visible {
  background: var(--plot-hover);
  outline: none;
}
.analysis-menu-item[aria-disabled="true"],
.analysis-new[aria-disabled="true"] {
  color: var(--plot-muted);
  cursor: default;
}
.analysis-menu-reason {
  color: var(--plot-muted);
  font-size: 0.72rem;
}
.analysis-group-title {
  white-space: nowrap;
  padding: 8px 16px 2px;
  font-weight: 600;
  color: var(--plot-muted);
  text-transform: uppercase;
  font-size: 0.68rem;
  letter-spacing: 0.04em;
}
.analysis-family {
  margin-top: 6px;
  font-weight: 600;
}
.analysis-sub {
  padding-left: 32px;
}
/* Right-aligned, also when large text wraps them under the title. */
.analysis-launcher-actions {
  display: inline-flex;
  gap: 4px;
  margin-left: auto;
}
.analysis-open-line {
  display: flex;
  align-items: center;
  min-width: 0;
  padding-right: 8px;
}
.analysis-open-row {
  flex: 1;
  min-width: 0;
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
  padding-right: 6px;
}
/* A quiet × beside each plot: it closes the plot without opening it. */
.analysis-open-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 13px;
  background: none;
  color: var(--plot-muted);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}
.analysis-open-close:hover,
.analysis-open-close:focus-visible {
  background: var(--plot-hover);
  color: var(--plot-fg);
  outline: none;
}
.analysis-open-close:focus-visible {
  border-color: var(--plot-accent);
}
.analysis-open-close.is-confirming {
  color: var(--plot-danger);
  border-color: currentColor;
  font-weight: 600;
}
.is-coarse .analysis-open-close {
  min-width: 32px;
  height: 32px;
  border-radius: 16px;
}
@media (prefers-reduced-motion: reduce) {
  .analysis-open-close {
    transition: none;
  }
}
.analysis-open-id {
  min-width: 1.8rem;
  font-weight: 700;
  color: var(--plot-accent);
}
.analysis-open-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.analysis-open-name,
.analysis-open-place {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.analysis-open-place {
  color: var(--plot-muted);
  font-size: 0.72rem;
}
/* Short ("Ready") on one line; a longer state wraps in its own column
   (at most about two-fifths of the row) instead of hiding the plot's name. */
.analysis-open-state {
  flex: 0 1 auto;
  max-width: 42%;
  color: var(--plot-muted);
  font-size: 0.75rem;
  text-align: right;
  overflow-wrap: anywhere;
}
.analysis-tip {
  margin: 8px 16px 0;
  padding-top: 8px;
  border-top: 1px solid var(--plot-border);
  color: var(--plot-muted);
  font-size: 0.72rem;
}
.analysis-compare-count {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--plot-accent) 18%, transparent);
  font-size: 0.68rem;
  font-weight: 600;
}
</style>
