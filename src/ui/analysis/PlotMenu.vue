<script lang="ts" setup>
import { onClickOutside, useEventListener, useMediaQuery } from "@vueuse/core";
import { computed, nextTick, onMounted, ref, watch } from "vue";

import {
  findCharts,
  SEARCH_EXAMPLES,
  type TFinderEntry,
  type TCompareView,
} from "./chartFinder.ts";
import {
  figuresOf,
  GLYPH_PATHS,
  ICONS,
  placeMenu,
  placeSubmenu,
  quietReason,
  SECTOR_LIST,
  SECTORS,
  type TFigure,
  type TSector,
  type TSectorInfo,
} from "./orbitDial.ts";
import type { TDialChoice } from "./OrbitDial.vue";

import { ANALYSIS_KINDS, type TAnalysisKind } from "@/lib/analysis/types.ts";

/**
 * The right-click menu: five main entries (Point, Path, Box, Polygon,
 * Country), each opening a submenu of its plots, the same ones the Orbit
 * dial offers. The clicked place is the start: a point plot opens there, a
 * path, box or polygon is drawn from it, a country is preselected from it.
 */
const props = defineProps<{
  /** The click, in the map layer's pixels. */
  at: { x: number; y: number };
  area: { width: number; height: number };
  variable: string;
  /** The clicked place (the menu opens only on the map). */
  place: string;
  approximate?: boolean;
  capabilities: Record<TAnalysisKind, string>;
  note: string;
  vertical?: { physical: boolean; label: string; units?: string };
}>();

const emit = defineEmits<{
  choose: [choice: TDialChoice];
  close: [];
  /**
   * One of Compare's charts was found: Compare opens at that view. With
   * `here`, Compare opens with this place's time series as its first pick.
   */
  compare: [view?: TCompareView, here?: boolean];
}>();

const coarse = useMediaQuery("(pointer: coarse)");
const root = ref<HTMLElement>();
const main = ref<HTMLElement>();
const sub = ref<HTMLElement>();
/** The main entry whose submenu is open. */
const open = ref<TSector>();
const MAIN_WIDTH = 236;
const SUB_WIDTH = 300;
/** Find a chart: typed in the header, results in place of the entries. */
const query = ref("");
const search = ref<HTMLInputElement>();
const results = computed(() => findCharts(query.value, 6));
const searching = computed(() => Boolean(query.value.trim()));

function reason(kind: TAnalysisKind) {
  return quietReason(props.note || props.capabilities[kind] || "");
}

/** Compare from here needs this place's time series. */
const compareReason = computed(() => reason(ANALYSIS_KINDS.POINT_SERIES));

function sectorReason(id: TSector) {
  const reasons = figuresOf(id, props.vertical).map((f) => reason(f.kind));
  return reasons.every(Boolean) ? reasons[0] : "";
}

const openInfo = computed(() => SECTOR_LIST.find((s) => s.id === open.value));
const openFigures = computed(() =>
  open.value ? figuresOf(open.value, props.vertical) : []
);

/**
 * The menu at the click (flipped only at the map's edges); `beside` says
 * whether its submenu fits next to it, else the submenu takes its place.
 */
const mainBox = computed(() =>
  placeMenu(
    props.at,
    {
      w: MAIN_WIDTH,
      h: 96 + SECTOR_LIST.length * (coarse.value ? 52 : 46),
    },
    SUB_WIDTH,
    props.area
  )
);
const wide = computed(() => mainBox.value.beside);

/** The submenu beside its entry: to the right when it fits, else left. */
const subBox = ref({ x: 0, y: 0, w: SUB_WIDTH });
function placeSub() {
  const item = main.value?.querySelector<HTMLElement>(
    `[data-entry="${open.value}"]`
  );
  const host = root.value?.parentElement?.getBoundingClientRect();
  if (!item || !host) {
    return;
  }
  // Beside the whole menu (not its entry, which is inset by the padding);
  // with no room beside, in the menu's place, with Back.
  const menu = main.value!.getBoundingClientRect();
  subBox.value = placeSubmenu(
    {
      left: menu.left - host.left,
      right: menu.right - host.left,
      top: menu.top - host.top,
    },
    item.getBoundingClientRect().top - host.top,
    { w: SUB_WIDTH, h: sub.value?.offsetHeight ?? 260 },
    props.area,
    wide.value
  );
}

