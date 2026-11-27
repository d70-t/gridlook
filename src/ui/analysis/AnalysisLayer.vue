<script lang="ts" setup>
import {
  useElementBounding,
  useElementSize,
  useEventListener,
  useWindowSize,
  watchDebounced,
} from "@vueuse/core";
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  toRaw,
  watch,
} from "vue";

import { rectangleSelection } from "./boxFootprint.ts";
import { suggestCharts, type TCompareView } from "./chartFinder.ts";
import ComparePanel from "./ComparePanel.vue";
import CountryPicker from "./CountryPicker.vue";
import { mapCountryPicker } from "./countryPicking.ts";
import DrawGuide from "./DrawGuide.vue";
import { guidesSeen, markGuideSeen } from "./drawGuides.ts";
import GeometryOverlay from "./GeometryOverlay.vue";
import { installHoverLabels } from "./hoverLabel.ts";
import { levelRead } from "./levelRead.ts";
import {
  besideSelection,
  cheapToDescribe,
  chooserReasons,
  compareReason,
} from "./orbitDial.ts";
import OrbitDial, { type TDialChoice } from "./OrbitDial.vue";
import {
  routeDistanceNear,
  screenRoute,
  type TScreenRoute,
} from "./pathMarks.ts";
import {
  cascadeRect,
  clampRect,
  maximizedRect,
  titleBarInset,
  isNarrow,
  mapSettingsFromStore,
} from "./plotLayout.ts";
import PlotMenu from "./PlotMenu.vue";
import { selectionBox } from "./plotMotion.ts";
import PlotsLauncher from "./PlotsLauncher.vue";
import { isTemperatureSalinity } from "./scatterFigure.ts";
import ShapeEditor from "./ShapeEditor.vue";
import ShapePicker from "./ShapePicker.vue";

import { countryAtPoint } from "@/lib/analysis/analysisClient.ts";
import { publicSourceRef } from "@/lib/analysis/analysisExport.ts";
import type { TRunSource } from "@/lib/analysis/analysisRunner.ts";
import { ancillaryNames } from "@/lib/analysis/companionAlign.ts";
import { removeVertex } from "@/lib/analysis/shapeEdit.ts";
import { polygonCrossings } from "@/lib/analysis/sphere.ts";
import {
  ANALYSIS_KINDS,
  COUNTRY_RESOLUTIONS,
  GEOMETRY_KINDS,
  geometryKey,
  type TAnalysisKind,
  type TCountryGeometry,
  type TShapeGeometry,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import { windPairs } from "@/lib/analysis/windPair.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import {
  DRAW_MODES,
  ensembleOf,
  PLOT_KIND_NAMES,
  readSessionParam,
  sessionOf,
  useAnalysisStore,
  type TDrawMode,
  type TPlotWindow,
  type TTurnOn,
} from "@/store/analysisStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { MOBILE_BREAKPOINT } from "@/ui/common/viewConstants.ts";
import {
  getMapScene,
  mapFrame,
  registerMapTool,
  type TMapContextMenuEvent,
  type TMapGeoPoint,
} from "@/ui/grids/composables/useMapInteraction.ts";

const props = defineProps<{
  datasources: TSources | undefined;
  src: string;
  /** Hidden (distraction-free): no tool may catch the map's gestures. */
  hidden?: boolean;
}>();

// Charts and windows load when the first plot opens.
const PlotWindow = defineAsyncComponent(() => import("./PlotWindow.vue"));

const analysis = useAnalysisStore();
const globe = useGlobeControlStore();
// The menu covers the map below the viewer's mobile breakpoint (as the
// globe's own offset assumes): Plotting tools step aside meanwhile, so the
// button does not sit over the menu's controls (24 Nov).
const { width: viewportWidth } = useWindowSize();
const menuCoversMap = computed(
  () => globe.controlPanelVisible && viewportWidth.value < MOBILE_BREAKPOINT
);
const layer = ref<HTMLElement>();
const layerSize = useElementSize(layer);
const layerBox = useElementBounding(layer);
/** The map's size, and how far the app's title bar reaches into it. */
const area = computed(() => ({
  width: layerSize.width.value,
  height: layerSize.height.value,
  top: titleBarInset({ left: layerBox.left.value, top: layerBox.top.value }),
}));
// Narrow screens show one focused window; Plots switches between results.
const narrowLayer = computed(() =>
  isNarrow({ width: layerSize.width.value, height: layerSize.height.value })
);
const shownWindows = computed(() =>
  isNarrow({ width: layerSize.width.value, height: layerSize.height.value })
    ? analysis.visibleWindows
        .filter((w) => w.id === analysis.focusedId)
        .slice(0, 1)
    : analysis.visibleWindows
);
// Windows stay inside the map when it shrinks (sidebar, drawer, rotation),
// and when they are created or restored.
watch(
  [
    layerSize.width,
    layerSize.height,
    () => area.value.top,
    () => analysis.visibleWindows.map((w) => w.id).join(),
  ],
  () => keepInside()
);

function keepInside() {
  const { width, height } = area.value;
  if (!width || !height) {
    return;
  }
  for (const w of analysis.windows) {
    const next = w.maximized
      ? maximizedRect(area.value)
      : clampRect(w.rect, { width, height });
    if (JSON.stringify(next) !== JSON.stringify(w.rect)) {
      analysis.patchWindow(w.id, { rect: next });
    }
  }
}
/**
 * The Orbit dial, open from the Plotting tools button or a map right-click
 * (whose location it remembers). One dial at a time.
 */
type TDialState = {
  /** The Plotting tools button and its icon, in layer pixels. */
  button: { x: number; y: number; w: number; h: number };
  grow: { x: number; y: number };
};
const dial = ref<TDialState | null>(null);
const dialRef = ref<InstanceType<typeof OrbitDial>>();
/** The right-click menu: where it was opened, and what was under it. */
const menu = ref<{
  at: { x: number; y: number };
  event: TMapContextMenuEvent;
  geo: TMapGeoPoint;
} | null>(null);
/** A right-click off the map: a brief tip at the pointer, no menu. */
const offMap = ref<{ x: number; y: number } | null>(null);
let offMapTimer: ReturnType<typeof setTimeout> | undefined;
/** Importing a shape for a plot: its kind, and any files dropped on the map. */
const shapeChoice = ref<{
  kind: TAnalysisKind;
  files?: File[];
  chooseKind?: boolean;
} | null>(null);
/** Choosing a country for a plot: its kind, and the one preselected. */
const countryChoice = ref<{
  kind: TAnalysisKind;
  initial?: TCountryGeometry;
  /** A plot's country chosen again (from its Settings). */
  plot?: string;
} | null>(null);
const entryKind = ref<TAnalysisKind | null>(null);
const entryError = ref("");
let lastClick = { time: 0, x: 0, y: 0 };

// The one watcher on the dataset: a switch binds windows to a new source.
watch(
  () => props.datasources,
  // eslint-disable-next-line max-lines-per-function
  (sources) => {
    if (!sources) {
      return;
    }
    const generation = analysis.bindDatasources(toRaw(sources));
    if (generation === undefined) {
      return; // the same dataset: the layer was only remounted
    }
    const variable = Object.keys(sources.levels[0].datasources)[0];
    const first = sources.levels[0].datasources[variable];
    const source: TRunSource = {
      key: `${props.src}#${generation}`,
      store: first?.store ?? props.src,
      dataset: first?.dataset ?? "",
      format: sources.zarr_format,
      file: first?.file,
      // The level's grid and time stores, when they are separate (ICON).
      routes: [sources.levels[0].grid, sources.levels[0].time]
        .filter((route) => route?.store)
        .map((route) => ({ store: route!.store, dataset: route!.dataset })),
      ...levelRead(
        sources,
        first?.store ?? props.src,
        first?.dataset,
        props.src
      ),
    };
    const { ref: publicRef, shareable } = publicSourceRef(props.src);
    const ancillary = ancillaryNames(sources.levels[0].datasources);
    const variableSources = Object.fromEntries(
      Object.entries(sources.levels[0].datasources).map(([name, entry]) => [
        name,
        {
          store: entry.store,
          dataset: entry.dataset,
          file: entry.file,
          // For pairing wind components (barbs need east and north).
          standardName: entry.attrs?.standard_name as string | undefined,
          units: entry.attrs?.units as string | undefined,
          // What is known of its dimensions without a request: Against
          // leaves out fields that cannot pair (pairCandidates).
          ...dimensionsOf(entry),
          // Coordinates and support arrays the index found. Quality flags and
          // cell measures too.
          ...(entry.hidden || ancillary.has(name) ? { support: true } : {}),
        },
      ])
    );
    analysis.setActiveSource(
      source,
      {
        ref: publicRef,
        name: sources.name,
        versionStatus: shareable ? "best-effort" : "session",
      },
      sources.name ?? props.src,
      variableSources
    );
    restoreFromUrl(shareable);
  },
  { immediate: true }
);

/**
 * Exact capabilities of the map's variable, once any plot described it
 * (the store records each description by source generation and variable;
 * closing windows keeps it, another source drops it). Opening the menu
 * describes only a variable with short axes: a description reads the
 * whole time coordinate (tens of thousands of requests when it is stored
 * one value per chunk). Another is described when a plot is chosen. Until then the map's own dimensions rule out what they
 * can, and the rest is offered (its window says why one cannot work).
 */
const knownSummary = computed(() =>
  analysis.summaryOf(
    analysis.sourceFor(globe.varnameSelector)?.key,
    globe.varnameSelector
  )
);

/**
 * The plots of the link reopen once per page, with fresh reads: each
 * window where it was (scaled to this screen), shown as it was, and
 * Compare as it was.
 */
