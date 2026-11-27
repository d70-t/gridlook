<script lang="ts" setup>
import {
  onClickOutside,
  useActiveElement,
  useMediaQuery,
  useResizeObserver,
} from "@vueuse/core";
import {
  computed,
  markRaw,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  ref,
  watch,
} from "vue";

import CanvasFigure from "./CanvasFigure.vue";
import {
  chartValuesCsv,
  hodographCsv,
  roseCsv,
  scatterCsv,
} from "./chartValues.ts";
import { customLimitsInUse, plotScale } from "./colourScale.ts";
import ComputeModeSwitch from "./ComputeModeSwitch.vue";
import { compactDateRange, shortDate } from "./dateRangeText.ts";
import {
  CENTRAL_RANGES,
  CURVE_NAMES,
  CURVE_VIEWS,
  cdfPoints,
  DEFAULT_RANGE,
  distributionMarks,
  rangeName,
  shareAboveText,
  summaryText,
  type TCurveView,
} from "./distribution.ts";
import { errorHelp, type TErrorAction } from "./errorHelp.ts";
import type { TExportFormat } from "./exportMenu.ts";
import { customLayout, printedMillimetres } from "./exportSize.ts";
import {
  captionHeight,
  composeFigure,
  plotColor,
  type TFigureText,
} from "./figure.ts";
import { followRequest } from "./followMap.ts";
import HeatmapCanvas from "./HeatmapCanvas.vue";
import {
  chanceAbove,
  meanDurations,
  memberStats,
  roundThreshold,
} from "./members.ts";
import {
  methodSections,
  readDiagnostics,
  type TRowAction,
  levelReadText,
} from "./methodFacts.ts";
import PlotExportMenu from "./PlotExportMenu.vue";
import {
  chartSpec,
  latitudeMonotonic,
  latitudeVaries,
  countThreshold,
  dataView,
  heatmapSpec,
  sliceSpec,
  partialText,
  selectionSubtitle,
  shownValues,
  TABLE_ROWS,
  type TSeriesSpec,
} from "./plotFigure.ts";
import PlotIcon from "./PlotIcon.vue";
import {
  axisQuantity,
  clampRect,
  focusPlotsButton,
  geometryVertices,
  idMeaning,
  isNarrow,
  isReading,
  correspondingIndex,
  mapCoordinateOf,
  mapSettingsFromStore,
  maximizedRect,
  pendingChanges,
  quantityTitle,
  resizedRect,
  verticalTitle,
  type TResizeEdge,
} from "./plotLayout.ts";
import PlotMethod from "./PlotMethod.vue";
import { foldInto, growFrom, launcherBox } from "./plotMotion.ts";
import PlotSettings from "./PlotSettings.vue";
import {
  bytesRead,
  bytesText,
  chunksText,
  goalDates,
  partsText,
  stagesOf,
} from "./readStatus.ts";
import {
  coveredValues,
  drawScatter,
  probeScatter,
  samplingNote,
  scatterOf,
} from "./scatterFigure.ts";
import SectionCanvas from "./SectionCanvas.vue";
import SeriesChart from "./SeriesChart.vue";
import {
  periodDates,
  reshapeViews,
  reshapedSpec,
  type TSeriesContext,
} from "./seriesViews.ts";
import {
  annualCycle,
  anomalies,
  dateKey,
  datePieces,
  defaultWindow,
  diurnalCycle,
  linearTrend,
  trendRate,
  MONTHS,
  monthOf,
  spansMonths,
  stepName,
  stepSeconds,
  subDaily,
  TIME_VIEWS,
  type TTimeView,
} from "./timeViews.ts";
import { introduceTab, viewTabs, type TViewTab } from "./viewTabs.ts";
import { windText } from "./windBarbs.ts";
import {
  drawHodograph,
  drawRose,
  probeHodograph,
  probeRose,
  roseOf,
} from "./windFigures.ts";
import WindowDialog from "./WindowDialog.vue";

import {
  resultCsvParts,
  resultProvenance,
} from "@/lib/analysis/analysisExport.ts";
import { timeLabelAt, timeLabels } from "@/lib/analysis/calendar.ts";
import { pairCandidates, pairHint } from "@/lib/analysis/companionAlign.ts";
import {
  convertResult,
  defaultChartStyle,
  temperatureMetadata,
} from "@/lib/analysis/displayUnits.ts";
import { freezeResult } from "@/lib/analysis/partialUpdates.ts";
import {
  PREVIEW_BYTES,
  previewFacts,
  withOverlayBytes,
  withPartnerBytes,
  remainingChunks,
} from "@/lib/analysis/preview.ts";
import { polygonCrossings } from "@/lib/analysis/sphere.ts";
import {
  clipSelection,
  rowCount,
  rowOf,
  rowsBefore,
  rowsUntil,
} from "@/lib/analysis/timeRows.ts";
import {
  ANALYSIS_KINDS,
  GEOMETRY_KINDS,
  maxDatesFor,
  SECTION_MODES,
  SPREAD_VIEWS,
  TIME_RANGE_KINDS,
  type TAnalysisKind,
  type TAnalysisResult,
  type TSpreadView,
} from "@/lib/analysis/types.ts";
import { converter } from "@/lib/analysis/unitConvert.ts";
import {
  levelStatisticsOverRows,
  statisticOverTime,
  verticalStatistics,
  type TColumn,
  type TVerticalStat,
} from "@/lib/analysis/verticalStats.ts";
import {
  AUTO_COMPUTE_BYTES,
  DRAW_MODES,
  PLOT_KIND_NAMES,
  PLOT_STATUS,
  ensembleOf,
  otherMemberReads,
  isCurrentPair,
  levelText,
  oceanVertical,
  overlayBytes,
  shownCompanions,
  standardNameOf,
  useAnalysisStore,
  type TMemberView,
  type TPlotWindow,
} from "@/store/analysisStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { formatValue } from "@/utils/formatValue.ts";

const props = defineProps<{
  plot: TPlotWindow;
  /** The map area's live size: compact layout and clamping follow it. */
  areaSize: { width: number; height: number; top?: number };
}>();

const analysis = useAnalysisStore();
const globe = useGlobeControlStore();
const root = ref<HTMLElement>();
const chart = ref<{
  canvas: () => HTMLCanvasElement | undefined;
  renderExport: (
    width: number,
    height: number,
    target?: HTMLCanvasElement,
    ratio?: number
  ) => Promise<HTMLCanvasElement>;
}>();

// Exported figures have their own size, independent of the window.
const EXPORT_SIZE = { width: 960, height: 540 };
/** Whether a PNG of this size can be drawn, or why not; its print size. */
function checkPngSize(size: { width: number; height: number }) {
  const fit = customLayout(
    size,
    EXPORT_SIZE.width,
    captionHeight(exportCaption(), EXPORT_SIZE.width, root.value),
    slice.value ? 260 : 0
  );
  return "error" in fit
    ? { error: fit.error, note: "" }
    : {
        error: "",
        note: `At 300 dpi it prints ${printedMillimetres(size.width, 300)} × ${printedMillimetres(size.height, 300)} mm.`,
      };
}
const exportNote = ref("");
const closing = ref(false);
// Minimize, Maximize/Restore and Close at the upper right on every
// platform and width; a coarse pointer gets 44 px targets.
const coarse = useMediaQuery("(pointer: coarse)");

const w = computed(() => props.plot);
// While a PNG is drawn, the window shows the revision captured at the click,
// so the figure, caption and status cannot move on underneath it.
const pinned = ref<TAnalysisResult>();
/** A figure being drawn for export: one at a time, Export off meanwhile. */
const drawingFigure = ref(false);
/** The result as read, in the file's units: data exports and pinning. */
const storedResult = computed(() => pinned.value ?? w.value.result);
/** The result as shown: in the units chosen under Settings → Display. */
const result = computed(() =>
  storedResult.value
    ? convertResult(
        storedResult.value,
        w.value.displayUnits,
        // A snapshot carries its own meaning; the open dataset's metadata
        // is another dataset's.
        standardNameOf(
          storedResult.value,
          w.value.snapshot ? {} : analysis.variableSources
        )
      )
    : undefined
);
// The displayed result's own variable summary: a variable chosen in
// Settings but not applied does not relabel the chart.
const summary = computed(() =>
  result.value && w.value.resultSummary
    ? w.value.resultSummary
    : (w.value.committedBinding?.summary ?? w.value.summary)
);
// The figure, title, marker and exports describe what is on screen: the
// result's own query, else the committed one; edits stay pending.
const shownQuery = computed(() => result.value?.query ?? w.value.committed);
/** The catalog level read, said when the dataset has several. */
const levelRead = computed(() => {
  const source = w.value.committedBinding?.source ?? w.value.source;
  return levelReadText(
    result.value?.query.source.level ??
      levelText(source, shownQuery.value?.variable ?? w.value.draft.variable)
  );
});
const pending = computed(() => pendingChanges(w.value));
const variableName = computed(
  () => shownQuery.value?.variable ?? w.value.draft.variable
);
const title = computed(() =>
  quantityTitle(
    variableName.value,
    result.value?.longName ?? summary.value?.longName,
    result.value?.units ?? summary.value?.units
  )
);
/** The first line: the quantity, its units apart (set lighter). */
const heading = computed(() => ({
  name: quantityTitle(
    variableName.value,
    result.value?.longName ?? summary.value?.longName,
    undefined
  ),
  units: result.value?.units ?? summary.value?.units,
}));
const subtitle = computed(() => selectionSubtitle(w.value, shownQuery.value));
const busy = computed(() => isReading(w.value));
const isSeries = computed(
  () =>
    w.value.kind === ANALYSIS_KINDS.POINT_SERIES ||
    w.value.kind === ANALYSIS_KINDS.REGION_SERIES
);
/** Plots that can carry wind barbs: series in time, and profiles. */
const WIND_KINDS: string[] = [
  ANALYSIS_KINDS.POINT_SERIES,
  ANALYSIS_KINDS.REGION_SERIES,
  ANALYSIS_KINDS.PROFILE,
  ANALYSIS_KINDS.TIME_DEPTH,
  ANALYSIS_KINDS.SECTION,
];
type TWindChoice = Omit<ReturnType<typeof analysis.windAvailable>, "pair"> & {
  pair?: ReturnType<typeof analysis.windAvailable>["pair"];
};
const windChoice = computed<TWindChoice>(() =>
  WIND_KINDS.includes(w.value.kind) && !w.value.snapshot
    ? analysis.windAvailable(
        shownQuery.value?.variable ?? w.value.draft.variable
      )
    : { pair: undefined, pairs: [], reason: undefined, guess: undefined }
);
const windCompanions = computed(() =>
  w.value.wind ? shownCompanions(w.value, "wind") : undefined
);
// The components menu beside Barbs.
const windMenuOpen = ref(false);
const windMenuHost = ref<HTMLElement>();
onClickOutside(windMenuHost, () => (windMenuOpen.value = false));
const otherU = ref("");
const otherV = ref("");
/** The dataset's fields (not coordinates), for components with unusual names. */
const windVariables = computed(() =>
  Object.entries(analysis.variableSources)
    .filter(([, meta]) => !meta.support)
    .map(([name]) => name)
    .sort()
);
/**
 * Barbs offered when no pair is recognized by name or standard name
 * (25 Nov: CIOFS `u_eastward`/`v_northward` had no Barbs button at all):
 * the components are chosen, a best guess filled in.
 */
const windByHand = computed(
  () =>
    WIND_KINDS.includes(w.value.kind) &&
    !w.value.snapshot &&
    !windChoice.value.pair &&
    windVariables.value.length >= 2
);
function chooseWind(pair: { u: string; v: string } | undefined) {
  windMenuOpen.value = false;
  analysis.setWindChoice(w.value.id, pair);
}
/**
 * Whether the chart shown can carry barbs: its points are the series' own
 * samples (a time series, its anomalies, running mean or cumulative total,
 * a profile, a path, time–height, a section). Boxes by month, cycles,
 * counts, spectra, return levels, distributions and the figure tabs are
 * not (25 Nov: Barbs stayed on the bar over Boxes by month).
 */
const barbsFit = computed(() => {
  const shown = spec.value;
  return (
    !shownFigure.value &&
    (!shown || ["time", "path", "profile"].includes(shown.mode))
  );
});
/** The Barbs tool: components known or to choose, on a chart for barbs. */
const windOffered = computed(
  () => Boolean(windChoice.value.pair || windByHand.value) && barbsFit.value
);
/**
 * A current, not a wind (25 Nov): as read, else as its components'
 * standard names, the plot's depth axis or an ocean field beside them say.
 * Then the tool is Currents, with arrows; otherwise Barbs.
 */
const asCurrent = computed(() => {
  const read = windCompanions.value?.results;
  if (read) {
    return Boolean(windCompanions.value?.current);
  }
  const plotted = shownQuery.value?.variable ?? w.value.draft.variable;
  const pair = w.value.windChoice ??
    windChoice.value.pair ??
    windChoice.value.guess ?? { u: plotted, v: plotted };
  return isCurrentPair(
    pair,
    analysis.variableSources,
    oceanVertical((w.value.resultSummary ?? w.value.summary)?.vertical)
  );
});
/** The tool's words and icon, for a wind or a current. */
const vector = computed(() =>
  asCurrent.value
    ? {
        tool: "Currents",
        ask: "Arrows need the current",
        name: "Current arrows",
        what: "the current",
        marks: "arrows",
        icon: "currents" as const,
        components: "Current components",
      }
    : {
        tool: "Barbs",
        ask: "Barbs need the wind",
        name: "Wind barbs",
        what: "the wind",
        marks: "barbs",
        icon: "barbs" as const,
        components: "Wind components",
      }
);
/** Barbs pressed: on or off; with no components known, choose them first. */
function pressBarbs() {
  if (!w.value.wind && !windChoice.value.pair && !w.value.windChoice) {
    const guess = windChoice.value.guess;
    otherU.value ||= guess?.u ?? "";
    otherV.value ||= guess?.v ?? "";
    windMenuOpen.value = true;
    return;
  }
  analysis.setWind(w.value.id, !w.value.wind);
}
/** Automatic: the pair it found for this plot, once read. */
const autoWindLabel = computed(() => {
  const read = !w.value.windChoice && windCompanions.value?.results;
  return read
    ? `(${read.u.query.variable} / ${read.v.query.variable})`
    : "(matches the plot's level)";
});

/** The pair in use once read; before that, the likeliest one. */
const windTitle = computed(() => {
  if (w.value.wind && windCompanions.value?.status === "failed") {
    return `No ${vector.value.marks}: ${windCompanions.value.message ?? `${vector.value.what} could not be read`}`;
  }
  const read = windCompanions.value?.results;
  const known: { u: string; v: string } | undefined =
    w.value.windChoice ?? windChoice.value.pair;
  const [u, v] = read
    ? [read.u.query.variable, read.v.query.variable]
    : [known?.u, known?.v];
  if (!u || !v) {
    return `${vector.value.tool}: no eastward and northward components were recognized by name; choose them`;
  }
  return `${vector.value.name} from ${u} and ${v}`;
});
// Barbs follow the result on screen: a new result reads its components.
watch(
  () => [w.value.wind, w.value.status, result.value?.query] as const,
  ([on]) => on && void analysis.loadWind(w.value.id)
);
/** The barbs' components, in the result's own sample order. */
const windSpec = computed(() => {
  const ready = windCompanions.value;
  const geometry = result.value?.query.geometry;
  // Parts already read are drawn while the rest streams.
  if (!ready?.results || ready.status === "failed" || !geometry) {
    return undefined;
  }
  const { u, v } = ready.results;
  const lats = geometryVertices(geometry).map((p) => p.lat);
  const lat = lats.reduce((sum, value) => sum + value, 0) / (lats.length || 1);
  return {
    u: u.values,
    v: v.values,
    units: u.units,
    flip: lat < 0,
    current: Boolean(ready.current),
  };
});
/**
 * What is being read with the plot, said in its status line: the wind
 * components (parts of both, while a series streams) or the members.
 */
/**
 * Barbs waiting for approval: a card on the Barbs button, apart from the
 * chart's own read card (25 Nov: asked at the bottom, unseen, Barbs was
 * pressed again and again).
 */
const windAsk = computed(() => {
  const wind = windCompanions.value;
  return wind?.status === "confirm" && w.value.wind && !inMore("wind")
    ? { size: wind.size, message: wind.message }
    : undefined;
});
/** Turning each companion off. */
const COMPANION_STOPS = {
  wind: () => analysis.setWind(w.value.id, false),
  members: () => analysis.setMembers(w.value.id, undefined),
  pair: () => analysis.setPair(w.value.id, undefined),
};
// eslint-disable-next-line max-lines-per-function
const companionStatus = computed(() => {
  if (busy.value) {
    return undefined;
  }
  const wind = windCompanions.value;
  const members = memberCompanions.value;
  // A companion too large to start unasked: its cost, Read or turn it off.
  for (const [companions, purpose] of [
    [wind, "wind"],
    [members, "members"],
    [pairCompanions.value, "pair"],
  ] as const) {
    const stop = COMPANION_STOPS[purpose];
    // The wind asks on the Barbs button itself (25 Nov), unless Barbs is
    // under More, out of sight.
    if (
      companions?.status === "confirm" &&
      !(purpose === "wind" && windAsk.value)
    ) {
      return {
        purpose,
        text: companions.message ?? "A large read",
        progress: undefined,
        size: companions.size,
        read: () => analysis.approveCompanions(w.value.id, purpose),
        stop,
      };
    }
  }
  if (wind?.status === "loading") {
    const p = wind.progress;
    const share = p?.total
      ? ` (${Math.round((100 * p.done) / p.total)} %)`
      : "";
    return {
      purpose: "wind" as const,
      text: `Reading ${vector.value.what} for its ${vector.value.marks}${share}`,
      progress: p,
      stop: () => analysis.setWind(w.value.id, false),
    };
  }
  if (members?.status === "loading") {
    const p = members.progress;
    return {
      purpose: "members" as const,
      text: `Reading members ${p?.done ?? 0} of ${p?.total ?? "?"}`,
      progress: p,
      stop: () => analysis.setMembers(w.value.id, undefined),
    };
  }
  const pair = pairCompanions.value;
  if (pair?.status === "loading" || pair?.status === "failed") {
    const p = pair.progress;
    return {
      purpose: "pair" as const,
      text:
        pair.status === "failed"
          ? `Scatter against ${w.value.pairWith} is not possible: ${(pair.message ?? "").replace(/^Scatter: /, "")}`
          : `Reading ${w.value.pairWith} for the scatter${p?.total ? ` (${Math.round((100 * p.done) / p.total)} %)` : ""}`,
      progress: pair.status === "loading" ? p : undefined,
      failed: pair.status === "failed",
      stop: () => analysis.setPair(w.value.id, undefined),
    };
  }
  return staleCompanion.value;
});

/**
 * A companion read across a live publication of its dates: some of its values
 * may be older than the plot's. Said where the plot is read, with Read again.
 */
const staleCompanion = computed(() => {
  const id = w.value.id;
  for (const [companions, purpose, again] of [
    [windCompanions.value, "wind", () => analysis.loadWind(id)],
    [memberCompanions.value, "members", () => analysis.loadMembers(id)],
    [pairCompanions.value, "pair", () => analysis.loadPair(id)],
  ] as const) {
    if (companions?.status === "ready" && companions.stale) {
      return {
        purpose,
        text: `The source published new data while ${COMPANION_NAMES.value[purpose]} was read: some of its values may be older than the plot's.`,
        progress: undefined,
        stale: true,
        label: "Read again",
        size: undefined,
        read: () => void again(),
        stop: COMPANION_STOPS[purpose],
      };
    }
  }
  return undefined;
});

/** The cap of Automatic, as text. */
const autoCap = bytesText(AUTO_COMPUTE_BYTES);
/** The plan's notes worth reading on the card (timings stay in Method). */
const gateNotes = computed(() =>
  (w.value.estimate?.notes ?? []).filter((note) => !/^Planning took/.test(note))
);

/** Before the first values: the stages, from the plot's status. */
const stages = computed(() =>
  stagesOf(
    w.value.status === PLOT_STATUS.RUNNING ? "running" : String(w.value.status)
  )
);

/** A companion's icon, name and what turning it off is called. */
const COMPANION_ICONS = computed(() => ({
  wind: vector.value.icon,
  members: "chart" as const,
  pair: "scatter" as const,
}));
const COMPANION_NAMES = computed(() => ({
  wind: vector.value.name.toLowerCase(),
  members: "the members",
  pair: "the scatter",
}));
const COMPANION_OFF = computed(() => ({
  wind: `Turn off ${vector.value.marks}`,
  members: "One member only",
  pair: "No scatter",
}));

/** Another variable read with this plot's query, for a scatter (T–S). */
const pairCompanions = computed(() =>
  w.value.pairWith ? shownCompanions(w.value, "pair") : undefined
);
// A new result reads the other variable again.
watch(
  () => [w.value.pairWith, w.value.status, result.value?.query] as const,
  ([on]) => on && void analysis.loadPair(w.value.id)
);
/** Series and profiles can be scattered against another variable. */
const canPair = computed(
  () =>
    !w.value.snapshot &&
    (isSeries.value || w.value.kind === ANALYSIS_KINDS.PROFILE) &&
    w.value.status === PLOT_STATUS.DONE
);
/**
 * Variables to scatter against: the dataset's other fields. Coordinates, bounds
 * and formula terms are not offered: at a fixed place latitude is a constant,
 * and time is already the axis.
 */
const pairChoices = computed(() =>
  pairCandidates(analysis.variableSources, result.value?.query.variable)
);
/** Each choice with what it is: its quantity and units, as listed. */
const pairHints = computed(() =>
  pairChoices.value.map((name) =>
    pairHint(name, analysis.variableSources[name])
  )
);
/** The scatter, once the other variable is read. */
const scatter = computed(() => {
  const other = pairCompanions.value?.results?.other;
  const r = result.value;
  if (pairCompanions.value?.status !== "ready" || !other || !r) {
    return undefined;
  }
  // The plot's valid-area threshold holds for both: a mean the chart hides is
  // no point of the scatter.
  const threshold = r.query.minCoverage;
  const input = (res: typeof r) => ({
    name: res.query.variable,
    values: coveredValues(res.values, res.region?.coverage, threshold),
    units: res.units,
    standardName: standardNameOf(res, analysis.variableSources),
    ...(res.region?.coverage ? { coverage: res.region.coverage } : {}),
  });
  const profile =
    w.value.kind === ANALYSIS_KINDS.PROFILE
      ? {
          levels: (r.vertical?.values ?? []).map(
            (value) =>
              `${formatValue(value)}${r.vertical?.units ? ` ${r.vertical.units}` : ""}`
          ),
        }
      : undefined;
  const made = scatterOf(input(r), input(other), profile, seriesDates.value);
  const sampling = samplingNote(
    { cell: r.cell, region: r.region, name: r.query.variable },
    { cell: other.cell, region: other.region, name: other.query.variable }
  );
  return sampling ? { ...made, sampling } : made;
});

/** The wind read now is complete: its figure can be drawn. */
const windReady = computed(
  () => Boolean(windSpec.value) && windCompanions.value?.status === "ready"
);
/** The rose of the wind read, and the last one (kept while re-read). */
const roseFresh = computed(() => {
  const wind = windSpec.value;
  return windReady.value && wind && isSeries.value
    ? roseOf(wind.u, wind.v, wind.units, Boolean(windCompanions.value?.current))
    : undefined;
});
const roseKept = ref<ReturnType<typeof roseOf>>();
watch(roseFresh, (rose) => rose && (roseKept.value = rose));
/** The rose shown, and the speed classes its legend hides (25 Nov). */
const roseNow = computed(() =>
  shownFigure.value === "rose" ? (roseFresh.value ?? roseKept.value) : undefined
);
/**
 * A figure of the wind read for the barbs: a rose for a time series (a
 * current rose for ocean components), a hodograph for a profile.
 */