// The map can change size with a submenu open (a rotated phone, a panel).
watch(
  () => [props.area.width, props.area.height],
  () => open.value && nextTick(placeSub)
);

async function openEntry(id: TSector, focus = false) {
  if (sectorReason(id)) {
    return;
  }
  open.value = id;
  await nextTick();
  placeSub();
  if (focus) {
    sub.value
      ?.querySelector<HTMLElement>(".plot-menu-row:not([aria-disabled='true'])")
      ?.focus();
  }
}

/** What a row does from this click. */
function primaryAction(info: TSectorInfo): TDialChoice["action"] {
  if (info.id === SECTORS.COUNTRY) {
    return "country";
  }
  return info.id === SECTORS.POINT ? "here" : "draw";
}

function rowLabel(info: TSectorInfo) {
  switch (primaryAction(info)) {
    case "here":
      return "Opens at the clicked place";
    case "country":
      return "Choose the country (the one here preselected)";
    default:
      return info.id === SECTORS.BOX
        ? "Drag on the map to draw it"
        : `Draw from the clicked place (${info.origin})`;
  }
}

/** Whether a found chart can be made here. */
function entryReason(entry: TFinderEntry) {
  return sectorReason(entry.sector) || reason(entry.kind);
}

/** A found chart, from the clicked place: as its place's row would. */
function chooseEntry(entry: TFinderEntry) {
  const info = SECTOR_LIST.find((s) => s.id === entry.sector);
  if (!info || entryReason(entry)) {
    return;
  }
  if (entry.compare) {
    emit("compare", entry.compare);
    return;
  }
  emit("choose", {
    kind: entry.kind,
    mode: info.mode,
    action: primaryAction(info),
    ...(entry.turnOn ? { turnOn: entry.turnOn } : {}),
  });
}

/** Enter takes the first result, Down moves into them, Escape clears. */
function searchKeys(event: KeyboardEvent) {
  if (event.key === "Escape" && query.value) {
    event.stopPropagation();
    query.value = "";
  } else if (event.key === "Enter" && searching.value) {
    event.preventDefault();
    const first = results.value.find((entry) => !entryReason(entry));
    if (first) {
      chooseEntry(first);
    }
  } else if (event.key === "ArrowDown" && results.value.length) {
    event.preventDefault();
    main.value?.querySelector<HTMLElement>(".plot-menu-result")?.focus();
  }
}

/** Typing a letter on an entry starts a search with it. */
function typeAhead(event: KeyboardEvent) {
  if (
    event.key.length === 1 &&
    /\S/.test(event.key) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    event.preventDefault();
    open.value = undefined;
    query.value += event.key;
    search.value?.focus();
    return true;
  }
  return false;
}

function choose(figure: TFigure, action?: TDialChoice["action"]) {
  const info = openInfo.value;
  if (!info || reason(figure.kind)) {
    return;
  }
  emit("choose", {
    kind: figure.kind,
    mode: info.mode,
    action: action ?? primaryAction(info),
  });
}

function entries() {
  return [
    ...(main.value?.querySelectorAll<HTMLElement>(
      ".plot-menu-entry:not([aria-disabled='true'])"
    ) ?? []),
  ];
}

function rows() {
  return [
    ...(sub.value?.querySelectorAll<HTMLElement>(
      ".plot-menu-row:not([aria-disabled='true'])"
    ) ?? []),
  ];
}

function resultRows() {
  return [
    ...(main.value?.querySelectorAll<HTMLElement>(
      ".plot-menu-result:not([aria-disabled='true'])"
    ) ?? []),
  ];
}

function move(list: HTMLElement[], step: number) {
  const at = list.indexOf(document.activeElement as HTMLElement);
  list[(at + step + list.length) % list.length]?.focus();
}