// eslint-disable-next-line max-lines-per-function
function restoreFromUrl(shareable: boolean, mapWaited = false) {
  if (analysis.urlRestored) {
    return;
  }
  analysis.restorePending = shareable;
  // The map's dates first, so a restored plot opens on the map's date. Not for
  // ever: after a few seconds the plots open anyway.
  if (!mapWaited && shareable && !globe.varinfo) {
    const go = () => {
      stop();
      clearTimeout(timer);
      restoreFromUrl(shareable, true);
    };
    const stop = watch(
      () => globe.varinfo && globe.dimSlidersValues.length,
      (ready) => ready && go()
    );
    const timer = setTimeout(go, 5000);
    return;
  }
  // Windows are placed inside the layer: wait until it is laid out.
  if (!layer.value) {
    const stop = watch(layer, (element) => {
      if (element) {
        stop();
        restoreFromUrl(shareable);
      }
    });
    return;
  }
  analysis.urlRestored = true;
  const session = shareable ? readSessionParam() : { plots: [] };
  analysis.restorePending = false;
  const area = bounds();
  const ids: (string | undefined)[] = session.plots.map(
    ({ query, view, rect }, at) => {
      const scale = session.screen
        ? {
            x: window.innerWidth / session.screen.w,
            y: window.innerHeight / session.screen.h,
          }
        : undefined;
      const placed =
        rect && scale
          ? clampRect(
              {
                x: rect.x * scale.x,
                y: rect.y * scale.y,
                w: rect.w * scale.x,
                h: rect.h * scale.y,
              },
              area
            )
          : cascadeRect(query.kind, area, at);
      const before = analysis.windows.length;
      void analysis.openWindow(
        query.kind,
        query.geometry,
        {
          variable: query.variable,
          indices: mapSettingsFromStore(globe).indices,
        },
        placed,
        query,
        undefined,
        view as Partial<TPlotWindow>
      );
      // A window is added at once (its reading follows), or not at all.
      return analysis.windows.length > before
        ? analysis.windows[analysis.windows.length - 1].id
        : undefined;
    }
  );
  const compare = session.compare;
  if (compare) {
    const reference = ids[compare.reference];
    const chosen = compare.ids.flatMap((at) => (ids[at] ? [ids[at]!] : []));
    if (reference && chosen.length) {
      analysis.compare = { ids: chosen, reference };
    }
  }
}

// The link follows every change of what windows show (debounced).
// Compared by a signature: a shape by its digest, never serialised whole
// here (the link itself is written only when something changed).
watchDebounced(
  () => {
    const { session } = sessionOf(analysis.windows, analysis.compare);
    // Compare too: choosing another reference rewrites the link.
    return JSON.stringify({
      plots: session.plots.map((plot) => ({
        ...plot,
        query: { ...plot.query, geometry: geometryKey(plot.query.geometry) },
      })),
      compare: session.compare,
    });
  },
  () => analysis.urlRestored && analysis.writeLink(),
  { debounce: 400 }
);

// One plain reason when no plot type can work here, shown once in the menu.
// Capabilities come from the resolved variable, not from the map renderer.
const menuNote = computed(() => {
  const reasons = new Set(Object.values(capabilities.value));
  const [only] = reasons;
  return reasons.size === 1 && only ? only : "";
});

// The map's own dimensions, once it shows the chosen variable.
const capabilities = computed(() =>
  chooserReasons(
    knownSummary.value,
    globe.varnameDisplay === globe.varnameSelector ? globe.varinfo : undefined
  )
);

/** Why Compare cannot start: the dial and Plotting tools say the same. */
const compareLocked = computed(() =>
  compareReason(
    capabilities.value,
    menuNote.value,
    analysis.windows.filter(
      (w) =>
        w.result?.time &&
        !w.result.partial &&
        (w.kind === ANALYSIS_KINDS.POINT_SERIES ||
          w.kind === ANALYSIS_KINDS.REGION_SERIES)
    ).length
  )
);

/** The variable's vertical coordinate, naming Time–depth and the like. */
const verticalInfo = computed(() => knownSummary.value?.vertical);

/** Dimension names that hold ensemble members, before a description. */
const MEMBER_NAMES = /^(member|members|ensemble|ens|realization|realisation)$/i;

/**
 * Charts suggested in the dial, from metadata only (nothing is read): the
 * dataset's wind pairs, the variable's members, levels and standard name.
 */
const dialSuggestions = computed(() => {
  const variable = globe.varnameSelector;
  const summary = knownSummary.value;
  const mapDims =
    globe.varnameDisplay === variable
      ? (globe.varinfo?.dimRanges ?? []).map((range) => range?.name ?? "")
      : [];
  const ensemble = summary
    ? Boolean(ensembleOf(summary))
    : mapDims.some((name) => MEMBER_NAMES.test(name));
  return suggestCharts({
    wind: windPairs(analysis.variableSources, variable).pairs.length > 0,
    ensemble,
    // Undescribed, a profile is offered unless the map shows no levels.
    vertical: summary
      ? Boolean(summary.vertical)
      : !capabilities.value[ANALYSIS_KINDS.PROFILE] && !ensemble,
    standardName: analysis.variableSources[variable]?.standardName,
    timed: summary
      ? Boolean(summary.time)
      : mapDims.some((name) => /time/i.test(name)),
    temperatureSalinity: Object.entries(analysis.variableSources).some(
      ([name, info]) =>
        name !== variable &&
        isTemperatureSalinity(
          {
            name: variable,
            values: [],
            standardName: analysis.variableSources[variable]?.standardName,
          },
          { name, values: [], standardName: info.standardName }
        )
    ),
    reasons: capabilities.value,
  });
});

function bounds() {
  const rect = layer.value?.getBoundingClientRect();
  return {
    left: rect?.left ?? 0,
    top: rect?.top ?? 0,
    width: rect?.width ?? 800,
    height: rect?.height ?? 600,
  };
}

let focusBeforeDial: HTMLElement | null = null;

/**
 * The dial opens in the lower-left corner, out of the Plotting tools
 * button. A right-click opens the plot menu at the click instead.
 */
function launcherAnchor() {
  const area = bounds();
  const button = layer.value
    ?.querySelector<HTMLElement>(".analysis-plots-button")
    ?.getBoundingClientRect();
  const icon = layer.value
    ?.querySelector<HTMLElement>(".analysis-plots-icon")
    ?.getBoundingClientRect();
  const b = button ?? new DOMRect(18, area.height - 54, 160, 36);
  const i = icon ?? b;
  return {
    button: {
      x: b.left - area.left,
      y: b.top - area.top,
      w: b.width,
      h: b.height,
    },
    grow: {
      x: i.left + i.width / 2 - area.left,
      y: i.top + i.height / 2 - area.top,
    },
  };
}

/**
 * A right-click on the map opens the plot menu there. Off the map (space
 * around the globe) there is no place to start from: a brief tip says
 * where to click instead; Plotting tools still offers every plot.
 */
function openMenu(event: TMapContextMenuEvent) {
  if (dial.value) {
    closeDial(false);
  }
  interaction++;
  analysis.markHintSeen();
  const area = bounds();
  const at = { x: event.clientX - area.left, y: event.clientY - area.top };
  clearTimeout(offMapTimer);
  if (!event.geo) {
    menu.value = null;
    // Centred under the pointer, kept inside the map.
    const half = 130;
    offMap.value = {
      x: Math.min(Math.max(at.x, half), Math.max(half, area.width - half)),
      y: Math.min(at.y, area.height - 40),
    };
    offMapTimer = setTimeout(() => (offMap.value = null), 1800);
    return;
  }
  offMap.value = null;
  focusBeforeDial = document.activeElement as HTMLElement | null;
  analysis.pendingStart = { lat: event.geo.lat, lon: event.geo.lon };
  menu.value = { at, event, geo: event.geo };
  describeForMenu();
}

/** Variables being described for the menu (`source|variable`). */
const describingForMenu = new Set<string>();

/**
 * The map's variable described as the menu opens, when that is a few
 * reads (short axes besides the horizontal ones): the menu then offers
 * exactly the plots it can make, while it is open. Before, a one-date
 * variable offered Time series until a plot had described it.
 */
function describeForMenu() {
  const variable = globe.varnameSelector;
  const source = analysis.sourceFor(variable);
  const map = globe.varnameDisplay === variable ? globe.varinfo : undefined;
  const key = source && `${source.key}|${variable}`;
  if (
    !source ||
    !key ||
    !map ||
    knownSummary.value ||
    describingForMenu.has(key) ||
    !cheapToDescribe(map)
  ) {
    return;
  }
  describingForMenu.add(key);
  void analysis
    .describe(source, variable)
    .catch(() => undefined)
    .finally(() => describingForMenu.delete(key));
}

function closeMenu(returnFocus = true) {
  menu.value = null;
  if (analysis.drawMode === DRAW_MODES.NONE) {
    analysis.pendingStart = undefined;
  }
  if (returnFocus) {
    focusBeforeDial?.focus?.();
    refocus();
  }
}

/** Plotting tools → New plot. */
function openFromLauncher() {
  closeMenu(false);
  openDial(launcherAnchor());
}

function openDial(state: TDialState) {
  interaction++;
  focusBeforeDial = document.activeElement as HTMLElement | null;
  if (dial.value) {
    // A second origin replaces the first at once.
    dial.value = null;
    void nextTick(() => (dial.value = state));
  } else {
    dial.value = state;
  }
}

/** Close (or reverse an opening dial); it unmounts when folded away. */
function closeDial(returnFocus = true) {
  dialRef.value?.close();
  if (returnFocus) {
    focusBeforeDial?.focus?.();
  }
}

function dialClosed() {
  dial.value = null;
  refocus();
}

/** Focus left in a closed panel (or on the page) goes to Plotting tools. */
function refocus() {
  void nextTick(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) {
      layer.value
        ?.querySelector<HTMLElement>(".analysis-plots-button")
        ?.focus();
    }
  });
}

/** The launcher's button toggles the dial. */
function toggleLauncherDial() {
  if (dial.value && dialRef.value?.isOpen()) {
    closeDial();
  } else {
    openFromLauncher();
  }
}

function create(kind: TAnalysisKind, geometry: TGeometry) {
  const area = bounds();
  const open = analysis.windows.filter((w) => !w.minimized).length;
  // The frame emerges from the visible selection and settles beside it
  // when there is room.
  const selection = selectionBox(geometry, area);
  const cascade = cascadeRect(kind, area, open);
  const rect =
    selection && !narrowLayer.value
      ? clampRect(besideSelection(selection, cascade, area), area)
      : cascade;
  void analysis.openWindow(
    kind,
    geometry,
    mapSettingsFromStore(globe),
    rect,
    undefined,
    selection && {
      x: selection.x + area.left,
      y: selection.y + area.top,
      w: selection.w,
      h: selection.h,
    }
  );
}

function pauseRotation() {
  const rotating = globe.isRotating;
  if (rotating) {
    globe.isRotating = false;
  }
  return rotating;
}

function startDrawing(
  kind: TAnalysisKind,
  mode: TDrawMode,
  first?: TMapGeoPoint
) {
  analysis.startDrawing(mode, kind, first, undefined, pauseRotation());
}

/** A choice in the dial (no place yet). */
/**
 *  New plot → Compare places (or a Compare chart found by name): Compare
 * opens, asks for places when it needs them, and shows that view.
 */
function compareFromDial(view?: TCompareView) {
  closeDial(false);
  analysis.openCompare(view);
}
function compareFromMenu(view?: TCompareView, here?: boolean) {
  const geo = menu.value?.geo;
  closeMenu(false);
  analysis.openCompare(view);
  // From here: this place's time series is Compare's first pick (a series
  // finished while Compare is open joins it).
  if (here && geo) {
    choose({ kind: ANALYSIS_KINDS.POINT_SERIES, action: "here" }, geo);
  }
}