const figureKind = computed(() => {
  if (!windSpec.value || windCompanions.value?.status !== "ready") {
    // Read again (Extend, a new date range): the figure stays on its tab,
    // its last drawing shown until the new wind is in (25 Nov).
    const status = windCompanions.value?.status;
    const kept =
      w.value.figure === "rose" ? roseKept.value : hodographKept.value;
    return (status === "loading" || status === "confirm") && kept
      ? (w.value.figure as "rose" | "hodograph")
      : undefined;
  }
  return isSeries.value
    ? ("rose" as const)
    : w.value.kind === ANALYSIS_KINDS.PROFILE
      ? ("hodograph" as const)
      : undefined;
});
const shownFigure = computed(() =>
  w.value.figure === "scatter"
    ? scatter.value
      ? ("scatter" as const)
      : undefined
    : w.value.figure && w.value.figure === figureKind.value
      ? w.value.figure
      : undefined
);
const ROSE_RAMP = [
  "#c6dbef",
  "#9ecae1",
  "#6baed6",
  "#3182bd",
  "#08519c",
  "#08306b",
];
const HODOGRAPH_RAMP = [
  "#fdae6b",
  "#f16913",
  "#d94801",
  "#8c2d04",
  "#54278f",
  "#3f007d",
];
const roseHidden = ref(new Set<number>());
/** The hodograph of the wind read (a profile), and the last one. */
const hodographFresh = computed(() => {
  const wind = windSpec.value;
  const r = result.value;
  if (
    !windReady.value ||
    !wind ||
    !r ||
    w.value.kind !== ANALYSIS_KINDS.PROFILE
  ) {
    return undefined;
  }
  const levels = (r.vertical?.values ?? []).map(
    (value) =>
      `${formatValue(value)}${r.vertical?.units ? ` ${r.vertical.units}` : ""}`
  );
  return { u: wind.u, v: wind.v, units: wind.units, levels };
});
const hodographKept = ref<NonNullable<(typeof hodographFresh)["value"]>>();
watch(hodographFresh, (h) => h && (hodographKept.value = h));
const hodographNow = computed(() =>
  shownFigure.value === "hodograph"
    ? (hodographFresh.value ?? hodographKept.value)
    : undefined
);
const figureDraw = computed(() => {
  const el = root.value;
  const colours = {
    fg: plotColor(el, "--plot-fg", "#1f2937"),
    muted: plotColor(el, "--plot-muted", "#4b5563"),
    grid: plotColor(el, "--plot-grid", "rgba(0,0,0,0.12)"),
    bg: plotColor(el, "--plot-bg", "#ffffff"),
  };
  if (shownFigure.value === "scatter" && scatter.value) {
    const s = scatter.value;
    const line = plotColor(el, "--plot-line", "#1d4ed8");
    return (context: CanvasRenderingContext2D, width: number, height: number) =>
      drawScatter(context, width, height, s, { ...colours, line });
  }
  const rose = roseNow.value;
  if (rose) {
    const hidden = roseHidden.value;
    return (context: CanvasRenderingContext2D, width: number, height: number) =>
      drawRose(
        context,
        width,
        height,
        rose,
        { ...colours, ramp: ROSE_RAMP },
        hidden
      );
  }
  const hodograph = hodographNow.value;
  return hodograph
    ? (context: CanvasRenderingContext2D, width: number, height: number) =>
        drawHodograph(context, width, height, hodograph, {
          ...colours,
          ramp: HODOGRAPH_RAMP,
        })
    : undefined;
});
/** What the figure says under the pointer: a point's or a sector's values. */
const figureProbe = computed(() => {
  if (shownFigure.value === "scatter" && scatter.value) {
    const s = scatter.value;
    return (x: number, y: number, width: number, height: number) =>
      probeScatter(x, y, width, height, s);
  }
  const rose = roseNow.value;
  if (rose) {
    const hidden = roseHidden.value;
    return (x: number, y: number, width: number, height: number) =>
      probeRose(x, y, width, height, rose, ROSE_RAMP, hidden);
  }
  const hodograph = hodographNow.value;
  return hodograph
    ? (x: number, y: number, width: number, height: number) =>
        probeHodograph(x, y, width, height, hodograph)
    : undefined;
});
/** A click on a rose's legend hides or shows that speed class. */
function figurePress(x: number, y: number, width: number, height: number) {
  const rose = roseNow.value;
  const hit =
    rose && probeRose(x, y, width, height, rose, ROSE_RAMP, roseHidden.value);
  if (hit?.index === undefined) {
    return;
  }
  const next = new Set(roseHidden.value);
  if (!next.delete(hit.index)) {
    next.add(hit.index);
  }
  roseHidden.value = next;
}
/** The figure shown instead of the chart, as CSV (what it draws). */
const figureCsv = computed(() => {
  const wind = windSpec.value;
  const r = result.value;
  if (shownFigure.value === "scatter" && scatter.value) {
    return scatterCsv(scatter.value);
  }
  if (!shownFigure.value || !wind || !r) {
    return undefined;
  }
  if (shownFigure.value === "rose") {
    return roseCsv(
      roseOf(wind.u, wind.v, wind.units, Boolean(windCompanions.value?.current))
    );
  }
  return hodographCsv({
    u: wind.u,
    v: wind.v,
    units: wind.units,
    levels: r.vertical?.values ?? [],
    levelUnits: r.vertical?.units,
  });
});
const figureLabel = computed(() =>
  shownFigure.value === "scatter"
    ? `${scatter.value?.title ?? "Scatter"}: ${scatter.value?.yTitle} against ${scatter.value?.xTitle}${scatter.value?.sampling ? `. ${scatter.value.sampling}` : ""}`
    : shownFigure.value === "rose"
      ? "Wind rose: how often the wind comes from each direction, by speed"
      : "Hodograph: the wind vector through the levels"
);

/** An ensemble dimension of a series, when it has several members. */
const memberDimension = computed(() =>
  w.value.kind === ANALYSIS_KINDS.POINT_SERIES ||
  w.value.kind === ANALYSIS_KINDS.REGION_SERIES
    ? ensembleOf(w.value.resultSummary ?? w.value.summary)
    : undefined
);
const memberCompanions = computed(() =>
  w.value.members ? shownCompanions(w.value, "members") : undefined
);
const ownMember = computed(() => {
  const dimension = memberDimension.value?.dimension;
  return dimension ? (shownQuery.value?.fixed[dimension] ?? 0) : 0;
});
function setMembers(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  analysis.setMembers(w.value.id, (value || undefined) as TMemberView);
}
watch(
  () => [w.value.members, w.value.status, result.value?.query] as const,
  ([on]) => on && void analysis.loadMembers(w.value.id)
);
/** The members as series, in member order, with their percentiles. */
const membersSpec = computed(() => {
  const ready = memberCompanions.value;
  const shown = result.value;
  if (
    ready?.status !== "ready" ||
    !ready.results ||
    !shown ||
    !w.value.members
  ) {
    return undefined;
  }
  // Members in the units shown, as the series is, each masked by its own area
  // coverage under the plot's cutoff.
  const cutoff = shown.query.minCoverage;
  const shownMember = (member: string) => {
    const read = ready.results![member];
    const values = convertResult(
      read,
      w.value.displayUnits,
      standardNameOf(read, analysis.variableSources)
    ).values;
    const coverage = read.region?.coverage;
    return cutoff !== undefined && coverage
      ? Array.from(values, (value, at) =>
          coverage[at] < cutoff ? Number.NaN : value
        )
      : values;
  };
  const series = Object.keys(ready.results)
    .sort((a, b) => Number(a) - Number(b))
    .map(shownMember);
  const length = shown.values.length;
  const chance = w.value.members === "chance";
  const threshold = chance
    ? (w.value.memberThreshold ?? roundThreshold(series))
    : undefined;
  return {
    series,
    view: w.value.members,
    chosen: ownMember.value,
    name: memberDimension.value?.dimension ?? "member",
    ...memberStats(series, length, meanDurations(shown)),
    ...(threshold !== undefined
      ? { threshold, chance: chanceAbove(series, threshold, length) }
      : {}),
  };
});
function setThreshold(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) {
    analysis.patchWindow(w.value.id, { memberThreshold: value });
  }
}
const asRead = computed(() => {
  const base = result.value
    ? chartSpec(
        result.value,
        // The members' percentiles take the band's place.
        membersSpec.value ? undefined : w.value.spread,
        w.value.pathAxis
      )
    : undefined;
  if (!base) {
    return undefined;
  }
  const members = membersSpec.value;
  const wind = windSpec.value;
  const units = result.value?.units ? ` ${result.value.units}` : "";
  // The readout adds what is drawn with the series: members and wind.
  const extra = (index: number) =>
    [
      members &&
        `Members: median ${formatValue(members.p50[index])}${units}, 10–90 % ${formatValue(members.p10[index])} to ${formatValue(members.p90[index])}`,
      members?.chance &&
        members.chance.valid[index] &&
        `Above ${formatValue(members.threshold!)}${units}: ${members.chance.above[index]} of ${members.chance.valid[index]} members (${Math.round(members.chance.share[index])} %)`,
      wind && windText(wind.u[index], wind.v[index], wind.units, wind.current),
    ].filter((line): line is string => Boolean(line));
  return {
    ...base,
    ...(wind ? { wind } : {}),
    ...(members ? { members } : {}),
    ...(members || wind
      ? {
          readout: (index: number) => [...base.readout(index), ...extra(index)],
        }
      : {}),
  };
});

/** A time series' dates as its calendar writes them (once per axis). */
const seriesDates = computed(() => {
  const r = result.value;
  return r?.time && isSeries.value ? timeLabels(r.time) : [];
});
/** What the reshaping views need: dates, raw times, units, settings. */
/** The values as plotted (below the coverage cutoff: none), kept. */
const plottedValues = computed(() =>
  result.value ? shownValues(result.value) : undefined
);
const seriesContext = computed<TSeriesContext>(() => {
  const r = result.value;
  const raw = r?.time?.raw ?? [];
  const step = stepSeconds(raw, r?.time?.units);
  return {
    dates: seriesDates.value,
    raw,
    bounds: r?.time?.bounds,
    boundsUnread: r?.time?.boundsUnread,
    timeUnits: r?.time?.units,
    units: r?.units,
    cellMethods: r?.cellMethods,
    quantity: r?.time?.quantity,
    timeDimension: r?.time?.dimension,
    calendar: r?.time?.calendar,
    // As plotted: means below the coverage cutoff do not make a year observed;
    // one array per result and cutoff.
    values: plottedValues.value,
    window: w.value.timeWindow ?? defaultWindow(step),
    // The 90th percentile of the series, to two figures: "above P90".
    // Read only by the Count view (a getter): no percentile of a long
    // series on every result.
    get threshold() {
      return w.value.timeThreshold ?? defaultThreshold.value;
    },
  };
});
/** The Count view's first threshold (P90 of the values as plotted). */
const defaultThreshold = computed(() => countThreshold(result.value));
/** The time views this series allows: cycles need months or hours. */
const timeViews = computed(() => {
  const dates = seriesDates.value;
  if (!dates.length || result.value?.partial) {
    return [];
  }
  return [
    ...(spansMonths(dates) ? [TIME_VIEWS.ANOMALY, TIME_VIEWS.ANNUAL] : []),
    ...(subDaily(dates) ? [TIME_VIEWS.DIURNAL] : []),
    ...reshapeViews(seriesContext.value),
  ];
});
const TIME_VIEW_NAMES: Record<TTimeView, string> = {
  anomaly: "Anomaly",
  annual: "Annual cycle",
  diurnal: "Diurnal cycle",
  running: "Running mean",
  cumulative: "Cumulative total",
  count: "Count above",
  boxes: "Boxes by month",
  spectrum: "Spectrum (periods)",
  return: "Return levels",
};
/** The running mean's step word, beside its length. */
const stepWord = computed(() =>
  stepName(stepSeconds(seriesContext.value.raw, seriesContext.value.timeUnits))
);
function setTimeNumber(field: "timeWindow" | "timeThreshold", event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (
    Number.isFinite(value) &&
    (field === "timeThreshold" || (value >= 1 && Number.isInteger(value)))
  ) {
    analysis.patchWindow(w.value.id, { [field]: value });
  }
}
const timeView = computed(() =>
  w.value.timeView && timeViews.value.includes(w.value.timeView)
    ? w.value.timeView
    : undefined
);
/**
 * A view asked for (a chart found by name) that this series cannot show
 * yet: kept, shown waiting in Time, and on once the dates allow it.
 */
const waitingView = computed(() =>
  w.value.timeView && !timeView.value ? w.value.timeView : undefined
);
function setTimeView(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  analysis.patchWindow(w.value.id, {
    timeView: (value || undefined) as TTimeView | undefined,
  });
}
/**
 * The trend of what is shown (values, or anomalies), per decade: one fit for
 * the line, its legend and the Trend button.
 */
const trend = computed(() => {
  const base = asRead.value;
  if (!w.value.trend || !base || base.mode !== "time" || isCycle.value) {
    return undefined;
  }
  const shown =
    timeView.value === TIME_VIEWS.ANOMALY
      ? anomalies(periodDates(seriesContext.value), base.y)
      : base.y;
  return linearTrend(
    seriesDates.value,
    shown,
    result.value?.time?.raw,
    result.value?.time?.units,
    result.value?.time?.calendar
  );
});
/** Views that are not the series against time take no trend. */
const isCycle = computed(
  () =>
    timeView.value !== undefined &&
    timeView.value !== TIME_VIEWS.ANOMALY &&
    timeView.value !== TIME_VIEWS.RUNNING
);
const trendText = computed(() => {
  const t = trend.value;
  if (!t || !Number.isFinite(t.perDecade)) {
    return "";
  }
  return slopeLabel(t);
});

/** What the chart draws: the series as read, or seen another way. */
/** A distribution's curves and 95 % range, by the window's choice. */
const curveView = computed<TCurveView>(() => w.value.curve ?? "density");
const centralRange = computed(() => w.value.centralRange ?? DEFAULT_RANGE);
const distribution = computed(() => {
  const h = result.value?.histogram;
  return h && h.constant === undefined
    ? distributionMarks(
        h,
        curveView.value,
        centralRange.value,
        w.value.shareAbove
      )
    : undefined;
});
/** "Above 10 m s-1: ≈ 23 % of the area", when a value is given. */
const shareAbove = computed(() => {
  const h = result.value?.histogram;
  return h && w.value.shareAbove !== undefined
    ? shareAboveText(h, w.value.shareAbove, result.value?.units)
    : "";
});
// A chart found as "Share of the area above a value": the mean to begin with.
watch(
  () => [w.value.shareAboveMean, result.value?.histogram?.mean] as const,
  ([pending, mean]) => {
    if (pending && mean !== undefined && Number.isFinite(mean)) {
      analysis.patchWindow(w.value.id, {
        shareAbove: Number(formatValue(mean)),
        shareAboveMean: undefined,
      });
    }
  },
  { immediate: true }
);
function setShareAbove(event: Event) {
  const text = (event.target as HTMLInputElement).value.trim();
  const value = Number(text);
  analysis.patchWindow(w.value.id, {
    shareAbove: text && Number.isFinite(value) ? value : undefined,
  });
}
/** The distribution as its cumulative share: 0 to 100 % of the area. */
function cdfSpec(base: TSeriesSpec): TSeriesSpec {
  const points = cdfPoints(result.value!.histogram!)!;
  const units = unitsText();
  return {
    mode: "cycle",
    x: points.x,
    y: points.y,
    xTitle: base.xTitle,
    yTitle: "Share of valid area below (%)",
    xFree: true,
    yRange: [0, 100],
    distribution: distribution.value,
    readout: (index: number) => [
      `${formatValue(points.x[index])}${units}`,
      `${formatValue(points.y[index])} % of the valid area below`,
    ],
  };
}
const distributionText = computed(() => {
  const h = result.value?.histogram;
  return h ? summaryText(h, result.value?.units, centralRange.value) : "";
});

/** How the series is drawn: as chosen, else bars for precipitation. */
const chartStyle = computed(
  () =>
    w.value.chartStyle ??
    defaultChartStyle(
      variableName.value,
      storedResult.value?.units,
      analysis.variableSources[variableName.value ?? ""]?.standardName
    )
);
/**
 *  The series in the chosen style, where a style applies: the values as
 * read (or their anomalies) in time or along a path.
 */
const spec = computed(() => {
  const viewed = viewedSpec.value;
  // Barbs only where the points are the series' own samples.
  const shown =
    viewed?.wind && !["time", "path", "profile"].includes(viewed.mode)
      ? { ...viewed, wind: undefined }
      : viewed;
  const style = chartStyle.value;
  const view = timeView.value;
  return shown &&
    style !== "line" &&
    (shown.mode === "time" || shown.mode === "path") &&
    (!view || view === TIME_VIEWS.ANOMALY) &&
    !shown.boxes &&
    !shown.markers
    ? { ...shown, style }
    : shown;
});
const viewedSpec = computed(() => {
  const base = asRead.value;
  const view = timeView.value;
  if (base?.mode === "histogram" && distribution.value) {
    return curveView.value === "cdf"
      ? cdfSpec(base)
      : { ...base, distribution: distribution.value };
  }
  if (!base || base.mode !== "time" || !view) {
    return base && trend.value
      ? { ...base, fit: { values: trend.value.fitted, label: trendText.value } }
      : base;
  }
  if (view === TIME_VIEWS.RUNNING) {
    const running = reshapedSpec(view, base, seriesContext.value)!;
    return trend.value
      ? {
          ...running,
          fit: { values: trend.value.fitted, label: trendText.value },
        }
      : running;
  }
  return (
    reshapedSpec(view, base, seriesContext.value) ??
    (view === TIME_VIEWS.ANOMALY
      ? anomalySpec(base)
      : cycleSpec(base, view === TIME_VIEWS.ANNUAL))
  );
});

const unitsText = () => (result.value?.units ? ` ${result.value.units}` : "");
const slopeLabel = (fit: ReturnType<typeof linearTrend>) => {
  const rate = trendRate(fit);
  return `${rate.value >= 0 ? "+" : ""}${formatValue(rate.value)}${unitsText()} per ${rate.per}`;
};

/**
 * What an anomaly is taken from: its month's own mean, or for a cell over a
 * month's end each month's by its share.
 */
function anomalyBaseline(dates: string[], index: number) {
  const pieces = datePieces.get(dates)?.get(index);
  const months = [
    ...new Set(
      (pieces?.length ? pieces.map((p) => p.date) : [dates[index] ?? ""]).map(
        (date) => MONTHS[Number(monthOf(date)) - 1] ?? ""
      )
    ),
  ].filter(Boolean);
  return months.length > 1
    ? `from the series' own ${months.join(" and ")} means, by each month's share of the cell`
    : `from the series' own ${months[0] ?? ""} mean`;
}

/** Values minus the series' own monthly means (and their trend). */
function anomalySpec(base: TSeriesSpec): TSeriesSpec {
  const dates = periodDates(seriesContext.value);
  const y = anomalies(dates, base.y);
  const fit = trend.value;
  return {
    ...base,
    y,
    yTitle: `Anomaly of ${base.yTitle}`,
    band: undefined,
    members: undefined,
    readout: (index: number) => [
      ...base.readout(index),
      `Anomaly ${formatValue(y[index])}${unitsText()} (${anomalyBaseline(dates, index)})`,
    ],
    ...(fit ? { fit: { values: fit.fitted, label: slopeLabel(fit) } } : {}),
  };
}

/** Each month (or hour) across years (or days): mean and range. */
function cycleSpec(base: TSeriesSpec, annual: boolean): TSeriesSpec {
  // Grouped by the period each value covers (a cell's middle).
  const dates = periodDates(seriesContext.value);
  const cycle = annual
    ? annualCycle(dates, base.y)
    : diurnalCycle(dates, base.y);
  const across = annual ? "years" : "days";
  const name = (key: number) =>
    annual ? MONTHS[key - 1] : `${String(key).padStart(2, "0")}:00`;
  const units = unitsText();
  return {
    mode: "cycle",
    x: cycle.x,
    y: cycle.mean,
    xTitle: annual ? "Month" : "Hour of day (the file's time)",
    yTitle: `Mean ${base.yTitle}`,
    xLabel: (value: number) =>
      Number.isInteger(value) && cycle.x.includes(value) ? name(value) : "",
    units: result.value?.units,
    band: {
      lower: cycle.low,
      upper: cycle.high,
      label: `Range across ${across}`,
    },
    readout: (index: number) => [
      name(cycle.x[index]),
      `Mean ${formatValue(cycle.mean[index])}${units}`,
      `Range ${formatValue(cycle.low[index])} to ${formatValue(cycle.high[index])}${units} over ${cycle.count[index]} ${across}`,
      ...(cycle.unknownLeft
        ? [
            `Values of unknown length left out of ${cycle.unknownLeft.toLocaleString("en-US")} ${annual ? "monthly" : "hourly"} ${cycle.unknownLeft === 1 ? "mean" : "means"} (the others weighted by length)`,
          ]
        : []),
      // Hours only from what was observed at that resolution.
      ...(!annual && cycle.leftOut
        ? [
            `${cycle.leftOut.toLocaleString("en-US")} ${cycle.leftOut === 1 ? "value" : "values"} over more than an hour, or an extreme across two, left out: ${cycle.leftOut === 1 ? "its" : "their"} hours are not known`,
          ]
        : []),
      ...(annual && cycle.leftOut
        ? [
            `${cycle.leftOut.toLocaleString("en-US")} ${cycle.leftOut === 1 ? "mean" : "means"} over more than a month left out: ${cycle.leftOut === 1 ? "its" : "their"} months are not known`,
          ]
        : []),
      // How a cell across two periods was counted.
      ...(cycle.spread
        ? [
            `${cycle.spread.toLocaleString("en-US")} ${cycle.spread === 1 ? "cell" : "cells"} across ${annual ? "months" : "hours"} split between them, each taken as constant over its cell`,
          ]
        : []),
    ],
  };
}
/** An area series can show its spread: off, ±1σ or min–max. */
const hasSpread = computed(() => Boolean(result.value?.region?.spread));
/**
 * A path's samples can be drawn against latitude when it changes: a line
 * always, a section only when it does not turn (its cells would overlap).
 */
const pathAxisOffered = computed(() => {
  const r = result.value;
  if (!r?.samples || !latitudeVaries(r)) {
    return false;
  }
  return isCurtain.value
    ? latitudeMonotonic(r)
    : r.sectionMode === SECTION_MODES.PATH;
});
function setPathAxis(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  analysis.patchWindow(w.value.id, {
    pathAxis: value === "latitude" ? "latitude" : undefined,
  });
}
function setSpread(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  analysis.patchWindow(w.value.id, {
    spread: value ? (value as TSpreadView) : undefined,
  });
}
const heat = computed(() => {
  const base =
    result.value && !spec.value ? heatmapSpec(result.value) : undefined;
  // Time–height carries barbs on its cells.
  return base && windSpec.value && w.value.kind === ANALYSIS_KINDS.TIME_DEPTH
    ? { ...base, wind: windSpec.value }
    : base;
});

// Picking a date in a time × axis plot shows that date's trace.
const pickedRow = ref<number>();
const slice = computed(() => {
  const row = pickedRow.value;
  const base =
    result.value && heat.value && row !== undefined
      ? sliceSpec(result.value, row)
      : undefined;
  const wind = heat.value?.wind;
  if (!base || !wind || row === undefined) {
    return base;
  }
  // The picked date's profile: its barbs beside it, its wind read out.
  const n = heat.value!.axis.values.length;
  const rowWind = {
    ...wind,
    u: wind.u.slice(row * n, row * n + n),
    v: wind.v.slice(row * n, row * n + n),
  };
  return {
    ...base,
    wind: rowWind,
    readout: (index: number) =>
      [
        ...base.readout(index),
        windText(
          rowWind.u[index],
          rowWind.v[index],
          rowWind.units,
          rowWind.current
        ),
      ].filter((line): line is string => Boolean(line)),
  };
});
const sliceDate = computed(() =>
  pickedRow.value === undefined
    ? ""
    : timeLabelAt(result.value?.time, pickedRow.value)
);
const sliceTitle = computed(() => {
  switch (w.value.kind) {
    case ANALYSIS_KINDS.TIME_DEPTH:
      return `Profile at ${sliceDate.value}`;
    case ANALYSIS_KINDS.HOVMOLLER_PATH:
      return `Path at ${sliceDate.value}`;
    default:
      return `${sliceDate.value}: ${result.value?.axis?.reduction ?? ""}`;
  }
});

/** Read rows in time order: what the trace date picker steps through. */
const readRows = computed(() => {
  const r = result.value;
  if (!r?.time || !heat.value) {
    return [];
  }
  const read = r.partial
    ? rowsUntil(r.query.time, r.partial.readUntil)
    : r.time.raw.length;
  const raw = r.time.raw;
  // Dated rows in time order: an undated one has no place in it.
  return Array.from({ length: Math.max(0, read) }, (_, k) => k)
    .filter((k) => Number.isFinite(raw[k]))
    .sort((a, b) => raw[a] - raw[b] || a - b);
});
const pickedPosition = computed(() =>
  pickedRow.value === undefined ? -1 : readRows.value.indexOf(pickedRow.value)
);

/**
 * A row of Data in a time × axis plot belongs to one date (rows run
 * time-major): choosing it picks that date's trace for the chart.
 */
function heatRowOf(tableRow: number) {
  if (!heat.value || !result.value?.axis) {
    return undefined;
  }
  const width = result.value.shape?.[1];
  return width ? Math.floor(tableRow / width) : undefined;
}
function pickDataRow(tableRow: number) {
  const row = heatRowOf(tableRow);
  if (row !== undefined && row < readRows.value.length) {
    pickedRow.value = row;
  }
}