/** Up/Down move, Right/Enter open a submenu, Left/Escape go back. */
function mainKeys(event: KeyboardEvent, id: TSector) {
  if (typeAhead(event)) {
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    move(entries(), event.key === "ArrowDown" ? 1 : -1);
  } else if (
    event.key === "ArrowRight" ||
    event.key === "Enter" ||
    event.key === " "
  ) {
    event.preventDefault();
    void openEntry(id, true);
  }
}

/** Back to the main entries (Left, Escape, or Back on a narrow map). */
function back() {
  const id = open.value;
  open.value = undefined;
  void nextTick(() =>
    main.value?.querySelector<HTMLElement>(`[data-entry="${id}"]`)?.focus()
  );
}

function subKeys(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    move(rows(), event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    back();
  }
}

useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (event.key !== "Escape") {
    return;
  }
  event.preventDefault();
  if (open.value) {
    back();
  } else {
    emit("close");
  }
});
onClickOutside(root, () => emit("close"), { ignore: [".plot-menu-sub"] });

onMounted(() => entries()[0]?.focus());
</script>

<template>
  <div ref="root" class="plot-menu-host">
    <div
      ref="main"
      class="plot-menu"
      :class="{ coarse }"
      role="menu"
      :aria-label="`New plot at ${place}`"
      :style="{
        left: `${mainBox.x}px`,
        top: `${mainBox.y}px`,
        width: `${MAIN_WIDTH}px`,
      }"
    >
      <div class="plot-menu-head">
        <span class="plot-menu-title">
          <span class="plot-menu-variable">{{ variable }}</span>
          <button
            type="button"
            class="plot-menu-compare"
            data-menu-compare
            :disabled="Boolean(compareReason)"
            :aria-label="
              compareReason ||
              'Compare: this place\'s time series against others you pick'
            "
            :title="
              compareReason ||
              'Compare: this place\'s time series against others you pick'
            "
            @click="emit('compare', undefined, true)"
          >
            <i class="fa-solid fa-scale-balanced" aria-hidden="true"></i>
            <span class="plot-menu-compare-label">Compare</span>
          </button>
        </span>
        <span class="plot-menu-place">{{ place }}</span>
        <span v-if="approximate" class="plot-menu-place"
          >Picking is approximate in this projection.</span
        >
        <label class="plot-menu-search">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
          <input
            ref="search"
            v-model="query"
            type="search"
            placeholder="Find a chart…"
            aria-label="Find a chart"
            autocomplete="off"
            @input="open = undefined"
            @keydown="searchKeys"
          />
        </label>
      </div>
      <template v-if="searching">
        <p v-if="!results.length" class="plot-menu-none">
          No chart matches “{{ query.trim() }}”. Try
          <template v-for="(example, k) in SEARCH_EXAMPLES" :key="example">
            <button
              type="button"
              class="plot-menu-example"
              @click="query = example"
            >
              {{ example }}</button>{{
              k < SEARCH_EXAMPLES.length - 1 ? ", " : "."
            }}
          </template>
        </p>
        <button
          v-for="entry in results"
          :key="`${entry.title}|${entry.where}`"
          type="button"
          class="plot-menu-entry plot-menu-result"
          role="menuitem"
          :aria-disabled="Boolean(entryReason(entry))"
          @click="chooseEntry(entry)"
          @keydown.down.prevent="move(resultRows(), 1)"
          @keydown.up.prevent="move(resultRows(), -1)"
        >
          <svg
            class="plot-menu-icon"
            viewBox="-12 -12 24 24"
            aria-hidden="true"
          >
            <path :d="ICONS[entry.sector]" />
          </svg>
          <span class="plot-menu-text">
            <span class="plot-menu-label">{{ entry.title }}</span>
            <span class="plot-menu-cue">{{
              entryReason(entry) || entry.where
            }}</span>
          </span>
          <i
            class="fa-solid plot-menu-more"
            :class="entryReason(entry) ? 'fa-lock' : 'fa-chevron-right'"
            aria-hidden="true"
          ></i>
        </button>
      </template>
      <p v-if="note" class="plot-menu-note">{{ note }}</p>
      <button
        v-for="s in searching ? [] : SECTOR_LIST"
        :key="s.id"
        type="button"
        class="plot-menu-entry"
        role="menuitem"
        aria-haspopup="menu"
        :data-entry="s.id"
        :aria-expanded="open === s.id"
        :aria-disabled="Boolean(sectorReason(s.id))"
        :class="{ active: open === s.id }"
        :title="sectorReason(s.id) || undefined"
        @pointerenter="wide && openEntry(s.id)"
        @click="openEntry(s.id, true)"
        @keydown="mainKeys($event, s.id)"
      >
        <svg class="plot-menu-icon" viewBox="-12 -12 24 24" aria-hidden="true">
          <path :d="ICONS[s.id]" />
        </svg>
        <span class="plot-menu-text">
          <span class="plot-menu-label">{{ s.label }}</span>
          <span class="plot-menu-cue">{{ sectorReason(s.id) || s.cue }}</span>
        </span>
        <i
          class="fa-solid plot-menu-more"
          :class="sectorReason(s.id) ? 'fa-lock' : 'fa-chevron-right'"
          aria-hidden="true"
        ></i>
      </button>
    </div>

    <div
      v-if="openInfo"
      ref="sub"
      class="plot-menu plot-menu-sub"
      :class="{ coarse }"
      role="menu"
      :aria-label="`${openInfo.label} plots`"
      :style="{
        left: `${subBox.x}px`,
        top: `${subBox.y}px`,
        width: `${subBox.w}px`,
      }"
      @keydown="subKeys"
    >
      <button
        v-if="!wide"
        type="button"
        class="plot-menu-row plot-menu-back"
        role="menuitem"
        @click="back"
      >
        <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
        <span class="plot-menu-label">Back</span>
      </button>
      <div class="plot-menu-sub-head">
        {{ openInfo.label }} |
        <span class="plot-menu-cue">{{ rowLabel(openInfo) }}</span>
      </div>
      <div
        v-for="figure in openFigures"
        :key="figure.kind"
        class="plot-menu-line"
      >
        <button
          type="button"
          class="plot-menu-row"
          role="menuitem"
          :aria-disabled="Boolean(reason(figure.kind))"
          @click="choose(figure)"
        >
          <svg class="plot-menu-glyph" viewBox="0 0 24 24" aria-hidden="true">
            <path :d="GLYPH_PATHS[figure.glyph]" />
          </svg>
          <span class="plot-menu-text">
            <span class="plot-menu-label">{{ figure.title }}</span>
            <span class="plot-menu-cue">{{
              reason(figure.kind) || figure.help
            }}</span>
          </span>
          <i
            v-if="reason(figure.kind)"
            class="fa-solid fa-lock plot-menu-more"
            aria-hidden="true"
          ></i>
        </button>
        <button
          v-if="openInfo.id !== SECTORS.COUNTRY && !reason(figure.kind)"
          type="button"
          class="plot-menu-type"
          role="menuitem"
          :aria-label="`${figure.title}: enter coordinates`"
          title="Enter coordinates"
          @click="choose(figure, 'enter')"
        >
          <i class="fa-solid fa-keyboard" aria-hidden="true"></i>
        </button>
        <button
          v-if="openInfo.id === SECTORS.POLYGON && !reason(figure.kind)"
          type="button"
          class="plot-menu-type"
          role="menuitem"
          :aria-label="`${figure.title}: import a shape file`"
          title="Import a shape (GeoJSON, KML, Shapefile)"
          @click="choose(figure, 'import')"
        >
          <i class="fa-solid fa-file-arrow-up" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plot-menu-host {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 22;
}
.plot-menu {
  position: absolute;
  display: flex;
  flex-direction: column;
  padding: 6px;
  background: var(--plot-bg);
  color: var(--plot-fg);
  border: 1px solid var(--plot-border);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.28);
  pointer-events: auto;
}
.plot-menu-head {
  display: flex;
  flex-direction: column;
  padding: 4px 8px 8px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--plot-border);
  color: var(--plot-muted);
  font-size: 0.75rem;
}
/* The variable, and a slim Compare at the right of its line. */
.plot-menu-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.plot-menu-title .plot-menu-variable {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plot-menu-compare {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--plot-border);
  border-radius: 4px;
  background: none;
  color: var(--plot-accent);
  font: inherit;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
}
.plot-menu-compare:hover:not(:disabled) {
  background: var(--plot-hover);
}
.plot-menu-compare:disabled {
  color: var(--plot-muted);
  cursor: not-allowed;
}
/* A touch screen: the icon alone (its name is its label). */
@media (pointer: coarse) {
  .plot-menu-compare {
    height: 30px;
    padding: 0 9px;
  }
  .plot-menu-compare-label {
    display: none;
  }
}
.plot-menu-variable {
  color: var(--plot-fg);
  font-weight: 600;
  font-size: 0.85rem;
}
/* Find a chart: a small field under the place. */
.plot-menu-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  min-height: 28px;
  padding: 0 6px;
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  background: var(--plot-raised);
}
.plot-menu-search:focus-within {
  border-color: var(--plot-accent);
}
.plot-menu-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--plot-fg);
  font: inherit;
  font-size: 0.8rem;
}
.coarse .plot-menu-search {
  min-height: 44px;
}
.plot-menu-none {
  margin: 4px 8px 6px;
  color: var(--plot-muted);
  font-size: 0.8rem;
}
.plot-menu-note {
  margin: 0 8px 6px;
  color: var(--plot-warn);
  font-size: 0.75rem;
}
.plot-menu-entry,
.plot-menu-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 42px;
  padding: 4px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.coarse .plot-menu-entry,