function chooseFromDial(choice: TDialChoice) {
  // Typed coordinates open beside Plotting tools, where they were asked.
  const button = dial.value?.button;
  entryAnchor.value = button ? { x: button.x, y: button.y, above: true } : null;
  closeDial(false);
  choose(choice);
}

/** A choice in the right-click menu: the clicked place is the start. */
function chooseFromMenu(choice: TDialChoice) {
  const geo = menu.value?.geo;
  // Typed coordinates open beside the place clicked (24 Nov).
  entryAnchor.value = menu.value ? { ...menu.value.at } : null;
  closeMenu(false);
  choose(choice, geo);
}

/**
 * Counts the user's starts (a choice, the menu, the dial, Cancel): a slow
 * country lookup for an earlier one must not open its panel over a later.
 */
let interaction = 0;

/** Choose a country for an area plot, the one under `geo` preselected. */
async function chooseCountry(kind: TAnalysisKind, geo?: TMapGeoPoint) {
  if (analysis.drawMode !== DRAW_MODES.NONE) {
    cancelDrawing();
  }
  entryKind.value = null;
  const current = interaction;
  const initial = geo
    ? await countryAtPoint(geo.lat, geo.lon, COUNTRY_RESOLUTIONS.MEDIUM).catch(
        () => undefined
      )
    : undefined;
  if (current === interaction && analysis.drawMode === DRAW_MODES.NONE) {
    countryChoice.value = { kind, initial };
  }
}

function submitCountry(geometry: TGeometry) {
  const choice = countryChoice.value;
  if (!choice) {
    return;
  }
  if (choice.plot) {
    analysis.updateDraft(choice.plot, { geometry });
    void analysis.apply(choice.plot);
  } else {
    create(choice.kind, geometry);
  }
  countryChoice.value = null;
  analysis.countryPreview = undefined;
}

// A plot's country chosen again: the bar opens for it.
watch(
  () => analysis.countryFor,
  (id) => {
    const w = analysis.windows.find((entry) => entry.id === id);
    const geometry = w?.draft.geometry;
    if (!w || geometry?.kind !== GEOMETRY_KINDS.COUNTRY) {
      return;
    }
    if (analysis.drawMode !== DRAW_MODES.NONE) {
      cancelDrawing();
    }
    entryKind.value = null;
    interaction++;
    countryChoice.value = { kind: w.kind, initial: geometry, plot: w.id };
    // Asked again later (the same plot), it opens again.
    analysis.countryFor = undefined;
  }
);
const countryTitle = computed(() => {
  const choice = countryChoice.value;
  const plot = analysis.windows.find((w) => w.id === choice?.plot);
  return plot
    ? `${plot.label}: choose its country`
    : `${choice ? PLOT_KIND_NAMES[choice.kind] : ""} by country`;
});
/**
 * Plot windows step aside while a plot's place is picked on the map
 * (25 Nov): its shape edited or redrawn, or its country chosen again.
 */
const plotsAside = computed(() =>
  Boolean(
    analysis.shapeEdit || analysis.drawTargetId || countryChoice.value?.plot
  )
);

/**
 * Not a country (a continent, a basin, a district, a village): the same
 * plot over the scientist's own boundaries, from a file.
 */
function importInstead() {
  const kind = countryChoice.value?.kind;
  countryChoice.value = null;
  analysis.countryPreview = undefined;
  if (kind) {
    shapeChoice.value = { kind };
  }
}

function submitShape(geometry: TShapeGeometry, kind: TAnalysisKind) {
  shapeChoice.value = null;
  analysis.shapePreview = undefined;
  create(kind, geometry);
}

function cancelShape() {
  shapeChoice.value = null;
  analysis.shapePreview = undefined;
  void nextTick(() =>
    layer.value?.querySelector<HTMLElement>(".analysis-plots-button")?.focus()
  );
}

/**
 * A shape file dropped on the map opens the import panel with it, for an
 * area plot chosen there. Other drops (and drops while drawing) are left
 * to the page.
 */
const SHAPE_FILE = /\.(geojson|json|kml|kmz|zip|shp|dbf|prj|shx|cpg)$/i;
const dropping = ref(false);
function overMap(event: DragEvent) {
  return (
    !props.hidden &&
    event.dataTransfer?.types.includes("Files") &&
    analysis.drawMode === DRAW_MODES.NONE &&
    event.target === getMapScene()?.canvas()
  );
}
useEventListener(window, "dragover", (event: DragEvent) => {
  dropping.value = Boolean(overMap(event));
  if (dropping.value) {
    event.preventDefault();
  }
});
useEventListener(window, "dragleave", () => (dropping.value = false));
useEventListener(window, "drop", (event: DragEvent) => {
  const was = dropping.value;
  dropping.value = false;
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!was || !overMap(event) || !files.some((f) => SHAPE_FILE.test(f.name))) {
    return;
  }
  event.preventDefault();
  if (dial.value) {
    closeDial(false);
  }
  countryChoice.value = null;
  analysis.countryPreview = undefined;
  shapeChoice.value = {
    kind: ANALYSIS_KINDS.REGION_SERIES,
    files,
    chooseKind: true,
  };
});

function previewCountry(country: TCountryGeometry | undefined) {
  analysis.countryPreview = country;
}

/**
 * While a country picker is open (a new plot's, or one in Settings), a map
 * click picks the country there, at that picker's boundary detail. The
 * answer goes only to the same picker at the same detail.
 */
async function pickCountryAt(geo: TMapGeoPoint, additive = false) {
  const picker = mapCountryPicker.value;
  if (!picker) {
    return;
  }
  const resolution = picker.resolution();
  const found = await countryAtPoint(geo.lat, geo.lon, resolution).catch(
    () => undefined
  );
  if (mapCountryPicker.value === picker && picker.resolution() === resolution) {
    picker.choose(found, additive);
  }
}

/**
 * While a country is chosen on the map, the country under the pointer is
 * highlighted: one lookup at a time (in the analysis worker), then the
 * pointer's latest place.
 */
let hoverAt: { x: number; y: number } | undefined;
let hoverBusy = false;
async function hoverCountry() {
  const picker = mapCountryPicker.value;
  const at = hoverAt;
  hoverAt = undefined;
  if (!picker || !at) {
    return;
  }
  hoverBusy = true;
  const geo = getMapScene()?.pick(at.x, at.y);
  const found = geo
    ? await countryAtPoint(geo.lat, geo.lon, picker.resolution()).catch(
        () => undefined
      )
    : undefined;
  hoverBusy = false;
  // Only a change of country redraws the highlight.
  const now = analysis.countryHover;
  if (
    mapCountryPicker.value === picker &&
    (found?.id !== now?.id || found?.resolution !== now?.resolution)
  ) {
    analysis.countryHover = found;
  }
  if (hoverAt) {
    void hoverCountry();
  }
}
useEventListener(window, "pointermove", (event: PointerEvent) => {
  if (
    props.hidden ||
    !mapCountryPicker.value ||
    event.pointerType === "touch"
  ) {
    return;
  }
  if (event.target !== getMapScene()?.canvas()) {
    analysis.countryHover = undefined;
    return;
  }
  hoverAt = { x: event.clientX, y: event.clientY };
  if (!hoverBusy) {
    void hoverCountry();
  }
});
watch(
  () => Boolean(mapCountryPicker.value),
  (picking) => {
    if (!picking) {
      hoverAt = undefined;
      analysis.countryHover = undefined;
    }
  }
);

function cancelCountry() {
  interaction++;
  countryChoice.value = null;
  analysis.countryPreview = undefined;
  void nextTick(() =>
    layer.value?.querySelector<HTMLElement>(".analysis-plots-button")?.focus()
  );
}

/** Plot here, draw on the map, type coordinates or choose a country. */
/**
 * A T–S diagram's partner by the same metadata the suggestion used: the one
 * sea-water salinity (by standard name) beside an ocean temperature, passed by
 * its name; with several, none is guessed and Against lists them.
 */
function resolvedTurnOn(turnOn: TTurnOn): TTurnOn {
  if (turnOn.pair !== "salinity") {
    return turnOn;
  }
  const variable = globe.varnameSelector;
  const own = analysis.variableSources[variable];
  const partners = Object.entries(analysis.variableSources)
    .filter(
      ([name, info]) =>
        name !== variable &&
        isTemperatureSalinity(
          { name: variable, values: [], standardName: own?.standardName },
          { name, values: [], standardName: info.standardName }
        )
    )
    .map(([name]) => name);
  return {
    ...turnOn,
    pair: partners.length === 1 ? { variable: partners[0] } : "choose",
  };
}

function choose(choice: TDialChoice, geo?: TMapGeoPoint) {
  interaction++;
  // A found chart's switch (anomaly, barbs…) is set on the plot it opens.
  analysis.nextTurnOn = choice.turnOn
    ? { turnOn: resolvedTurnOn(choice.turnOn), at: Date.now() }
    : undefined;
  analysis.pendingStart = undefined;
  countryChoice.value = null;
  analysis.countryPreview = undefined;
  if (choice.action === "country") {
    void chooseCountry(choice.kind, geo);
  } else if (choice.action === "import") {
    shapeChoice.value = { kind: choice.kind };
  } else if (choice.action === "here" && geo) {
    create(choice.kind, {
      kind: GEOMETRY_KINDS.POINT,
      lat: geo.lat,
      lon: geo.lon,
    });
  } else if (choice.action === "draw" && choice.mode) {
    // From a right-click the clicked place is a path's or polygon's point
    // 1; a box is drawn afresh, by dragging.
    startDrawing(
      choice.kind,
      choice.mode,
      choice.mode === DRAW_MODES.POINT || choice.mode === DRAW_MODES.BOX
        ? undefined
        : geo
    );
  } else if (choice.mode) {
    enterNew(choice.kind, choice.mode, geo);
  }
}

// A polygon being drawn whose edges cross has no single inside: its crossing
// edges are marked and Finish waits (Undo, or more points, mends it).
watch(
  () =>
    analysis.drawMode === DRAW_MODES.POLYGON
      ? analysis.drawVertices.map((v) => `${v.lat},${v.lon}`).join(";")
      : "",
  () => {
    analysis.drawCrossings =
      analysis.drawMode === DRAW_MODES.POLYGON
        ? polygonCrossings(analysis.drawVertices)
        : [];
  }
);