function pickPosition(event: Event) {
  const row = readRows.value[Number((event.target as HTMLInputElement).value)];
  if (row !== undefined && row !== pickedRow.value) {
    pickRow(row);
  }
}

function pickRow(row: number) {
  pickedRow.value = pickedRow.value === row ? undefined : row;
  // The trace needs room under the figure: grow a short window once.
  const rect = w.value.rect;
  if (
    pickedRow.value !== undefined &&
    !w.value.maximized &&
    !narrow.value &&
    rect.h < 540
  ) {
    analysis.patchWindow(w.value.id, {
      rect: clampRect({ ...rect, h: 540 }, mapArea()),
    });
  }
}

/** The map's coordinate along a dimension (see mapCoordinateOf). */
const mapCoordinate = (dimension: string) => mapCoordinateOf(globe, dimension);
/**
 * The map's index along this plot's dimension `dimension` of `axis`: the row
 * whose decoded date or level is the map's, not the same position in another
 * store; by position only when the map's coordinate is unknown.
 */
function mapIndexOn(
  dimension: string,
  axis: {
    values: number[];
    units?: string;
    calendar?: string;
    positive?: string;
  },
  kind: "time" | "level"
) {
  const index = mapSettingsFromStore(globe).indices[dimension];
  if (index === undefined) {
    return undefined;
  }
  const map = mapCoordinate(dimension);
  if (!map) {
    return index >= 0 && index < axis.values.length ? index : undefined;
  }
  return correspondingIndex(map, index, axis, kind);
}
// The map's time step on this plot's time axis.
const mapTimeIndex = computed(() => {
  const time = w.value.snapshot ? undefined : summary.value?.time;
  return time
    ? mapIndexOn(
        time.dimension,
        { values: time.raw, units: time.units, calendar: time.calendar },
        "time"
      )
    : undefined;
});
/** The map is at a date this plot does not hold (another store's). */
const mapTimeElsewhere = computed(() => {
  const time = w.value.snapshot ? undefined : summary.value?.time;
  return (
    Boolean(time) &&
    mapTimeIndex.value === undefined &&
    mapSettingsFromStore(globe).indices[time!.dimension] !== undefined
  );
});
// The map's level on this plot's vertical axis.
const mapLevelIndex = computed(() => {
  const vertical = w.value.snapshot ? undefined : summary.value?.vertical;
  if (!vertical) {
    return undefined;
  }
  return mapIndexOn(
    vertical.dimension,
    {
      values: vertical.values,
      units: vertical.units,
      positive: vertical.positive,
    },
    "level"
  );
});
/**
 * A plot of one time. Declared before the level watcher below, which runs
 * at once (a reopened plot that follows the map level reads it in setup).
 */
const singleTime = computed(
  () => Boolean(summary.value?.time) && !TIME_RANGE_KINDS.includes(w.value.kind)
);
/**
 * A plot at one level (a series, a Hovmöller) can follow the map's level as
 * a one-time plot follows its time: played on the map, it moves with it.
 */
const levelFollowable = computed(
  () =>
    !singleTime.value &&
    !w.value.snapshot &&
    Boolean(result.value) &&
    Boolean(summary.value?.vertical) &&
    w.value.committed?.level !== undefined
);
function followLevelNow(index: number | undefined) {
  if (
    w.value.followMapLevel &&
    levelFollowable.value &&
    index !== undefined &&
    // A read under way finishes first (below).
    !busy.value &&
    w.value.committed?.level !== index
  ) {
    void analysis.followLevel(w.value.id, index);
  }
}
watch(mapLevelIndex, followLevelNow, { immediate: true });
/** The map's level within a plot drawn over levels, for its marker. */
const mapLevelMark = computed(() =>
  (
    [
      ANALYSIS_KINDS.PROFILE,
      ANALYSIS_KINDS.TIME_DEPTH,
      ANALYSIS_KINDS.SECTION,
      ANALYSIS_KINDS.LAT_VERTICAL,
      ANALYSIS_KINDS.LON_VERTICAL,
    ] as TAnalysisKind[]
  ).includes(w.value.kind)
    ? mapLevelIndex.value
    : undefined
);

/** The map's row in a time series: several rows can share its time. */
const mapRow = computed(() => {
  const at = mapTimeIndex.value;
  const time = result.value?.query.time;
  const row = at === undefined || !time ? -1 : rowOf(time, at);
  return row >= 0 && row < (result.value?.time?.raw.length ?? 0)
    ? row
    : undefined;
});
/** The map's current time as a raw coordinate, for the time markers. */
const mapTime = computed(() =>
  mapTimeIndex.value === undefined
    ? undefined
    : summary.value?.time?.raw[mapTimeIndex.value]
);
/** For a one-time plot: where the map is, when it differs. */
const mapTimeNote = computed(() => {
  if (singleTime.value && mapTimeElsewhere.value) {
    return "Map at a date this plot's data does not have";
  }
  const shownAt = shownQuery.value?.time?.start;
  // Following the map, the plot is on its way to the map's date: no chip
  // that comes and goes at every step while the map plays, pushing the
  // controls beside it into More (24 Nov: the Curve menu moved, and closed,
  // at each step).
  if (
    !singleTime.value ||
    mapTimeIndex.value === undefined ||
    shownAt === undefined ||
    w.value.followMapTime
  ) {
    return "";
  }
  return mapTimeIndex.value === shownAt
    ? ""
    : `Map at ${timeLabelAt(summary.value?.time, mapTimeIndex.value)}`;
});

// Follow map time: a one-time plot recomputes when the map's time moves
// (results already computed come from the cache). `immediate`: a window
// restored after the map moved catches up at once, not at the next move.
function followTimeNow(index: number | undefined) {
  if (
    !w.value.followMapTime ||
    !singleTime.value ||
    index === undefined ||
    w.value.snapshot ||
    !w.value.committed ||
    // A read under way finishes first (below).
    busy.value ||
    w.value.committed.time?.start === index
  ) {
    return;
  }
  // Only the time follows; unapplied edits stay unapplied.
  void analysis.followTime(w.value.id, index);
}
watch(mapTimeIndex, followTimeNow, { immediate: true });
// A map that moves on while a step is read (playing) is followed to its
// latest step when that read ends, not restarted at every step (24 Nov: a
// read longer than a step restarted at each one, never finished, and
// Stop could not stop it).
watch(busy, (reading) => {
  if (!reading) {
    followTimeNow(mapTimeIndex.value);
    followLevelNow(mapLevelIndex.value);
  }
});

/**
 * Stop: the read stops, and a plot following the map stops following it,
 * so the next map step does not start another (24 Nov: Stop could not
 * stop a plot while the map played). Follow turns it on again.
 */
function stopReading() {
  const following = w.value.followMapTime || w.value.followMapLevel;
  analysis.cancel(w.value.id);
  if (following) {
    analysis.patchWindow(w.value.id, {
      followMapTime: false,
      followMapLevel: false,
    });
    w.value.message = `${w.value.message ? `${w.value.message} ` : ""}No longer following the map: turn Follow map on to follow it again.`;
  }
}

/** Change dates: open the settings at the start date, for a new estimate. */
async function changeDates() {
  methodOpen.value = false;
  analysis.patchWindow(w.value.id, { showSettings: true });
  // After the dialog has mounted and focused its first field.
  await nextTick();
  await nextTick();
  root.value?.querySelector<HTMLInputElement>("[data-time-start]")?.focus();
}

function toggleFollow() {
  const byLevel = levelFollowable.value;
  analysis.patchWindow(
    w.value.id,
    byLevel
      ? { followMapLevel: !w.value.followMapLevel }
      : { followMapTime: !w.value.followMapTime }
  );
  const next = followRequest({
    byLevel,
    following: Boolean(
      byLevel ? w.value.followMapLevel : w.value.followMapTime
    ),
    complete: w.value.status === PLOT_STATUS.DONE && !result.value?.partial,
    mapLevel: mapLevelIndex.value,
    mapTime: mapTimeIndex.value,
    shownTime: w.value.committed?.time?.start,
  });
  if (next && "level" in next) {
    void analysis.followLevel(w.value.id, next.level, next.again);
  } else if (next) {
    void analysis.followTime(w.value.id, next.time);
  }
}
// Curtains and latitude × vertical sections share one cell renderer.
const isCurtain = computed(
  () =>
    result.value?.sectionMode === SECTION_MODES.CURTAIN ||
    result.value?.kind === ANALYSIS_KINDS.LAT_VERTICAL ||
    result.value?.kind === ANALYSIS_KINDS.LON_VERTICAL
);
const partial = computed(() => partialText(result.value));

/** What the preview bar is priced from: the dates read and what is next. */
function previewOptions(
  shown: { start: number; stop: number },
  state: NonNullable<typeof w.value.preview>,
  chunk: number
) {
  const shownResult = result.value;
  const complete =
    shownResult && !shownResult.partial && w.value.status === PLOT_STATUS.DONE;
  return {
    shown,
    span: state.intent.time!,
    chunk,
    perGroup: state.perGroup,
    fullBytes: state.fullBytes,
    // Only a complete plot is kept and joined; otherwise all is read again.
    rereadShown: !complete,
    // Dates, not indices, of a request in several stored slices.
    datesIn: (range: { start: number; stop: number }) => {
      const part = clipSelection(state.intent.time!, range);
      return part ? rowCount(part) : 0;
    },
    // Rows actually read, not the range planned.
    ...(shownResult?.partial
      ? {
          read: Math.max(
            0,
            shownResult.query.time
              ? rowsBefore(
                  shownResult.query.time,
                  shownResult.partial.readUntil
                )
              : shownResult.partial.readUntil - shown.start
          ),
        }
      : {}),
    ...(complete && w.value.pendingExtend
      ? { pending: w.value.pendingExtend.target }
      : {}),
    ...(shownResult?.shape[0]
      ? {
          maxDates: maxDatesFor(
            shownResult.values.length / shownResult.shape[0],
            state.limit
          ),
        }
      : {}),
  };
}

/** The plot's prices with its scatter partner's share (see withPartner). */
function withPartner(
  own: ReturnType<typeof previewFacts>,
  rereadShown: boolean
) {
  // Every overlay shown (barbs' components, a scatter partner) at the stored
  // chunks the new dates touch.
  const all = w.value.preview?.intent.time;
  const next = all ? clipSelection(all, own.next) : undefined;
  // The other members shown read the same new dates as the plot's own.
  // Members stored together may be read once more past the chunk cache:
  // said here as the members' own gate says it.
  const others =
    memberCompanions.value && memberDimension.value
      ? otherMemberReads(memberDimension.value, own.nextBytes ?? 0)
      : 0;
  const priced =
    (windCompanions.value || pairCompanions.value || others) &&
    withOverlayBytes(
      own,
      {
        next: next && overlayBytes(w.value, next, rereadShown),
        all: all && overlayBytes(w.value, all, rereadShown),
      },
      others
    );
  if (priced) {
    return priced;
  }
  return {
    ...withPartnerBytes(own, pairCompanions.value?.perDate, rereadShown),
    // Barbs still being read: their part is not in the price yet.
    unpriced: Boolean(windCompanions.value) && !others,
  };
}

/** What the overlays read for are called in a quote. */
const overlayNames = computed(() =>
  [
    windCompanions.value ? "the barbs" : "",
    pairCompanions.value ? (w.value.pairWith ?? "") : "",
    memberCompanions.value ? "the other members" : "",
  ]
    .filter(Boolean)
    .join(" and ")
);

/**
 * A request refused whole for its stored chunks: what is left of it, when
 * a complete plot leaves no more than one plan may read (Read all reads
 * only the dates not shown).
 */
function refusedRemainder(
  state: NonNullable<typeof w.value.preview>,
  shownDates: number
) {
  const complete =
    result.value &&
    !result.value.partial &&
    w.value.status === PLOT_STATUS.DONE;
  return complete
    ? remainingChunks(state.refused, state.total, shownDates)
    : undefined;
}

// A first preview: the dates shown of those asked for, and their prices.
// eslint-disable-next-line max-lines-per-function
const preview = computed(() => {
  const state = w.value.preview;
  const shown = w.value.committed?.time;
  const time = summary.value?.time;
  if (!state?.intent.time || !shown || !time?.chunk) {
    return undefined;
  }
  const options = previewOptions(shown, state, time.chunk);
  const own = previewFacts(options);
  const partnered = withPartner(own, options.rereadShown);
  const { facts, partnerBytes, partnerAllBytes } = partnered;
  const unpriced =
    "unpriced" in partnered && partnered.unpriced
      ? `; ${overlayNames.value} not priced yet`
      : "";
  const left = refusedRemainder(state, facts.dates);
  const label = (at: number) => timeLabelAt(time, at) || `step ${at + 1}`;
  const around =
    w.value.anchor === undefined ? "" : ` around ${label(w.value.anchor)}`;
  return {
    ...facts,
    text: `${facts.dates.toLocaleString("en-US")} of ${facts.total.toLocaleString("en-US")} dates loaded`,
    // One stored time chunk past the first-dates budget is read whole: its size
    // is said.
    around: `Showing the dates${around} first${
      state.perGroup && state.perGroup > PREVIEW_BYTES
        ? `; one stored time chunk decodes about ${bytesText(state.perGroup)}`
        : ""
    }`,
    range: `${label(shown.start)} – ${label(shown.stop - 1)}`,
    extendTitle:
      `Read ${facts.nextDates.toLocaleString("en-US")} more dates` +
      (facts.nextBytes
        ? ` (about ${bytesText(facts.nextBytes)} to decode${
            partnerBytes
              ? `: ${bytesText(own.nextBytes ?? 0)} for this plot, ${bytesText(partnerBytes)} for ${overlayNames.value}`
              : unpriced
          })`
        : ""),
    allTitle:
      (facts.allBytes
        ? `Read all ${facts.total.toLocaleString("en-US")} dates: about ${bytesText(facts.allBytes)} to decode${
            partnerAllBytes
              ? ` (${bytesText(own.allBytes ?? 0)} for this plot, ${bytesText(partnerAllBytes)} for ${overlayNames.value})`
              : ""
          }`
        : `Read all ${facts.total.toLocaleString("en-US")} dates`) +
      (left === undefined
        ? ""
        : ` (the dates not shown: ${left.toLocaleString("en-US")} stored chunks)`),
    // The size beside the action that incurs it (decoded bytes, estimated).
    nextCost: facts.nextBytes ? `≈ ${bytesText(facts.nextBytes)}` : "",
    allCost: facts.allBytes ? `≈ ${bytesText(facts.allBytes)}` : "",
    tooMany: state.tooMany
      ? `Not offered: all ${facts.total.toLocaleString("en-US")} dates would hold ${state.tooMany.toLocaleString("en-US")} values, more than ${state.limit ? `this plot keeps (${state.limit.toLocaleString("en-US")})` : "a plot keeps"}. Narrow the dates or the area${state.limit ? ", choose a wider bin" : ""}, or read on a part at a time.`
      : state.refused && left === undefined
        ? `Not offered: all ${facts.total.toLocaleString("en-US")} dates at once is refused (${state.refused.replace(/\.$/, "")}). Read on a part at a time.`
        : undefined,
  };
});
/** What the chart draws, when it is not the values as read. */
const plottedColumn = computed(() => {
  const s = spec.value;
  const r = result.value;
  if (!s || s.mode !== "time" || !timeView.value || !r) {
    return undefined;
  }
  if (s.overlay) {
    return { title: s.overlay.label, values: s.overlay.values };
  }
  return s.y !== r.values ? { title: s.yTitle, values: s.y } : undefined;
});
const table = computed(() =>
  result.value && w.value.showTable
    ? dataView(result.value, plottedColumn.value)
    : undefined
);

/**
 * The Data rows at the map's date (25 Nov): highlighted, and kept in the
 * middle of the table as the map moves or plays. A row per date, or per
 * date and axis value (a Hovmöller); other tables have no date rows.
 */
const tableBody = ref<HTMLElement>();
function mapDateRows() {
  const row = mapRow.value;
  const dates = result.value?.time?.raw.length ?? 0;
  const width = result.value?.axis ? (result.value.shape?.[1] ?? 0) : 1;
  if (row === undefined || !table.value || !width) {
    return undefined;
  }
  return table.value.total === dates * width
    ? { first: row * width, last: row * width + width - 1 }
    : undefined;
}
const atMapRows = computed(mapDateRows);
watch(
  [atMapRows, () => w.value.showTable],
  async () => {
    const rows = atMapRows.value;
    await nextTick();
    const body = tableBody.value;
    const tr = rows && body?.children[rows.first];
    const box = body?.closest<HTMLElement>(".analysis-table");
    if (tr instanceof HTMLElement && box) {
      const [row, view] = [
        tr.getBoundingClientRect(),
        box.getBoundingClientRect(),
      ];
      box.scrollTop += row.top - view.top - (view.height - row.height) / 2;
    }
  },
  { flush: "post" }
);

const narrow = computed(() => isNarrow(props.areaSize));

function mapArea() {
  return props.areaSize;
}

