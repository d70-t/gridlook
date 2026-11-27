<script lang="ts" setup>
import {
  useEventListener,
  useMediaQuery,
  useResizeObserver,
} from "@vueuse/core";
import { computed, nextTick, onMounted, ref, watch } from "vue";

import {
  findCharts,
  type TCompareView,
  type TFinderEntry,
  type TTurnOn,
} from "./chartFinder.ts";
import {
  beadAt,
  bezelPaths,
  DIAL_MOTION,
  figuresOf,
  GLYPH_PATHS,
  ICONS,
  LOCK_ICON,
  nextBeadTurn,
  placeDial,
  quietReason,
  RING,
  SECTOR_LIST,
  SECTORS,
  wedgeCentre,
  wedgePath,
  type TBox,
  type TFigure,
  type TSector,
  type TSectorInfo,
} from "./orbitDial.ts";

import type { TAnalysisKind } from "@/lib/analysis/types.ts";
import type { TDrawMode } from "@/store/analysisStore.ts";
import RightClickMouse from "@/ui/common/RightClickMouse.vue";

/** A chosen plot: draw it on the map, type its coordinates, or pick a country. */
export type TDialChoice = {
  kind: TAnalysisKind;
  mode?: TDrawMode;
  action: "here" | "draw" | "enter" | "country" | "import";
  /** From a found or suggested chart: the switch set as it opens. */
  turnOn?: TTurnOn;
};

const props = defineProps<{
  /** The Plotting tools button, in the map layer's pixels. */
  button: TBox;
  /** Where the dial grows from and folds back into: the button's icon. */
  growOrigin: { x: number; y: number };
  area: { width: number; height: number };
  variable: string;
  capabilities: Record<TAnalysisKind, string>;
  /** One reason when nothing can be plotted at all. */
  note: string;
  vertical?: { physical: boolean; label: string; units?: string };
  /** Charts suited to the data shown, from its metadata. */
  suggestions?: TFinderEntry[];
  /** Why Compare cannot start ("" when it can). */
  compareReason?: string;
}>();

const emit = defineEmits<{
  choose: [choice: TDialChoice];
  /**
   *  Compare places or areas (opens Compare, which asks for them), at a
   * view when a found chart is one of Compare's.
   */
  compare: [view?: TCompareView];
  /** The closing motion has finished: unmount. */
  closed: [];
}>();

const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
const coarse = useMediaQuery("(pointer: coarse)");
const panel = ref<HTMLElement>();
const content = ref<HTMLElement>();
const opened = ref(false);
const sector = ref<TSector>(SECTORS.POINT);
const focusedSector = ref<TSector>(SECTORS.POINT);
const hovered = ref<TSector>();
const pressing = ref<TSector>();
const picked = ref<TAnalysisKind>();
/** Find a chart: the query and the charts it finds. */
const query = ref("");
const results = computed(() => findCharts(query.value));

/** The most figures any geometry offers: the list keeps that height. */
const LIST_SLOTS = 6;

const narrow = computed(() => props.area.width < 640);
const measured = ref(0);
const size = computed(() => {
  const w = narrow.value ? Math.min(380, props.area.width - 16) : 600;
  return { w, h: measured.value || (narrow.value ? 640 : 420) };
});
// The dial is as tall as its content (borders included), up to the room.
useResizeObserver(content, () => {
  measured.value = (content.value?.offsetHeight ?? 0) + 2;
});
const box = computed(() => placeDial(props.button, size.value, props.area));
const info = computed(
  () => SECTOR_LIST.find((s) => s.id === sector.value) as TSectorInfo
);
const figures = computed(() => figuresOf(sector.value, props.vertical));
// A pick stays usable only while its plot is available (capabilities
// can arrive after it was made): the footer acts on nothing otherwise.
const pickedFigure = computed(() =>
  figures.value.find((f) => f.kind === picked.value && !reason(f.kind))
);
const growFrom = computed(() => ({
  x: props.growOrigin.x - box.value.x,
  y: props.growOrigin.y - box.value.y,
}));

function reason(kind: TAnalysisKind) {
  return quietReason(props.note || props.capabilities[kind] || "");
}

function sectorReason(id: TSector) {
  const reasons = figuresOf(id, props.vertical).map((f) => reason(f.kind));
  return reasons.every(Boolean) ? reasons[0] : "";
}

/** How far a piece stands above the ring (px). */
/** Copies of a key's outline that, stacked, draw its sidewall. */
const SIDE_STEPS = 8;

/** The raised key is drawn last, so its shadow falls on its neighbours. */
const pieceOrder = computed(() => [
  ...SECTOR_LIST.filter((s) => s.id !== sector.value),
  ...SECTOR_LIST.filter((s) => s.id === sector.value),
]);