function finishDrawing() {
  const vertices = analysis.drawVertices.map((v) => ({
    lat: v.lat,
    lon: v.lon,
  }));
  const kind = analysis.drawKind;
  const mode = analysis.drawMode;
  const target = analysis.drawTargetId;
  let geometry: TGeometry | undefined;
  if (mode === DRAW_MODES.POLYLINE && vertices.length >= 2) {
    geometry = { kind: GEOMETRY_KINDS.POLYLINE, vertices };
  } else if (
    mode === DRAW_MODES.POLYGON &&
    vertices.length >= 3 &&
    !polygonCrossings(vertices).length
  ) {
    geometry = { kind: GEOMETRY_KINDS.POLYGON, vertices };
  } else if (mode === DRAW_MODES.BOX && vertices.length === 2) {
    // The rectangle as released: what the preview showed (boxFootprint.ts).
    geometry =
      boxReleased ??
      (boxPointer ? boxSelection(boxPointer, true)?.geometry : undefined);
    boxReleased = undefined;
  } else if (mode === DRAW_MODES.POINT && vertices.length === 1) {
    geometry = { kind: GEOMETRY_KINDS.POINT, ...vertices[0] };
  }
  if (!geometry) {
    return;
  }
  endDrawing();
  if (target) {
    // A redraw edits the plot it came from, which comes back into view.
    analysis.updateDraft(target, { geometry });
  } else if (kind) {
    create(kind, geometry);
  }
}

/** Leave drawing; a redraw's window returns with focus. */
function endDrawing() {
  const rotation = analysis.rotationBeforeDrawing;
  const target = analysis.drawTargetId;
  analysis.stopDrawing();
  if (rotation) {
    globe.isRotating = true;
  }
  if (target) {
    analysis.setMinimized(target, false);
    analysis.focus(target);
  }
}

function cancelDrawing() {
  endDrawing();
}

// Distraction-free hides the layer but keeps it mounted: a drawing or a
// shape edit in progress ends as Cancel would, so its capture handlers do
// not take the bare map's drags, and the camera turns as before.
watch(
  () => props.hidden,
  (hidden) => {
    if (!hidden) {
      return;
    }
    if (analysis.drawMode !== DRAW_MODES.NONE) {
      endDrawing();
    }
    if (analysis.shapeEdit) {
      analysis.endShapeEdit(false);
    }
    // Its menus and choosers close; the country under the pointer is no longer
    // marked.
    if (dial.value) {
      closeDial(false);
    }
    menu.value = null;
    countryChoice.value = null;
    analysis.countryPreview = undefined;
    analysis.countryHover = undefined;
    dropping.value = false;
  }
);

/**
 * Drawing a box: press on the map, drag to the opposite corner and let go
 * (the map does not turn meanwhile). Two clicks also work: the first sets
 * corner 1 and the box follows the pointer to the second. Other buttons,
 * the wheel and a press off the map still move the map.
 *
 * The box is the rectangle on screen from corner 1 to the pointer, and the
 * selection what it covers of the map, clipped to the map's edge or the
 * globe's horizon (boxFootprint.ts): one corner stays, the other follows
 * the pointer anywhere, also off the map. The preview (outline, fill,
 * label) follows at most once per animation frame and reads no data.
 */
/** The press drawing the box: only its own pointer moves or ends it. */
let boxPress:
  | {
      id: number;
      x: number;
      y: number;
      /** Where the finger or pointer is now. */
      at?: { x: number; y: number };
      dragged: boolean;
      hadCorner: boolean;
    }
  | undefined;
/** The selection as released, computed once (validation and commit). */
let boxReleased: TGeometry | undefined;
/**
 * Touches down while a second finger made a box press a pinch: the map's until
 * the last is lifted, and nothing is drawn or committed meanwhile.
 */
const pinch = new Set<number>();
let pinchEnded = -Infinity;
let boxPointer: { x: number; y: number } | undefined;
let previewFrame = 0;
/** A listed field's dimension names, shape and axis, as far as known. */
function dimensionsOf(entry: {
  attrs?: Record<string, unknown>;
  shape?: number[];
}) {
  const named = entry.attrs?.dimensionNames ?? entry.attrs?._ARRAY_DIMENSIONS;
  const dims =
    Array.isArray(named) && named.every((d) => typeof d === "string")
      ? (named as string[])
      : undefined;
  const axis = entry.attrs?.axis;
  return {
    ...(dims ? { dims } : {}),
    ...(entry.shape ? { shape: entry.shape } : {}),
    ...(typeof axis === "string" ? { axis } : {}),
  };
}

/** Plots computed along latitude or longitude: a latitude/longitude box. */
const LAT_LON_BOX_KINDS: readonly string[] = [
  ANALYSIS_KINDS.HOVMOLLER_LON,
  ANALYSIS_KINDS.HOVMOLLER_LAT,
  ANALYSIS_KINDS.LAT_VERTICAL,
  ANALYSIS_KINDS.LON_VERTICAL,
];
/** The selection a rectangle from corner 1 to `pointer` makes. */
function boxSelection(pointer: { x: number; y: number }, exact = false) {
  const scene = getMapScene();
  const corner = analysis.drawVertices[0];
  const at = corner && scene?.project(corner.lat, corner.lon);
  if (!scene || !at?.visible) {
    return undefined;
  }
  // One view for the whole trace: its canvas rectangle read once, and
  // kept with the shape when committing (screenFrame.ts).
  const view = scene.frame?.();
  const viewport = view?.viewport;
  return rectangleSelection(
    (x, y) => scene.pick(x, y, viewport),
    (lat, lon) => scene.project(lat, lon, viewport),
    { x: at.x, y: at.y },
    pointer,
    LAT_LON_BOX_KINDS.includes(analysis.drawKind ?? ""),
    exact,
    exact ? view : undefined
  );
}
function followPointer(pointer: { x: number; y: number }) {
  boxPointer = pointer;
  if (!previewFrame) {
    previewFrame = requestAnimationFrame(showBox);
  }
}
function showBox() {
  previewFrame = 0;
  if (boxPointer && analysis.drawMode === DRAW_MODES.BOX) {
    const selection = boxSelection(boxPointer);
    analysis.drawBox = selection?.geometry;
    analysis.drawBoxLabel = selection?.label ?? "";
    analysis.drawBoxScreen = selection?.screen;
    analysis.drawBoxOutline = selection?.outline;
  }
}
/** Corner 1 set: a new rectangle starts there. */
function startBox() {
  boxPointer = undefined;
  analysis.drawBox = undefined;
  analysis.drawBoxLabel = "";
  analysis.drawBoxScreen = undefined;
  analysis.drawBoxOutline = undefined;
}
/**
 * While corner 1 waits for the second click, a camera change (wheel, pan) moves
 * the map under the pointer: the preview follows at the next frame, from the
 * latest pointer, so the click commits what is shown.
 */
// Each map render (and only then): a zoom with the pointer still, on the globe
// or off it, moves the preview, and nothing is measured while the map is still.
watch(mapFrame, () => {
  if (
    analysis.drawMode === DRAW_MODES.BOX &&
    analysis.drawVertices.length === 1 &&
    boxPointer &&
    !pinch.size
  ) {
    followPointer(boxPointer);
  }
});
watch(
  () => analysis.drawMode,
  () => {
    boxReleased = undefined;
    boxPointer = undefined;
    cancelAnimationFrame(previewFrame);
    previewFrame = 0;
  }
);
/** A finger the box held, pressed again on the map for its controls. */
function handFingerToMap(press: NonNullable<typeof boxPress>) {
  getMapScene()
    ?.canvas()
    ?.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: press.id,
        pointerType: "touch",
        isPrimary: true,
        clientX: press.at?.x ?? press.x,
        clientY: press.at?.y ?? press.y,
        button: 0,
        buttons: 1,
        bubbles: true,
        cancelable: true,
      })
    );
}
useEventListener(
  window,
  "pointerdown",
  // eslint-disable-next-line max-lines-per-function -- one gesture's start.
  (event: PointerEvent) => {
    // A second finger: the gesture is the map's (zoom), not a box. A
    // corner this press set goes; one from an earlier click stays.
    if (
      event.pointerType === "touch" &&
      (pinch.size || (boxPress && event.pointerId !== boxPress.id))
    ) {
      if (boxPress) {
        pinch.add(boxPress.id);
        if (!boxPress.hadCorner && analysis.drawMode === DRAW_MODES.BOX) {
          analysis.drawVertices = [];
          startBox();
        }
        // The camera controls never saw the first finger (the box took it):
        // they get it now, where it is, so the two fingers zoom as on the bare
        // map.
        const held = boxPress;
        boxPress = undefined;
        handFingerToMap(held);
      }
      pinch.add(event.pointerId);
      return;
    }
    if (
      analysis.drawMode !== DRAW_MODES.BOX ||
      event.button !== 0 ||
      !event.isPrimary ||
      boxPress || // one gesture at a time, whatever the device
      event.target !== getMapScene()?.canvas()
    ) {
      return;
    }
    // A box starts on the map itself; the drag may then leave it, and a second
    // click may land off it (the rectangle clipped to the map). A glide from a
    // pan stops first.
    getMapScene()?.hold?.();
    const at = getMapScene()?.pick(event.clientX, event.clientY);
    const hasCorner = analysis.drawVertices.length === 1;
    if (!at && !hasCorner) {
      return;
    }
    // Before the camera controls see it: no turning, no emulated click.
    event.preventDefault();
    event.stopPropagation();
    const hadCorner = analysis.drawVertices.length === 1;
    if (!hadCorner && at) {
      analysis.drawVertices = [{ lat: at.lat, lon: at.lon }];
      startBox();
    }
    if (at) {
      analysis.drawHover = { lat: at.lat, lon: at.lon };
    }
    boxPress = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      dragged: false,
      hadCorner,
    };
  },
  { capture: true }
);
useEventListener(window, "pointermove", (event: PointerEvent) => {
  if (
    pinch.size ||
    analysis.drawMode !== DRAW_MODES.BOX ||
    analysis.drawVertices.length !== 1 ||
    (boxPress && event.pointerId !== boxPress.id) ||
    (!boxPress && !event.isPrimary)
  ) {
    return;
  }
  if (boxPress) {
    boxPress.at = { x: event.clientX, y: event.clientY };
  }
  if (
    boxPress &&
    Math.hypot(event.clientX - boxPress.x, event.clientY - boxPress.y) > 4
  ) {
    boxPress.dragged = true;
  }
  const at = getMapScene()?.pick(event.clientX, event.clientY);
  if (at) {
    analysis.drawHover = { lat: at.lat, lon: at.lon };
  }
  followPointer({ x: event.clientX, y: event.clientY });
});
// A cancelled press (the system took the touch) leaves no half-made box: a
// corner it set goes, one set by an earlier click stays. The box owns a
// one-finger gesture on the map: the map's own touch handlers (a flat map turns
// under one finger) never see it, from press to release. Two fingers still
// zoom; ordinary navigation returns when drawing ends.
for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
  useEventListener(
    window,
    type,
    (event: TouchEvent) => {
      // Only a gesture the box owns: a touch off the globe, or a pinch, still
      // moves the map.
      if (
        analysis.drawMode === DRAW_MODES.BOX &&
        boxPress &&
        !pinch.size &&
        event.target === getMapScene()?.canvas()
      ) {
        event.stopPropagation();
        if (event.cancelable && type === "touchmove") {
          event.preventDefault();
        }
      }
    },
    { capture: true, passive: false }
  );
}
for (const type of ["pointerup", "pointercancel"]) {
  useEventListener(window, type, (event: PointerEvent) => {
    // The pinch ends with its last finger; a later press draws again.
    if (pinch.delete(event.pointerId) && !pinch.size) {
      pinchEnded = performance.now();
    }
  });
}
useEventListener(window, "pointercancel", (event: PointerEvent) => {
  if (!boxPress || event.pointerId !== boxPress.id) {
    return;
  }
  if (!boxPress.hadCorner && analysis.drawMode === DRAW_MODES.BOX) {
    analysis.drawVertices = [];
    startBox();
  }
  boxPress = undefined;
});
useEventListener(window, "pointerup", (event: PointerEvent) => {
  const press = boxPress;
  if (!press || event.pointerId !== press.id) {
    return;
  }
  boxPress = undefined;
  if (analysis.drawMode !== DRAW_MODES.BOX) {
    return;
  }
  // A click without a drag (or a sliver of a box) leaves corner 1 for a
  // second click.
  boxPointer = { x: event.clientX, y: event.clientY };
  // Committed exactly once, on release (the preview is the rectangle).
  boxReleased =
    press.dragged || press.hadCorner
      ? boxSelection(boxPointer, true)?.geometry
      : undefined;
  if (boxReleased) {
    const corner = analysis.drawVertices[0];
    analysis.drawVertices = [corner, analysis.drawHover ?? corner];
    finishDrawing();
  }
});