const style = computed(() => {
  const rect = narrow.value
    ? { x: 0, y: 0, w: mapArea().width, h: mapArea().height }
    : w.value.rect;
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.w}px`,
    height: `${rect.h}px`,
    zIndex: w.value.z,
  };
});

const RESIZE_EDGES: TResizeEdge[] = [
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
];
function startGesture(event: PointerEvent, mode: TResizeEdge) {
  if (
    w.value.maximized ||
    (event.target as HTMLElement).closest("button") ||
    narrow.value
  ) {
    return;
  }
  analysis.focus(w.value.id);
  const start = {
    x: event.clientX,
    y: event.clientY,
    rect: { ...w.value.rect },
  };
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => {
    analysis.patchWindow(w.value.id, {
      rect: resizedRect(
        start.rect,
        mode,
        e.clientX - start.x,
        e.clientY - start.y,
        mapArea()
      ),
    });
  };
  const end = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
}

/**
 * Expand in map / Restore size. The earlier bounds live with the plot, so
 * they survive minimizing and reopening.
 */
function toggleMaximize() {
  // A narrow map shows the plot as a sheet: there is nothing to expand, and
  // a stray double-click must not leave it maximized for a wider map.
  if (narrow.value) {
    return;
  }
  if (w.value.maximized) {
    analysis.patchWindow(w.value.id, {
      rect: clampRect(w.value.restoreRect ?? w.value.rect, mapArea()),
      restoreRect: undefined,
      maximized: false,
    });
    return;
  }
  analysis.patchWindow(w.value.id, {
    restoreRect: { ...w.value.rect },
    rect: maximizedRect(mapArea()),
    maximized: true,
  });
}

/**
 * Minimize into Plotting tools: the window folds into the button (on a
 * narrow map, Back to map simply returns); its result and work go on, and
 * focus goes to the button.
 */
let folding = false;
async function minimize() {
  if (folding) {
    return;
  }
  folding = true;
  if (!narrow.value && root.value) {
    await foldInto(root.value, launcherBox());
  }
  folding = false;
  analysis.setMinimized(w.value.id, true);
  analysis.announcement = `${w.value.label} minimized to Plotting tools.`;
  void focusPlotsButton();
}

// A new window grows out of its selection; a restored one out of the
// Plotting tools button (both set `emergeFrom` just before it appears).
onMounted(() => {
  const from = w.value.emergeFrom;
  if (from) {
    analysis.patchWindow(w.value.id, { emergeFrom: undefined });
    if (root.value && !narrow.value) {
      growFrom(root.value, from);
    }
  }
});

/**
 * Close plot: a finished plot closes at once (Undo is offered); closing one
 * that is reading or has pending edits asks first.
 */
function requestClose() {
  // A read of the map's step, made by following it, is no request of the
  // scientist's: closing does not ask about it (24 Nov: with the map
  // playing, every close asked first).
  const following =
    (w.value.followMapTime && singleTime.value) ||
    (w.value.followMapLevel && levelFollowable.value);
  if ((busy.value && !following) || pending.value.length) {
    closing.value = true;
    return;
  }
  analysis.close(w.value.id, true);
}

// ----- vertical statistics (profiles, time–vertical sections)
/** The column a profile or time–vertical result is taken on. */
const columnBase = computed((): Omit<TColumn, "values"> | undefined => {
  const r = result.value;
  const vertical = r?.vertical;
  if (!r || !vertical?.physical) {
    return undefined;
  }
  return {
    z: vertical.values,
    zUnits: vertical.units,
    positive: vertical.positive,
    bounds: vertical.bounds,
    units: r.units,
    unitsMetadata: r.unitsMetadata,
    standardName: standardNameOf(r, analysis.variableSources),
    // The variable's own name, not its groups'.
    name: `${r.query.variable.split("/").pop()} ${r.longName ?? ""}`,
    cellMethods: r.cellMethods,
  };
});
/** A profile's statistics: chips under the chart, its levels marked. */
const profileStats = computed(() =>
  w.value.kind === ANALYSIS_KINDS.PROFILE && columnBase.value && result.value
    ? verticalStatistics({ ...columnBase.value, values: result.value.values })
    : []
);
/** The levels found, on the chart with their value: "Tropopause: 200 hPa". */
const profileMarks = computed(() =>
  profileStats.value
    .filter((stat) => stat.kind === "level" && !stat.id.endsWith("-level"))
    .map((stat) => ({
      at: stat.value,
      label: `${stat.label.replace(/ \(.*\)$/, "")}: ${statText(stat)}`,
    }))
);
const statText = (stat: TVerticalStat) =>
  `${formatValue(stat.value)}${stat.units ? ` ${stat.units}` : ""}`;
/** A time–vertical section: which found level is drawn over it. */
const lineStat = ref<TVerticalStat["id"] | "">("");
/** The levels that can be found in this section (from its mean column). */
const lineChoices = computed(() => {
  const r = result.value;
  const base = columnBase.value;
  if (w.value.kind !== ANALYSIS_KINDS.TIME_DEPTH || !r || !base) {
    return [];
  }
  const [rows, nk] = r.shape;
  return levelStatisticsOverRows(rows, nk, r.values, base);
});
const heatLine = computed(() => {
  const r = result.value;
  const base = columnBase.value;
  const choice = lineChoices.value.find((stat) => stat.id === lineStat.value);
  if (!choice || !r || !base) {
    return undefined;
  }
  return {
    label: choice.label,
    values: statisticOverTime(
      r.shape[0],
      r.shape[1],
      r.values,
      base,
      choice.id
    ),
  };
});

/** A failure explained, with the actions that can help. */
const failure = computed(() =>
  w.value.status === PLOT_STATUS.ERROR
    ? errorHelp(
        w.value.message ?? "",
        TIME_RANGE_KINDS.includes(w.value.kind),
        w.value.failure
      )
    : undefined
);
const ERROR_ACTIONS: Record<TErrorAction, { label: string; icon: string }> = {
  "first-dates": { label: "Show the first dates", icon: "fa-forward-step" },
  dates: { label: "Fewer dates", icon: "fa-calendar" },
  bins: { label: "Wider bins", icon: "fa-table-columns" },
  samples: { label: "Fewer samples", icon: "fa-ellipsis" },
  settings: { label: "Settings", icon: "fa-sliders" },
  retry: { label: "Try again", icon: "fa-rotate-right" },
  copy: { label: "Copy details", icon: "fa-copy" },
};
const errorNote = ref("");
async function errorAction(action: TErrorAction) {
  errorNote.value = "";
  const help = failure.value;
  if (action === "first-dates" && help?.size) {
    if (!analysis.startPreview(w.value.id, help.size)) {
      errorNote.value =
        "No shorter range of whole stored chunks fits; choose fewer dates in Settings.";
    }
  } else if (action === "dates") {
    await changeDates();
  } else if (
    action === "bins" ||
    action === "samples" ||
    action === "settings"
  ) {
    methodOpen.value = false;
    analysis.patchWindow(w.value.id, { showSettings: true });
  } else if (action === "retry") {
    void analysis.retry(w.value.id);
  } else if (action === "copy") {
    const text = `${w.value.label} ${title.value} — ${subtitle.value}\n${w.value.message ?? ""}`;
    try {
      await navigator.clipboard.writeText(text);
      errorNote.value = "Copied.";
    } catch {
      errorNote.value = "Copying is not allowed here; select the text above.";
    }
  }
}

/** What closing loses, said plainly (whatever changed since it asked). */
const closeText = computed(() => {
  const losses = [
    busy.value ? "stops the read in progress" : "",
    pending.value.length
      ? `discards the edits not applied (${pending.value.join(", ")})`
      : "",
  ].filter(Boolean);
  return losses.length
    ? `Closing ${losses.join(" and ")}. Undo will not bring them back.`
    : "The plot and its chart are removed from the map.";
});
const keepButton = ref<HTMLButtonElement>();
// The safe choice has focus when the dialog opens.
watch(closing, async (open) => {
  if (open) {
    await nextTick();
    keepButton.value?.focus();
  }
});

/** What the reads did so far: bytes the store sent, and decoded apart. */
const work = computed(() =>
  bytesRead(result.value?.counters, summary.value?.opened?.uncounted)
);
/** The chunks behind those bytes, for the bytes' tooltip. */
const workDetail = computed(() => {
  const c = result.value?.counters;
  return c?.chunkReads
    ? `${c.chunkReads.toLocaleString("en-US")} stored chunk${c.chunkReads === 1 ? "" : "s"} read`
    : "";
});

/** Nothing read yet: the frame of a streaming plot, without values. */
const nothingRead = computed(() => {
  const r = result.value;
  // A section filling in by chunks shows what came: its date is drawn part way;
  // one counted only (formula heights come last) shows nothing yet.
  if (r?.partial?.chunks) {
    return Boolean(r.partial.countOnly);
  }
  return Boolean(
    r?.partial && rowsUntil(r.query.time, r.partial.readUntil) <= 0
  );
});

const statusText = computed(() => {
  switch (w.value.status) {
    case PLOT_STATUS.LOADING:
      return "Reading metadata…";
    case PLOT_STATUS.PLANNING:
      return "Planning the reads…";
    case PLOT_STATUS.QUEUED:
      return "Waiting for another plot to finish…";
    case PLOT_STATUS.RUNNING:
      return w.value.progress
        ? partsText(w.value.progress, w.value.paused)
        : "Reading data…";
    default:
      return "";
  }
});

/** Deliver a file, unless its window was closed while it was written. */
function download(blob: Blob, name: string) {
  if (!analysis.ownsDownloads(w.value.id)) {
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseName() {
  const query = shownQuery.value;
  return `${w.value.label}_${(query?.variable ?? "plot").replace(/\W+/g, "_")}_${w.value.kind}`;
}

/** A distribution's valid area, apart from each bin's share of it. */
const validArea = computed(() => {
  const h = result.value?.histogram;
  return h
    ? `Valid area: ${Math.round(h.validFraction * 1000) / 10} % of ${h.unweighedCells ? `the cells with an area (${h.unweighedCells.toLocaleString("en-US")} without one left out)` : `the selection (${h.validCells.toLocaleString("en-US")} of ${h.selectedCells.toLocaleString("en-US")} cells)`}${h.constant !== undefined ? `; all valid values are ${formatValue(h.constant)}${result.value?.units ? ` ${result.value.units}` : ""}` : ""}`
    : "";
});

function legendText() {
  if (validArea.value) {
    const curves =
      distribution.value &&
      (curveView.value === "density" || curveView.value === "both")
        ? ` Solid curve: smoothed density${curveView.value === "both" ? "; grey dashed: normal curve of the same mean and standard deviation" : ""}.`
        : "";
    const summary = distributionText.value
      ? // σ is not in the PDF's standard font: spelled out, the caption
        // stays searchable text.
        ` ${distributionText.value.replace("σ", "standard deviation")} (bracket: the central ${centralRange.value} %, tails outside it shaded; lines: median solid dark, mean dashed amber).`
      : "";
    const above = shareAbove.value ? ` ${shareAbove.value}.` : "";
    const shown =
      curveView.value === "cdf"
        ? "Line: share of the valid area below each value (cumulative)."
        : "Bars: share of the valid area in each value bin.";
    return `${shown}${curves} ${validArea.value}.${summary}${above}`;
  }
  if (result.value?.region) {
    return `Lower panel: valid area per time step${result.value.query.minCoverage !== undefined ? `; triangles mark means hidden below the ${Math.round(result.value.query.minCoverage * 100)} % threshold` : ""}.`;
  }
  if (result.value?.kind === ANALYSIS_KINDS.LAT_VERTICAL) {
    return "Each column: the area-weighted mean over the sector at that latitude bin; hatched: no valid value there.";
  }
  return isCurtain.value
    ? "Hatched: missing value in a stored cell; blank: no stored cell."
    : undefined;
}

/** Title, selection, status and legend of the PNG, as shown now. */
function exportCaption() {
  return {
    title: `${w.value.label} ${title.value}`,
    subtitle: subtitle.value,
    status:
      partial.value ||
      (w.value.snapshot ? `Snapshot of ${w.value.datasetName}` : undefined),
    legend:
      [
        legendText(),
        heat.value
          ? slice.value
            ? `Lower panel: ${sliceTitle.value}.`
            : "Heatmap only (pick a date to add its trace)."
          : undefined,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

/**
 * The PNG or PDF shows the figure in either view, with title and
 * selection.
 */
async function exportFigure(
  format: "png" | "pdf" | "svg",
  r: TAnalysisResult,
  size?: { width: number; height: number }
) {
  const fromData = w.value.showTable;
  // The caption and name as shown at the click.
  const name = baseName();
  const caption = exportCaption();
  let blob: Blob | null = null;
  try {
    if (fromData) {
      // The figure component mounts in Chart view; Data returns after.
      analysis.patchWindow(w.value.id, { showTable: false });
      await nextTick();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    blob =
      format === "png"
        ? await figurePng(caption, size)
        : format === "svg"
          ? await figureSvg(caption)
          : await figurePdf(caption, name, result.value ?? r);
  } catch {
    blob = null;
  } finally {
    // Back to Data, unless the scientist went there meanwhile.
    if (fromData && !w.value.showTable) {
      analysis.patchWindow(w.value.id, { showTable: true });
    }
  }
  if (blob) {
    download(blob, `${name}.${format}`);
    exportNote.value = "";
  } else {
    exportNote.value = "The figure could not be drawn for export.";
  }
}

async function figurePng(
  caption: TFigureText,
  size?: { width: number; height: number }
) {
  // A custom size: the standard layout drawn at as many pixels as asked.
  const fit = size
    ? customLayout(
        size,
        EXPORT_SIZE.width,
        captionHeight(caption, EXPORT_SIZE.width, root.value),
        slice.value ? 260 : 0
      )
    : undefined;
  if (fit && "error" in fit) {
    return null;
  }
  const ratio = fit?.ratio ?? 2;
  const main = await chart.value?.renderExport(
    EXPORT_SIZE.width,
    fit?.chartHeight ?? EXPORT_SIZE.height,
    undefined,
    ratio
  );
  // A shown trace goes into the PNG under its heatmap.
  const trace = slice.value
    ? await sliceChart.value?.renderExport(
        EXPORT_SIZE.width,
        260,
        undefined,
        ratio
      )
    : undefined;
  const figure = trace && main ? stackCanvases(main, trace) : main;
  return composeFigure(figure, caption, root.value, ratio, size);
}

/** The figure parts (chart, and a shown trace) for a vector export. */
function vectorParts() {
  const main = chart.value;
  if (!main) {
    return undefined;
  }
  const { width, height } = EXPORT_SIZE;
  const parts = [
    {
      width,
      height,
      draw: (canvas: HTMLCanvasElement) =>
        main.renderExport(width, height, canvas),
    },
  ];
  const trace = slice.value ? sliceChart.value : undefined;
  if (trace) {
    parts.push({
      width,
      height: 260,
      draw: (canvas) => trace.renderExport(width, 260, canvas),
    });
  }
  return parts;
}

/** The same figure as SVG (paths and text; images embedded). */
async function figureSvg(caption: TFigureText) {
  const parts = vectorParts();
  if (!parts) {
    return null;
  }
  const { composeFigureSvg } = await import("./pdfFigure.ts");
  const svg = await composeFigureSvg(parts, caption, root.value);
  return new Blob([svg], { type: "image/svg+xml" });
}

/** The same figure as vectors, with its query and provenance attached. */
async function figurePdf(
  caption: TFigureText,
  name: string,
  r: TAnalysisResult
) {
  const parts = vectorParts();
  if (!parts) {
    return null;
  }
  const { composeFigurePdf } = await import("./pdfFigure.ts");
  const provenance = new TextEncoder().encode(
    JSON.stringify(resultProvenance(r), null, 2)
  );
  const bytes = await composeFigurePdf(parts, caption, root.value, [
    {
      name: `${name}.json`,
      mime: "application/json",
      description: "Query and provenance of this figure (Gridlook)",
      bytes: provenance,
    },
  ]);
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}

const tabsBox = ref<HTMLElement>();
const methodBody = ref<InstanceType<typeof PlotMethod>>();

/** The chart's pointer, shown as a pointer on the path on the map. */
/** The map's pointer on this plot's route, as a distance (m). */
const mapCursor = computed(() =>
  analysis.pathHover?.fromMap && analysis.pathHover.id === w.value.id
    ? analysis.pathHover.meters
    : undefined
);

function hoverPath(meters: number | undefined) {
  if (meters !== undefined) {
    analysis.pathHover = { id: w.value.id, meters };
  } else if (analysis.pathHover?.id === w.value.id) {
    analysis.pathHover = undefined;
  }
}
onBeforeUnmount(() => {
  hoverPath(undefined);
  // Downloads belong to the plot, not this view of it: closing the plot
  // (the store) cancels them; minimizing does not.
});
const sliceChart = ref<InstanceType<typeof SeriesChart>>();

function stackCanvases(top: HTMLCanvasElement, bottom: HTMLCanvasElement) {
  const out = document.createElement("canvas");
  out.width = Math.max(top.width, bottom.width);
  out.height = top.height + bottom.height;
  const context = out.getContext("2d")!;
  context.drawImage(top, 0, 0);
  context.drawImage(bottom, 0, top.height);
  return out;
}

/** Tabs: arrows, Home and End move and select (roving tabindex). */
async function tabKeys(event: KeyboardEvent) {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!keys.includes(event.key)) {
    return;
  }
  event.preventDefault();
  const items = [
    ...(tabsBox.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ??
      []),
  ].filter((tab) => !tab.disabled);
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (at + (event.key === "ArrowRight" ? 1 : -1) + items.length) %
          items.length;
  items[next]?.click();
  await nextTick();
  items[next]?.focus();
}

/** Scientific downloads: written from the result, no source reads. */
async function exportData(
  format: "nc" | "zarr" | "geojson",
  r: TAnalysisResult,
  name: string
) {
  exportNote.value = "";
  try {
    const exporter = await import("@/lib/analysis/scientificExport.ts");
    if (format === "geojson") {
      const text = JSON.stringify(
        await exporter.selectionGeoJSON(r, w.value.label)
      );
      download(
        new Blob([text], { type: "application/geo+json" }),
        `${name}.geojson`
      );
      return;
    }
    // Written in the background (a worker), one file at a time.
    exportNote.value = `Preparing ${format === "nc" ? "NetCDF-4" : "Zarr"}…`;
    const { writeScientificFile } =
      await import("@/lib/analysis/exportClient.ts");
    // Closing cancels queued jobs; one not queued yet must not start.
    if (!analysis.ownsDownloads(w.value.id)) {
      exportNote.value = "";
      return;
    }
    const { bytes, background } = await writeScientificFile(
      format,
      r,
      w.value.id
    );
    download(
      new Blob([bytes as BlobPart], {
        type: format === "nc" ? "application/x-netcdf" : "application/zip",
      }),
      format === "nc" ? `${name}.nc` : `${name}.zarr.zip`
    );
    exportNote.value = background
      ? ""
      : "The background writer is unavailable in this browser; the file was written on this page.";
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      exportNote.value = "";
      return;
    }
    exportNote.value = `The ${format === "nc" ? "NetCDF" : format === "zarr" ? "Zarr" : "GeoJSON"} file could not be written: ${(error as Error).message}`;
  }
}

/** A scientific file that cannot be queued is refused before the copy. */
async function refused(format: string, r: TAnalysisResult) {
  if (format !== "nc" && format !== "zarr") {
    return false;
  }
  const { exportRefusal } = await import("@/lib/analysis/exportClient.ts");
  const refusal = exportRefusal(r);
  if (refusal) {
    exportNote.value = refusal;
  }
  return Boolean(refusal);
}

// eslint-disable-next-line max-lines-per-function
async function exportAs(
  format: TExportFormat,
  size?: { width: number; height: number }
) {
  const stored = storedResult.value;
  if (!result.value || !stored) {
    return;
  }
  const name = baseName();
  // The chart as shown (a time view, boxes, a spectrum, a rose, a
  // hodograph, a scatter…) and a script.
  if (format === "chart-csv") {
    const text = figureCsv.value ?? (spec.value && chartValuesCsv(spec.value));
    if (text) {
      download(
        new Blob([text], { type: "text/csv" }),
        `${name}_${shownFigure.value ?? "chart"}.csv`
      );
    }
    return;
  }
  if (format === "py") {
    const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
    download(
      new Blob(
        [
          pythonScript(
            freezeResult(stored),
            name,
            `${w.value.label} ${title.value}`,
            // A view of the values (a rose, an anomaly…) is named, not redrawn.
            shownFigure.value
              ? {
                  rose: "a wind rose",
                  hodograph: "a hodograph",
                  scatter: "a scatter against another variable",
                }[shownFigure.value]
              : timeView.value
                ? `the ${TIME_VIEW_NAMES[timeView.value].toLowerCase()} view`
                : undefined,
            pathAxisOffered.value && w.value.pathAxis === "latitude"
              ? "latitude"
              : undefined
          ),
        ],
        {
          type: "text/x-python",
        }
      ),
      `${name}.py`
    );
    return;
  }
  // Selection and provenance read the query and status as they are now;
  // nothing to copy.
  if (format === "geojson" || format === "json") {
    if (format === "geojson") {
      await exportData(format, stored, name);
    } else {
      download(
        new Blob([JSON.stringify(resultProvenance(stored), null, 2)], {
          type: "application/json",
        }),
        `${name}.json`
      );
    }
    return;
  }
  if (await refused(format, stored)) {
    return;
  }
  // Values, coverage and status frozen at the click: later parts of a
  // running series are not mixed in. Data files keep the file's units.
  const r = freezeResult(stored);
  if (format === "png" || format === "pdf" || format === "svg") {
    if (drawingFigure.value) {
      return;
    }
    drawingFigure.value = true;
    pinned.value = markRaw(r);
    try {
      await nextTick();
      await exportFigure(format, r, size);
    } finally {
      pinned.value = undefined;
      drawingFigure.value = false;
    }
    return;
  }
  if (format === "nc" || format === "zarr") {
    await exportData(format, r, name);
    return;
  }
  if (format === "csv") {
    download(
      new Blob(await resultCsvParts(r), { type: "text/csv" }),
      `${name}.csv`
    );
  }
}

/** Redraw: the map shows while drawing, the window returns afterwards. */
function redraw() {
  const kind = w.value.draft.geometry.kind;
  const mode =
    kind === GEOMETRY_KINDS.POLYLINE
      ? DRAW_MODES.POLYLINE
      : kind === GEOMETRY_KINDS.POLYGON
        ? DRAW_MODES.POLYGON
        : kind === GEOMETRY_KINDS.BOX ||
            (kind === GEOMETRY_KINDS.SHAPE && w.value.draft.geometry.drawn)
          ? DRAW_MODES.BOX
          : DRAW_MODES.POINT;
  const rotating = globe.isRotating;
  globe.isRotating = false;
  analysis.startDrawing(mode, w.value.kind, undefined, w.value.id, rotating);
  analysis.setMinimized(w.value.id, true);
}

/**
 * A dialog inside the window: Settings (its state kept with the plot) or
 * Method (read-only). Closing returns focus to the button that opened it.
 */
const methodOpen = ref(false);
const methodButton = ref<HTMLButtonElement>();
const settingsButton = ref<HTMLButtonElement>();
const dialog = computed(() =>
  w.value.showSettings && !w.value.snapshot
    ? ("settings" as const)
    : methodOpen.value
      ? ("method" as const)
      : undefined
);
/** The chart's zoom, kept while Data is shown (its chart is unmounted). */
const chartZoom = ref<{
  key: string;
  range?: { min: number; max: number };
}>();

/** Units and chart type when Settings opened: what Cancel restores. */
const displayAtOpen =
  ref<Pick<TPlotWindow, "displayUnits" | "chartStyle" | "shareAbove">>();
watch(
  dialog,
  (now) => {
    displayAtOpen.value =
      now === "settings"
        ? {
            displayUnits: w.value.displayUnits,
            chartStyle: w.value.chartStyle,
            // Converted with the units: Cancel puts it back too.
            shareAbove: w.value.shareAbove,
          }
        : undefined;
  },
  { immediate: true }
);
/** Display choices changed since Settings opened (already shown). */
const displayChanged = computed(() => {
  const before = displayAtOpen.value;
  return before
    ? [
        before.displayUnits !== w.value.displayUnits && "units",
        before.chartStyle !== w.value.chartStyle && "chart type",
      ].filter((item): item is string => Boolean(item))
    : [];
});
function toggleMethod() {
  const opening = dialog.value !== "method";
  analysis.patchWindow(w.value.id, { showSettings: false });
  methodOpen.value = opening;
}
function toggleSettings() {
  methodOpen.value = false;
  analysis.patchWindow(w.value.id, { showSettings: !w.value.showSettings });
}
/**
 * Close the dialog: Cancel drops Settings' edits, Apply applies them (and
 * stays open when they cannot be applied: a crossed outline says why).
 */
async function closeDialog(action?: "apply" | "cancel") {
  const which = dialog.value;
  if (action === "cancel") {
    analysis.discardDraft(w.value.id);
    // Display choices are shown at once; Cancel puts them back.
    if (displayAtOpen.value) {
      analysis.patchWindow(w.value.id, { ...displayAtOpen.value });
    }
  } else if (action === "apply" && pending.value.length) {
    void analysis.apply(w.value.id);
    // Applied, Settings closes (25 Nov); an outline that crosses itself
    // is not applied, and Settings stays to show where.
    const g = w.value.draft.geometry;
    if (
      g.kind === GEOMETRY_KINDS.POLYGON &&
      polygonCrossings(g.vertices).length
    ) {
      return;
    }
  }
  methodOpen.value = false;
  methodFocus.value = undefined;
  analysis.patchWindow(w.value.id, { showSettings: false });
  await nextTick();
  (which === "method" ? methodButton : settingsButton).value?.focus();
}

/**
 * The map owns the colour scale: a heatmap or section of the variable the
 * map shows takes its palette, limits, inversion and steps (and follows
 * them); another variable keeps the palette with its own range, labelled.
 */
/** What a result holds against the map's one slice (see plotScale). */
function sliceAgainstMap(r: TAnalysisResult | undefined) {
  if (!r) {
    return "map" as const;
  }
  if (r.vertical) {
    return "levels" as const;
  }
  if ((r.time?.raw.length ?? 0) > 1) {
    return "dates" as const;
  }
  const level = r.query.level;
  if (
    summary.value?.vertical &&
    level !== undefined &&
    level !== mapLevelIndex.value
  ) {
    return "level" as const;
  }
  const date = r.query.time?.start;
  return date !== undefined &&
    mapTimeIndex.value !== undefined &&
    date !== mapTimeIndex.value
    ? ("date" as const)
    : ("map" as const);
}

const colourScale = computed(() => {
  const r = result.value;
  const source = w.value.committedBinding?.source ?? w.value.source;
  // A variable's source key extends the dataset's ("<dataset>|store|path").
  const active = analysis.activeSource?.key;
  const scale = plotScale(
    {
      colormap: globe.colormap,
      invertColormap: globe.invertColormap,
      posterizeLevels: globe.posterizeLevels,
      hideLowerBound: globe.hideLowerBound,
      hideUpperBound: globe.hideUpperBound,
      selection: globe.selection,
      varnameDisplay: globe.varnameDisplay,
      fixedLimits: customLimitsInUse(
        globe.customBoundsActive,
        globe.userBoundsLow,
        globe.userBoundsHigh,
        globe.selection
      ),
    },
    {
      variable: r?.query.variable ?? w.value.draft.variable,
      sameSource:
        !w.value.snapshot &&
        active !== undefined &&
        (source.key === active || source.key.startsWith(`${active}|`)),
      values: r?.values ?? [],
      slice: sliceAgainstMap(r),
    }
  );
  // The map's limits are in the file's units: shown in the plot's units.
  const stored = storedResult.value;
  if (scale.from === "map" && stored && r && r.units !== stored.units) {
    const meta = temperatureMetadata(
      stored,
      standardNameOf(stored, analysis.variableSources)
    );
    const shown = converter(stored.units, r.units, { from: meta, to: meta });
    return shown
      ? { ...scale, low: shown(scale.low), high: shown(scale.high) }
      : scale;
  }
  return scale;
});

/** Chart, the figures the data allow, and Data, at the lower right. */
const tabs = computed(() =>
  viewTabs({
    figure: figureKind.value,
    current: Boolean(windCompanions.value?.current),
    scatter: scatter.value
      ? scatter.value.title.startsWith("Temperature")
        ? "T–S"
        : "Scatter"
      : undefined,
  })
);
const activeTab = computed<TViewTab["id"]>(() =>
  w.value.showTable ? "data" : (shownFigure.value ?? "chart")
);
function selectTab(tab: TViewTab["id"]) {
  analysis.patchWindow(
    w.value.id,
    tab === "data"
      ? { showTable: true }
      : { showTable: false, figure: tab === "chart" ? undefined : tab }
  );
}
// A figure tab that appears is announced once and pulses twice; Chart
// stays selected.
const pulsing = ref<TViewTab["id"]>();
watch(
  tabs,
  (list) => {
    for (const tab of list) {
      if (introduceTab(w.value.id, tab.id)) {
        pulsing.value = tab.id;
        analysis.announcement = `${w.value.label}: ${tab.label} available.`;
        setTimeout(() => {
          if (pulsing.value === tab.id) {
            pulsing.value = undefined;
          }
        }, 2400);
      }
    }
  },
  { immediate: true }
);

/**
 * The read-status row: dates (of the time axis) apart from request parts,
 * and bytes the store sent apart from those decoded.
 */
const readFacts = computed(() => {
  const dates = goalDates(w.value.extending, result.value);
  return {
    dates: dates && result.value?.partial ? dates : undefined,
    // Request parts: while reading, else how many a stopped read finished.
    parts: w.value.progress
      ? partsText(w.value.progress, w.value.paused)
      : result.value?.partial
        ? `${result.value.partial.done.toLocaleString("en-US")} of ${result.value.partial.total.toLocaleString("en-US")} parts read`
        : "",
    ...work.value,
  };
});
/**
 * The chart's tools, most used first. Tools that do not fit on the line
 * (and the less used ones always) sit under More analysis; Export stays at
 * the right. One copy of each control moves between the two places.
 */
type TControl =
  | "time"
  | "trend"
  | "wind"
  | "curve"
  | "range"
  | "above"
  | "follow"
  | "members"
  | "spread"
  | "along"
  | "pair";
const SECONDARY: TControl[] = [
  "members",
  "spread",
  "along",
  "pair",
  "range",
  "above",
];
/**
 * The bar is one line, always: tools stay on it in this order (Follow map
 * time, Time, Trend, Barbs, Curve) while they fit; the rest, and the less
 * used ones always, sit under More.
 */
const controls = computed<TControl[]>(() => {
  if (w.value.showTable) {
    return [];
  }
  const shown: [TControl, boolean][] = [
    [
      "follow",
      (singleTime.value && !w.value.snapshot && Boolean(result.value)) ||
        levelFollowable.value,
    ],
    ["time", seriesTools.value && !shownFigure.value],
    ["trend", seriesTools.value && !shownFigure.value && !isCycle.value],
    ["wind", windOffered.value],
    ["curve", Boolean(distribution.value)],
    ["range", Boolean(distribution.value)],
    ["above", Boolean(distribution.value)],
    ["members", Boolean(memberDimension.value) && !w.value.snapshot],
    ["spread", hasSpread.value && !w.value.members && !timeView.value],
    ["along", pathAxisOffered.value],
    ["pair", canPair.value && pairChoices.value.length > 0],
  ];
  return shown.filter(([, on]) => on).map(([id]) => id);
});
const moreId = computed(() => `plot-more-${w.value.id}`);
/** Time and Trend belong to every series in time; locked while reading. */
const seriesTools = computed(
  () => isSeries.value && Boolean(result.value?.time) && !nothingRead.value
);
const timeLocked = computed(() =>
  result.value?.partial
    ? "Available once every date is read"
    : !timeViews.value.length
      ? "This series has no other time views"
      : ""
);
const moreHost = ref<HTMLElement>();
const moreOpen = ref(false);
onClickOutside(moreHost, () => (moreOpen.value = false));
/** More's panel opens under its button, moved left to stay in the window. */
const morePanel = ref<HTMLElement>();
const moreShift = ref(0);
function placeMore() {
  const panel = morePanel.value;
  const frame = panel?.closest(".analysis-window")?.getBoundingClientRect();
  if (!panel || !frame || !moreOpen.value) {
    return;
  }
  const rect = panel.getBoundingClientRect();
  const natural = rect.left - moreShift.value;
  const over = natural + rect.width - (frame.right - 8);
  moreShift.value = Math.round(
    Math.max(frame.left + 8 - natural, Math.min(0, -over))
  );
}
watch(moreOpen, async (open) => {
  if (open) {
    await nextTick();
    placeMore();
  }
});
useResizeObserver(morePanel, placeMore);
function closeMore() {
  moreOpen.value = false;
  moreHost.value?.querySelector<HTMLElement>("button")?.focus();
}
/** How many of the most used tools fit on the line. */
const fitting = ref(Number.POSITIVE_INFINITY);
/** Whether the tools as placed are wider than the line. */
const toolbarOverflows = ref(false);
const activeElement = useActiveElement();
let lastPlacement: { inline: TControl[]; more: TControl[] } | undefined;
const placement = computed(() => {
  const inline = controls.value
    .filter((id) => !SECONDARY.includes(id))
    .slice(0, fitting.value);
  const next = {
    inline,
    more: controls.value.filter((id) => !inline.includes(id)),
  };
  // A control in use (its menu open) stays where it is: moving it to More
  // would close the menu under the pointer (24 Nov: the Curve menu closed
  // at each step while the map played).
  const using = activeElement.value
    ?.closest?.("[data-control]")
    ?.getAttribute("data-control") as TControl | null | undefined;
  // Unless the line overflows: then it goes under More too (25 Nov: Count
  // above's field pushed Export off a phone's narrow bar).
  if (
    using &&
    !toolbarOverflows.value &&
    lastPlacement?.inline.includes(using) &&
    next.more.includes(using) &&
    controls.value.includes(using)
  ) {
    return lastPlacement;
  }
  lastPlacement = next;
  return next;
});
const inMore = (id: TControl) => placement.value.more.includes(id);
/** A read started from a tool under More is under way: More spins. */
const moreBusy = computed(
  () =>
    (inMore("pair") && pairCompanions.value?.status === "loading") ||
    (inMore("members") && memberCompanions.value?.status === "loading") ||
    (inMore("wind") && windCompanions.value?.status === "loading")
);
/** A tool under More analysis is in use: the button carries a dot. */
const moreActive = computed(() =>
  placement.value.more.some((id) =>
    id === "members"
      ? Boolean(w.value.members)
      : id === "spread"
        ? Boolean(w.value.spread)
        : id === "pair"
          ? Boolean(w.value.pairWith)
          : id === "trend"
            ? Boolean(w.value.trend)
            : id === "wind"
              ? Boolean(w.value.wind)
              : id === "follow"
                ? Boolean(w.value.followMapTime || w.value.followMapLevel)
                : id === "time"
                  ? Boolean(timeView.value)
                  : false
  )
);
const toolbarEl = ref<HTMLElement>();
const controlsEl = ref<HTMLElement>();
/** Widths of the tools, kept from when each was last on the line. */
const toolWidths = new Map<string, number>();
/** More as "⋯" only (its word and caret dropped) to keep a tool in view. */
const moreCompact = ref(false);
let moreFullWidth = 0;
const MORE_COMPACT_WIDTH = 36;
/**
 * The tools that fit beside More: as "⋯ More", or as "⋯" alone when that
 * keeps one more tool on the bar (Barbs beside Time and Trend in a
 * default-size window).
 */
function withMore(
  bar: HTMLElement,
  room: number,
  count: (room: number) => number
) {
  const button = bar.querySelector<HTMLElement>(".analysis-more-button");
  if (button && !moreCompact.value) {
    moreFullWidth = button.offsetWidth;
  }
  const n = count(room - (moreFullWidth || 112) - 6);
  const tight = count(room - MORE_COMPACT_WIDTH - 6);
  return tight > n ? { n: tight, compact: true } : { n, compact: false };
}

/**
 * Tools under More, at the width they would take on the line, with the
 * choice they show now: a hidden copy on the line, measured and removed.
 * Kept from when it last stood there, Time chosen as Annual cycle (wide)
 * stayed too wide to come back after As read (23 Nov).
 */
function measureMoreTools() {
  const line = controlsEl.value;
  const host = document.getElementById(moreId.value);
  if (!line || !host) {
    return;
  }
  for (const element of host.querySelectorAll<HTMLElement>("[data-control]")) {
    const copy = element.cloneNode(true) as HTMLElement;
    // A copied select shows its first choice: give it the one shown.
    const selects = element.querySelectorAll("select");
    copy.querySelectorAll("select").forEach((select, k) => {
      select.value = selects[k]?.value ?? select.value;
    });
    copy.removeAttribute("id");
    copy.setAttribute("aria-hidden", "true");
    copy.style.cssText +=
      ";position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0;width:auto";
    line.append(copy);
    toolWidths.set(element.dataset.control!, copy.offsetWidth);
    copy.remove();
  }
}

// eslint-disable-next-line max-lines-per-function
function measureToolbar() {
  const bar = toolbarEl.value;
  if (!bar) {
    return;
  }
  const over = bar.scrollWidth > bar.clientWidth + 1;
  if (over !== toolbarOverflows.value) {
    toolbarOverflows.value = over;
  }
  for (const element of controlsEl.value?.querySelectorAll<HTMLElement>(
    ":scope > [data-control]"
  ) ?? []) {
    toolWidths.set(element.dataset.control!, element.offsetWidth);
  }
  measureMoreTools();
  const exporter =
    bar.querySelector<HTMLElement>(".analysis-export")?.offsetWidth ?? 0;
  const primary = controls.value.filter((id) => !SECONDARY.includes(id));
  const count = (room: number) => {
    let used = 0;
    let n = 0;
    for (const id of primary) {
      const width = toolWidths.get(id) ?? 120;
      if (used + width + (n ? 6 : 0) > room) {
        break;
      }
      used += width + (n ? 6 : 0);
      n++;
    }
    return n;
  };
  // Padding and gaps; the heatmap's own pickers (Trace, Line), which never
  // move under More; then the More button's room when anything is left.
  // At their full width (a hidden copy): they give way only once no tool is
  // left on the line, and measuring them shrunk would bring tools back.
  let fixed = 0;
  for (const element of controlsEl.value?.querySelectorAll<HTMLElement>(
    ":scope > .analysis-trace-picker, :scope > .analysis-vline"
  ) ?? []) {
    const copy = element.cloneNode(true) as HTMLElement;
    const selects = element.querySelectorAll("select");
    copy.querySelectorAll("select").forEach((select, k) => {
      select.value = selects[k]?.value ?? select.value;
    });
    copy.setAttribute("aria-hidden", "true");
    copy.style.cssText +=
      ";position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0;flex:none";
    controlsEl.value!.append(copy);
    fixed += copy.offsetWidth + 6;
    copy.remove();
  }
  const room = bar.clientWidth - exporter - 40 - fixed;
  let n = count(room);
  let compact = false;
  if (
    n < primary.length ||
    controls.value.some((id) => SECONDARY.includes(id))
  ) {
    ({ n, compact } = withMore(bar, room, count));
  }
  if (compact !== moreCompact.value) {
    moreCompact.value = compact;
  }
  if (
    n !== fitting.value &&
    !(n >= primary.length && fitting.value >= primary.length)
  ) {
    fitting.value = n;
  }
}
useResizeObserver(toolbarEl, measureToolbar);
onUpdated(measureToolbar);

const compactRange = computed(() =>
  compactDateRange(preview.value?.range ?? "")
);

/**
 * The bottom bar's two lines: what is happening (or what was read), and
 * small facts under it. Dates of the time axis stay apart from request
 * parts and from bytes.
 */
// eslint-disable-next-line max-lines-per-function
const bar = computed(() => {
  const empty = {
    progress: undefined as { done: number; total: number } | undefined,
    lead: "",
    main: "",
    mainTitle: undefined as string | undefined,
    parts: "",
    warn: false,
    reading: false,
    through: "",
    throughDay: "",
    /** Which state the bar shows (its actions follow it). */
    mode: "done" as "reading" | "confirm" | "preview" | "stopped" | "done",
    /** A progress line runs (indeterminate without counts). */
    line: false,
    /** The main line is the map's value (a ring marks it). */
    ring: false,
  };
  if (busy.value) {
    const dates = readFacts.value.dates;
    const running = w.value.status === PLOT_STATUS.RUNNING && w.value.progress;
    return {
      ...empty,
      // One measure for the words and the line: dates when counted, else
      // the request parts (a plot without a time axis).
      progress: dates?.total
        ? { done: dates.read, total: dates.total }
        : w.value.progress,
      mode: "reading" as const,
      line: true,
      reading: true,
      lead: running ? (w.value.paused ? "Paused" : "Reading") : "",
      main: running
        ? dates
          ? ` ${dates.text}${dates.total ? ` (${Math.floor((100 * dates.read) / dates.total)} %)` : ""}`
          : result.value?.partial?.chunks && w.value.progress
            ? ` ${chunksText(w.value.progress)}`
            : ""
        : statusText.value,
      // The last date reached: in full, or its day alone in a small window.
      through: running && dates?.through ? shortDate(dates.through) : "",
      throughDay: running && dates?.through ? dateKey(dates.through, 10) : "",
      // "Paused" leads the line already.
      parts: running ? statusText.value.replace(/^Paused after/, "After") : "",
    };
  }
  const estimate = w.value.estimate;
  if (w.value.status === PLOT_STATUS.CONFIRM && estimate) {
    // The question itself is asked in the window (the gate card).
    return {
      ...empty,
      mode: "confirm" as const,
      main: estimate.needsConfirmation
        ? "Waiting: locate the cells first"
        : "Waiting for Compute",
    };
  }
  if (preview.value && !w.value.snapshot) {
    // An Extend that stopped or failed says so beside the dates loaded (which
    // the count is): "Stopped: 24 more dates added.". A first read
    // that stopped or failed says so too.
    const note =
      w.value.status === PLOT_STATUS.DONE ||
      w.value.status === PLOT_STATUS.ERROR ||
      (w.value.status === PLOT_STATUS.CANCELLED && result.value?.partial)
        ? w.value.message
        : "";
    return {
      ...empty,
      mode: "preview" as const,
      lead: preview.value.text,
      main: note ? ` — ${note}` : ` — ${compactRange.value}`,
      warn: Boolean(note),
      mainTitle: note || preview.value.around,
    };
  }
  if (partial.value) {
    return {
      ...empty,
      mode: "stopped" as const,
      warn: true,
      main: shortDate(partial.value.replace(/^Partial: /, "Stopped: ")),
      parts: readFacts.value.parts,
    };
  }
  if (w.value.status === PLOT_STATUS.CANCELLED) {
    return { ...empty, main: "Cancelled." };
  }
  // A series with no value at all: say so plainly, and where.
  const r = result.value;
  if (
    r &&
    isSeries.value &&
    r.values.length &&
    !r.values.some(Number.isFinite)
  ) {
    return {
      ...empty,
      warn: true,
      main: `No values here: all ${r.values.length.toLocaleString("en-US")} dates are missing at this point (land, or no data in the source)`,
    };
  }
  return {
    ...empty,
    main:
      validArea.value ||
      mapValue.value?.text ||
      (w.value.snapshot
        ? `Snapshot of ${w.value.datasetName} (read-only)`
        : ""),
    mainTitle: validArea.value ? distributionText.value : mapValue.value?.title,
    ring: !validArea.value && Boolean(mapValue.value),
    parts:
      w.value.snapshot && (validArea.value || mapValue.value)
        ? `Snapshot of ${w.value.datasetName} (read-only)`
        : "",
  };
});
/** The plotted value at the map's date (a series), for the footer. */
const mapValue = computed(() => {
  const row = mapRow.value;
  const r = result.value;
  if (row === undefined || !r || !isSeries.value || r.histogram) {
    return undefined;
  }
  const value = r.values[row];
  const units = r.units ? ` ${r.units}` : "";
  return {
    text: Number.isFinite(value)
      ? `Map: ${formatValue(value)}${units}`
      : "Map: no value",
    title: `At the map's date, ${timeLabelAt(r.time, row)}`,
  };
});
/**
 * Reads in parts that are kept when stopped: series, and time × axis plots
 * (Hovmöllers, time–depth), which stream their dates the same way.
 */