function lift(id: TSector) {
  if (pressing.value === id) {
    return 0.5;
  }
  if (id === sector.value) {
    return 3.5;
  }
  return hovered.value === id && !sectorReason(id) ? 1.5 : 0;
}

onMounted(() => {
  const first = SECTOR_LIST.find((s) => !sectorReason(s.id));
  sector.value = first?.id ?? SECTORS.POINT;
  focusedSector.value = sector.value;
  requestAnimationFrame(() => {
    opened.value = true;
    void nextTick(() => sectorButton(sector.value)?.focus());
  });
});

/** Close, or reverse an opening still under way; `closed` follows. */
function close() {
  opened.value = false;
  if (reduced.value) {
    setTimeout(() => emit("closed"), DIAL_MOTION.reduced);
  }
}

function transitionEnd(event: TransitionEvent) {
  if (event.target === panel.value && !opened.value && !reduced.value) {
    emit("closed");
  }
}

/** A click presses the piece briefly, then it settles raised. */
function selectSector(id: TSector) {
  if (sectorReason(id)) {
    return;
  }
  if (id !== sector.value) {
    picked.value = undefined;
  }
  sector.value = id;
  focusedSector.value = id;
  if (!reduced.value) {
    pressing.value = id;
    setTimeout(() => {
      if (pressing.value === id) {
        pressing.value = undefined;
      }
    }, 110);
  }
}

function sectorButton(id: TSector) {
  return panel.value?.querySelector<SVGPathElement>(`[data-sector="${id}"]`);
}

/** Arrow keys walk the ring (roving focus); Enter or Space locks it. */
function ringKeys(event: KeyboardEvent) {
  const order = SECTOR_LIST.map((s) => s.id);
  const at = order.indexOf(focusedSector.value);
  const step =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
  if (step) {
    event.preventDefault();
    focusedSector.value = order[(at + step + order.length) % order.length];
    sectorButton(focusedSector.value)?.focus();
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectSector(focusedSector.value);
  }
}

/**
 * A row is picked; the fixed footer then acts on it. A country has one way
 * to choose its place: the row goes straight to the map's country picker
 * (24 Nov: "Choose country" was a second click with nothing to decide).
 */
function pick(figure: TFigure) {
  if (reason(figure.kind)) {
    return;
  }
  picked.value = figure.kind;
  if (isCountry.value) {
    emit("choose", {
      kind: figure.kind,
      mode: info.value.mode,
      action: "country",
    });
  }
}

/** Whether a found or suggested chart can be made here. */
function entryReason(entry: TFinderEntry) {
  return sectorReason(entry.sector) || reason(entry.kind);
}

/**
 * A found or suggested chart goes straight to the map: click the point,
 * draw the path, box or polygon, or choose the country. The switch it is
 * (anomaly, barbs…) travels with it and is set as the new plot opens.
 */
/** Where a found chart lives. */
function entryHint(entry: TFinderEntry) {
  return entry.where;
}

function chooseEntry(entry: TFinderEntry) {
  if (entryReason(entry)) {
    return;
  }
  if (entry.compare) {
    emit("compare", entry.compare);
    return;
  }
  const place = SECTOR_LIST.find((s) => s.id === entry.sector)!;
  emit("choose", {
    kind: entry.kind,
    mode: place.mode,
    action: entry.sector === SECTORS.COUNTRY ? "country" : "draw",
    ...(entry.turnOn ? { turnOn: entry.turnOn } : {}),
  });
}

/** Enter takes the first result, Down moves into them, Escape clears. */
function searchKeys(event: KeyboardEvent) {
  if (event.key === "Escape" && query.value) {
    event.stopPropagation();
    query.value = "";
  } else if (event.key === "Enter" && results.value.length) {
    event.preventDefault();
    const first = results.value.find((entry) => !entryReason(entry));
    if (first) {
      chooseEntry(first);
    }
  } else if (event.key === "ArrowDown" && results.value.length) {
    event.preventDefault();
    content.value?.querySelector<HTMLButtonElement>(".dial-result")?.focus();
  }
}

/** The glyph of a found chart's plot. */
function glyphOf(entry: TFinderEntry) {
  const figure = figuresOf(entry.sector, props.vertical).find(
    (f) => f.kind === entry.kind
  );
  return GLYPH_PATHS[figure?.glyph ?? "line"];
}

/** The plot rows are a radio group: arrows move to and pick a row. */
function rowKeys(event: KeyboardEvent) {
  // A country row starts choosing at once: arrows only move to it there.
  arrowTo(event, ".dial-row:not([aria-disabled='true'])", !isCountry.value);
}