/** Corner 2 by a click: the rectangle to there, unless it is a sliver. */
function boxCornerClicked(event: { clientX: number; clientY: number }) {
  if (
    analysis.drawMode !== DRAW_MODES.BOX ||
    analysis.drawVertices.length !== 1
  ) {
    return true;
  }
  if (pinch.size || pinchEnded > performance.now() - 400) {
    return false; // the click a pinch's release makes is no corner
  }
  boxPointer = { x: event.clientX, y: event.clientY };
  boxReleased = boxSelection(boxPointer, true)?.geometry;
  return Boolean(boxReleased);
}

/**
 * The map's pointer on a path plot's route marks that place on its chart
 * (the chart's pointer already marks the route): two ways, at most once a
 * frame, only while nothing is being drawn.
 */
let routeFrame = 0;
let routePointer: { x: number; y: number } | undefined;
/**
 * Each route as drawn, projected once per view: rebuilt when the map renders
 * anew or the route changes, not on every pointer frame.
 */
const routesOnScreen = new WeakMap<
  object,
  { frame: number; route: TScreenRoute }
>();
function routeOnScreen(
  geometry: { vertices: { lat: number; lon: number }[] },
  project: (p: {
    lat: number;
    lon: number;
  }) => { x: number; y: number } | undefined
) {
  const kept = routesOnScreen.get(geometry.vertices);
  if (kept?.frame === mapFrame.value) {
    return kept.route;
  }
  const route = screenRoute(geometry.vertices, project);
  routesOnScreen.set(geometry.vertices, { frame: mapFrame.value, route });
  return route;
}
function pointRoute() {
  routeFrame = 0;
  const scene = getMapScene();
  const at = routePointer;
  let found: { id: string; meters: number } | undefined;
  if (scene && at && analysis.drawMode === DRAW_MODES.NONE) {
    for (const w of analysis.windows) {
      const g = w.result?.query.geometry ?? w.committed?.geometry;
      if (w.minimized || g?.kind !== GEOMETRY_KINDS.POLYLINE) {
        continue;
      }
      const meters = routeDistanceNear(
        routeOnScreen(g, (p) => {
          const q = scene.project(p.lat, p.lon);
          return q?.visible ? q : undefined;
        }),
        at
      );
      if (meters !== undefined) {
        found = { id: w.id, meters };
        break;
      }
    }
  }
  if (found) {
    analysis.pathHover = { ...found, fromMap: true };
  } else if (analysis.pathHover?.fromMap) {
    analysis.pathHover = undefined;
  }
}
useEventListener(window, "pointermove", (event: PointerEvent) => {
  // On the map, or on a route's own drawn line (it takes the pointer for
  // its plot: hovering it answers too).
  const onMap =
    event.target === getMapScene()?.canvas() ||
    Boolean((event.target as Element | null)?.closest?.(".analysis-outline"));
  if (!onMap && !analysis.pathHover?.fromMap) {
    return;
  }
  routePointer = onMap ? { x: event.clientX, y: event.clientY } : undefined;
  routeFrame ||= requestAnimationFrame(pointRoute);
});

/** A touch tap also produces an emulated mouse click: count it once. */
function repeatedTap(event: { clientX: number; clientY: number }) {
  const now = performance.now();
  const again =
    now - lastClick.time < 500 &&
    Math.abs(event.clientX - lastClick.x) < 8 &&
    Math.abs(event.clientY - lastClick.y) < 8;
  if (!again) {
    lastClick = { time: now, x: event.clientX, y: event.clientY };
  }
  return again;
}

/** Pixels from the first point within which a click closes a polygon. */
const CLOSE_PIXELS = 12;
function closesPolygon(event: { clientX: number; clientY: number }) {
  const [first] = analysis.drawVertices;
  if (
    analysis.drawMode !== DRAW_MODES.POLYGON ||
    analysis.drawVertices.length < 3 ||
    !first
  ) {
    return false;
  }
  const p = getMapScene()?.project(first.lat, first.lon);
  return Boolean(
    p?.visible &&
    Math.hypot(p.x - event.clientX, p.y - event.clientY) <= CLOSE_PIXELS
  );
}

function onMapClick(
  geo: TMapGeoPoint | null,
  event: {
    clientX: number;
    clientY: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
  }
) {
  if (mapCountryPicker.value) {
    if (geo) {
      // Ctrl (⌘ on a Mac) adds the country to those chosen.
      void pickCountryAt(geo, Boolean(event.ctrlKey || event.metaKey));
    }
    return true;
  }
  if (analysis.drawMode === DRAW_MODES.NONE) {
    // While coordinates are typed, a click fills them (25 Nov).
    return Boolean(entryKind.value && geo && fillEntryFrom(geo));
  }
  if (repeatedTap(event)) {
    return true;
  }
  // Corner 2 of a box may be off the map: the rectangle clipped to it.
  const corner2 =
    analysis.drawMode === DRAW_MODES.BOX && analysis.drawVertices.length === 1;
  if (corner2 && boxCornerClicked(event)) {
    analysis.drawVertices.push(geo ?? analysis.drawVertices[0]);
    finishDrawing();
    return true;
  }
  if (!geo || corner2) {
    return true;
  }
  // A click on (or within a finger's width of) the first point closes the
  // polygon and plots it.
  if (closesPolygon(event)) {
    if (!analysis.drawCrossings.length) {
      finishDrawing();
    }
    return true;
  }
  analysis.drawVertices.push({ lat: geo.lat, lon: geo.lon });
  if (
    analysis.drawMode === DRAW_MODES.BOX &&
    analysis.drawVertices.length === 1
  ) {
    startBox();
  }
  if (analysis.drawMode === DRAW_MODES.POINT) {
    finishDrawing();
  }
  return true;
}

// A live dataset published newer time steps: plots that read any of them
// read those chunks again when asked for. The first notice covers every
// step up to it (plots may have been made before it arrived).
watch(
  () => globe.liveTimestep,
  (timestep, before) => {
    if (timestep !== undefined) {
      const from = before === undefined ? 0 : Math.min(before + 1, timestep);
      analysis.livePublished(from, timestep);
    }
  }
);

// Picking a country: the map shows a crosshair while the panel is open
// (a page class; the map's camera controls set their own inline cursor).
watch(
  () => Boolean(mapCountryPicker.value) || analysis.drawMode === DRAW_MODES.BOX,
  (picking) => document.body.classList.toggle("analysis-picking", picking)
);
onBeforeUnmount(() => document.body.classList.remove("analysis-picking"));

// Hidden (distraction-free), it takes no map clicks or right-clicks: the
// bare map's own handling applies.
let unregister: (() => void) | undefined;
watch(
  () => props.hidden,
  (hidden) => {
    unregister?.();
    unregister = hidden
      ? undefined
      : registerMapTool({ contextMenu: openMenu, click: onMapClick });
  },
  { immediate: true }
);
onBeforeUnmount(() => unregister?.());
onBeforeUnmount(() => clearTimeout(offMapTimer));
// What each control is, in a small label beside it on hover.
let removeHoverLabels: (() => void) | undefined;
onMounted(() => {
  removeHoverLabels = layer.value && installHoverLabels(layer.value);
});
onBeforeUnmount(() => removeHoverLabels?.());

useEventListener(window, "keydown", (event: KeyboardEvent) => {
  const tag = (event.target as HTMLElement | null)?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    return;
  }
  if (dial.value) {
    return;
  }
  if (analysis.drawMode === DRAW_MODES.NONE) {
    return;
  }
  // A focused control does its own labelled action (Enter on Cancel
  // cancels, on Undo undoes); the shortcuts apply only elsewhere.
  const control = (event.target as HTMLElement | null)?.closest?.(
    "button, a[href], [role='button'], [role='menuitem'], [role='tab'], summary"
  );
  if (
    control &&
    (event.key === "Enter" || event.key === " " || event.key === "Backspace")
  ) {
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    finishDrawing();
  } else if (event.key === "Escape") {
    cancelDrawing();
  } else if (event.key === "Backspace") {
    event.preventDefault();
    analysis.drawVertices.pop();
  }
});

useEventListener(window, "pointerdown", (event: PointerEvent) => {
  const target = event.target as HTMLElement;
  if (
    dial.value &&
    !target.closest?.(".orbit-dial") &&
    !target.closest?.(".analysis-plots-button")
  ) {
    closeDial(false);
  }
  if (menu.value && !target.closest?.(".plot-menu")) {
    closeMenu(false);
  }
});