const streams = computed(
  () => isSeries.value || Boolean(w.value.result?.partial)
);

/** After Stop: what Continue reads (its tooltip), if there is more. */
const continuing = computed(() => {
  const r = result.value;
  const span = w.value.committed?.time;
  const until = r?.partial?.readUntil;
  if (
    (w.value.status !== PLOT_STATUS.CANCELLED &&
      w.value.status !== PLOT_STATUS.ERROR) ||
    !span ||
    until === undefined ||
    until >= span.stop
  ) {
    return "";
  }
  const from = timeLabelAt(summary.value?.time, until);
  return `Read the ${(span.stop - until).toLocaleString("en-US")} dates not read yet${from ? `, from ${shortDate(from)}` : ""}; the dates read are kept`;
});

/** How the heatmap is drawn (from the canvas), for Read details. */
const heatNotes = ref<string[]>([]);

/** When Read all is off: change the dates, redraw the area, or read on. */
const allWaysOn = computed(() =>
  preview.value?.tooMany
    ? [
        { id: "dates" as const, label: "Change dates" },
        { id: "area" as const, label: "Redraw on map" },
        ...(preview.value.nextDates > 0
          ? [
              {
                id: "extend" as const,
                label: `+${preview.value.nextDates.toLocaleString("en-US")} dates`,
              },
            ]
          : []),
      ]
    : undefined
);

/** A way on from Read details: new dates, a new area, or more dates. */
function readAction(id: TRowAction) {
  if (id === "dates") {
    void changeDates();
  } else if (id === "area") {
    methodOpen.value = false;
    redraw();
  } else {
    methodOpen.value = false;
    void analysis.extendDates(w.value.id);
  }
}

/** Read details: the Method dialog, at its read diagnostics. */
const methodFocus = ref<"method" | "diagnostics">();
async function openReadDetails() {
  methodFocus.value = "diagnostics";
  analysis.patchWindow(w.value.id, { showSettings: false });
  methodOpen.value = true;
}

/** Room the Export menu may take below the toolbar. */
const menuRoom = computed(() =>
  Math.round((narrow.value ? props.areaSize.height : w.value.rect.h) - 110)
);

/** Method's second tab: where the read stands and what it cost. */
const diagnostics = computed(() => {
  const r = result.value;
  if (!r) {
    return [];
  }
  const s = summary.value;
  const progress = w.value.progress ?? r.partial;
  const intent = w.value.preview?.intent.time;
  const label = (at: number) => timeLabelAt(s?.time, at) || `step ${at + 1}`;
  return readDiagnostics(r, {
    grid: s
      ? `${s.gridLabel}${s.frame ? ` — ${s.frame}` : ""} — ${s.decoding}`
      : undefined,
    opened: s?.opened,
    ...(s?.time?.reads
      ? { timeReads: { reads: s.time.reads, bytes: s.time.readBytes ?? 0 } }
      : {}),
    read: {
      state: busy.value
        ? w.value.paused
          ? "Paused"
          : "Reading"
        : preview.value
          ? "First dates shown"
          : partial.value
            ? "Stopped"
            : w.value.status === PLOT_STATUS.CANCELLED
              ? "Cancelled"
              : "Complete",
      parts: progress
        ? `${progress.done.toLocaleString("en-US")} of ${progress.total.toLocaleString("en-US")}`
        : undefined,
      requested: intent
        ? {
            first: label(intent.start),
            last: label(intent.stop - 1),
            count: rowCount(intent),
          }
        : undefined,
      allRefused: preview.value?.tooMany,
      allActions: allWaysOn.value,
      drawing: heat.value ? heatNotes.value : undefined,
    },
  });
});

/** The Method dialog: what was selected and computed, and how it was read. */
const method = computed(() => {
  const r = result.value;
  if (!r) {
    return [];
  }
  const s = summary.value;
  const sections = methodSections(r, {
    // Where, without the date (the Date row says it once).
    selection: selectionSubtitle(
      w.value,
      shownQuery.value && { ...shownQuery.value, time: undefined }
    ),
    grid: s
      ? `${s.gridLabel}${s.frame ? ` — ${s.frame}` : ""} — ${s.decoding}`
      : undefined,
    level: levelRead.value,
    view: shownFigure.value
      ? figureLabel.value
      : timeView.value
        ? `${TIME_VIEW_NAMES[timeView.value]} (Data and exports keep the values as computed)`
        : undefined,
    centralRange: centralRange.value,
  });
  // A profile's column statistics, each with how it was computed.
  const vertical = profileStats.value.map((stat) => ({
    label: stat.label,
    value: `${statText(stat)} — ${stat.method}`,
  }));
  return vertical.length
    ? [...sections, { title: "Vertical statistics", rows: vertical }]
    : sections;
});
</script>