/**
 * Charts found are a list of actions: arrows only move between them;
 * Enter or Space starts one (an arrow never starts drawing).
 */
function resultKeys(event: KeyboardEvent) {
  arrowTo(event, ".dial-result:not([aria-disabled='true'])", false);
}

function arrowTo(event: KeyboardEvent, selector: string, pickToo: boolean) {
  const step = ["ArrowDown", "ArrowRight"].includes(event.key)
    ? 1
    : ["ArrowUp", "ArrowLeft"].includes(event.key)
      ? -1
      : 0;
  if (!step) {
    return;
  }
  event.preventDefault();
  const rows = [
    ...(content.value?.querySelectorAll<HTMLButtonElement>(selector) ?? []),
  ];
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = rows[(at + step + rows.length) % rows.length];
  next?.focus();
  if (pickToo) {
    next?.click();
  }
}

function act(action: "draw" | "enter" | "import") {
  if (!pickedFigure.value) {
    return;
  }
  emit("choose", {
    kind: pickedFigure.value.kind,
    mode: info.value.mode,
    action,
  });
}

const isCountry = computed(() => sector.value === SECTORS.COUNTRY);

useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (event.key === "Escape" && opened.value) {
    event.preventDefault();
    close();
  }
});

// A finished summary can make the active geometry, or the picked plot,
// unusable.
watch(
  () => props.capabilities,
  () => {
    if (picked.value && reason(picked.value)) {
      picked.value = undefined;
    }
    if (sectorReason(sector.value)) {
      const first = SECTOR_LIST.find((s) => !sectorReason(s.id));
      if (first) {
        selectSector(first.id);
      }
    }
  }
);

const C = RING.size / 2;
const bezel = computed(() => bezelPaths(info.value.angle));
// The bead turns the short way round to the chosen piece.
const beadTurn = ref(SECTOR_LIST[0].angle);
watch(
  () => info.value.angle,
  (angle) => {
    beadTurn.value = nextBeadTurn(beadTurn.value, angle);
  },
  { immediate: true }
);
const beadTop = beadAt(0);

defineExpose({ close, isOpen: () => opened.value });
</script>