// The launcher's New plot asks whether to draw or type coordinates.
type TEntryVertex = { lat: string; lon: string };
/**
 * Where typed coordinates were asked for (layer pixels): the place
 * right-clicked, or Plotting tools (`above` its button); the panel opens
 * beside it, inside the map (24 Nov: it always opened at the lower left).
 */
const entryAnchor = ref<{ x: number; y: number; above?: boolean } | null>(null);
const entryPanel = ref<HTMLElement>();
const entryPanelSize = useElementSize(entryPanel);
const ENTRY_WIDTH = 300;
/** The panel's height when it opened: its foot is placed by it, once. */
const entryFirstTall = ref<number>();
watch(entryAnchor, () => (entryFirstTall.value = undefined));
watch(
  () => entryPanelSize.height.value,
  (tall) => {
    if (tall && entryFirstTall.value === undefined) {
      entryFirstTall.value = tall;
    }
  }
);
const entryStyle = computed(() =>
  panelBeside(entryAnchor.value, entryFirstTall.value)
);
// Importing a shape opens where typed coordinates would (25 Nov).
const shapePanel = ref<HTMLElement>();
const shapePanelSize = useElementSize(shapePanel);
const shapeStyle = computed(() =>
  panelBeside(entryAnchor.value, shapePanelSize.height.value || undefined)
);
/**
 * A panel opened from a place (right-click) or from Plotting tools: beside
 * the place or above the button, inside the map; at most 420 px tall,
 * growing upward from its foot as rows are added (25 Nov).
 */
function panelBeside(
  at: { x: number; y: number; above?: boolean } | null,
  firstTall: number | undefined
) {
  const [width, height] = [layerSize.width.value, layerSize.height.value];
  if (!at || narrowLayer.value || !width || !height) {
    return undefined;
  }
  const limit = `${Math.min(420, height - 16)}px`;
  // The panel's own height (border box) when it opened.
  const real = Math.min(420, firstTall || 220);
  const tall = real + 34;
  const inside = (x: number, low: number, high: number) =>
    Math.max(low, Math.min(x, high));
  if (at.above) {
    return {
      left: `${inside(at.x, 8, width - ENTRY_WIDTH - 8)}px`,
      bottom: `${inside(height - at.y + 10, 8, height - tall - 8)}px`,
      top: "auto",
      maxHeight: limit,
    };
  }
  // Right of the place, or left of it where the map has no room. Its foot
  // stays put, so added rows grow it upward (25 Nov), its first row level
  // with the place while there is room.
  const right = at.x + 14;
  const left =
    right + ENTRY_WIDTH <= width - 8 ? right : at.x - 14 - ENTRY_WIDTH;
  const top = inside(at.y - 12, 8, height - tall - 8);
  return {
    left: `${inside(left, 8, width - ENTRY_WIDTH - 8)}px`,
    bottom: `${Math.max(8, height - top - real)}px`,
    top: "auto",
    maxHeight: limit,
  };
}
const entryVertices = ref<TEntryVertex[]>([]);
const entryBox = ref({ west: "", east: "", south: "", north: "" });

function enterNew(kind: TAnalysisKind, mode: TDrawMode, from?: TMapGeoPoint) {
  entryKind.value = kind;
  entryMode.value = mode;
  entryError.value = "";
  entryRow.value = undefined;
  boxCornersClicked = from ? 1 : 0;
  const count =
    entryMode.value === DRAW_MODES.POLYGON
      ? 3
      : entryMode.value === DRAW_MODES.POLYLINE
        ? 2
        : 1;
  entryVertices.value = Array.from({ length: count }, () => ({
    lat: "",
    lon: "",
  }));
  entryBox.value = { west: "", east: "", south: "", north: "" };
  // A right-click's place starts the entry: vertex 1 or corner 1.
  if (from) {
    const [lat, lon] = [pickedText(from.lat), pickedText(from.lon)];
    if (mode === DRAW_MODES.BOX) {
      entryBox.value = { west: lon, east: "", south: lat, north: "" };
    } else {
      entryVertices.value[0] = { lat, lon };
    }
  }
}

const entryMode = ref<TDrawMode>(DRAW_MODES.POINT);
/** The row being typed in (a click on the map fills it). */
const entryRow = ref<number>();
/** Box corners clicked on the map so far (0, 1: then the other corner). */
let boxCornersClicked = 0;

/**
 * A click on the map while coordinates are typed fills them (25 Nov): the
 * row in use, else the first empty one, else a new one where the shape
 * takes more; a box takes one corner, then the other.
 */
function fillEntryFrom(geo: TMapGeoPoint): true {
  const [lat, lon] = [pickedText(geo.lat), pickedText(geo.lon)];
  if (entryMode.value === DRAW_MODES.BOX) {
    const box = entryBox.value;
    if (boxCornersClicked % 2 === 0) {
      entryBox.value = { west: lon, east: "", south: lat, north: "" };
    } else {
      const [s1, n1] = [Number(box.south), Number(lat)].sort((a, b) => a - b);
      // The two clicked longitudes bound the shorter interval, as a box dragged
      // between them does, whichever was clicked first.
      const [a, b] = [Number(box.west), Number(lon)];
      const eastward = (((b - a) % 360) + 360) % 360;
      const [west, east] = eastward > 180 ? [lon, box.west] : [box.west, lon];
      entryBox.value = {
        west,
        east,
        south: pickedText(s1),
        north: pickedText(n1),
      };
    }
    boxCornersClicked++;
    return true;
  }
  const rows = entryVertices.value;
  const focused = entryRow.value;
  const empty = rows.findIndex((v) => !v.lat.trim() && !v.lon.trim());
  const many =
    entryMode.value === DRAW_MODES.POLYLINE ||
    entryMode.value === DRAW_MODES.POLYGON;
  const at =
    focused !== undefined && focused < rows.length
      ? focused
      : empty >= 0
        ? empty
        : many
          ? rows.push({ lat: "", lon: "" }) - 1
          : rows.length - 1;
  rows[at] = { lat, lon };
  // The next click goes to the next empty row.
  const next = rows.findIndex(
    (v, k) => k > at && !v.lat.trim() && !v.lon.trim()
  );
  entryRow.value = next >= 0 ? next : undefined;
  return true;
}

/**
 * A picked coordinate as text: twelve significant digits, not four decimals.
 */
function pickedText(value: number) {
  return String(Number(value.toPrecision(12)));
}

function numberOf(text: string) {
  return text.trim() === "" ? Number.NaN : Number(text);
}

function submitEntry() {
  const kind = entryKind.value!;
  let geometry: TGeometry | undefined;
  if (entryMode.value === DRAW_MODES.BOX) {
    const { west, east, south, north } = entryBox.value;
    const values = [west, east, south, north].map(numberOf);
    if (values.every(Number.isFinite)) {
      const [w, e, s, n] = values;
      geometry = {
        kind: GEOMETRY_KINDS.BOX,
        west: w,
        east: e,
        south: s,
        north: n,
      };
    }
  } else {
    const vertices = entryVertices.value.map((v) => ({
      lat: numberOf(v.lat),
      lon: numberOf(v.lon),
    }));
    if (
      vertices.every(
        (v) =>
          Number.isFinite(v.lat) &&
          Number.isFinite(v.lon) &&
          Math.abs(v.lat) <= 90
      )
    ) {
      geometry =
        entryMode.value === DRAW_MODES.POLYLINE
          ? { kind: GEOMETRY_KINDS.POLYLINE, vertices }
          : entryMode.value === DRAW_MODES.POLYGON
            ? { kind: GEOMETRY_KINDS.POLYGON, vertices }
            : { kind: GEOMETRY_KINDS.POINT, ...vertices[0] };
    }
  }
  if (!geometry) {
    entryError.value =
      "Fill every field with degrees: latitude −90 to 90, longitude east of Greenwich.";
    return;
  }
  entryKind.value = null;
  create(kind, geometry);
}

/** The bar names the plot being drawn (e.g. Distance × time), not the tool. */
/**
 * The drawing bar's words: the plot drawn, the points so far (a chip),
 * what to do next, or what is wrong (a crossing outline).
 */
/** The shape being edited: the bar's title, hint and state. */
const shapeEditing = computed(() => {
  const edit = analysis.shapeEdit;
  const w = edit && analysis.windows.find((entry) => entry.id === edit.id);
  if (!edit || !w) {
    return undefined;
  }
  const g = w.draft.geometry;
  const hint =
    g.kind === GEOMETRY_KINDS.BOX
      ? "Drag a corner or an edge"
      : g.kind === GEOMETRY_KINDS.SHAPE
        ? "Drag a corner: only its two sides move"
        : g.kind === GEOMETRY_KINDS.POINT
          ? "Drag the point"
          : "Drag a point; + between two adds one; click a point to select it";
  const selected = edit.selected;
  const deletable =
    selected !== undefined && removeVertex(g, selected) !== undefined;
  return {
    label: w.label,
    hint,
    selected,
    deletable,
    changed: geometryKey(g) !== geometryKey(edit.start),
    crossing:
      g.kind === GEOMETRY_KINDS.POLYGON &&
      polygonCrossings(g.vertices).length > 0,
  };
});
const drawing = computed(() => {
  const n = analysis.drawVertices.length;
  const kind = analysis.drawKind;
  const name = kind
    ? kind === ANALYSIS_KINDS.HOVMOLLER_PATH
      ? "Distance × time"
      : PLOT_KIND_NAMES[kind]
    : undefined;
  const count = `${n} point${n === 1 ? "" : "s"}`;
  switch (analysis.drawMode) {
    case DRAW_MODES.POLYLINE:
      return {
        title: name ?? "Cross-section",
        count,
        hint: n < 2 ? "Click to add points; at least 2" : "Click to add more",
      };
    case DRAW_MODES.POLYGON: {
      const [first] = analysis.drawCrossings;
      const edge = (k: number) =>
        k === n - 1 ? `the closing edge (${n}→1)` : `edge ${k + 1}→${k + 2}`;
      return {
        title: `${name ?? "Area"} polygon`,
        count,
        hint:
          n < 3
            ? "Click to add points; at least 3"
            : "Click point 1 to close, or add more",
        warn: first
          ? `${edge(first[0])} crosses ${edge(first[1])}: undo the last point, or add points so the outline does not cross itself.`
          : undefined,
      };
    }
    case DRAW_MODES.BOX:
      return {
        title: name ?? "Box",
        // While dragging: exactly what will be computed.
        hint:
          analysis.drawBoxLabel ||
          (n
            ? "Click the opposite corner"
            : "Drag across the map to draw the box"),
      };
    case DRAW_MODES.POINT:
      return { title: name ?? "Point", hint: "Click a location on the map" };
    default:
      return { title: "", hint: "" };
  }
});