<template>
  <section
    ref="root"
    class="analysis-window analysis-panel"
    :class="{
      focused: analysis.focusedId === plot.id,
      coarse,
      maximized: plot.maximized || narrow,
      phone: narrow,
    }"
    :style="style"
    role="dialog"
    tabindex="-1"
    :data-plot-id="plot.id"
    :aria-label="`${plot.label} ${PLOT_KIND_NAMES[plot.kind]}: ${title}`"
    @pointerdown="analysis.focus(plot.id)"
    @wheel.stop
    @contextmenu.stop
  >
    <header
      class="analysis-title"
      :class="{ sheet: narrow }"
      @pointerdown="startGesture($event, 'move')"
      @dblclick="toggleMaximize"
    >
      <span
        class="analysis-id"
        tabindex="0"
        :title="`${idMeaning(plot.label, PLOT_KIND_NAMES[plot.kind])}. Hover to show it on the map.`"
        :aria-label="`${idMeaning(plot.label, PLOT_KIND_NAMES[plot.kind])}: show its selection on the map`"
        @mouseenter="analysis.highlight(plot.id, true)"
        @mouseleave="analysis.unhighlight(plot.id)"
        @focus="analysis.highlight(plot.id, true)"
        @blur="analysis.unhighlight(plot.id)"
        @pointerdown.stop
        >{{ plot.label }}</span
      >
      <div class="analysis-heading">
        <div class="analysis-heading-title" :title="title">
          <span class="analysis-heading-name">{{ heading.name }}</span><span
            v-if="heading.units"
            class="analysis-heading-units"
          >
            ({{ heading.units }})</span
          >
        </div>
        <div class="analysis-heading-row">
          <div class="analysis-heading-sub" :title="subtitle">
            {{ subtitle }}
          </div>
        </div>
      </div>
      <!-- Method and Settings beside the window's buttons (review of
           23 Nov): quiet, with icons, a gap always left before them. -->
      <div
        class="analysis-meta"
        role="group"
        :aria-label="`${plot.label} method and settings`"
      >
        <button
          ref="methodButton"
          type="button"
          class="analysis-meta-button"
          aria-haspopup="dialog"
          :aria-expanded="dialog === 'method'"
          aria-label="Method"
          :disabled="!result"
          title="Selection, calculation, weighting, coverage, statistics and reads"
          @click="toggleMethod"
        >
          <PlotIcon name="method" :size="11" />
          <span>Method</span>
        </button>
        <!-- A snapshot has nothing to edit: no Settings. -->
        <button
          v-if="!plot.snapshot"
          ref="settingsButton"
          type="button"
          class="analysis-meta-button"
          aria-haspopup="dialog"
          :aria-expanded="dialog === 'settings'"
          :aria-label="pending.length ? 'Settings (edits pending)' : 'Settings'"
          title="Selection, dates, level and parameters"
          @click="toggleSettings"
        >
          <PlotIcon name="settings" :size="11" />
          <span>Settings</span
          ><span v-if="pending.length" class="analysis-dot" aria-hidden="true"
            >•</span
          >
        </button>
      </div>
      <!-- Minimize, Maximize/Restore, Close: this order on every platform
           and width, visually and for the keyboard. -->
      <div class="analysis-controls">
        <button
          type="button"
          class="analysis-icon"
          :aria-label="`Minimize ${plot.label} to Plotting tools`"
          :title="narrow ? 'Back to map' : 'Minimize to Plotting tools'"
          @click="minimize"
        >
          <i class="fa-solid fa-window-minimize" aria-hidden="true"></i>
        </button>
        <!-- A phone's plot is already full screen: no inert button taking
             the title's room (25 Nov). -->
        <button
          v-if="!narrow"
          type="button"
          class="analysis-icon"
          :aria-label="
            plot.maximized || narrow
              ? `Restore ${plot.label} size`
              : `Maximize ${plot.label} in map`
          "
          :title="
            narrow
              ? 'Full screen on a narrow map'
              : plot.maximized
                ? 'Restore size'
                : 'Maximize in map'
          "
          :aria-disabled="narrow"
          :class="{ inert: narrow }"
          @click="toggleMaximize"
        >
          <i
            class="fa-solid"
            :class="
              plot.maximized || narrow
                ? 'fa-window-restore'
                : 'fa-window-maximize'
            "
            aria-hidden="true"
          ></i>
        </button>
        <button
          type="button"
          class="analysis-icon analysis-close"
          :aria-label="`Close plot ${plot.label}`"
          title="Close plot"
          @click="requestClose"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>
    </header>
    <!-- Closing a plot that is reading or has edits: asked in a small
         dialog over the window (Escape keeps it). -->
    <div
      v-if="closing"
      class="analysis-confirm-layer"
      @keydown.esc.stop.prevent="closing = false"
    >
      <div class="analysis-confirm-scrim" @click="closing = false"></div>
      <div
        class="analysis-confirm"
        role="alertdialog"
        aria-modal="true"
        :aria-labelledby="`${plot.id}-close-title`"
        :aria-describedby="`${plot.id}-close-text`"
      >
        <i
          class="fa-solid fa-triangle-exclamation analysis-confirm-icon"
          aria-hidden="true"
        ></i>
        <h3 :id="`${plot.id}-close-title`">Close {{ plot.label }}?</h3>
        <p :id="`${plot.id}-close-text`">{{ closeText }}</p>
        <div class="analysis-confirm-actions">
          <button
            ref="keepButton"
            type="button"
            class="analysis-tool"
            @click="closing = false"
          >
            Keep plot
          </button>
          <button
            type="button"
            class="button is-small is-danger"
            @click="analysis.close(plot.id, false)"
          >
            Close plot
          </button>
        </div>
      </div>
    </div>

    <!-- Everything under the title bar; the in-window dialogs cover it. -->
    <div class="analysis-stage">
      <nav
        ref="toolbarEl"
        class="analysis-toolbar"
        :aria-label="`${plot.label} chart tools and export`"
      >
        <!-- Controls of the chart shown: Chart view only. -->
        <div
          v-if="!plot.showTable"
          ref="controlsEl"
          class="analysis-chart-controls"
          :aria-label="`${plot.label} chart tools`"
          role="group"
        >
          <!-- A heatmap's trace: one date's values under it. -->
          <label
            v-if="heat && readRows.length > 1"
            class="analysis-trace-picker"
            title="Show one date's values under the chart: drag, click a row, or use the arrow keys on the chart"
          >
            <PlotIcon name="trend" />
            <span>Trace</span>
            <input
              type="range"
              min="0"
              :max="readRows.length - 1"
              step="1"
              :value="Math.max(0, pickedPosition)"
              aria-label="Trace date"
              :aria-valuetext="sliceDate || 'none picked'"
              @input="pickPosition"
            />
            <span
              class="analysis-trace-date"
              :class="{ 'is-empty': !sliceDate }"
              >{{ sliceDate ? shortDate(sliceDate) : "none" }}</span
            >
          </label>
          <!-- A time–vertical section: a level found at each date, drawn
               over it (mixed layer, 20 °C isotherm, tropopause…). -->
          <label
            v-if="lineChoices.length"
            class="analysis-field analysis-vline"
            title="Draw a level found at each date over the section"
          >
            <span class="analysis-field-label">Line</span>
            <select
              v-model="lineStat"
              aria-label="Level drawn over the section"
            >
              <option value="">None</option>
              <option
                v-for="stat in lineChoices"
                :key="stat.id"
                :value="stat.id"
                :title="stat.method"
              >
                {{ stat.label }}
              </option>
            </select>
          </label>
          <Teleport
            v-if="
              (singleTime && !plot.snapshot && (result || plot.committed)) ||
              levelFollowable
            "
            defer
            :to="`#${moreId}`"
            :disabled="!inMore('follow')"
          >
            <span class="analysis-follow-group" data-control="follow">
              <button
                type="button"
                class="analysis-toggle analysis-follow"
                :aria-label="
                  levelFollowable ? 'Follow map level' : 'Follow map time'
                "
                :aria-pressed="
                  Boolean(
                    levelFollowable ? plot.followMapLevel : plot.followMapTime
                  )
                "
                :title="
                  levelFollowable
                    ? 'Recompute this plot when the map\'s level changes (as it plays, too)'
                    : 'Recompute this plot when the map\'s time changes'
                "
                @click="toggleFollow"
              >
                <i class="fa-solid fa-link" aria-hidden="true"></i
                ><span class="analysis-wind-label">{{
                  levelFollowable ? "Follow map level" : "Follow map time"
                }}</span>
              </button>
              <span
                v-if="mapTimeNote"
                class="analysis-chip analysis-map-time"
                >{{ mapTimeNote }}</span
              >
            </span>
          </Teleport>
          <Teleport
            v-if="memberDimension && !plot.snapshot"
            defer
            :to="`#${moreId}`"
            :disabled="!inMore('members')"
          >
            <label
              data-control="members"
              class="analysis-field analysis-members"
              :title="
                plot.members && memberCompanions?.status === 'failed'
                  ? `No members drawn: ${memberCompanions.message}`
                  : `Read every ${memberDimension.dimension} with this plot's query`
              "
            >
              <span class="analysis-field-label">Members</span>
              <select :value="plot.members ?? ''" @change="setMembers">
                <option value="">
                  {{ memberDimension.dimension }} {{ ownMember }} only
                </option>
                <option value="plume">
                  All {{ memberDimension.size }} (plume)
                </option>
                <option value="fan">Median, 10–90 %</option>
                <option value="both">Plume and 10–90 %</option>
                <option value="chance">Chance above a value</option>
              </select>
              <input
                v-if="
                  plot.members === 'chance' &&
                  membersSpec?.threshold !== undefined
                "
                class="analysis-threshold"
                type="number"
                step="any"
                :value="membersSpec.threshold"
                :aria-label="`Threshold${result?.units ? ` (${result.units})` : ''}`"
                @change="setThreshold"
              />
              <span
                v-if="plot.members === 'chance' && result?.units"
                class="analysis-field-units"
                >{{ result.units }}</span
              >
            </label>
          </Teleport>
          <Teleport
            v-if="seriesTools && !shownFigure"
            defer
            :to="`#${moreId}`"
            :disabled="!inMore('time')"
          >
            <label
              data-control="time"
              class="analysis-field analysis-time-view"
              :class="{ locked: timeLocked }"
              :title="
                timeLocked ||
                'See the series as anomalies, folded into its cycles, smoothed, accumulated, counted, boxed by month, as a spectrum or as return levels'
              "
            >
              <span class="analysis-field-label">Time</span>
              <i
                v-if="timeLocked"
                class="fa-solid fa-lock analysis-lock"
                aria-hidden="true"
              ></i>
              <select
                :value="timeView ?? waitingView ?? ''"
                :disabled="Boolean(timeLocked)"
                @change="setTimeView"
              >
                <option value="">As read</option>
                <option v-if="waitingView" :value="waitingView" disabled>
                  {{ TIME_VIEW_NAMES[waitingView] }}
                  ({{
                    result?.partial
                      ? "once every date is read"
                      : "not for these dates"
                  }})
                </option>
                <option v-for="view in timeViews" :key="view" :value="view">
                  {{ TIME_VIEW_NAMES[view] }}
                </option>
              </select>
              <template v-if="timeView === TIME_VIEWS.RUNNING">
                <input
                  class="analysis-threshold analysis-time-window"
                  type="number"
                  min="1"
                  step="1"
                  :value="seriesContext.window"
                  :aria-label="`Running mean length (${stepWord})`"
                  @change="setTimeNumber('timeWindow', $event)"
                />
                <span class="analysis-field-units">{{ stepWord }}</span>
              </template>
              <template v-if="timeView === TIME_VIEWS.COUNT">
                <input
                  class="analysis-threshold analysis-time-threshold"
                  type="number"
                  step="any"
                  :value="seriesContext.threshold"
                  :aria-label="`Count above${result?.units ? ` (${result.units})` : ''}`"
                  @change="setTimeNumber('timeThreshold', $event)"
                />
                <span v-if="result?.units" class="analysis-field-units">{{
                  result.units
                }}</span>
              </template>
            </label>
          </Teleport>
          <Teleport
            v-if="seriesTools && !shownFigure && !isCycle"
            defer
            :to="`#${moreId}`"
            :disabled="!inMore('trend')"
          >
            <button
              data-control="trend"
              type="button"
              class="analysis-toggle analysis-trend"
              :class="{ locked: result?.partial }"
              :disabled="Boolean(result?.partial)"
              :aria-label="
                plot.trend && trendText ? `Trend ${trendText}` : 'Trend'
              "
              :aria-pressed="Boolean(plot.trend)"
              :title="
                trendText
                  ? `Least-squares trend: ${trendText}`
                  : 'Least-squares trend line'
              "
              @click="analysis.patchWindow(plot.id, { trend: !plot.trend })"
            >
              <PlotIcon name="trend" />
              <span class="analysis-wind-label">Trend</span>
            </button>
          </Teleport>
          <Teleport
            v-if="distribution"
            defer
            :to="`#${moreId}`"
            :disabled="!inMore('curve')"
          >
            <label
              data-control="curve"
              class="analysis-field analysis-curve"
              title="A smooth curve over the bars, a normal curve to compare, or the cumulative share"
            >
              <span class="analysis-field-label">Curve</span>
              <select
                :value="curveView"
                @change="
                  analysis.patchWindow(plot.id, {
                    curve: ($event.target as HTMLSelectElement)
                      .value as TCurveView,
                  })
                "
              >
                <option v-for="view in CURVE_VIEWS" :key="view" :value="view">
                  {{ CURVE_NAMES[view] }}
                </option>
              </select>
            </label>
          </Teleport>
          <Teleport
            v-if="distribution"
            defer
            :to="`#${moreId}`"
            :disabled="!inMore('range')"
          >
            <label
              data-control="range"
              class="analysis-field analysis-range"
              title="The central share of the area bracketed on the chart; the tails outside it are shaded"
            >
              <span class="analysis-field-label">Range</span>
              <select
                :value="centralRange"
                @change="
                  analysis.patchWindow(plot.id, {
                    centralRange: Number(
                      ($event.target as HTMLSelectElement).value
                    ),
                  })
                "
              >
                <option
                  v-for="range in CENTRAL_RANGES"
                  :key="range"
                  :value="range"
                  :title="rangeName(range)"
                >
                  {{ range }} %
                </option>
              </select>
            </label>
          </Teleport>
          <Teleport
            v-if="distribution"
            defer
            :to="`#${moreId}`"
            :disabled="!inMore('above')"
          >
            <label
              data-control="above"
              class="analysis-field analysis-above"
              title="The share of the area above a value"
            >
              <span class="analysis-field-label">Above</span>
              <input
                class="analysis-threshold"
                type="number"
                step="any"
                placeholder="value"
                :value="plot.shareAbove ?? ''"
                :aria-label="`Share of the area above${result?.units ? ` (${result.units})` : ''}`"
                @change="setShareAbove"
              />
              <span
                v-if="shareAbove"
                class="analysis-field-units analysis-share-above"
                >{{ shareAbove }}</span
              >
            </label>
          </Teleport>
          <Teleport
            v-if="canPair && pairChoices.length"
            defer
            :to="`#${moreId}`"
            :disabled="!inMore('pair')"
          >
            <label
              data-control="pair"
              class="analysis-field analysis-pair"
              title="Read another variable with this plot's query and scatter one against the other (temperature with salinity: a T–S diagram)"
            >
              <span class="analysis-field-label">Against</span>
              <select
                :value="plot.pairWith ?? ''"
                @change="
                  analysis.setPair(
                    plot.id,
                    ($event.target as HTMLSelectElement).value || undefined
                  )
                "
              >
                <option value="">None</option>
                <option
                  v-for="choice in pairHints"
                  :key="choice.name"
                  :value="choice.name"
                  :title="choice.title"
                >
                  {{ choice.label }}
                </option>
              </select>
            </label>
          </Teleport>
          <Teleport
            v-if="pathAxisOffered"
            defer
            :to="`#${moreId}`"
            :disabled="!inMore('along')"
          >
            <label
              data-control="along"
              class="analysis-field"
              title="Draw the path's samples against distance or latitude"
            >
              <span class="analysis-field-label">Along</span>
              <select :value="plot.pathAxis ?? ''" @change="setPathAxis">
                <option value="">Distance (km)</option>
                <option value="latitude">Latitude (°N)</option>
              </select>
            </label>
          </Teleport>
          <Teleport
            v-if="hasSpread && !plot.members && !timeView"
            defer
            :to="`#${moreId}`"
            :disabled="!inMore('spread')"
          >
            <label
              data-control="spread"
              class="analysis-field analysis-area-spread"
              title="Show how values vary across the area"
            >
              <span class="analysis-field-label">Spread</span>
              <select :value="plot.spread ?? ''" @change="setSpread">
                <option value="">Mean only</option>
                <option :value="SPREAD_VIEWS.STD">± 1σ</option>
                <option :value="SPREAD_VIEWS.RANGE">Min–max</option>
              </select>
            </label>
          </Teleport>
          <Teleport
            v-if="windOffered"
            defer
            :to="`#${moreId}`"
            :disabled="!inMore('wind')"
          >
            <div
              ref="windMenuHost"
              data-control="wind"
              class="analysis-wind-group"
              @keydown.esc.stop="windMenuOpen = false"
            >
              <button
                type="button"
                class="analysis-toggle analysis-wind"
                :aria-pressed="Boolean(plot.wind)"
                :title="windTitle"
                :aria-label="vector.name"
                @click="pressBarbs"
              >
                <PlotIcon :name="vector.icon" />
                <span class="analysis-wind-label">{{ vector.tool }}</span><span
                  v-if="
                    plot.wind && plot.companions?.wind?.status === 'loading'
                  "
                  class="analysis-wind-busy"
                  aria-label="reading the wind components"
                ></span
                ><span
                  v-if="windAsk"
                  class="analysis-wind-asks"
                  aria-label="waiting for your approval"
                ></span>
              </button>
              <div
                v-if="windAsk"
                class="analysis-wind-ask"
                role="alertdialog"
                :aria-label="`Read ${vector.what} for the ${vector.marks}?`"
                data-wind-ask
              >
                <p>
                  <strong>{{ vector.ask }}</strong>
                  <span
                    >Its eastward and northward components:
                    {{ windAsk.size ?? "a large read" }}.</span
                  >
                </p>
                <div class="analysis-wind-ask-actions">
                  <button
                    type="button"
                    class="analysis-tool"
                    @click="analysis.setWind(plot.id, false)"
                  >
                    Not now
                  </button>
                  <button
                    type="button"
                    class="analysis-tool analysis-primary"
                    @click="analysis.approveCompanions(plot.id, 'wind')"
                  >
                    Read{{ windAsk.size ? ` ${windAsk.size}` : "" }}
                  </button>
                </div>
              </div>
              <button
                type="button"
                class="analysis-toggle analysis-wind-more"
                aria-haspopup="menu"
                :aria-expanded="windMenuOpen"
                :aria-label="`Choose the ${vector.components.toLowerCase()}`"
                :title="`Choose the ${vector.components.toLowerCase()}`"
                @click="windMenuOpen = !windMenuOpen"
              >
                <i class="fa-solid fa-caret-down" aria-hidden="true"></i>
              </button>
              <div
                v-if="windMenuOpen"
                class="analysis-popover analysis-wind-menu"
                role="menu"
                :aria-label="vector.components"
              >
                <span class="analysis-wind-heading">{{
                  vector.components
                }}</span>
                <button
                  type="button"
                  role="menuitemradio"
                  :aria-checked="!plot.windChoice && Boolean(windChoice.pair)"
                  :disabled="!windChoice.pair"
                  @click="chooseWind(undefined)"
                >
                  Automatic
                  <span class="analysis-wind-hint">{{
                    windChoice.pair ? autoWindLabel : "(none found by name)"
                  }}</span>
                </button>
                <button
                  v-for="pair in windChoice.pairs"
                  :key="`${pair.u}|${pair.v}`"
                  type="button"
                  role="menuitemradio"
                  :aria-checked="
                    plot.windChoice?.u === pair.u &&
                    plot.windChoice?.v === pair.v
                  "
                  @click="chooseWind(pair)"
                >
                  {{ pair.u }} / {{ pair.v }}
                </button>
                <div class="analysis-wind-other">
                  <span class="analysis-wind-heading">Other components</span>
                  <label>
                    East (u)
                    <select v-model="otherU">
                      <option value="" disabled>Choose…</option>
                      <option
                        v-for="name in windVariables"
                        :key="name"
                        :value="name"
                      >
                        {{ name }}
                      </option>
                    </select>
                  </label>
                  <label>
                    North (v)
                    <select v-model="otherV">
                      <option value="" disabled>Choose…</option>
                      <option
                        v-for="name in windVariables"
                        :key="name"
                        :value="name"
                      >
                        {{ name }}
                      </option>
                    </select>
                  </label>
                  <button
                    type="button"
                    class="analysis-tool"
                    :disabled="!otherU || !otherV || otherU === otherV"
                    @click="chooseWind({ u: otherU, v: otherV })"
                  >
                    Use these
                  </button>
                </div>
              </div>
            </div>
          </Teleport>

          <div
            v-show="placement.more.length"
            ref="moreHost"
            class="analysis-more"
            data-more
          >
            <button
              type="button"
              class="analysis-toggle analysis-more-button"
              aria-haspopup="true"
              aria-label="More analysis"
              :aria-expanded="moreOpen"
              title="More analysis: tools used less often"
              :class="{ active: moreActive, compact: moreCompact }"
              @click="moreOpen = !moreOpen"
            >
              <i class="fa-solid fa-ellipsis" aria-hidden="true"></i
              ><span v-if="!moreCompact">More</span
              ><span
                v-if="moreBusy"
                class="analysis-wind-busy"
                aria-label="(reading)"
              ></span
              ><span
                v-if="moreActive && !moreBusy"
                class="analysis-dot"
                aria-label="(in use)"
                >•</span
              >
              <i
                v-if="!moreCompact"
                class="fa-solid fa-caret-down"
                aria-hidden="true"
              ></i>
            </button>
            <div
              v-show="moreOpen"
              :id="moreId"
              ref="morePanel"
              class="analysis-popover analysis-more-panel"
              :style="{ left: `${moreShift}px` }"
              role="group"
              :aria-label="`${plot.label} more analysis`"
              @keydown.esc.stop="closeMore"
            ></div>
          </div>
        </div>

        <PlotExportMenu
          class="analysis-export"
          :compact="narrow"
          :disabled="!result || nothingRead || drawingFigure"
          :chart-values="Boolean(spec || shownFigure)"
          :check-size="checkPngSize"
          :room="menuRoom"
          @export="exportAs"
        />
      </nav>

      <div class="analysis-body">
        <div v-if="table" class="analysis-table">
          <p
            v-if="table.total > TABLE_ROWS || result?.partial"
            class="analysis-table-note"
          >
            <template v-if="table.total > TABLE_ROWS">
              Showing the first {{ TABLE_ROWS }} of
              {{ table.total.toLocaleString("en-US") }} requested rows.
            </template>
            {{
              result?.partial
                ? "The computed-values CSV includes all requested rows and marks unread rows as “not read”."
                : "The computed-values CSV includes all rows."
            }}
          </p>
          <table>
            <thead>
              <tr>
                <th
                  v-for="(h, c) in table.columns"
                  :key="c"
                  scope="col"
                  :class="{ num: table.numeric[c] }"
                >
                  {{ h }}
                </th>
              </tr>
            </thead>
            <tbody ref="tableBody">
              <tr
                v-for="(row, r) in table.rows"
                :key="r"
                :aria-current="
                  atMapRows && r >= atMapRows.first && r <= atMapRows.last
                    ? 'date'
                    : undefined
                "
                :class="{
                  'at-map':
                    atMapRows && r >= atMapRows.first && r <= atMapRows.last,
                  pickable: heatRowOf(r) !== undefined,
                  picked:
                    heatRowOf(r) !== undefined && heatRowOf(r) === pickedRow,
                }"
                :title="
                  heatRowOf(r) !== undefined
                    ? 'Show this date as the trace under the chart'
                    : undefined
                "
                @click="pickDataRow(r)"
              >
                <td
                  v-for="(cell, c) in row"
                  :key="c"
                  :class="{ num: table.numeric[c], missing: cell === '—' }"
                >
                  {{ cell }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <template v-else-if="result && !nothingRead">
          <CanvasFigure
            v-if="figureDraw"
            ref="chart"
            :draw="figureDraw"
            :label="figureLabel"
            :probe="figureProbe"
            :press="figurePress"
          />
          <SeriesChart
            v-else-if="spec"
            ref="chart"
            :spec="spec"
            :map-time="mapTime"
            :map-row="mapRow"
            :map-level="mapLevelMark"
            :cursor="mapCursor"
            :marks="profileMarks"
            :kept-zoom="chartZoom"
            @hover-distance="hoverPath"
            @zoom="chartZoom = $event"
          />
          <div v-else-if="heat" class="analysis-heat-stack">
            <HeatmapCanvas
              ref="chart"
              class="analysis-heat-main"
              :spec="heat"
              :scale="colourScale"
              :map-time="mapTime"
              :picked="pickedRow"
              :cursor="mapCursor"
              :map-level="mapLevelMark"
              :line="heatLine"
              @pick="pickRow"
              @hover-distance="hoverPath"
              @notes="heatNotes = $event"
            />
            <div
              v-if="slice"
              class="analysis-slice"
              role="group"
              :aria-label="sliceTitle"
            >
              <div class="analysis-slice-title">
                <span :title="sliceTitle">{{ sliceTitle }}</span>
                <button
                  type="button"
                  class="analysis-icon"
                  :aria-label="`Hide the trace at ${sliceDate}`"
                  @click="pickedRow = undefined"
                >
                  <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
              </div>
              <SeriesChart
                ref="sliceChart"
                :spec="slice"
                :cursor="mapCursor"
                @hover-distance="hoverPath"
              />
            </div>
          </div>
          <SectionCanvas
            v-else-if="isCurtain"
            ref="chart"
            :result="result"
            :scale="colourScale"
            :vertical-title="verticalTitle(result.vertical)"
            :wind="windSpec"
            :cursor="mapCursor"
            :along-latitude="plot.pathAxis === 'latitude' && pathAxisOffered"
            :map-level="mapLevelMark"
            :value-title="
              axisQuantity(variableName, result.longName, result.units)
            "
            @hover-distance="hoverPath"
          />
        </template>
        <!-- A failure: what happened, why, and what can help (a retry
             only where it can). -->
        <div
          v-else-if="plot.status === PLOT_STATUS.ERROR && failure"
          class="analysis-gate analysis-error-panel"
          role="alert"
          data-error
        >
          <div class="analysis-gate-card">
            <i
              class="fa-solid fa-circle-exclamation analysis-gate-icon analysis-error-icon"
              aria-hidden="true"
            ></i>
            <h3>{{ failure.title }}</h3>
            <p>{{ failure.why }}</p>
            <p class="analysis-error-detail" :title="plot.message">
              {{ plot.message }}
            </p>
            <div v-if="!plot.snapshot" class="analysis-gate-actions">
              <button
                v-for="action in failure.actions"
                :key="action"
                type="button"
                class="analysis-tool"
                :class="{
                  'analysis-primary': action === failure.actions[0],
                }"
                :data-error-action="action"
                @click="errorAction(action)"
              >
                <i
                  class="fa-solid"
                  :class="[ERROR_ACTIONS[action].icon]"
                  aria-hidden="true"
                ></i>
                {{ ERROR_ACTIONS[action].label }}
              </button>
            </div>
            <p v-if="errorNote" class="analysis-gate-why" role="status">
              {{ errorNote }}
            </p>
          </div>
        </div>
        <div
          v-else-if="plot.status === PLOT_STATUS.UNAVAILABLE"
          class="analysis-empty"
        >
          <p>{{ plot.message }}</p>
        </div>
        <!-- Before the first values: the stages, done and under way. -->
        <div v-else-if="busy" class="analysis-gate analysis-stages" data-stages>
          <div class="analysis-gate-card">
            <ol class="analysis-stage-list">
              <li
                v-for="stage in stages"
                :key="stage.name"
                :class="stage.state"
                :aria-current="stage.state === 'now' ? 'step' : undefined"
              >
                <span class="analysis-stage-mark" aria-hidden="true">
                  <i
                    v-if="stage.state === 'done'"
                    class="fa-solid fa-check"
                  ></i>
                  <span
                    v-else-if="stage.state === 'now'"
                    class="analysis-spinner"
                  ></span>
                </span>
                <span class="analysis-stage-text">
                  <span class="analysis-stage-name">{{ stage.name }}</span>
                  <span
                    v-if="stage.state === 'now'"
                    class="analysis-stage-detail"
                    >{{ stage.detail }}</span
                  >
                </span>
              </li>
            </ol>
            <!-- Notes in short (the whole text on hover and in Method);
                 Pause and Stop are in the bar below. -->
            <p
              v-for="note in gateNotes.slice(0, 2)"
              :key="note"
              class="analysis-busy-note"
              :title="note"
            >
              {{ note }}
            </p>
          </div>
        </div>
        <!-- A read that waits for the scientist: asked in the window,
             with its size and a clear Compute. -->
        <div
          v-if="plot.status === PLOT_STATUS.CONFIRM && plot.estimate"
          class="analysis-gate"
          role="group"
          aria-label="This plot waits for Compute"
          data-gate
          @click.self="analysis.cancel(plot.id)"
          @keydown.esc.stop="analysis.cancel(plot.id)"
        >
          <div class="analysis-gate-card">
            <!-- Not now: nothing is read; a chart already shown stays (also
                 by a click beside the card, or Escape). -->
            <button
              type="button"
              class="analysis-gate-close"
              aria-label="Cancel"
              :title="
                plot.result
                  ? 'Cancel: do not read; keep the chart shown now'
                  : 'Cancel: do not read anything for this plot'
              "
              data-gate-cancel
              @click="analysis.cancel(plot.id)"
            >
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
            <i
              class="fa-solid analysis-gate-icon"
              :class="
                plot.estimate.needsConfirmation
                  ? 'fa-location-crosshairs'
                  : 'fa-database'
              "
              aria-hidden="true"
            ></i>
            <h3>
              {{
                plot.estimate.needsConfirmation
                  ? "First, locate the cells"
                  : "A large read: compute when ready"
              }}
            </h3>
            <p v-if="plot.estimate.needsConfirmation">
              {{ plot.estimate.notes[0] }}
            </p>
            <p v-else>
              About
              <strong>{{ bytesText(plot.estimate.decodedBytes) }}</strong> to
              decode from
              {{ plot.estimate.chunks.toLocaleString("en-US") }} stored chunk{{
                plot.estimate.chunks === 1 ? "" : "s"
              }}<template v-if="plot.estimate.geometryReads">
                and
                {{ plot.estimate.geometryReads.toLocaleString("en-US") }}
                coordinate chunks</template
              >. Nothing is read until you choose.
            </p>
            <p
              v-if="
                !plot.estimate.needsConfirmation && plot.estimate.chunks === 1
              "
              class="analysis-gate-why"
            >
              This is the smallest read: the source stores whole chunks (many
              dates of the whole map each), and fewer dates would read the same
              chunk.
            </p>
            <ul
              v-if="
                plot.estimate.notes.length >
                (plot.estimate.needsConfirmation ? 1 : 0)
              "
              class="analysis-gate-notes"
            >
              <li
                v-for="note in gateNotes.slice(
                  plot.estimate.needsConfirmation ? 1 : 0,
                  4
                )"
                :key="note"
              >
                {{ note }}
              </li>
            </ul>
            <p
              v-if="
                analysis.computeMode === 'auto' &&
                !plot.estimate.needsConfirmation
              "
              class="analysis-gate-why"
            >
              Automatic starts reads up to {{ autoCap }}; this one is larger, so
              it asks.
            </p>
            <p v-if="pending.length" class="analysis-gate-pending">
              Edits are pending: apply or cancel them in Settings first.
            </p>
            <div class="analysis-gate-actions">
              <!-- Fewer dates read less only when the read spans chunks. -->
              <button
                v-if="
                  TIME_RANGE_KINDS.includes(plot.kind) &&
                  plot.draft.time &&
                  plot.estimate.chunks > 1
                "
                type="button"
                class="analysis-tool"
                @click="changeDates"
              >
                <i class="fa-regular fa-calendar" aria-hidden="true"></i>
                Change dates
              </button>
              <button
                type="button"
                class="analysis-tool analysis-primary analysis-gate-go"
                :aria-label="
                  plot.estimate.needsConfirmation ? 'Locate cells' : 'Compute'
                "
                :disabled="pending.length > 0"
                :title="
                  pending.length
                    ? 'Apply or cancel the pending edits in Settings first'
                    : undefined
                "
                @click="analysis.confirm(plot.id)"
              >
                {{ plot.estimate.needsConfirmation ? "Locate cells" : "Compute"
                }}<span
                  v-if="!plot.estimate.needsConfirmation"
                  class="analysis-gate-size"
                  >{{ bytesText(plot.estimate.decodedBytes) }}</span
                >
              </button>
            </div>
            <ComputeModeSwitch class="analysis-gate-mode" />
          </div>
        </div>
        <p v-if="exportNote" class="analysis-error analysis-note">
          {{ exportNote }}
        </p>
        <!-- No wind or members found: nothing is drawn; the reason is in
             the Barbs or Members tooltip, not a red line over the chart. -->
      </div>

      <!-- A read beside the plot (wind, members, another variable): its own
           row, saying what it is for, with buttons that say what they do. -->
      <div
        v-if="companionStatus && !busy"
        class="analysis-companion analysis-companion-status"
        role="status"
      >
        <progress
          v-if="!companionStatus.read"
          class="analysis-progress-line"
          :value="companionStatus.progress?.done"
          :max="companionStatus.progress?.total"
          :aria-label="companionStatus.text"
        ></progress>
        <i
          v-if="
            ('failed' in companionStatus && companionStatus.failed) ||
            'stale' in companionStatus
          "
          class="fa-solid fa-triangle-exclamation analysis-companion-warn"
          aria-hidden="true"
        ></i>
        <PlotIcon
          v-else
          :name="COMPANION_ICONS[companionStatus.purpose]"
          :size="14"
          class="analysis-companion-icon"
        />
        <span class="analysis-companion-text">{{ companionStatus.text }}</span>
        <button
          v-if="companionStatus.read"
          type="button"
          class="analysis-tool analysis-primary analysis-companion-read"
          :aria-label="`Read${companionStatus.size ? ` ${companionStatus.size}` : ''} for ${COMPANION_NAMES[companionStatus.purpose]}`"
          @click="companionStatus.read()"
        >
          {{
            "label" in companionStatus
              ? companionStatus.label
              : `Read${companionStatus.size ? ` ${companionStatus.size}` : ""}`
          }}
        </button>
        <button
          type="button"
          class="analysis-tool"
          @click="companionStatus.stop()"
        >
          {{
            companionStatus.read
              ? COMPANION_OFF[companionStatus.purpose]
              : "failed" in companionStatus && companionStatus.failed
                ? "OK"
                : "Stop"
          }}
        </button>
      </div>

      <!-- One bar under the figure, in Chart and Data alike: what is being
           read (or was), its actions, and the view tabs. Progress runs
           along its top edge. -->
      <footer class="analysis-footer" :class="{ warn: bar.warn }">
        <!-- Indeterminate until the first count arrives. -->
        <progress
          v-if="bar.line"
          class="analysis-progress-line"
          :value="bar.progress?.done"
          :max="bar.progress?.total"
          :aria-label="`${bar.lead}${bar.main}`.replace(/^ — /, '')"
        ></progress>
        <div
          class="analysis-status"
          role="status"
          data-read-status
          :data-preview="bar.mode === 'preview' ? '' : undefined"
        >
          <span
            v-if="bar.main || bar.lead"
            class="analysis-status-main"
            :class="{
              'analysis-warn-text': bar.warn,
              'analysis-preview-text': bar.mode === 'preview',
            }"
            :title="bar.mainTitle"
            ><span
              v-if="bar.ring"
              class="analysis-map-ring"
              aria-hidden="true"
            ></span
            ><strong v-if="bar.lead">{{ bar.lead }}</strong
            >{{ bar.main }}</span
          >
          <span class="analysis-status-sub">
            <!-- First dates: where they lie, and what reading more costs. -->
            <template v-if="bar.mode === 'preview' && preview">
              <span
                class="analysis-preview-strip"
                :title="`${preview.range} of the dates asked for`"
                aria-hidden="true"
                ><span
                  :style="{
                    left: `${preview.left}%`,
                    width: `${preview.width}%`,
                  }"
                ></span
              ></span>
            </template>
            <span v-if="bar.through" class="analysis-through"
              ><span class="analysis-wide-only">through {{ bar.through }}</span
              ><span class="analysis-narrow-only"
                >to {{ bar.throughDay }}</span
              ></span
            >
            <span
              v-if="bar.parts"
              data-parts
              :class="{ 'analysis-wide-only': bar.mode === 'reading' }"
              >{{ bar.parts }}</span
            >
            <span
              v-if="
                (readFacts.fetched || readFacts.decoded) &&
                bar.mode !== 'preview'
              "
              class="analysis-read-facts"
              :class="{ 'analysis-wide-only': bar.mode === 'reading' }"
              :title="workDetail"
              >{{
                [readFacts.fetched, readFacts.decoded]
                  .filter(Boolean)
                  .join(", ")
              }}</span
            >
            <span v-if="(heat || isCurtain) && colourScale.from === 'own'">{{
              colourScale.note
            }}</span>
            <!-- While reading, the date and part come first (Method has the
                 details). -->
            <button
              v-if="
                result &&
                result.counters.chunkReads &&
                (bar.mode === 'done' || bar.mode === 'stopped')
              "
              type="button"
              class="analysis-link"
              @click="openReadDetails"
            >
              Read details
            </button>
            <button
              v-if="pending.length && result && !busy"
              type="button"
              class="analysis-link analysis-pending-link"
              title="Open Settings to apply or cancel them"
              @click="toggleSettings"
            >
              Edits pending
            </button>
          </span>
        </div>

        <!-- At the right: what to read next (more dates, all), or Continue
             after a stop; Chart and Data stay at the left. -->
        <div class="analysis-status-actions">
          <template v-if="bar.mode === 'preview' && preview && !busy">
            <!-- Too many values for one plot: All is off; Read details
               says why. -->
            <button
              v-if="preview.tooMany"
              type="button"
              class="analysis-tool analysis-read-all analysis-read-all-off"
              aria-label="Read all: not possible here; open Read details"
              :title="preview.tooMany"
              @click="openReadDetails"
            >
              <i class="fa-solid fa-ban" aria-hidden="true"></i>
              <span>All</span
              ><span class="analysis-cost">{{
                plot.preview?.refused ? "not at once" : "too many values"
              }}</span>
            </button>
            <button
              v-else
              type="button"
              class="analysis-tool analysis-read-all"
              :class="{ heavy: (preview.allBytes ?? 0) > 2 ** 30 }"
              aria-label="Read all"
              :title="preview.allTitle"
              @click="analysis.readAll(plot.id)"
            >
              <i
                class="fa-solid"
                :class="
                  (preview.allBytes ?? 0) > 2 ** 30
                    ? 'fa-triangle-exclamation'
                    : 'fa-angles-right'
                "
                aria-hidden="true"
              ></i>
              <span class="analysis-action-label"
                >All<span class="analysis-wide-only">
                  {{ preview.total.toLocaleString("en-US") }} dates</span
                ></span
              ><span v-if="preview.allCost" class="analysis-cost">{{
                preview.allCost.replace("≈ ", "")
              }}</span>
            </button>
            <!-- More of them (what you get, then its size): the main next
               step, at the far right (review of 23 Nov). -->
            <button
              v-if="preview.nextDates > 0"
              type="button"
              class="analysis-tool analysis-extend"
              aria-label="Extend date range"
              :title="preview.extendTitle"
              @click="analysis.extendDates(plot.id)"
            >
              <i class="fa-solid fa-forward" aria-hidden="true"></i>
              <span
                >+{{ preview.nextDates.toLocaleString("en-US") }} dates</span
              >
              <span v-if="preview.nextCost" class="analysis-cost">{{
                preview.nextCost.replace("≈ ", "")
              }}</span>
            </button>
          </template>
          <template v-if="busy">
            <button
              v-if="plot.status === PLOT_STATUS.RUNNING && plot.progress"
              type="button"
              class="analysis-round"
              :aria-label="plot.paused ? 'Resume' : 'Pause'"
              :title="plot.paused ? 'Resume reading' : 'Pause reading'"
              @click="analysis.setPaused(plot.id, !plot.paused)"
            >
              <i
                class="fa-solid"
                :class="plot.paused ? 'fa-play' : 'fa-pause'"
                aria-hidden="true"
              ></i>
            </button>
            <button
              type="button"
              class="analysis-round"
              :aria-label="streams ? 'Stop' : 'Cancel'"
              :title="
                streams ? 'Stop reading; keep what has been read' : 'Cancel'
              "
              @click="stopReading"
            >
              <i class="fa-solid fa-stop" aria-hidden="true"></i>
            </button>
          </template>
          <!-- Stopped: read on from where it stopped, keeping the rest. -->
          <button
            v-else-if="continuing"
            type="button"
            class="analysis-tool analysis-primary analysis-continue"
            :aria-label="
              plot.status === PLOT_STATUS.ERROR
                ? 'Retry the dates not read'
                : 'Continue reading'
            "
            :title="continuing"
            @click="analysis.continueRead(plot.id)"
          >
            <i
              class="fa-solid"
              :class="
                plot.status === PLOT_STATUS.ERROR
                  ? 'fa-rotate-right'
                  : 'fa-play'
              "
              aria-hidden="true"
            ></i>
            <span class="analysis-action-label">{{
              plot.status === PLOT_STATUS.ERROR ? "Retry rest" : "Continue"
            }}</span>
          </button>
        </div>

        <div
          ref="tabsBox"
          class="analysis-views"
          role="tablist"
          :aria-label="`${plot.label} view`"
          @keydown="tabKeys"
        >
          <button
            v-for="tab in tabs"
            :key="tab.id"
            type="button"
            role="tab"
            :class="{ pulse: pulsing === tab.id }"
            :aria-selected="activeTab === tab.id"
            :tabindex="activeTab === tab.id ? 0 : -1"
            :disabled="tab.id === 'data' && (!result || nothingRead)"
            :title="tab.label"
            @click="selectTab(tab.id)"
          >
            <PlotIcon :name="tab.icon" :size="13" />
            <span class="analysis-tab-label">{{ tab.label }}</span>
          </button>
        </div>
      </footer>

      <WindowDialog
        v-if="dialog === 'method' && result"
        :title="`Method — ${plot.label}`"
        icon="method"
        :subtitle="title"
        @close="closeDialog()"
      >
        <PlotMethod
          ref="methodBody"
          :sections="method"
          :diagnostics="diagnostics"
          :initial="methodFocus"
          :heading="`${plot.label} ${title} — ${subtitle}`"
          @action="readAction"
        />
        <template #footer>
          <span class="analysis-dialog-note"
            >Read-only. Change the selection in Settings.</span
          >
          <span class="analysis-spacer"></span>
          <button
            type="button"
            class="analysis-tool"
            :class="{ 'analysis-copied': methodBody?.copied }"
            aria-live="polite"
            @click="methodBody?.copy()"
          >
            <i
              :class="
                methodBody?.copied === 'Copied'
                  ? 'fa-solid fa-check'
                  : 'fa-regular fa-copy'
              "
              aria-hidden="true"
            ></i>
            {{ methodBody?.copied || "Copy as text" }}
          </button>
          <button
            type="button"
            class="analysis-tool analysis-primary"
            @click="closeDialog()"
          >
            Done
          </button>
        </template>
      </WindowDialog>
      <WindowDialog
        v-if="dialog === 'settings'"
        title="Settings"
        icon="settings"
        :subtitle="`${plot.label} — ${PLOT_KIND_NAMES[plot.kind]}`"
        @close="closeDialog()"
      >
        <PlotSettings
          :plot="plot"
          @redraw="redraw"
          @edit="analysis.startShapeEdit(plot.id)"
          @country="analysis.chooseCountryFor(plot.id)"
        />
        <template #footer>
          <span
            class="analysis-dialog-note"
            :class="{ pending: pending.length }"
            >{{
              pending.length
                ? `Pending: ${pending.join(", ")}`
                : displayChanged.length
                  ? `Shown now: ${displayChanged.join(", ")}`
                  : "No changes yet"
            }}</span
          >
          <span class="analysis-spacer"></span>
          <button
            type="button"
            class="analysis-tool"
            @click="closeDialog('cancel')"
          >
            Cancel
          </button>
          <button
            type="button"
            class="button is-small is-link"
            :disabled="!pending.length && !displayChanged.length"
            @click="closeDialog('apply')"
          >
            Apply
          </button>
        </template>
      </WindowDialog>
    </div>

    <!-- Every side and corner resizes (the far side stays put). -->
    <div
      v-for="edge in RESIZE_EDGES"
      :key="edge"
      class="analysis-resize"
      :class="[`analysis-resize-${edge}`]"
      :data-resize="edge"
      aria-hidden="true"
      @pointerdown="startGesture($event, edge)"
    ></div>
  </section>