.coarse .plot-menu-row,
.coarse .plot-menu-type {
  min-height: 48px;
}
.plot-menu-entry:hover,
.plot-menu-entry.active,
.plot-menu-row:hover {
  background: var(--plot-hover);
}
.plot-menu-entry:focus-visible,
.plot-menu-row:focus-visible,
.plot-menu-type:focus-visible {
  outline: 2px solid var(--plot-accent);
  outline-offset: -2px;
}
/* Locked: dimmed, a padlock at the end, the reason in place of the cue. */
.plot-menu-entry[aria-disabled="true"],
.plot-menu-row[aria-disabled="true"] {
  color: var(--plot-muted);
  cursor: not-allowed;
}
[aria-disabled="true"] > .plot-menu-icon,
[aria-disabled="true"] > .plot-menu-glyph,
[aria-disabled="true"] .plot-menu-label {
  opacity: 0.5;
}
.plot-menu-entry[aria-disabled="true"]:hover,
.plot-menu-row[aria-disabled="true"]:hover {
  background: transparent;
}
.plot-menu-icon,
.plot-menu-glyph {
  flex: 0 0 22px;
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.plot-menu-entry.active .plot-menu-icon {
  stroke: var(--plot-accent);
}
.plot-menu-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.plot-menu-label {
  font-weight: 600;
  font-size: 0.85rem;
}
.plot-menu-cue {
  color: var(--plot-muted);
  font-size: 0.72rem;
  line-height: 1.25;
}
.plot-menu-more {
  color: var(--plot-muted);
  font-size: 0.7rem;
}
.plot-menu-sub-head {
  padding: 4px 8px 8px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--plot-border);
  font-weight: 600;
  font-size: 0.8rem;
}
.plot-menu-back {
  min-height: 34px;
  color: var(--plot-muted);
}
.plot-menu-line {
  display: flex;
  align-items: stretch;
  gap: 2px;
}
.plot-menu-type {
  flex: 0 0 34px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--plot-muted);
  cursor: pointer;
}
.plot-menu-type:hover {
  background: var(--plot-hover);
  color: var(--plot-fg);
}
.plot-menu-example {
  padding: 0;
  border: 0;
  background: none;
  color: var(--plot-accent, #2563eb);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
</style>