/**
 * How to draw, under the drawing bar: shown the first times a tool is used
 * (until its first point), and on demand (How?). On a phone it is asked for, never
 * shown by itself: the map stays in view.
 */
const guideSeen = ref(guidesSeen());
const guideAsked = ref(false);
watch(
  () => analysis.drawMode,
  () => {
    guideAsked.value = false;
  }
);
const showGuide = computed(
  () =>
    analysis.drawMode !== DRAW_MODES.NONE &&
    (guideAsked.value ||
      (!isNarrow(area.value) && !guideSeen.value.has(analysis.drawMode)))
);
function dismissGuide() {
  markGuideSeen(analysis.drawMode);
  guideSeen.value = guidesSeen();
  guideAsked.value = false;
}
// The first point placed shows the steps are understood: the guide folds
// away by itself, for good unless How? asks for it (25 Nov: Got it beside
// Finish confused which ends the drawing).
watch(
  () => analysis.drawVertices.length,
  (placed, before) => {
    if (placed > 0 && !before && showGuide.value && !guideAsked.value) {
      dismissGuide();
    }
  }
);

function formatGeo(geo: TMapGeoPoint) {
  return `${geo.lat.toFixed(3)}°, ${geo.lon.toFixed(3)}°`;
}
</script>

<template>
  <div
    ref="layer"
    class="analysis-layer"
    :class="{ narrow: narrowLayer, 'menu-open': menuCoversMap }"
  >
    <GeometryOverlay />
    <ShapeEditor v-if="analysis.shapeEdit" />
    <div v-show="!plotsAside" class="analysis-windows">
      <PlotWindow
        v-for="w in shownWindows"
        :key="w.id"
        :plot="w"
        :area-size="area"
      />
      <!-- Among the plots: it goes behind one clicked, as they do. -->
      <ComparePanel v-if="analysis.compare" />
    </div>

    <OrbitDial
      v-if="dial"
      ref="dialRef"
      :button="dial.button"
      :grow-origin="dial.grow"
      :area="{ width: layerSize.width.value, height: layerSize.height.value }"
      :variable="globe.varnameDisplay"
      :capabilities="capabilities"
      :note="menuNote"
      :vertical="verticalInfo"
      :suggestions="dialSuggestions"
      :compare-reason="compareLocked"
      @choose="chooseFromDial"
      @compare="compareFromDial"
      @closed="dialClosed"
    />
    <div
      v-if="offMap"
      class="analysis-off-map"
      role="status"
      :style="{ left: `${offMap.x}px`, top: `${offMap.y}px` }"
    >
      Right-click on the globe to plot there
    </div>
    <!-- The variable a plot reads, though the map may not show it (still
         loading, or failed to load: a GEFS menu said "-"). -->
    <PlotMenu
      v-if="menu"
      :key="`${menu.at.x},${menu.at.y}`"
      :at="menu.at"
      :area="{ width: layerSize.width.value, height: layerSize.height.value }"
      :variable="globe.varnameSelector || globe.varnameDisplay"
      :place="formatGeo(menu.geo)"
      :approximate="!menu.event.reliable"
      :capabilities="capabilities"
      :note="menuNote"
      :vertical="verticalInfo"
      @choose="chooseFromMenu"
      @compare="compareFromMenu"
      @close="closeMenu()"
    />
    <div
      v-if="countryChoice"
      class="analysis-entry analysis-panel analysis-country at-top"
      role="dialog"
      aria-labelledby="country-plot-title"
    >
      <div id="country-plot-title" class="analysis-entry-title">
        {{ countryTitle }}
      </div>
      <CountryPicker
        :initial="countryChoice.initial"
        :submit-label="countryChoice.plot ? 'Use for this plot' : 'Create plot'"
        :offer-shapes="!countryChoice.plot"
        :compact="narrowLayer"
        :bar="!narrowLayer"
        @select="submitCountry"
        @cancel="cancelCountry"
        @preview="previewCountry"
        @import-shape="importInstead"
      />
    </div>

    <div
      v-if="shapeChoice"
      ref="shapePanel"
      class="analysis-entry analysis-panel analysis-country"
      :style="shapeStyle"
      role="dialog"
      aria-labelledby="shape-plot-title"
    >
      <div id="shape-plot-title" class="analysis-entry-title">
        {{
          shapeChoice.chooseKind
            ? "Plot over an imported shape"
            : `${PLOT_KIND_NAMES[shapeChoice.kind]} over an imported shape`
        }}
      </div>
      <ShapePicker
        :key="shapeChoice.files?.length ?? 0"
        :kind="shapeChoice.kind"
        :files="shapeChoice.files"
        :choose-kind="shapeChoice.chooseKind"
        submit-label="Create plot"
        @select="submitShape"
        @cancel="cancelShape"
        @preview="analysis.shapePreview = $event"
      />
    </div>
    <div v-if="dropping" class="analysis-drop-hint" role="status">
      <i class="fa-solid fa-file-arrow-up mr-1" aria-hidden="true"></i>
      Drop to plot over this shape
    </div>

    <!-- Editing a plot's shape: what to do, Cancel and Apply. -->
    <div
      v-if="shapeEditing"
      class="analysis-drawbar analysis-panel"
      role="toolbar"
      aria-label="Editing a shape"
      data-shape-edit
    >
      <div class="analysis-drawbar-line">
        <span class="analysis-drawbar-title"
          >Edit {{ shapeEditing.label }}'s shape</span
        >
        <span class="analysis-drawbar-hint" :title="shapeEditing.hint">{{
          shapeEditing.hint
        }}</span>
        <span class="analysis-drawbar-actions">
          <button
            v-if="shapeEditing.selected !== undefined"
            type="button"
            class="analysis-bar-button analysis-bar-delete"
            data-delete-selected
            :disabled="!shapeEditing.deletable"
            :title="
              shapeEditing.deletable
                ? 'Delete the selected point (Delete key)'
                : 'An area keeps at least 3 points, a path 2'
            "
            @click="analysis.deleteEditPoint()"
          >
            <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
            Delete point {{ shapeEditing.selected + 1 }}
          </button>
          <button
            type="button"
            class="analysis-bar-button analysis-bar-cancel"
            aria-label="Cancel"
            title="Cancel (Esc)"
            @click="analysis.endShapeEdit(false)"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            <span class="analysis-bar-label">Cancel</span>
          </button>
          <button
            type="button"
            class="analysis-bar-button analysis-bar-finish"
            :disabled="!shapeEditing.changed || shapeEditing.crossing"
            :title="
              shapeEditing.crossing
                ? 'The outline crosses itself: an area needs one inside'
                : shapeEditing.changed
                  ? 'Read the plot for the new shape'
                  : 'Move a handle first'
            "
            @click="analysis.endShapeEdit(true)"
          >
            <i class="fa-solid fa-check" aria-hidden="true"></i>
            Apply
          </button>
        </span>
      </div>
      <p
        v-if="shapeEditing.crossing"
        class="analysis-drawbar-warn"
        role="alert"
      >
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        The outline crosses itself; move a point so that it does not.
      </p>
    </div>

    <div
      v-if="analysis.drawMode !== DRAW_MODES.NONE"
      class="analysis-drawbar analysis-panel"
      role="toolbar"
      aria-label="Drawing tool"
    >
      <div class="analysis-drawbar-line">
        <span class="analysis-drawbar-title">{{ drawing.title }}</span>
        <span
          v-if="drawing.count"
          class="analysis-drawbar-count"
          :title="drawing.count"
          >{{
            narrowLayer ? drawing.count.replace(/\D+$/, "") : drawing.count
          }}</span
        >
        <span class="analysis-drawbar-hint" :title="drawing.hint">{{
          drawing.hint
        }}</span>
        <span class="analysis-drawbar-actions">
          <button
            type="button"
            class="analysis-bar-button analysis-bar-how"
            :aria-pressed="showGuide"
            title="How to draw"
            @click="showGuide ? dismissGuide() : (guideAsked = true)"
          >
            <i class="fa-regular fa-circle-question" aria-hidden="true"></i>
            <span class="analysis-bar-label">How?</span>
          </button>
          <button
            v-if="analysis.drawMode !== DRAW_MODES.POINT"
            type="button"
            class="analysis-bar-button"
            :disabled="!analysis.drawVertices.length"
            title="Remove the last point"
            @click="analysis.drawVertices.pop()"
          >
            <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
            <span class="analysis-bar-label">Undo</span>
          </button>
          <button
            type="button"
            class="analysis-bar-button analysis-bar-cancel"
            aria-label="Cancel"
            title="Cancel (Esc)"
            @click="cancelDrawing"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            <span class="analysis-bar-label">Cancel</span>
          </button>
          <button
            v-if="
              analysis.drawMode === DRAW_MODES.POLYLINE ||
              analysis.drawMode === DRAW_MODES.POLYGON
            "
            type="button"
            class="analysis-bar-button analysis-bar-finish"
            :disabled="
              analysis.drawVertices.length <
                (analysis.drawMode === DRAW_MODES.POLYGON ? 3 : 2) ||
              analysis.drawCrossings.length > 0
            "
            :title="
              analysis.drawCrossings.length
                ? 'The outline crosses itself: an area needs one inside'
                : undefined
            "
            @click="finishDrawing"
          >
            <i class="fa-solid fa-check" aria-hidden="true"></i>
            Finish
          </button>
        </span>
      </div>
      <!-- What stops Finish, in full, under the line. -->
      <p v-if="drawing.warn" class="analysis-drawbar-warn" role="alert">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        {{ drawing.warn }}
      </p>
      <DrawGuide
        v-if="showGuide"
        :mode="analysis.drawMode"
        :kind="analysis.drawKind"
        :placed="analysis.drawVertices.length"
        :compact="isNarrow(area)"
      />
    </div>

    <form
      v-if="entryKind"
      ref="entryPanel"
      class="analysis-entry analysis-panel"
      :style="entryStyle"
      :aria-label="`Enter coordinates for a ${PLOT_KIND_NAMES[entryKind].toLowerCase()}`"
      @submit.prevent="submitEntry"
    >
      <div class="analysis-entry-title">
        {{ PLOT_KIND_NAMES[entryKind] }}: enter coordinates
      </div>
      <p class="analysis-entry-tip">
        Type them, or click the map to fill
        {{ entryMode === DRAW_MODES.BOX ? "a corner" : "the row in use" }}.
      </p>
      <div v-if="entryMode === DRAW_MODES.BOX" class="analysis-entry-grid">
        <label
          v-for="field in ['west', 'east', 'south', 'north'] as const"
          :key="field"
        >
          <span>{{
            {
              west: "West (° E)",
              east: "East (° E)",
              south: "South (° N)",
              north: "North (° N)",
            }[field]
          }}</span>
          <input
            v-model="entryBox[field]"
            class="input is-small"
            inputmode="decimal"
          />
        </label>
      </div>
      <template v-else>
        <div
          v-for="(v, at) in entryVertices"
          :key="at"
          class="analysis-entry-row"
          :class="{ 'is-target': entryRow === at }"
          @focusin="entryRow = at"
        >
          <span v-if="entryVertices.length > 1" class="analysis-entry-number">{{
            at + 1
          }}</span>
          <label>
            <span>Latitude (° N)</span>
            <input v-model="v.lat" class="input is-small" inputmode="decimal" />
          </label>
          <label>
            <span>Longitude (° E)</span>
            <input v-model="v.lon" class="input is-small" inputmode="decimal" />
          </label>
          <button
            v-if="
              entryVertices.length >
                (entryMode === DRAW_MODES.POLYGON ? 3 : 2) &&
              entryMode !== DRAW_MODES.POINT
            "
            type="button"
            class="analysis-bar-button"
            :aria-label="`Remove point ${at + 1}`"
            @click="entryVertices.splice(at, 1)"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
        <button
          v-if="
            entryMode === DRAW_MODES.POLYLINE ||
            entryMode === DRAW_MODES.POLYGON
          "
          type="button"
          class="analysis-bar-button"
          @click="entryVertices.push({ lat: '', lon: '' })"
        >
          Add point
        </button>
      </template>
      <p v-if="entryError" class="analysis-entry-error">{{ entryError }}</p>
      <div class="analysis-entry-actions">
        <button
          type="button"
          class="analysis-bar-button"
          @click="entryKind = null"
        >
          Cancel
        </button>
        <button type="submit" class="button is-small is-link">
          Create plot
        </button>
      </div>
    </form>

    <PlotsLauncher
      :hidden="(narrowLayer && shownWindows.length > 0) || menuCoversMap"
      :dial-open="Boolean(dial)"
      :compare-reason="compareLocked"
      @new-plot="toggleLauncherDial"
    />
    <div class="is-sr-only" role="status" aria-live="polite">
      {{ analysis.announcement }}
    </div>
  </div>