<template>
  <div
    ref="panel"
    class="orbit-dial"
    :class="{ open: opened, reduced, narrow, coarse }"
    role="dialog"
    aria-label="New plot"
    :style="{
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.w}px`,
      maxHeight: `${box.h}px`,
      '--grow-x': `${growFrom.x}px`,
      '--grow-y': `${growFrom.y}px`,
      '--open-ms': `${DIAL_MOTION.open}ms`,
      '--close-ms': `${DIAL_MOTION.close}ms`,
      '--fade-ms': `${DIAL_MOTION.reduced}ms`,
    }"
    @transitionend="transitionEnd"
  >
    <div ref="content" class="dial-content">
      <header class="dial-head">
        <div class="dial-context">
          <span class="dial-variable">{{ variable }}</span>
          <span class="dial-place">New plot</span>
        </div>
        <label class="dial-search">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
          <input
            v-model="query"
            type="search"
            placeholder="Find a chart: rose, Taylor, anomaly…"
            aria-label="Find a chart"
            autocomplete="off"
            @keydown="searchKeys"
          />
        </label>
        <button
          type="button"
          class="dial-close"
          aria-label="Close the plot chooser"
          @click="close"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </header>
      <p v-if="note" class="dial-note">{{ note }}</p>

      <div class="dial-body">
        <!-- The ring, and under it the charts suggested for this data. -->
        <div class="dial-left">
          <svg
            class="dial-ring"
            :viewBox="`0 0 ${RING.size} ${RING.size}`"
            role="radiogroup"
            aria-label="Where to sample"
            @keydown="ringKeys"
          >
            <defs>
              <radialGradient id="dial-rim" cx="38%" cy="32%" r="75%">
                <stop offset="0%" class="stop-rim-light" />
                <stop offset="100%" class="stop-rim-dark" />
              </radialGradient>
              <radialGradient id="dial-hub" cx="50%" cy="50%" r="50%">
                <stop offset="70%" class="stop-hub" />
                <stop offset="100%" class="stop-hub-edge" />
              </radialGradient>
              <!-- The raised key's top edge catches the light; its foot does not. -->
              <linearGradient id="dial-bevel" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" class="stop-bevel-top" />
                <stop offset="70%" class="stop-bevel-bottom" />
              </linearGradient>
              <linearGradient id="dial-face" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" class="stop-face-light" />
                <stop offset="100%" class="stop-face-dark" />
              </linearGradient>
              <!-- A raised key catches more light: the same face, brighter. -->
              <linearGradient id="dial-face-raised" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" class="stop-raised-light" />
                <stop offset="100%" class="stop-raised-dark" />
              </linearGradient>
              <filter
                id="dial-glow"
                x="-200%"
                y="-200%"
                width="500%"
                height="500%"
              >
                <feGaussianBlur stdDeviation="1.1" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter
                id="dial-soft"
                x="-20%"
                y="-20%"
                width="140%"
                height="140%"
              >
                <feGaussianBlur stdDeviation="2.4" />
              </filter>
            </defs>

            <!-- One continuous rim and the recessed base the pieces sit in. -->
            <circle :cx="C" :cy="C" :r="RING.rim" class="dial-rim" />
            <circle
              :cx="C"
              :cy="C"
              :r="RING.rim - 2.5"
              class="bezel-groove-ring"
            />
            <circle
              :cx="C"
              :cy="C"
              :r="RING.outer + 3"
              class="bezel-groove-ring"
            />
            <!-- The bezel's engraved scale; the chosen piece's ticks light up. -->
            <path :d="bezel.lip" class="bezel-lip" />
            <path :d="bezel.groove" class="bezel-tick" />
            <path :d="bezel.lit" class="bezel-tick lit" />
            <g
              class="bezel-bead"
              :style="{
                transform: `rotate(${beadTurn}deg)`,
                transformOrigin: `${C}px ${C}px`,
              }"
            >
              <circle :cx="beadTop.x" :cy="beadTop.y" r="2.6" />
            </g>
            <circle :cx="C" :cy="C" :r="RING.outer + 1.5" class="dial-base" />

            <g
              v-for="s in pieceOrder"
              :key="s.id"
              class="dial-piece"
              :class="{
                raised: s.id === sector,
                unavailable: Boolean(sectorReason(s.id)),
              }"
              :data-piece="s.id"
              :style="{
                '--lift': `${lift(s.id)}px`,
                '--shadow': lift(s.id) * 0.09,
              }"
            >
              <path :d="wedgePath(s.angle)" class="piece-shadow" />
              <!-- The sidewall: the face swept down to the base, a solid key. -->
              <path
                v-for="k in SIDE_STEPS"
                :key="k"
                :d="wedgePath(s.angle)"
                class="piece-side"
                :style="{ '--k': (k - 1) / SIDE_STEPS }"
              />
              <g class="piece-top">
                <path :d="wedgePath(s.angle)" class="piece-face" />
                <g
                  :transform="`translate(${wedgeCentre(s.angle).x} ${wedgeCentre(s.angle).y - 7})`"
                >
                  <path
                    :d="sectorReason(s.id) ? LOCK_ICON : ICONS[s.id]"
                    class="piece-icon"
                  />
                </g>
                <text
                  :x="wedgeCentre(s.angle).x"
                  :y="wedgeCentre(s.angle).y + 14"
                  class="piece-label"
                >
                  {{ s.label }}
                </text>
              </g>
            </g>

            <!-- The recessed hub: only the active geometry's icon. -->
            <circle :cx="C" :cy="C" :r="RING.hub" class="dial-hub" />
            <g :transform="`translate(${C} ${C})`">
              <path :d="ICONS[sector]" class="hub-icon" />
            </g>

            <!-- Stationary hit areas over everything: hover stays smooth. -->
            <path
              v-for="s in SECTOR_LIST"
              :key="`hit-${s.id}`"
              :d="wedgePath(s.angle)"
              class="piece-hit"
              role="radio"
              :data-sector="s.id"
              :aria-checked="s.id === sector"
              :aria-disabled="Boolean(sectorReason(s.id))"
              :aria-label="`${s.label}: ${s.cue}${sectorReason(s.id) ? `. ${sectorReason(s.id)}` : ''}`"
              :tabindex="s.id === focusedSector ? 0 : -1"
              @pointerenter="hovered = s.id"
              @pointerleave="hovered === s.id && (hovered = undefined)"
              @click="selectSector(s.id)"
              @focus="focusedSector = s.id"
            />
          </svg>
          <section class="dial-suggest" aria-label="Suggested for this data">
            <span class="dial-suggest-title">{{
              suggestions?.length ? "Suggested for this data" : "Also"
            }}</span>
            <!-- Compare is a plot too: two places or areas, side by side. -->
            <button
              type="button"
              class="dial-chip dial-compare"
              data-dial-compare
              :title="
                compareReason
                  ? `Compare places: ${compareReason}`
                  : 'Pick two or more places or areas and compare their time series (Taylor diagram, bias, scatter, Q–Q)'
              "
              :aria-disabled="Boolean(compareReason)"
              @click="compareReason || emit('compare')"
            >
              <i
                class="fa-solid mr-1"
                :class="compareReason ? 'fa-lock' : 'fa-scale-balanced'"
                aria-hidden="true"
              ></i
              >Compare places
            </button>
            <button
              v-for="entry in suggestions"
              :key="entry.title"
              type="button"
              class="dial-chip"
              :title="entryHint(entry)"
              :aria-disabled="Boolean(entryReason(entry))"
              @click="chooseEntry(entry)"
            >
              <svg
                class="dial-chip-glyph"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path :d="glyphOf(entry)" />
              </svg>
              {{ entry.title }}
            </button>
          </section>
        </div>

        <div class="dial-choices">
          <div v-if="query.trim()" class="dial-list-head">
            <span class="dial-list-title">Charts</span>
            <span class="dial-list-cue">{{
              results.length
                ? "Pick one to start it on the map"
                : `None match “${query.trim()}”: try “time series”, “cross-section” or “anomaly”`
            }}</span>
          </div>
          <div
            v-if="query.trim()"
            class="dial-figures"
            role="list"
            aria-label="Charts found"
            :style="{ '--slots': LIST_SLOTS }"
            @keydown="resultKeys"
          >
            <button
              v-for="entry in results"
              :key="`${entry.title}|${entry.where}`"
              type="button"
              role="listitem"
              class="dial-row dial-result"
              :aria-disabled="Boolean(entryReason(entry))"
              @click="chooseEntry(entry)"
            >
              <svg class="dial-glyph" viewBox="0 0 24 24" aria-hidden="true">
                <path :d="glyphOf(entry)" />
              </svg>
              <span class="dial-row-text">
                <span class="dial-row-title">{{ entry.title }}</span>
                <span class="dial-row-help">{{
                  entryReason(entry) || entryHint(entry)
                }}</span>
              </span>
              <i
                class="fa-solid dial-row-cue"
                :class="entryReason(entry) ? 'fa-lock' : 'fa-chevron-right'"
                aria-hidden="true"
              ></i>
            </button>
          </div>
          <div v-if="!query.trim()" class="dial-list-head">
            <span class="dial-list-title">{{ info.label }}</span>
            <span class="dial-list-cue">{{ info.cue }}</span>
          </div>
          <div
            v-if="!query.trim()"
            class="dial-figures"
            role="radiogroup"
            :aria-label="`${info.label} plots`"
            :style="{ '--slots': LIST_SLOTS }"
            @keydown="rowKeys"
          >
            <button
              v-for="figure in figures"
              :key="figure.kind"
              type="button"
              class="dial-row"
              role="radio"
              :class="{ picked: picked === figure.kind }"
              :aria-checked="picked === figure.kind"
              :aria-disabled="Boolean(reason(figure.kind))"
              @click="pick(figure)"
            >
              <svg class="dial-glyph" viewBox="0 0 24 24" aria-hidden="true">
                <path :d="GLYPH_PATHS[figure.glyph]" />
              </svg>
              <span class="dial-row-text">
                <span class="dial-row-title">{{ figure.title }}</span>
                <span class="dial-row-help">{{
                  reason(figure.kind) || figure.help
                }}</span>
              </span>
              <i
                class="fa-solid dial-row-cue"
                :class="
                  reason(figure.kind)
                    ? 'fa-lock'
                    : picked === figure.kind
                      ? 'fa-check'
                      : 'fa-chevron-right'
                "
                aria-hidden="true"
              ></i>
            </button>
          </div>
        </div>
      </div>
      <!-- A fixed footer: choosing a row never moves the rows below it. -->
      <!-- Country keeps the footer's room, so the panel does not jump
           (25 Nov): a line says what its rows do instead of buttons. -->
      <footer v-if="isCountry" class="dial-footer dial-footer-note">
        <i class="fa-solid fa-flag" aria-hidden="true"></i>
        Pick a plot, then choose its country on the map.
      </footer>
      <footer v-else class="dial-footer">
        <button
          type="button"
          class="dial-action"
          :aria-disabled="!pickedFigure"
          @click="act('enter')"
        >
          <i class="fa-solid fa-keyboard mr-1" aria-hidden="true"></i>Enter
          coordinates
        </button>
        <!-- A polygon can also come from a file (GeoJSON, KML, Shapefile). -->
        <button
          v-if="sector === SECTORS.POLYGON"
          type="button"
          class="dial-action"
          :aria-disabled="!pickedFigure"
          @click="act('import')"
        >
          <i class="fa-solid fa-file-arrow-up mr-1" aria-hidden="true"></i
          >Import shape…
        </button>
        <!-- Drawing is the usual way, on the right where the eye ends up
             (25 Nov); typed coordinates are the rare one, on the left. -->
        <button
          type="button"
          class="dial-action primary"
          :aria-disabled="!pickedFigure"
          @click="act('draw')"
        >
          <i class="fa-solid fa-pen mr-1" aria-hidden="true"></i>{{ info.draw }}
        </button>
      </footer>
      <p v-if="!coarse" class="dial-tip">
        <RightClickMouse class="mr-1" />
        Tip: right-click on the globe to start a plot at that spot.
      </p>
    </div>
  </div>
</template>

<style scoped>
/*
 * Gridlook's panel surface, foreground, divider, focus and accent colours.
 * The ring is a physical control: a continuous rim, a recessed base and
 * hub, and five bevelled pieces; the chosen one stands raised.
 */
.orbit-dial {
  --face-light: color-mix(in srgb, var(--plot-raised) 82%, white);
  --face-dark: color-mix(in srgb, var(--plot-raised) 86%, black);
  --side: color-mix(in srgb, var(--plot-raised) 62%, black);
  --base: color-mix(in srgb, var(--plot-bg) 80%, black);
  --rim-light: color-mix(in srgb, var(--plot-raised) 75%, white);
  --rim-dark: color-mix(in srgb, var(--plot-raised) 70%, black);
  position: absolute;
  z-index: 22;
  display: flex;
  flex-direction: column;
  overflow: auto;
  background: var(--plot-bg);
  color: var(--plot-fg);
  border: 1px solid var(--plot-border);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.28);
  pointer-events: auto;
  /* Closed: folded into the Plotting tools icon. */
  clip-path: circle(12px at var(--grow-x) var(--grow-y));
  transition: clip-path var(--close-ms) cubic-bezier(0.4, 0, 1, 1);
}
.orbit-dial.open {
  clip-path: circle(160% at var(--grow-x) var(--grow-y));
  transition: clip-path var(--open-ms) cubic-bezier(0.2, 0.8, 0.2, 1);
}
/* The ring expands first; the choices and text follow near the end. */
.dial-ring {
  transform: scale(0.35);
  transform-origin: 0% 100%;
  transition: transform var(--close-ms) ease-in;
}
.open .dial-ring {
  transform: none;
  transition: transform calc(var(--open-ms) * 0.7) ease-out;
}
.dial-head,
.dial-choices,
.dial-suggest,
.dial-note,
.piece-label {
  opacity: 0;
  transition: opacity calc(var(--close-ms) * 0.5) ease-in;
}
.open .dial-head,
.open .dial-choices,
.open .dial-suggest,
.open .dial-note,
.open .piece-label {
  opacity: 1;
  transition: opacity calc(var(--open-ms) * 0.4) ease-out
    calc(var(--open-ms) * 0.6);
}
/* Reduced motion: a short fade in place; the raised piece is just raised. */
.orbit-dial.reduced,
.orbit-dial.reduced .dial-ring {
  clip-path: none;
  transform: none;
}
.orbit-dial.reduced {
  opacity: 0;
  transition: opacity var(--fade-ms) linear;
}
.orbit-dial.reduced.open {
  opacity: 1;
}
.orbit-dial.reduced * {
  transition: none !important;
}

.dial-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px 8px 16px;
  border-bottom: 1px solid var(--plot-border);
}
.dial-context {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  color: var(--plot-muted);
}
.dial-variable {
  font-weight: 600;
  color: var(--plot-fg);
}
.dial-close {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--plot-fg);
  cursor: pointer;
}
.coarse .dial-close {
  width: 44px;
  height: 44px;
}
.dial-note {
  margin: 8px 16px 0;
  color: var(--plot-warn);
}
.dial-body {
  display: flex;
  gap: 14px;
  padding: 12px;
  align-items: flex-start;
}
.narrow .dial-body {
  flex-direction: column;
  align-items: center;
}

/* ---- the ring ---- */
.dial-ring {
  flex: 0 0 auto;
  width: 240px;
  height: 240px;
  overflow: visible;
}
.stop-rim-light {
  stop-color: var(--rim-light);
}
.stop-rim-dark {
  stop-color: var(--rim-dark);
}
.stop-hub {
  stop-color: var(--base);
}
.stop-hub-edge {
  stop-color: color-mix(in srgb, var(--base) 70%, black);
}
.stop-face-light {
  stop-color: var(--face-light);
}
.stop-face-dark {
  stop-color: var(--face-dark);
}
.stop-raised-light {
  stop-color: color-mix(in srgb, white 35%, var(--face-light));
}
.stop-raised-dark {
  stop-color: color-mix(in srgb, white 20%, var(--face-dark));
}
.dial-rim {
  fill: url(#dial-rim);
  stroke: var(--plot-border);
}
.dial-base {
  fill: var(--base);
}
/* The bezel: grooves cut into the rim, each with a light lower lip. */
.bezel-groove-ring {
  fill: none;
  stroke: color-mix(in srgb, var(--rim-dark) 70%, black);
  stroke-width: 0.6;
  opacity: 0.7;
}
.bezel-tick {
  fill: none;
  stroke: color-mix(in srgb, var(--rim-dark) 55%, black);
  stroke-width: 1.3;
  stroke-linecap: round;
}
.bezel-tick.lit {
  stroke: var(--plot-accent);
  stroke-width: 1.5;
}
.bezel-lip {
  fill: none;
  stroke: white;
  stroke-opacity: 0.18;
  stroke-width: 1;
  stroke-linecap: round;
}
.bezel-bead {
  transition: transform var(--open-ms) cubic-bezier(0.3, 0.9, 0.3, 1);
}
.bezel-bead circle {
  fill: var(--plot-accent);
  stroke: color-mix(in srgb, var(--plot-accent) 50%, black);
  stroke-width: 0.8;
  filter: drop-shadow(0 0.6px 0.6px rgba(0, 0, 0, 0.45));
}
/*
 * A raised key is a solid block seen from just above: its face lifts, its
 * sidewall (the face swept down to the base) shows below it, and it casts
 * a soft shadow on its neighbours (it is drawn last).
 */
.piece-shadow {
  fill: black;
  filter: url(#dial-soft);
  opacity: var(--shadow);
  transform: translateY(1.5px);
  transition: opacity 140ms;
}
.piece-side,
.piece-top {
  transition: transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.piece-side {
  /* Darker towards the base, as a wall turned away from the light. */
  fill: color-mix(in srgb, var(--face-dark) calc(55% + var(--k) * 45%), black);
  transform: translateY(calc(var(--lift) * -1 * var(--k)));
}
.piece-top {
  transform: translateY(calc(var(--lift) * -1));
}
/* One even hairline around every key: seams look alike all round. */
.piece-face {
  fill: url(#dial-face);
  stroke: color-mix(in srgb, var(--side) 55%, black);
  stroke-opacity: 0.45;
  stroke-width: 0.8;
}
.raised .piece-face {
  fill: url(#dial-face-raised);
  stroke: url(#dial-bevel);
  stroke-width: 1.2;
}
.stop-bevel-top {
  stop-color: white;
  stop-opacity: 0.7;
}
.stop-bevel-bottom {
  stop-color: white;
  stop-opacity: 0;
}
/* The chosen key is lit: its icon, the hub and its bezel ticks glow. */
.raised .piece-icon,
.hub-icon,
.bezel-tick.lit {
  filter: url(#dial-glow);
}
.raised .piece-icon {
  stroke: var(--plot-accent);
}
.raised .piece-label {
  fill: var(--plot-accent);
}
.piece-icon,
.hub-icon {
  fill: none;
  stroke: var(--plot-fg);
  stroke-width: 1.8;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.hub-icon {
  stroke: var(--plot-accent);
  stroke-width: 2.2;
}
.piece-label {
  font-size: 12px;
  font-weight: 600;
  text-anchor: middle;
  fill: var(--plot-fg);
}
.unavailable .piece-face {
  opacity: 0.55;
}
.unavailable .piece-label,
.unavailable .piece-icon {
  opacity: 0.45;
}
.dial-hub {
  fill: url(#dial-hub);
  stroke: color-mix(in srgb, var(--plot-border) 60%, black);
}
.piece-hit {
  fill: transparent;
  cursor: pointer;
  outline: none;
}
.piece-hit[aria-disabled="true"] {
  cursor: not-allowed;
}
.piece-hit:focus-visible {
  stroke: var(--plot-accent);
  stroke-width: 2.5;
  stroke-dasharray: 5 3;
}

/* ---- the list ---- */
.dial-choices {
  flex: 1;
  min-width: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dial-list-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 4px;
}
.dial-list-title {
  font-weight: 700;
}
.dial-list-cue {
  color: var(--plot-muted);
}
.dial-figures {
  --row: 52px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* As tall as the longest list, so nothing below it ever moves. */
  min-height: calc(var(--slots) * var(--row) + (var(--slots) - 1) * 4px);
}
.dial-row {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: var(--row);
  min-height: 44px;
  padding: 0 10px;
  text-align: left;
  background: transparent;
  color: var(--plot-fg);
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
}
.dial-row:hover {
  background: var(--plot-hover);
}
.dial-row:focus-visible {
  outline: 2px solid var(--plot-accent);
  outline-offset: 1px;
}
.dial-row.picked {
  border-color: var(--plot-accent);
  background: var(--plot-hover);
}
/* Locked: dimmed, a padlock in place of the chevron, the reason in full. */
.dial-row[aria-disabled="true"] {
  cursor: not-allowed;
  color: var(--plot-muted);
}
.dial-row[aria-disabled="true"] .dial-glyph,
.dial-row[aria-disabled="true"] .dial-row-title {
  opacity: 0.5;
}
.dial-row[aria-disabled="true"]:hover {
  background: transparent;
}
.dial-glyph {
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.dial-row-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.dial-row-title {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dial-row-help {
  color: var(--plot-muted);
  font-size: 0.72rem;
  line-height: 1.2;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dial-row-cue {
  flex: 0 0 auto;
  color: var(--plot-muted);
}
.dial-row.picked .dial-row-cue {
  color: var(--plot-accent);
}
.dial-content {
  display: flex;
  flex-direction: column;
}
.dial-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  /* Above both footers' own heights (actions, or Country's one-line
     note), so switching between them never moves the dial (25 Nov: it
     stepped by a pixel). */
  min-height: 56px;
  padding: 8px 12px;
  border-top: 1px solid var(--plot-border);
}
/* A phone's sheet scrolls: its actions (Click on map, Enter coordinates)
   stay at its bottom edge instead of below the fold. */
.orbit-dial.narrow .dial-footer {
  position: sticky;
  bottom: 0;
  z-index: 1;
  background: var(--plot-bg);
}
/* Find a chart: in the header, beside the variable. */
.dial-search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 200px;
  max-width: 280px;
  min-height: 32px;
  padding: 0 8px;
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  background: var(--plot-raised);
  color: var(--plot-muted);
}
.dial-search:focus-within {
  border-color: var(--plot-accent);
}
.dial-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--plot-fg);
  font: inherit;
}
.coarse .dial-search {
  min-height: 44px;
}
.narrow .dial-head {
  flex-wrap: wrap;
}
.narrow .dial-search {
  order: 3;
  flex-basis: 100%;
  max-width: none;
}
/* Under the ring: the charts suggested for this data, small. */
.dial-left {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  flex: 0 0 auto;
  width: 240px;
}
.dial-suggest {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 3px;
  width: 100%;
}
.dial-suggest-title {
  flex-basis: 100%;
  color: var(--plot-muted);
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.dial-chip {
  min-height: 20px;
  padding: 0 6px;
  /* A quiet outline: a full-strength one read thick (23 Nov). */
  border: 1px solid color-mix(in srgb, var(--plot-accent) 45%, transparent);
  border-radius: 999px;
  background: var(--plot-hover);
  color: var(--plot-accent);
  font-size: 0.66rem;
  cursor: pointer;
}
/* Touch: slim chips, 26 px drawn; the gap around them is part of what a finger
   hits. */
.coarse .dial-chip {
  min-height: 26px;
  padding: 0 9px;
  font-size: 0.7rem;
}
.coarse .dial-suggest {
  gap: 5px;
}
.dial-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dial-chip-glyph {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.dial-compare {
  border-style: dashed;
  font-weight: 600;
}
.dial-chip[aria-disabled="true"] {
  opacity: 0.5;
  cursor: default;
}
.dial-chip:focus-visible,
.dial-search:has(input:focus-visible) {
  outline: 2px solid var(--plot-accent);
  outline-offset: 1px;
}
.dial-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 12px 8px;
  color: var(--plot-muted);
  font-size: 0.75rem;
}
.dial-action {
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  background: var(--plot-raised);
  color: var(--plot-fg);
  cursor: pointer;
}
/* The footer's actions share its row in equal widths, and when they wrap
   (narrow, or large text) each fills its own row alike: aligned edges,
   never one short button above a longer one (23 Nov). */
.dial-footer {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr));
}
.dial-footer > .dial-action {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
}
/* Slim on touch too (32 px, as the other touch buttons). */
.coarse .dial-action {
  min-height: 32px;
}
.dial-footer-note {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 8px;
  color: var(--plot-muted);
  font-size: 0.875rem;
}
.dial-action.primary {
  border-color: var(--plot-accent);
  color: var(--plot-accent);
  font-weight: 600;
}
.dial-action[aria-disabled="true"] {
  opacity: 0.5;
  cursor: default;
}
.dial-action:focus-visible,
.dial-close:focus-visible {
  outline: 2px solid var(--plot-accent);
  outline-offset: 1px;
}
</style>