</template>

<style scoped>
/* ---------- The window ---------- */
.analysis-window {
  position: absolute;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-size: 0.8rem;
  border-radius: 10px;
  /* Its own width decides compact toolbars (its size is always set). */
  container: plot-window / inline-size;
}
.analysis-window.focused {
  border-color: var(--plot-accent);
  box-shadow:
    0 0 0 1px var(--plot-accent),
    0 16px 36px rgba(15, 23, 42, 0.35);
}
:focus-visible {
  outline: 2px solid var(--plot-accent);
  outline-offset: 1px;
}
.analysis-spacer {
  flex: 1;
}

/* ---------- Title: ID, quantity (units lighter), chart and place ---------- */
/* Title line: ID, title, Method and Settings, window buttons; the chart
   and place below, the whole width (under the buttons too). */
.analysis-title {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  column-gap: 9px;
  padding: 8px 6px 5px 12px;
  cursor: move;
  user-select: none;
  touch-action: none;
}
/* A sheet on a narrow map cannot be moved. */
.analysis-title.sheet {
  cursor: default;
}
.analysis-id {
  flex: 0 0 auto;
  margin-top: 1px;
  padding: 1px 6px;
  font-size: 0.7rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  color: var(--plot-accent);
  background: color-mix(in srgb, var(--plot-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--plot-accent) 45%, transparent);
  border-radius: 5px;
  cursor: help;
}
.analysis-heading {
  display: contents;
  line-height: 1.3;
}
.analysis-heading-title {
  grid-area: 1 / 2;
  line-height: 1.3;
}
.analysis-heading-row {
  grid-area: 2 / 2 / auto / -1;
  line-height: 1.3;
}
.analysis-meta {
  grid-area: 1 / 3;
}
.analysis-controls {
  grid-area: 1 / 4;
}
.analysis-id {
  grid-area: 1 / 1;
}
.analysis-heading-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.analysis-heading-name {
  font-weight: 650;
  font-size: 0.86rem;
}
.analysis-heading-units {
  margin-left: 2px;
  color: var(--plot-muted);
  font-size: 0.78rem;
  font-weight: 500;
}
/* Second line: the chart and place. */
.analysis-heading-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 3px;
}
/* Up to two lines in a narrow window rather than cut at the first
 * (24 Nov: labels not readable). */
.analysis-heading-sub {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--plot-muted);
  font-size: 0.72rem;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.analysis-controls {
  flex: 0 0 auto;
  display: flex;
  gap: 1px;
}
.analysis-icon {
  display: inline-grid;
  place-items: center;
  min-width: 24px;
  min-height: 24px;
  padding: 0 4px;
  font: inherit;
  font-size: 0.72rem;
  color: var(--plot-muted);
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}
.analysis-icon:hover {
  color: var(--plot-fg);
  background: var(--plot-hover);
}
.analysis-icon.inert {
  opacity: 0.45;
  cursor: default;
}
.analysis-icon.inert:hover {
  background: none;
}
.analysis-close:hover {
  color: var(--plot-danger);
  background: color-mix(in srgb, var(--plot-danger) 12%, transparent);
}
/* Touch: buttons a finger hits easily without looking heavy: 36 px drawn,
   rounded, icons kept small. */
/* Touch: one slim scale: 32 px drawn for the window's buttons, 28 px for the
   read actions in the footer. */
.analysis-window.coarse .analysis-icon,
.analysis-window.coarse .analysis-meta-button,
.analysis-window.coarse .analysis-toggle,
.analysis-window.coarse .analysis-views button {
  min-width: 32px;
  min-height: 32px;
}
.analysis-window.coarse .analysis-tool {
  min-height: 30px;
  padding-inline: 10px;
}
.analysis-window.coarse .analysis-status-actions > .analysis-tool {
  min-height: 28px;
  height: 28px;
}
/* The Method | Settings group grows with its touch-sized buttons (at a
   fixed 24 px it clipped them: icons cut, taps landing outside). */
.analysis-window.coarse .analysis-meta {
  height: auto;
}
.analysis-confirm-layer {
  position: absolute;
  inset: 0;
  z-index: 8;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
}
.analysis-confirm-scrim {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: rgba(2, 6, 23, 0.55);
  backdrop-filter: blur(2px);
}
.analysis-confirm {
  position: relative;
  width: min(360px, 100%);
  padding: 18px 18px 14px;
  border: 1px solid var(--plot-border);
  border-radius: 10px;
  background: var(--plot-bg);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.3);
  color: var(--plot-fg);
  text-align: center;
}
.analysis-confirm-icon {
  font-size: 1.1rem;
  color: var(--plot-warn, #d97706);
}
.analysis-confirm h3 {
  margin: 6px 0 4px;
  font-size: 0.9rem;
  font-weight: 650;
}
.analysis-confirm p {
  margin: 0 0 14px;
  color: var(--plot-muted);
  font-size: 0.78rem;
  line-height: 1.45;
}
.analysis-confirm-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
}
@media (pointer: coarse) {
  .analysis-confirm-actions > * {
    min-height: 44px;
    flex: 1;
  }
}

/* ---------- Stage: toolbar, figure, status, footer (dialogs cover it) ---------- */
.analysis-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* Above the figure: the chart's tools at the left, Export at the right. */
.analysis-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 12px;
  border-block: 1px solid var(--plot-border);
  background: color-mix(in srgb, var(--plot-raised) 55%, transparent);
}
/* Method and Settings on the title line, before the window's buttons:
   quiet text with small icons, a hairline between them and another
   before Minimize. The margin keeps a gap the title never fills (it
   shortens with an ellipsis instead). */