</template>

<style scoped>
/*
 * No stacking context of its own: the map outlines (z 5) stay below the
 * controls panel (z 10), while windows, menus and the launcher stay above.
 */
.analysis-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  font-size: 0.8rem;
}
.analysis-layer > * {
  pointer-events: auto;
}
/* The shape editor covers the map but passes it every drag (only its
   handles take the pointer), and keeps its handles on the map (25 Nov:
   by stylesheet order it caught every drag, and a path partly out of view
   put handles over the sidebar). */
.analysis-layer > .shape-editor {
  pointer-events: none;
  overflow: hidden;
}
/* The right-click menu's full-map host too: only the menu takes the
   pointer. */
.analysis-layer > .plot-menu-host {
  pointer-events: none;
}
/* Windows stack among themselves; menus and drawing tools stay above them. */
.analysis-layer > .analysis-windows {
  position: absolute;
  inset: 0;
  z-index: 20;
  pointer-events: none;
}
.analysis-windows > * {
  pointer-events: auto;
}
/* Dragging a file over the map: where it will go. */
.analysis-drop-hint {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 22;
  transform: translate(-50%, -50%);
  padding: 10px 16px;
  border: 2px dashed var(--plot-accent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--plot-bg) 90%, transparent);
  color: var(--plot-fg);
  font-weight: 600;
  pointer-events: none;
}
/* The tip for a right-click off the map, just below the pointer. */
.analysis-off-map {
  position: absolute;
  z-index: 22;
  transform: translate(-50%, 12px);
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--plot-fg);
  color: var(--plot-bg);
  font-size: 0.78rem;
  white-space: nowrap;
  pointer-events: none;
  animation: analysis-off-map 1.8s ease forwards;
}
@keyframes analysis-off-map {
  0%,
  80% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .analysis-off-map {
    animation: none;
  }
}
.analysis-drawbar,
.analysis-entry {
  z-index: 21;
}
/* A fixed width: the live size and place in the hint change at every move of
   the pointer, and a bar sized by its text shook. */
.analysis-drawbar {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 6px 6px 14px;
  width: min(680px, calc(100% - 24px));
  max-width: calc(100% - 24px);
  border-radius: 10px;
  font-size: 0.8rem;
}
/* One line: the plot, its points, the next step, then the actions. The
   hint gives way first (it ends in an ellipsis), never the buttons. */
.analysis-drawbar-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.analysis-drawbar-title {
  flex: none;
  font-weight: 650;
  white-space: nowrap;
}
.analysis-drawbar-count {
  flex: none;
  padding: 1px 8px;
  font-size: 0.72rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--plot-accent);
  background: color-mix(in srgb, var(--plot-accent) 14%, transparent);
  border-radius: 999px;
}
.analysis-drawbar-hint {
  flex: 1 1 auto;
  font-variant-numeric: tabular-nums;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--plot-muted);
}
.analysis-drawbar-actions {
  flex: none;
  display: flex;
  gap: 6px;
  margin-left: 6px;
}
.analysis-drawbar .analysis-bar-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: 7px;
}
.analysis-drawbar .analysis-bar-button .fa-solid {
  font-size: 0.7rem;
}
.analysis-bar-finish {
  font-weight: 600;
  color: var(--plot-bg) !important;
  background: var(--plot-accent) !important;
  border-color: var(--plot-accent) !important;
}
.analysis-bar-finish:disabled {
  color: var(--plot-muted) !important;
  background: none !important;
  border-color: var(--plot-border) !important;
}
.analysis-drawbar-warn {
  max-width: 520px;
  margin: 6px 8px 2px 0;
  font-size: 0.74rem;
  line-height: 1.4;
  color: var(--plot-danger);
}
/* Thinner on touch screens too (25 Nov: 44 px buttons made the bars
   tall); 32 px still takes a finger. */
@media (pointer: coarse) {
  .analysis-drawbar .analysis-bar-button {
    height: 32px;
  }
}
/* The phone's menu over the map: the drawing and entry panels wait under
   it, kept as they are, not shown on top of its controls (25 Nov). */
.analysis-layer.menu-open > .analysis-drawbar,
.analysis-layer.menu-open > .analysis-entry {
  display: none;
}
/* Delete point: its bin in red, the button stays quiet. */
.analysis-bar-delete i {
  color: var(--plot-danger, #dc2626);
}
/* Cancel in red: it drops what was drawn. */
.analysis-bar-cancel {
  color: var(--plot-danger, #dc2626) !important;
  border-color: color-mix(
    in srgb,
    var(--plot-danger, #dc2626) 45%,
    transparent
  ) !important;
}
.analysis-bar-cancel:hover {
  background: color-mix(
    in srgb,
    var(--plot-danger, #dc2626) 12%,
    transparent
  ) !important;
}
/* A phone: the bar sits low, above Plotting tools, so the page header
   stays visible; its buttons are icons (Cancel a red ✕), the hint wraps. */
.analysis-layer.narrow .analysis-drawbar {
  top: auto;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 72px);
  width: calc(100% - 16px);
  max-width: none;
  padding: 6px 6px 6px 10px;
}
/* One row on a phone: title, points, then the buttons; the title gives
   way (an ellipsis), never the buttons; the hint is the small line under
   them (25 Nov). */
.analysis-layer.narrow .analysis-drawbar-line {
  display: grid;
  grid-template-columns: minmax(0, max-content) auto minmax(0, 1fr) auto;
  column-gap: 6px;
  row-gap: 2px;
}
.analysis-layer.narrow .analysis-drawbar-title {
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.analysis-layer.narrow .analysis-drawbar-count {
  grid-column: 2;
  grid-row: 1;
}
.analysis-layer.narrow .analysis-drawbar-actions {
  grid-column: 4;
  grid-row: 1;
}
.analysis-layer.narrow .analysis-drawbar-hint {
  grid-column: 1 / -1;
  grid-row: 2;
  white-space: normal;
  font-size: 0.72rem;
}
.analysis-layer.narrow .analysis-drawbar-actions {
  margin-left: auto;
}
.analysis-layer.narrow .analysis-bar-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.analysis-layer.narrow .analysis-drawbar .analysis-bar-button {
  padding: 0 9px;
}
.analysis-layer.narrow .analysis-bar-cancel {
  width: 32px;
  justify-content: center;
  padding: 0;
  border-radius: 50%;
}
.analysis-bar-button {
  min-height: 24px;
  background: none;
  border: 1px solid var(--plot-border);
  border-radius: 4px;
  color: var(--plot-fg);
  padding: 2px 8px;
  cursor: pointer;
  font: inherit;
}
.analysis-bar-button:disabled {
  color: var(--plot-muted);
  cursor: default;
}
.analysis-entry {
  position: absolute;
  left: 16px;
  bottom: 124px;
  width: 300px;
  max-height: calc(100% - 160px);
  overflow: auto;
  padding: 16px;
}
/* Choosing a country: at the top of the map, as the drawing guides are
   (25 Nov), the list dropping down from its search field. */
.analysis-entry.at-top {
  top: 12px;
  bottom: auto;
  left: 50%;
  transform: translateX(-50%);
  width: min(680px, calc(100% - 24px));
  max-height: none;
  /* Slim, as the drawing guides are; the search list drops out of it. */
  overflow: visible;
  padding: 10px 14px;
}
.analysis-entry.at-top .analysis-entry-title {
  margin-bottom: 6px;
}
/* The row a click on the map fills. */
.analysis-entry-row.is-target input {
  border-color: var(--bulma-link, #485fc7);
}
.analysis-entry-tip {
  color: var(--plot-muted);
  font-size: 0.8rem;
  margin: -4px 0 8px;
}
/* A phone: entry panels are a low sheet across the map, so most of the
   map (where a country is tapped) stays in view above them. */
.analysis-layer.narrow .analysis-entry {
  left: 8px;
  right: 8px;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 68px);
  width: auto;
  max-height: 46%;
  padding: 10px 12px;
}
.analysis-layer.narrow .analysis-entry.at-top {
  top: auto;
  transform: none;
  width: auto;
}
.analysis-entry-title {
  font-weight: 600;
  margin-bottom: 8px;
}
.analysis-entry-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.analysis-entry-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  margin-bottom: 8px;
}
.analysis-entry label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}
.analysis-entry label > span {
  color: var(--plot-muted);
}
.analysis-entry-number {
  padding-bottom: 6px;
  min-width: 1rem;
}
.analysis-entry-error {
  color: var(--plot-danger);
  margin-top: 8px;
}
.analysis-entry-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