.analysis-meta {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 24px;
  margin-left: 16px;
  padding-right: 6px;
  border-right: 1px solid var(--plot-border);
}
.analysis-meta-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  font: inherit;
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--plot-muted);
  background: none;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.analysis-meta-button + .analysis-meta-button {
  position: relative;
  margin-left: 1px;
}
.analysis-meta-button + .analysis-meta-button::before {
  content: "";
  position: absolute;
  left: -1px;
  top: 6px;
  bottom: 6px;
  border-left: 1px solid var(--plot-border);
}
.analysis-meta-button:hover:not(:disabled) {
  color: var(--plot-fg);
}
.analysis-meta-button:hover:not(:disabled) {
  background: var(--plot-hover);
}
.analysis-meta-button:hover::before,
.analysis-meta-button:hover + .analysis-meta-button::before {
  opacity: 0;
}
.analysis-meta-button[aria-expanded="true"] {
  color: var(--plot-accent);
  background: color-mix(in srgb, var(--plot-accent) 12%, transparent);
}
.analysis-meta-button:disabled {
  color: var(--plot-muted);
  cursor: default;
}
.analysis-meta-button:focus-visible {
  outline-offset: -2px;
}
.analysis-dot {
  color: var(--plot-pending);
  margin-left: -2px;
  font-size: 1rem;
  line-height: 0;
}
.analysis-chart-controls {
  flex: 1;
  display: flex;
  /* One line, always: what does not fit goes under More. */
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.analysis-chart-controls > * {
  flex-shrink: 0;
}
/* The heatmap's own pickers never move under More: in a window too narrow
   for them they give way (a shorter slider, a shortened choice) rather than
   run under Export. */
.analysis-chart-controls > .analysis-trace-picker,
.analysis-chart-controls > .analysis-vline {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
}
.analysis-chart-controls > .analysis-vline select {
  min-width: 3em;
  flex: 0 1 auto;
  text-overflow: ellipsis;
}
.analysis-export {
  flex: 0 0 auto;
  margin-left: auto;
}
.analysis-follow-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
/* More analysis: the less used tools, and those the line has no room for. */
.analysis-more {
  position: relative;
}
.analysis-more-button {
  border-color: transparent;
  color: var(--plot-fg);
}
.analysis-more-button .fa-caret-down {
  font-size: 0.65rem;
  opacity: 0.7;
}
.analysis-more-button.compact {
  justify-content: center;
  min-width: 30px;
  padding: 0 8px;
}
.analysis-more-button.active {
  color: var(--plot-accent);
}
.analysis-popover.analysis-more-panel {
  left: 0;
  /* Never wider than the window (placeMore keeps it inside). */
  max-width: calc(100cqw - 16px);
  min-width: 270px;
  gap: 6px;
  padding: 10px 12px 12px;
}
.analysis-more-panel::before {
  content: "More analysis";
  padding: 0 2px 4px;
  color: var(--plot-muted);
  font-size: 0.64rem;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.analysis-more-panel > .analysis-field,
.analysis-more-panel > .analysis-toggle,
.analysis-more-panel > .analysis-wind-group,
.analysis-more-panel > .analysis-follow-group {
  width: 100%;
}
.analysis-more-panel > .analysis-field {
  justify-content: space-between;
  height: 32px;
  padding: 0 6px 0 12px;
}
.analysis-more-panel > .analysis-toggle,
.analysis-more-panel .analysis-wind-group .analysis-wind {
  height: 32px;
  padding: 0 12px;
}
.analysis-more-panel .analysis-wind-group .analysis-wind {
  flex: 1;
}
.analysis-more-panel .analysis-wind-menu {
  position: static;
  margin-top: 4px;
  box-shadow: none;
}
.analysis-more-panel .analysis-wind-label {
  display: inline;
}
.analysis-more-panel .analysis-wind-group {
  flex-wrap: wrap;
}
@container plot-window (max-width: 560px) {
  .analysis-tab-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .analysis-views [aria-selected="true"] .analysis-tab-label {
    position: static;
    width: auto;
    height: auto;
    clip-path: none;
  }
}
/* While reading, a small window keeps the dates, their share and the day
   reached; the request part and bytes are in Read diagnostics. */
.analysis-narrow-only {
  display: none;
}
@container plot-window (max-width: 560px) {
  .analysis-wide-only {
    display: none;
  }
  .analysis-narrow-only {
    display: inline;
  }
}
@container plot-window (max-width: 420px) {
  .analysis-chart-controls .analysis-wind-label,
  .analysis-meta-button span {
    display: none;
  }
}
/* A small window (24 Nov): Method and Settings as two plain icons, no
   outline and no hairline between them; the one before Minimize stays. */
@container plot-window (max-width: 420px) {
  .analysis-meta {
    gap: 2px;
    padding-right: 6px;
  }
  .analysis-meta-button {
    justify-content: center;
    width: 26px;
    padding: 0;
  }
  .analysis-meta-button + .analysis-meta-button {
    margin-left: 0;
  }
  .analysis-meta-button + .analysis-meta-button::before {
    display: none;
  }
  .analysis-window.coarse .analysis-meta-button {
    width: 32px;
  }
}

/* A labelled field: its name, then its control, in one quiet pill. */
.analysis-field {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 2px 0 8px;
  font-size: 0.74rem;
  color: var(--plot-fg);
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  white-space: nowrap;
}
.analysis-field-label {
  color: var(--plot-muted);
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.03em;
}
.analysis-field-units {
  color: var(--plot-muted);
  padding-right: 6px;
}
.analysis-share-above {
  color: var(--plot-accent);
}
.analysis-field select {
  /* As wide as the value shown, not the longest choice. */
  field-sizing: content;
  max-width: 150px;
  height: 22px;
  padding: 0 2px;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
.analysis-field select:hover {
  background: var(--plot-hover);
}
/* One outline: the field's own, lit when its choice has focus (the
   browser's ring drew a second box inside it). */
.analysis-field select:focus {
  outline: none;
}
.analysis-field:focus-within {
  border-color: var(--plot-accent);
  box-shadow: 0 0 0 1px var(--plot-accent);
}
.analysis-field select option {
  color: var(--plot-fg);
  background: var(--plot-bg);
}
/* A phone: the Time field without its word (the view's name says it),
   a narrower number field, so the line keeps Export (25 Nov). */
.analysis-window.phone .analysis-time-view .analysis-field-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.analysis-window.phone .analysis-threshold {
  width: 3.6em;
}
.analysis-window.phone .analysis-time-view select {
  max-width: 8.5em;
  text-overflow: ellipsis;
}
.analysis-threshold {
  width: 4.5em;
  height: 20px;
  font: inherit;
  color: var(--plot-fg);
  background: var(--plot-raised);
  border: 1px solid var(--plot-border);
  border-radius: 4px;
  padding: 0 4px;
}
/* A one-click switch with its icon and label. */
.analysis-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  font: inherit;
  font-size: 0.74rem;
  color: var(--plot-fg);
  background: none;
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.analysis-toggle:hover {
  background: var(--plot-hover);
}
.analysis-toggle[aria-pressed="true"] {
  color: var(--plot-accent);
  background: color-mix(in srgb, var(--plot-accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--plot-accent) 60%, transparent);
}
.analysis-follow .fa-link {
  font-size: 0.66rem;
}
.analysis-wind-group {
  position: relative;
  display: inline-flex;
}
/* Barbs asking to read the wind: a dot on the button, a card under it. */
.analysis-wind-asks {
  width: 7px;
  height: 7px;
  margin-left: 4px;
  border-radius: 50%;
  background: var(--plot-accent);
}
.analysis-wind-ask {
  position: absolute;
  z-index: 6;
  top: calc(100% + 8px);
  left: 0;
  width: 240px;
  padding: 8px 10px;
  background: var(--plot-bg);
  color: var(--plot-fg);
  border: 1px solid var(--plot-border);
  border-top: 3px solid var(--plot-accent);
  border-radius: 6px;
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.18);
  font-size: 0.8rem;
  white-space: normal;
}
.analysis-wind-ask::before {
  content: "";
  position: absolute;
  top: -9px;
  left: 18px;
  border: 6px solid transparent;
  border-bottom-color: var(--plot-accent);
}
.analysis-wind-ask p {
  display: grid;
  gap: 2px;
  margin: 0 0 8px;
}
.analysis-wind-ask-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
/* Barbs and its caret read as one split button. */
.analysis-wind-group .analysis-wind {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.analysis-wind-more {
  margin-left: -1px;
  padding-inline: 5px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
.analysis-wind-more .fa-caret-down {
  font-size: 0.65rem;
}
/* A small spinner while the wind components are read. */
.analysis-wind-busy {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-left: 2px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: analysis-wind-spin 0.8s linear infinite;
}
@keyframes analysis-wind-spin {
  to {
    transform: rotate(360deg);
  }
}
.analysis-popover {
  position: absolute;
  top: calc(100% + 4px);
  z-index: 6;
  display: flex;
  flex-direction: column;
  padding: 4px 0;
  background: var(--plot-bg);
  color: var(--plot-fg);
  border: 1px solid var(--plot-border);
  border-radius: 8px;
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.28);
}
.analysis-popover button {
  text-align: left;
  padding: 5px 14px;
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}
.analysis-popover button:hover,
.analysis-popover button:focus-visible {
  background: var(--plot-hover);
}
.analysis-wind-menu {
  left: 0;
  min-width: 240px;
}
.analysis-wind-heading {
  padding: 4px 14px 2px;
  color: var(--plot-muted);
  font-size: 0.66rem;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.analysis-wind-menu [role="menuitemradio"][aria-checked="true"]::before {
  content: "✓ ";
  color: var(--plot-accent);
}
.analysis-wind-hint {
  color: var(--plot-muted);
}
.analysis-wind-other {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
  padding: 4px 14px 6px;
  border-top: 1px solid var(--plot-border);
}
.analysis-wind-other .analysis-wind-heading {
  padding: 2px 0;
}
.analysis-wind-other label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  color: var(--plot-muted);
}
.analysis-wind-other select {
  max-width: 130px;
  font: inherit;
  color: var(--plot-fg);
  background: var(--plot-bg);
  border: 1px solid var(--plot-border);
  border-radius: 4px;
}
.analysis-popover .analysis-wind-other button {
  align-self: flex-end;
  border: 1px solid var(--plot-border);
  border-radius: 5px;
  padding: 2px 10px;
}

/* ---------- Buttons in rows ---------- */
.analysis-tool {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 22px;
  padding: 0 8px;
  font: inherit;
  font-size: 0.74rem;
  color: var(--plot-fg);
  background: none;
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.analysis-tool:hover:not(:disabled) {
  background: var(--plot-hover);
}
.analysis-tool:disabled {
  color: var(--plot-muted);
  cursor: default;
}
.analysis-tool .fa-solid,
.analysis-tool .fa-regular {
  font-size: 0.62rem;
}
.analysis-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  font: inherit;
  font-size: 0.72rem;
  line-height: 1.6;
  color: var(--plot-muted);
  background: none;
  border: 1px solid var(--plot-border);
  border-radius: 999px;
}
button.analysis-chip {
  cursor: pointer;
}
.analysis-warn {
  color: var(--plot-warn);
  border-color: currentColor;
}
.analysis-pending-chip {
  color: var(--plot-pending);
  border-color: currentColor;
}
.analysis-error {
  color: var(--plot-danger);
}

/* ---------- Figure and table ---------- */
/* A figure keeps its least readable height; a window smaller than that
 * scrolls to its axis titles instead of cutting them off. */
.analysis-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 4px 12px 2px;
  display: flex;
  flex-direction: column;
}
.analysis-note {
  margin: 2px 0 0;
  font-size: 0.74rem;
}
.analysis-empty {
  margin: auto;
  max-width: 440px;
  padding: 16px;
  text-align: center;
  color: var(--plot-muted);
  overflow: auto;
}
.analysis-empty p {
  margin: 0 0 8px;
}
.analysis-error-icon {
  color: var(--plot-danger, #dc2626);
}
/* The message as the program said it: small, for a report. */
.analysis-error-detail {
  max-height: 3.2em;
  overflow: hidden;
  color: var(--plot-muted);
  font-family: ui-monospace, monospace;
  font-size: 0.66rem;
}
.analysis-error-panel .analysis-gate-actions {
  flex-wrap: wrap;
}
.analysis-busy-note {
  margin-top: 12px;
  text-align: left;
  font-size: 0.72rem;
}
.analysis-heat-stack {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}
/* Its own width (it never shrinks): squeezed, the slider ran past its
   outline and the date was hidden (23 Nov). */
.analysis-trace-picker {
  flex: none;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  font-size: 0.72rem;
  color: var(--plot-muted);
  border: 1px solid var(--plot-border);
  border-radius: 6px;
}
.analysis-trace-picker input {
  width: 80px;
  flex: 0 1 80px;
  min-width: 32px;
  margin: 0;
  accent-color: var(--plot-accent);
}
.analysis-trace-date.is-empty {
  color: var(--plot-muted);
}
.analysis-continue {
  height: 28px;
  gap: 6px;
  padding: 0 12px;
}
.analysis-continue .fa-play {
  font-size: 0.66rem;
}
.analysis-read-all-off {
  color: var(--plot-muted);
  border-style: dashed;
}
.analysis-read-all-off .fa-ban {
  font-size: 0.65rem;
}

.analysis-trace-date {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--plot-fg);
  font-variant-numeric: tabular-nums;
}
.analysis-heat-main {
  flex: 1 1 60%;
  min-height: 140px;
}
.analysis-slice {
  flex: 0 0 38%;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--plot-border);
}
.analysis-slice-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 4px;
  color: var(--plot-muted);
  font-size: 0.72rem;
}
.analysis-slice-title > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.analysis-slice > :last-child {
  flex: 1;
  min-height: 0;
}
.analysis-table {
  overflow: auto;
  flex: 1;
}
.analysis-table-note {
  color: var(--plot-muted);
  margin: 0 0 4px;
  font-size: 0.72rem;
}
.analysis-table table {
  border-collapse: collapse;
  width: 100%;
}
.analysis-table th {
  position: sticky;
  top: 0;
  background: var(--plot-bg);
  text-align: left;
  font-weight: 600;
  padding: 3px 8px;
  border-bottom: 1px solid var(--plot-border);
  white-space: nowrap;
}
.analysis-table td {
  padding: 1px 8px;
  white-space: nowrap;
}
.analysis-table tbody tr:nth-child(even) td {
  background: color-mix(in srgb, var(--plot-raised) 70%, transparent);
}
.analysis-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.analysis-table .missing {
  color: var(--plot-muted);
}
.analysis-table tr.pickable {
  cursor: pointer;
}
/* Any row under the pointer, lightly; the map's date, more (25 Nov). */
.analysis-table tbody tr:hover td {
  background: color-mix(in srgb, var(--plot-accent) 8%, transparent);
}
.analysis-table tr.at-map td {
  background: color-mix(in srgb, var(--plot-accent) 22%, transparent);
}
.analysis-table tr.at-map td:first-child {
  box-shadow: inset 3px 0 0 var(--plot-accent);
}
.analysis-table tr.pickable:hover td {
  background: var(--plot-hover);
}
.analysis-table tr.picked td {
  background: color-mix(in srgb, var(--plot-accent) 16%, transparent);
}

/* ---------- A read waiting for Compute: a card in the window ---------- */
.analysis-gate {
  scrollbar-width: thin;
  scrollbar-color: var(--plot-border) transparent;
  position: absolute;
  inset: 0;
  z-index: 2;
  display: grid;
  /* Centred while it fits; from the top (scrolling) when it does not. */
  place-items: safe center;
  overflow: auto;
  padding: 10px;
  container: gate / size;
  background: color-mix(in srgb, var(--plot-bg) 72%, transparent);
  backdrop-filter: blur(1px);
}
.analysis-gate-card {
  position: relative;
  max-width: 400px;
  padding: 12px 16px;
  text-align: center;
  background: var(--plot-bg);
  border: 1px solid var(--plot-border);
  border-radius: 10px;
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.22);
}
/* The card's own ✕ (Cancel), at its upper right. */
.analysis-gate-close {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--plot-muted);
  cursor: pointer;
}
.analysis-gate-close:hover {
  background: var(--plot-hover);
  color: var(--plot-fg);
}
.analysis-window.coarse .analysis-gate-close {
  width: 40px;
  height: 40px;
  top: 2px;
  right: 2px;
}
.analysis-gate-icon {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin-bottom: 4px;
  font-size: 0.95rem;
  color: var(--plot-accent);
  background: color-mix(in srgb, var(--plot-accent) 12%, transparent);
  border-radius: 50%;
}
.analysis-gate-card h3 {
  margin: 0 0 6px;
  font-size: 0.88rem;
  font-weight: 650;
}
.analysis-gate-card p {
  margin: 0 0 6px;
  color: var(--plot-muted);
  line-height: 1.45;
}
.analysis-gate-card strong {
  color: var(--plot-fg);
}
.analysis-gate-notes {
  margin: 4px 0 8px;
  padding: 0;
  list-style: none;
  font-size: 0.7rem;
  color: var(--plot-muted);
  text-align: left;
}
.analysis-gate-notes li + li {
  margin-top: 3px;
}
.analysis-gate-why {
  font-size: 0.72rem;
}
.analysis-gate-mode {
  margin-top: 10px;
}
/* A short window: no icon, tighter lines, so Compute and the mode both
   show without scrolling. */
@container gate (max-height: 250px) {
  .analysis-gate-card {
    padding: 8px 14px 10px;
  }
  .analysis-gate-icon {
    display: none;
  }
  .analysis-gate-card h3 {
    margin-bottom: 3px;
  }
  .analysis-gate-card p {
    margin-bottom: 3px;
    line-height: 1.35;
  }
  .analysis-gate-actions {
    margin-top: 6px;
  }
  .analysis-gate-mode {
    margin-top: 7px;
  }
}
.analysis-gate-pending {
  color: var(--plot-pending) !important;
  font-size: 0.72rem;
}
.analysis-gate-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
}
/* A short window: the icon beside the title, notes left out (Method has
   them). */
@container plot-window (max-width: 520px) {
  .analysis-gate-notes {
    display: none;
  }
}
.analysis-gate-actions .analysis-tool {
  height: 30px;
  padding: 0 12px;
}
.analysis-gate-go {
  font-size: 0.8rem;
}
.analysis-gate-size {
  margin-left: 8px;
  padding-left: 8px;
  border-left: 1px solid color-mix(in srgb, var(--plot-bg) 45%, transparent);
  font-weight: 500;
  opacity: 0.9;
}

/* The stages before a figure: a short list, the current one spinning. */
.analysis-stages {
  background: none;
  backdrop-filter: none;
}
.analysis-stages .analysis-gate-card {
  min-width: 260px;
  text-align: left;
}
.analysis-stage-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.analysis-stage-list li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 5px 0;
  color: var(--plot-muted);
}
.analysis-stage-list li.now {
  color: var(--plot-fg);
}
.analysis-stage-list li.next {
  opacity: 0.6;
}
.analysis-stage-mark {
  flex: 0 0 auto;
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  font-size: 0.6rem;
  border: 1.5px solid var(--plot-border);
  border-radius: 50%;
}
.analysis-stage-list li.done .analysis-stage-mark {
  color: var(--plot-bg);
  background: var(--plot-accent);
  border-color: var(--plot-accent);
}
.analysis-stage-list li.now .analysis-stage-mark {
  border-color: transparent;
}
.analysis-stages .analysis-busy-note {
  display: -webkit-box;
  margin: 8px 0 0;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  font-size: 0.7rem;
  color: var(--plot-muted);
}
.analysis-spinner {
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--plot-accent);
  border-right-color: transparent;
  border-radius: 50%;
  animation: analysis-wind-spin 0.8s linear infinite;
}
.analysis-stage-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.analysis-stage-name {
  font-weight: 600;
}
.analysis-stage-detail {
  font-size: 0.7rem;
  color: var(--plot-muted);
}
@media (prefers-reduced-motion: reduce) {
  .analysis-spinner {
    animation: none;
  }
}

/* ---------- A companion's read: its own row above the bar ---------- */
.analysis-companion {
  position: relative;
  display: flex;
  /* In a narrow window the buttons go under the text, not over it. */
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 6px 10px 6px 12px;
  font-size: 0.74rem;
  border-top: 1px solid var(--plot-border);
  background: color-mix(in srgb, var(--plot-accent) 7%, transparent);
}
.analysis-companion-icon {
  color: var(--plot-accent);
}
.analysis-companion-warn {
  font-size: 0.8rem;
  color: var(--plot-warn);
}
.analysis-companion-text {
  flex: 1 1 12em;
  min-width: 0;
}

/* ---------- The bottom bar: status and facts, actions, view tabs ---------- */
.analysis-footer {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  row-gap: 4px;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 5px 8px 6px 12px;
  border-top: 1px solid var(--plot-border);
}
/* Progress as a thin line along the bar's top edge. */
.analysis-progress-line {
  position: absolute;
  left: 0;
  right: 0;
  top: -1px;
  width: 100%;
  height: 2px;
  appearance: none;
  border: 0;
  background: transparent;
  accent-color: var(--plot-accent);
}
.analysis-progress-line::-webkit-progress-bar {
  background: transparent;
}
.analysis-progress-line::-webkit-progress-value {
  background: var(--plot-accent);
  transition: width 0.2s ease-out;
}
.analysis-progress-line::-moz-progress-bar {
  background: var(--plot-accent);
}
/* Before the first count: a short segment sweeping along the line. */
.analysis-progress-line:indeterminate {
  background: linear-gradient(
      90deg,
      transparent 0 35%,
      var(--plot-accent) 35% 65%,
      transparent 65% 100%
    )
    0 0 / 200% 100%;
  animation: analysis-sweep 1.4s linear infinite;
}
.analysis-progress-line:indeterminate::-webkit-progress-bar {
  background: transparent;
}
.analysis-progress-line:indeterminate::-moz-progress-bar {
  background: transparent;
}
@keyframes analysis-sweep {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -100% 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .analysis-progress-line:indeterminate {
    animation: none;
    background-position: 50% 0;
  }
}
.analysis-status {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
}
.analysis-status-main {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.analysis-status-main strong {
  font-weight: 600;
}
.analysis-warn-text {
  color: var(--plot-warn);
}
.analysis-status-sub {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  color: var(--plot-muted);
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
}
.analysis-status-sub:empty {
  display: none;
}
.analysis-status-sub > .analysis-link {
  flex-shrink: 0;
}
/* The last date and the part give way last; bytes first. */
.analysis-status-sub > [data-parts] {
  flex-shrink: 0.15;
}
.analysis-status-sub > * {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Parts apart by space alone: a bar glyph read as a 1 or an l. */
.analysis-status-sub > * + * {
  margin-left: 14px;
}
.analysis-map-ring {
  display: inline-block;
  vertical-align: 0;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border: 1.5px solid var(--plot-accent);
  border-radius: 50%;
}
.analysis-link {
  flex: 0 0 auto;
  padding: 0;
  font: inherit;
  color: var(--plot-accent);
  background: none;
  border: 0;
  cursor: pointer;
  white-space: nowrap;
}
.analysis-link:hover {
  text-decoration: underline;
}
.analysis-pending-link {
  color: var(--plot-pending);
}
.analysis-status-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
.analysis-status-actions:empty {
  display: none;
}
/* Pause, Resume and Stop: small round icon buttons. */
.analysis-round {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  font-size: 0.62rem;
  color: var(--plot-fg);
  background: var(--plot-raised);
  border: 1px solid var(--plot-border);
  border-radius: 50%;
  cursor: pointer;
}
.analysis-round:hover {
  color: var(--plot-accent);
  border-color: color-mix(in srgb, var(--plot-accent) 60%, transparent);
}
.analysis-window.coarse .analysis-round {
  width: 32px;
  height: 32px;
}
.analysis-primary {
  color: var(--plot-bg);
  background: var(--plot-accent);
  border-color: var(--plot-accent);
  font-weight: 600;
}
.analysis-primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--plot-accent) 85%, var(--plot-fg));
}
.analysis-tool.analysis-copied {
  color: var(--plot-accent);
  border-color: var(--plot-accent);
}
/* Not yet possible (pending edits): outlined and muted, still legible. */
.analysis-primary:disabled {
  color: var(--plot-muted);
  background: var(--plot-raised);
  border-color: var(--plot-border);
  cursor: not-allowed;
}
.analysis-primary:disabled .analysis-gate-size {
  border-left-color: var(--plot-border);
}
.analysis-preview-strip {
  position: relative;
  flex: 0 0 3rem;
  height: 4px;
  margin-right: 8px;
  border-radius: 2px;
  background: var(--plot-unread);
}
/* A narrow window keeps both prices whole: the strip (the range is in the
   line above it) gives way, never the buttons. */
@container plot-window (max-width: 480px) {
  .analysis-preview-strip {
    display: none;
  }
}
/* Narrower still (a phone, 320–350 px): the dates loaded and their actions take
   a row of their own above the tabs, and the actions wrap rather than run under
   them. */
@container plot-window (max-width: 560px) {
  .analysis-footer {
    flex-wrap: wrap;
    row-gap: 4px;
  }
  /* The status on a row of its own; under it Chart and Data at the left,
     the read actions at the right. */
  .analysis-status {
    order: -2;
    flex: 1 0 100%;
  }
  .analysis-status-actions {
    margin-left: auto;
  }
}
/* A narrow window: the view tabs by their icons, so Chart and Data share
   one row with the read actions (their names stay as labels). */
@container plot-window (max-width: 420px) {
  .analysis-views [aria-selected="true"] .analysis-tab-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
/* A small window: Continue by its icon (its name is its label). */
@container plot-window (max-width: 480px) {
  .analysis-action-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
.analysis-status-actions > .analysis-extend,
.analysis-status-actions > .analysis-read-all {
  flex-shrink: 0;
}
.analysis-preview-strip > span {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 2px;
  border-radius: 2px;
  background: var(--plot-accent);
}
/* The size an action will read, inside its button, after a hairline. */
.analysis-cost {
  margin-left: 2px;
  padding-left: 6px;
  border-left: 1px solid var(--plot-border);
  color: var(--plot-muted);
  font-size: 0.68rem;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
/* Extend: the main next step of first dates. */
.analysis-status-actions > .analysis-tool {
  flex-shrink: 0;
  height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
/* The size first, then the icon and what it reads: "960 MiB ⏩ +768 dates",
   "22.9 GiB ⚠ All". */
.analysis-status-actions > .analysis-tool > .analysis-cost {
  order: -1;
  margin: 0 1px 0 0;
  padding: 0 6px 0 0;
  border-left: 0;
  border-right: 1px solid var(--plot-border);
}
.analysis-status-actions > .analysis-tool::before {
  content: none !important;
}
.analysis-extend {
  height: 22px;
  font-weight: 600;
  color: var(--plot-accent);
  border-color: color-mix(in srgb, var(--plot-accent) 55%, transparent);
  background: color-mix(in srgb, var(--plot-accent) 9%, transparent);
}
.analysis-extend .fa-forward {
  font-size: 0.6rem;
}
/* All: the second choice, outlined; amber with a warning past a GiB. */
.analysis-read-all {
  height: 22px;
  color: var(--plot-fg);
  border-color: var(--plot-border);
}
.analysis-read-all .fa-angles-right,
.analysis-read-all .fa-triangle-exclamation {
  font-size: 0.6rem;
  color: var(--plot-muted);
}
.analysis-read-all.heavy,
.analysis-read-all.heavy .analysis-cost,
.analysis-read-all.heavy .fa-triangle-exclamation {
  color: var(--plot-warn);
  border-color: color-mix(in srgb, var(--plot-warn) 45%, transparent);
}
.analysis-status-sub > .analysis-preview-strip + *::before {
  content: none;
}
.analysis-tool .fa-arrows-left-right {
  margin-right: 2px;
}
.analysis-read-facts {
  font-variant-numeric: tabular-nums;
}

/* Chart and Data first, at the left of the footer. */
.analysis-footer > .analysis-views {
  order: -1;
}
.analysis-views {
  flex: 0 0 auto;
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--plot-raised);
  border: 1px solid var(--plot-border);
  border-radius: 8px;
}
.analysis-views button {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  font: inherit;
  font-size: 0.74rem;
  color: var(--plot-muted);
  background: none;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.analysis-views button:hover:not(:disabled) {
  color: var(--plot-fg);
}
.analysis-views button[aria-selected="true"] {
  color: var(--plot-fg);
  font-weight: 600;
  background: var(--plot-bg);
  box-shadow:
    0 0 0 1px var(--plot-border),
    0 1px 2px rgba(15, 23, 42, 0.12);
}
.analysis-views button[aria-selected="true"] .plot-icon {
  color: var(--plot-accent);
}
.analysis-views button:disabled {
  opacity: 0.45;
  cursor: default;
}
.analysis-views button:focus-visible {
  outline-offset: -1px;
}
/* A new figure tab: two gentle outline pulses (2.4 s); its text holds. */
.analysis-views button.pulse {
  animation: analysis-tab-pulse 1.2s ease-in-out 2;
}
/* A new tab says its name while it pulses, also when tabs are icons. */
.analysis-views button.pulse .analysis-tab-label {
  position: static;
  width: auto;
  height: auto;
  clip-path: none;
}
/* A tool that waits for the whole series: shown, locked, with its reason. */
.analysis-field.locked,
.analysis-toggle.locked {
  opacity: 0.55;
  cursor: not-allowed;
}
.analysis-field.locked select {
  cursor: not-allowed;
}
.analysis-lock {
  font-size: 0.58rem;
  color: var(--plot-muted);
}
@keyframes analysis-tab-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--plot-accent) 0%, transparent);
  }
  45% {
    box-shadow: 0 0 0 3px
      color-mix(in srgb, var(--plot-accent) 50%, transparent);
  }
}
@media (prefers-reduced-motion: reduce) {
  .analysis-views button.pulse {
    animation: none;
    box-shadow: 0 0 0 2px
      color-mix(in srgb, var(--plot-accent) 50%, transparent);
  }
  .analysis-wind-busy {
    animation: none;
  }
}

/* ---------- Dialog footers ---------- */
.analysis-dialog-note {
  min-width: 0;
  color: var(--plot-muted);
  font-size: 0.72rem;
}
.analysis-dialog-note.pending {
  color: var(--plot-pending);
}

/* ---------- Resize edges: all four sides and corners ---------- */
.analysis-resize {
  position: absolute;
  touch-action: none;
  z-index: 7;
}
.analysis-resize-e,
.analysis-resize-w {
  top: 14px;
  bottom: 14px;
  width: 6px;
  cursor: ew-resize;
}
.analysis-resize-e {
  right: 0;
}
.analysis-resize-w {
  left: 0;
}
.analysis-resize-n,
.analysis-resize-s {
  left: 14px;
  right: 14px;
  height: 6px;
  cursor: ns-resize;
}
.analysis-resize-n {
  top: 0;
  /* Under the title bar's buttons: a thin strip, they keep their clicks. */
  height: 4px;
}
.analysis-resize-s {
  bottom: 0;
}
.analysis-resize-ne,
.analysis-resize-nw,
.analysis-resize-se,
.analysis-resize-sw {
  width: 14px;
  height: 14px;
}
.analysis-resize-ne {
  top: 0;
  right: 0;
  width: 8px;
  height: 8px;
  cursor: nesw-resize;
}
.analysis-resize-nw {
  top: 0;
  left: 0;
  width: 8px;
  height: 8px;
  cursor: nwse-resize;
}
.analysis-resize-se {
  right: 0;
  bottom: 0;
  cursor: nwse-resize;
}
.analysis-resize-sw {
  left: 0;
  bottom: 0;
  cursor: nesw-resize;
}
/* A maximized window or a sheet does not resize. */
.analysis-window.maximized .analysis-resize {
  display: none;
}
</style>
