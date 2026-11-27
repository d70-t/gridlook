import { defineStore } from "pinia";
import { markRaw } from "vue";

import {
  AnalysisRunError,
  cancelRun,
  setRunPaused,
  describeVariable,
  executeRun,
  planRun,
  releaseSource,
  sourcePublished,
} from "@/lib/analysis/analysisClient.ts";
import type { TErrorDetail } from "@/lib/analysis/analysisErrors.ts";
import type {
  TRunSource,
  TVariableSummary,
} from "@/lib/analysis/analysisRunner.ts";
import { timeLabelAt } from "@/lib/analysis/calendar.ts";
import { vectorMethodProblem } from "@/lib/analysis/cellMethods.ts";
import {
  alignTo,
  pairCandidates,
  partnerPieces,
  withPieces,
  partnerTimeChunks,
  type TAxes,
  partnerQuery,
} from "@/lib/analysis/companionAlign.ts";
import { temperatureMetadata } from "@/lib/analysis/displayUnits.ts";
import {
  continueJoiner,
  extendJoiner,
  extendResult,
  firstRows,
  freezeResult,
  lastRows,
  rowsBetween,
} from "@/lib/analysis/partialUpdates.ts";
import {
  groupsIn,
  nextDates,
  previewRange,
  remainingChunks,
  sizeRefusal,
} from "@/lib/analysis/preview.ts";
import {
  cleanView,
  decodeSession,
  encodedSession,
  encodeSession,
  MAX_SESSION_PLOTS,
  MAX_SESSION_TEXT_BYTES,
  type TSession,
  type TSessionPlot,
} from "@/lib/analysis/sessionLink.ts";
import { editableForm, removeVertex } from "@/lib/analysis/shapeEdit.ts";
import { polygonCrossings } from "@/lib/analysis/sphere.ts";
import {
  clipSelection,
  indexAt,
  indexRange,
  readsIndices,
  rowCount,
  rowsBefore,
  sameSelection,
} from "@/lib/analysis/timeRows.ts";
import {
  geometryKey,
  PATH_KINDS,
  GEOMETRY_KINDS,
  TIME_RANGE_KINDS,
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TAnalysisKind,
  type TAnalysisQuery,
  type TAnalysisResult,
  type TCountryGeometry,
  type TGeometry,
  type TPlanEstimate,
  type TShapeGeometry,
  type TSourceRef,
  type TSpreadView,
  maxDatesFor,
} from "@/lib/analysis/types.ts";
import { converter } from "@/lib/analysis/unitConvert.ts";
import {
  contradicted,
  gridRelative,
  guessComponents,
  notASpeed,
  speedFactor,
  windPairs,
  type TWindPair,
} from "@/lib/analysis/windPair.ts";
import { storePath } from "@/lib/data/sourceType.ts";
import { URL_PARAMETERS } from "@/utils/urlParams.ts";

/**
 * A switch inside a plot, set as the plot opens: the plot's own fields,
 * and a pair partner chosen from the dataset (any, or the salinity).
 */
export type TTurnOn = {
  wind?: true;
  figure?: "rose" | "hodograph";
  members?: "plume" | "fan" | "chance";
  timeView?:
    | "anomaly"
    | "annual"
    | "diurnal"
    | "running"
    | "cumulative"
    | "count"
    | "boxes"
    | "spectrum"
    | "return";
  trend?: true;
  spread?: "std";
  curve?: "cdf";
  /** Share of the area above a value: the area's mean to begin with. */
  shareAbove?: "mean";
  /**
   * A scatter partner: any other variable, the salinity (resolved by the
   * caller from metadata into `{ variable }`), or "choose": the scatter
   * opens and Against lists the candidates.
   */
  pair?: "any" | "salinity" | "choose" | { variable: string };
};

export const PLOT_STATUS = {
  LOADING: "loading",
  PLANNING: "planning",
  CONFIRM: "confirm",
  QUEUED: "queued",
  RUNNING: "running",
  DONE: "done",
  ERROR: "error",
  CANCELLED: "cancelled",
  UNAVAILABLE: "unavailable",
} as const;

type TPlotStatus = (typeof PLOT_STATUS)[keyof typeof PLOT_STATUS];

export const DRAW_MODES = {
  NONE: "none",
  POINT: "point",
  POLYLINE: "polyline",
  BOX: "box",
  POLYGON: "polygon",
} as const;

export type TDrawMode = (typeof DRAW_MODES)[keyof typeof DRAW_MODES];

export type TPlotDraft = {
  geometry: TGeometry;
  variable: string;
  time?: TAnalysisQuery["time"];
  level?: number;
  fixed: Record<string, number>;
  sectionSamples: number;
  minCoverage?: number;
  binDegrees?: number;
  valueBins?: number;
};

export type TMapSettings = {
  variable: string;
  /** Current index of each non-spatial dimension on the map, by name. */
  indices: Record<string, number>;
};

/**
 * Results a window draws with its own: the same query run for other
 * variables (the wind's eastward and northward components). They share
 * the plot runs' planning, queue and cache.
 */
export type TCompanionPurpose = "wind" | "members" | "pair";

/** How an ensemble series shows its members. */
export type TMemberView = "plume" | "fan" | "both" | "chance";

/** More members than this are not read for one plot. */
const MAX_MEMBERS = 100;

export type TCompanions = {
  purpose: TCompanionPurpose;
  /** Wind components that are an ocean current (drawn going to). */
  current?: boolean;
  /** The plot query they were computed for. */
  key: string;
  /** "confirm": too large to start unasked; the window offers Read. */
  status: "loading" | "ready" | "failed" | "confirm";
  /** What Read approves: locating cells, or the field read. */
  stage?: "geometry" | "field";
  /** Read before a live publication changed their steps: read again. */
  stale?: boolean;
  results?: Record<string, TAnalysisResult>;
  message?: string;
  /** The size Read would start, while it waits ("240 MiB"). */
  size?: string;
  /** The same in bytes: Automatic starts it only within its cap. */
  bytes?: number;
  /** Members read so far, while they are read. */
  progress?: { done: number; total: number };
  /**
   * Decoded bytes a scatter partner read per plot date: what Extend adds to its
   * own price.
   */
  perDate?: number;
  /**
   * What an Extend or Read all reads for these: each component's axes and
   * the plot's, to find the stored chunks new dates touch (overlayBytes).
   */
  quote?: TOverlayQuote[];
  /** What was asked for ("auto", or the chosen "u|v"). */
  choice?: string;
  /**
   * Which load these are from: a later load (another choice, another
   * result) supersedes an earlier one still running, whatever it returns.
   */
  generation?: number;
};

/** A companion component, as an extension of the plot prices it. */
type TOverlayQuote = {
  owner: string;
  variable: string;
  own: TAxes;
  partner: TAxes;
};

/**
 * A companion's request to confirm, kept while progress arrives: pieces already
 * running finish and report, a replan waits for Read.
 */
function stillAsking(current: TCompanions | undefined, owner: string) {
  return current?.status === "confirm" && companionWaits.get(owner)?.size
    ? {
        status: current.status,
        stage: current.stage,
        message: current.message,
        size: current.size,
        bytes: current.bytes,
      }
    : {};
}

/** Increases with each companion load. */
let companionGeneration = 0;
/** Decoded bytes each companion owner's runs read (their estimates). */
const companionSpent = new Map<string, number>();

export type TPreviewState = {
  /** The request as asked: every date. */
  intent: TAnalysisQuery;
  /** Dates asked for. */
  total: number;
  /** Decoded bytes of the whole request, when it was priced. */
  fullBytes?: number;
  /** Values the whole request would hold, when that is what refused it. */
  tooMany?: number;
  /** The plot's own values limit, when lower than the general one. */
  limit?: number;
  /** Why all the dates can never be read at once (chunks, memory). */
  refused?: string;
  /** Decoded bytes per stored time chunk (to price more dates). */
  perGroup?: number;
};

/**
 * An Extend under way: the result kept, the dates being added (`before`:
 * earlier ones), the range when they are in, and the preview state then.
 */
type TExtension = {
  kept: TAnalysisResult;
  shown: { start: number; stop: number };
  target: { start: number; stop: number };
  before: boolean;
  preview?: TPlotWindow["preview"];
  /** Read all: the range to extend to next, once these dates are in. */
  then?: { start: number; stop: number };
  /** The range shown when the scientist asked (steps add to it). */
  origin: { start: number; stop: number };
  /** The whole request's dates, when in several stored slices. */
  dates?: TAnalysisQuery["time"];
  /**
   * An earlier step, read from its end: what it has read so far, and the
   * publication count it began under (a stop keeps those dates beside the
   * plot unless the source published since).
   */
  read?: TAnalysisResult;
  publication?: number;
  /** The dates the step under way reads. */
  step?: { start: number; stop: number };
};

/**
 * The request with its range: an omitted one is every date, as an explicit one
 * is.
 */
function wholeRequest(
  asked: TAnalysisQuery | undefined,
  summary: TVariableSummary | undefined
) {
  const length = summary?.time?.raw.length;
  return asked && !asked.time && length
    ? { ...asked, time: { start: 0, stop: length } }
    : asked;
}

/**
 * Stored indices `range` of a request (`all`: its dates, in one stored
 * slice or several): its slices there (timeRows.ts). A request in one
 * slice gets the range itself, as before.
 */
function inRequest(
  all: TAnalysisQuery["time"] | undefined,
  range: { start: number; stop: number; fromEnd?: boolean }
): NonNullable<TAnalysisQuery["time"]> {
  return (all?.runs && clipSelection(all, range)) || { ...range };
}

/** The dates an Extend reads: earlier ones from their end, beside the plot. */
function extensionPiece(
  shown: { start: number; stop: number },
  next: { start: number; stop: number },
  chunk: number | undefined,
  all?: TAnalysisQuery["time"]
) {
  if (next.start >= shown.start) {
    return { start: shown.stop, stop: next.stop };
  }
  // In slices: the step is counted in the request's rows, so it never lands
  // wholly in a gap between slices.
  const start = all?.runs
    ? indexAt(
        all,
        earlierStep(
          { start: rowsBefore(all, shown.start) },
          { start: rowsBefore(all, next.start) },
          chunk
        )
      )
    : earlierStep(shown, next, chunk);
  return { start, stop: shown.start, fromEnd: true };
}

/** A stopped request's dates from stored index `readUntil` on. */
function restOf(query: TAnalysisQuery, readUntil: number) {
  const time = query.time!;
  return {
    ...query,
    time: inRequest(time, { start: readUntil, stop: time.stop }),
  };
}

/**
 * What a stopped or failed earlier step had read from its end, joined to the
 * dates shown: the plot from its first date read. Nothing when no date beside
 * the plot was read, or the source published any of the step's dates since it
 * began was read lost all 24).
 */
function earlierRead(ext: TExtension, committed: TAnalysisQuery) {
  const read = ext.read;
  const from = read?.partial?.readFrom;
  const pieceStart = ext.step?.start;
  if (
    !ext.before ||
    !read ||
    from === undefined ||
    pieceStart === undefined ||
    from >= ext.shown.start ||
    ext.publication === undefined ||
    publishedSince(ext.publication, from, ext.shown.start - 1)
  ) {
    return undefined;
  }
  const all = ext.dates;
  const query = {
    ...committed,
    time: inRequest(all, { start: from, stop: ext.shown.stop }),
  };
  const step = inRequest(all, { start: pieceStart, stop: ext.shown.start });
  const rows = lastRows(freezeResult(read), rowsBefore(step, from));
  return {
    query,
    result: inheritAge(
      markRaw({
        ...extendResult(ext.kept, rows, true),
        partial: undefined,
        query,
      }),
      ext.kept
    ),
  };
}

/**
 * The catalog level a variable is read from, as provenance says it ("2 of 3:
 * 1"): the level whose group its path names ("1/tas" is level 1's), else the
 * level plots read.
 */
export function levelText(source: TRunSource | undefined, variable: string) {
  const level = source?.level;
  if (!level) {
    return undefined;
  }
  const trim = (path: string) => path.replace(/^\/+|\/+$/g, "");
  const cut = variable.lastIndexOf("/");
  const group = cut > 0 ? trim(variable.slice(0, cut)) : undefined;
  // The level whose path holds the group, nested groups too, the longest such
  // path.
  let named = -1;
  (level.paths ?? []).forEach((path, at) => {
    const p = path === undefined ? undefined : trim(path);
    if (
      group !== undefined &&
      p !== undefined &&
      p !== "" &&
      (group === p || group.startsWith(`${p}/`)) &&
      (named < 0 || p.length > trim(level.paths![named]!).length)
    ) {
      named = at;
    }
  });
  // A level without paths names its store: this variable's own, when the level
  // keeps variables in several.
  const own = source.store
    ? storePath(source.store, source.dataset)
    : undefined;
  const label =
    level.paths?.[level.index] === undefined && own ? own : level.label;
  return named >= 0
    ? `${named + 1} of ${level.count}: ${level.paths![named]}`
    : `${level.index + 1} of ${level.count}: ${label}`;
}

function withLevel(
  ref: TSourceRef,
  source: TRunSource | undefined,
  variable: string
): TSourceRef {
  const level = levelText(source, variable);
  const { level: _old, ...rest } = ref;
  void _old;
  return level ? { ...rest, level } : rest;
}

/** A first preview's state: the request, and what priced or refused it. */
function previewState(
  intent: TAnalysisQuery,
  total: number,
  priced: {
    estimate?: TPlanEstimate;
    values?: number;
    limit?: number;
    refused?: string;
  },
  perGroup: number | undefined
): TPreviewState {
  const { estimate, values, limit, refused } = priced;
  return {
    intent,
    total,
    ...(estimate ? { fullBytes: estimate.decodedBytes } : {}),
    ...(values ? { tooMany: values } : {}),
    ...(limit ? { limit } : {}),
    ...(refused ? { refused } : {}),
    ...(perGroup ? { perGroup } : {}),
  };
}

const sameRange = (
  a: { start: number; stop: number },
  b: { start: number; stop: number }
) => a.start === b.start && a.stop === b.stop;

/** An Extend that stopped or failed: where Extend goes on to (no further). */
type TPendingExtend = {
  target: { start: number; stop: number };
  then?: { start: number; stop: number };
};

/**
 * Earlier dates are read in steps next to those shown, latest first: a read
 * finishes its rows from its start, so a stop keeps every whole step beside the
 * plot and no gap opens. At most eight steps, each whole stored chunks.
 */
function earlierStep(
  shown: { start: number },
  target: { start: number },
  chunk: number | undefined
) {
  const span = shown.start - target.start;
  if (!chunk || chunk <= 0) {
    return target.start;
  }
  const groups = Math.ceil(span / chunk);
  const size = chunk * Math.max(1, Math.ceil(groups / 8));
  return Math.max(
    target.start,
    Math.floor((shown.start - size) / chunk) * chunk
  );
}

export type TPlotWindow = {
  /** An Extend reading only its new dates. */
  extending?: TExtension;
  /** An Extend stopped or failed short of what was asked and priced. */
  pendingExtend?: TPendingExtend;
  id: string;
  label: string;
  kind: TAnalysisKind;
  source: TRunSource;
  sourceRef: TSourceRef;
  datasetName: string;
  snapshot: boolean;
  summary?: TVariableSummary;
  draft: TPlotDraft;
  committed?: TAnalysisQuery;
  changed: boolean;
  status: TPlotStatus;
  message?: string;
  /** What a failure is (its kind and size), as the worker decided it. */
  failure?: TErrorDetail;
  estimate?: TPlanEstimate;
  result?: TAnalysisResult;
  revision: number;
  rect: { x: number; y: number; w: number; h: number };
  z: number;
  minimized: boolean;
  maximized: boolean;
  showSettings: boolean;
  showTable: boolean;
  /** An area series' spread on the chart (none: the mean alone). */
  spread?: TSpreadView;
  /** A path's samples drawn against latitude (none: distance along it). */
  pathAxis?: "latitude";
  /** Wind barbs drawn with a series or profile (asked for by the user). */
  wind?: boolean;
  /** The wind components chosen for the barbs; none: automatic. */
  windChoice?: { u: string; v: string };
  /** An ensemble series: its members as a plume, percentiles or both. */
  members?: TMemberView;
  /** The value whose exceedance the members' chance counts. */
  memberThreshold?: number;
  /** Units the plot is shown in (Settings → Display); none: the file's. */
  displayUnits?: string;
  /** How a series is drawn: a line, bars from zero, or points. */
  chartStyle?: "line" | "bars" | "points";
  /**
   * A time series seen another way: anomalies, annual or diurnal cycle,
   * running mean, cumulative total, count above a value, boxes by month,
   * spectrum, return levels.
   */
  timeView?:
    | "anomaly"
    | "annual"
    | "diurnal"
    | "running"
    | "cumulative"
    | "count"
    | "boxes"
    | "spectrum"
    | "return";
  /** The running mean's length, in samples. */
  timeWindow?: number;
  /** The value a count above counts. */
  timeThreshold?: number;
  /** A least-squares trend line on a time series. */
  trend?: boolean;
  /**
   * A distribution's curve over its bars: the smoothed density (default),
   * that and a normal curve of the same mean and σ, or the bars alone.
   */
  curve?: "density" | "both" | "none" | "cdf";
  /** A distribution's central range in % of the valid area (default 95). */
  centralRange?: number;
  /** A distribution: the value whose share of the area above it is shown. */
  shareAbove?: number;
  /** Share above the area's mean once read (a chart found: Share above). */
  shareAboveMean?: true;
  /** A figure of the wind read for the barbs: a rose or a hodograph. */
  figure?: "rose" | "hodograph" | "scatter";
  /** Another variable read with this plot's query, for a scatter (T–S). */
  pairWith?: string;
  /** The plot's own query run for other variables or members. */
  companions?: Partial<Record<TCompanionPurpose, TCompanions>>;
  /** Parts read so far while a series streams. */
  progress?: { done: number; total: number };
  paused: boolean;
  /** A one-time plot that recomputes when the map's time moves. */
  followMapTime?: boolean;
  /** A one-level plot (a series) that recomputes when the map's level moves. */
  followMapLevel?: boolean;
  /** The map's time index when the plot was made: a first preview's centre. */
  anchor?: number;
  /**
   * Showing the dates around the anchor first: the request asked for, and
   * what it would cost (the plot's own query is the preview's dates).
   */
  preview?: TPreviewState;
  /** The dates a shared link showed of its request, until its preview. */
  shownRange?: { start: number; stop: number };
  /** Read this request (its key) once priced: Read all was chosen. */
  autoConfirm?: string;
  /**
   * For that key, only within this approval (decoded bytes; 0: none): a read
   * again after a publication is approved at the price agreed before, not at
   * any.
   */
  autoConfirmUpTo?: { key: string; bytes: number };
  /** Bounds before Expand in map, kept until Restore size. */
  restoreRect?: { x: number; y: number; w: number; h: number };
  /** Source and summary the committed query was made with (for Discard). */
  committedBinding?: { source: TRunSource; summary?: TVariableSummary };
  /**
   * The variable summary of the result on screen: while an applied change
   * runs, the previous result keeps its own (not the replacement's).
   */
  resultSummary?: TVariableSummary;
  /** Bumped by every rebinding edit, so a late description is ignored. */
  bindingRevision?: number;
  /**
   * Screen bounds the window grows out of when it next appears (its
   * selection when created, the Plotting tools button when restored).
   * Taken once by the window; never saved.
   */
  emergeFrom?: { x: number; y: number; w: number; h: number };
  /**
   * How the window was opened (the map's selections, or a restored query),
   * kept until its first description succeeds: Retry starts from the same
   * request rather than default time and member.
   */
  opening?: { map: TMapSettings; restored?: Omit<TAnalysisQuery, "source"> };
  /**
   * A restored plot that cannot run here (variable unavailable): its
   * request stays in the link until the plot is changed or closed.
   */
  heldIntent?: Omit<TAnalysisQuery, "source">;
};

/**
 * What a window shows: the result under the window's own committed query
 * (so a display-only threshold applies), with any preview approximation
 * recorded on it.
 */
/** The result as shown, binding the window's summary to it. */
function presentResult(w: TPlotWindow, result: TAnalysisResult) {
  const shown = w.committedBinding?.summary ?? w.summary;
  w.resultSummary = shown ? markRaw(shown) : undefined;
  const native = (w.committedBinding?.summary ?? w.summary)?.order;
  const order = w.committed?.analysisOrder;
  // A later-dates Extend under way shows the joined dates: its query says the
  // range they are of.
  const ext = w.extending;
  const query =
    ext && !ext.before && w.committed && result.partial
      ? {
          ...w.committed,
          time: inRequest(ext.dates, ext.target),
        }
      : (w.committed ?? result.query);
  const presented = markRaw({
    ...result,
    query,
    approximation:
      order !== undefined && native !== undefined && order !== native
        ? `coarse preview: mean of selected cells at order ${order}; native order is ${native}`
        : result.approximation,
  });
  return inheritAge(presented, result);
}

function structuredCloneQuery(query: TAnalysisQuery): TAnalysisQuery {
  return JSON.parse(JSON.stringify(query));
}

/** A stopped result owns its arrays: a run still shared cannot change it. */
function frozenResult(result: TAnalysisResult): TAnalysisResult {
  return inheritAge(markRaw(freezeResult(result)), result);
}

/**
 * `made` from `parts` is as old as the oldest of them, and stale when any is.
 */
type TTimeRange = NonNullable<TAnalysisQuery["time"]>;

/**
 * Only a priced Extend reads without asking, up to the price its button showed.
 */
function armExtend(
  w: TPlotWindow,
  key: string,
  time: TTimeRange,
  chunk: number | undefined,
  perGroup: number | undefined
) {
  w.autoConfirm = perGroup ? key : undefined;
  w.autoConfirmUpTo = perGroup
    ? { key, bytes: groupsIn(time, chunk ?? 1) * perGroup }
    : undefined;
}

/**
 * A preview's dates among the request's own rows: a map date in a gap between
 * slices anchors at the next selected date.
 */
function previewIn(
  span: TTimeRange,
  anchor: number | undefined,
  chunk: number,
  perGroup: number | undefined,
  {
    perDate,
    chunksPerGroup,
  }: { perDate: number | undefined; chunksPerGroup: number | undefined }
) {
  const rowsOf = span.runs ? { start: 0, stop: rowCount(span) } : undefined;
  const picked = previewRange({
    span: rowsOf ?? span,
    anchor: rowsOf
      ? Math.min(rowsOf.stop - 1, rowsBefore(span, anchor ?? 0))
      : (anchor ?? span.start),
    chunk,
    perGroup,
    perDate,
    chunksPerGroup,
  });
  return picked && rowsOf ? indexRange(span, picked) : picked;
}

/** The dates from the earlier start to the later stop of two ranges. */
function spanOf(
  a: { start: number; stop: number },
  b: { start: number; stop: number }
) {
  return {
    start: Math.min(a.start, b.start),
    stop: Math.max(a.stop, b.stop),
  };
}

function inheritAge(made: TAnalysisResult, ...parts: TAnalysisResult[]) {
  const epochs = parts
    .map((part) => resultEpoch.get(part))
    .filter((epoch) => epoch !== undefined);
  if (epochs.length) {
    resultEpoch.set(made, Math.min(...epochs));
  }
  if (parts.some((part) => staleResults.has(part))) {
    staleResults.add(made);
  }
  const spans = parts.flatMap((part) => republished.get(part) ?? []);
  if (spans.length) {
    republished.set(made, spans);
  }
  return made;
}

/**
 * Compare plots: the series compared and the reference among them;
 * `collect`: series finished while it is open join it (picked for it).
 */
type TCompare = {
  ids: string[];
  reference: string;
  collect?: boolean;
  /** The view asked for (from a found chart): shown once there are pairs. */
  view?: "taylor" | "bias" | "scatter" | "qq" | "parallel";
  /** Minimized into Plotting tools' list, with the plots. */
  minimized?: boolean;
  /** Its place in the plot windows' stacking order. */
  z?: number;
};

/** A plot whose shape is being edited on the map, and its shape before. */
type TShapeEdit = {
  id: string;
  /**
   * The point selected (its index): highlighted and numbered on the map,
   * deleted from the edit bar, its menu or the Delete key.
   */
  selected?: number;
  /** The shape before editing, and the form edited (a drawn box's corners). */
  before: TGeometry;
  start: TGeometry;
  minimized: boolean;
};

const LABEL_PREFIX: Record<TAnalysisKind, string> = {
  [ANALYSIS_KINDS.POINT_SERIES]: "P",
  [ANALYSIS_KINDS.REGION_SERIES]: "A",
  [ANALYSIS_KINDS.PROFILE]: "V",
  [ANALYSIS_KINDS.SECTION]: "S",
  [ANALYSIS_KINDS.TIME_DEPTH]: "T",
  [ANALYSIS_KINDS.HOVMOLLER_LON]: "H",
  [ANALYSIS_KINDS.HOVMOLLER_LAT]: "H",
  [ANALYSIS_KINDS.HOVMOLLER_PATH]: "H",
  [ANALYSIS_KINDS.DISTRIBUTION]: "D",
  [ANALYSIS_KINDS.LAT_VERTICAL]: "L",
  [ANALYSIS_KINDS.LON_VERTICAL]: "L",
};

export const PLOT_KIND_NAMES: Record<TAnalysisKind, string> = {
  [ANALYSIS_KINDS.POINT_SERIES]: "Time series",
  [ANALYSIS_KINDS.REGION_SERIES]: "Area time series",
  [ANALYSIS_KINDS.PROFILE]: "Vertical profile",
  [ANALYSIS_KINDS.SECTION]: "Cross-section",
  // Generic until the field's vertical coordinate is known (the window
  // names it then: Time–pressure, Latitude–altitude…).
  [ANALYSIS_KINDS.TIME_DEPTH]: "Time–vertical",
  [ANALYSIS_KINDS.HOVMOLLER_LON]: "Hovmöller, longitude × time",
  [ANALYSIS_KINDS.HOVMOLLER_LAT]: "Hovmöller, latitude × time",
  [ANALYSIS_KINDS.HOVMOLLER_PATH]: "Hovmöller, distance × time",
  [ANALYSIS_KINDS.DISTRIBUTION]: "Distribution",
  [ANALYSIS_KINDS.LAT_VERTICAL]: "Latitude–vertical section",
  [ANALYSIS_KINDS.LON_VERTICAL]: "Longitude–vertical section",
};

const MAX_CONCURRENT_RUNS = 2;
const HINT_KEY = "gridlook.plotsHintSeen";

const RUN_PHASES = {
  PLANNING: "planning",
  CONFIRM: "confirm",
  QUEUED: "queued",
  RUNNING: "running",
} as const;

type TRunPhase = (typeof RUN_PHASES)[keyof typeof RUN_PHASES];

/**
 * One run shared by every window showing the same query. It exists from the
 * moment the first window asks, before planning, so identical windows share
 * one plan and one execution; it ends when its last subscriber leaves.
 */
/** A place along a path plot, in metres from its start. */
type TPathHover = { id: string; meters: number; fromMap?: boolean };

type TSharedRun = {
  key: string;
  runId: string;
  source: TRunSource;
  query: TAnalysisQuery;
  subscribers: number;
  phase: TRunPhase;
  paused: boolean;
  /**
   * Whether it holds one of the run slots: a paused run gives its slot to
   * the next plot (two paused reads no longer block a third), and takes one
   * again to resume.
   */
  holdsSlot: boolean;
  /**
   * A Resume is waiting for a slot: further clicks join it (one slot
   * request per run), and a Pause meanwhile withdraws it.
   */
  resuming?: boolean;
  /** Ended (done, failed or cancelled): a slot it gets back is returned. */
  ended: boolean;
  /** Rejects when the run is abandoned (a queued slot request leaves). */
  abandoned: Promise<never>;
  /** The latest estimate: the field's, after Locate cells. */
  estimate?: TPlanEstimate;
  /** The latest partial result: a window joining mid-run shows it at once. */
  latestPartial?: TAnalysisResult;
  /**
   * Steps a live source republished while this run read them: every partial and
   * result it gives carries them, so a later partial cannot drop what an
   * earlier one was marked with.
   */
  republished: [number, number][];
  promise: Promise<TAnalysisResult>;
  /** Start a planned run that waits for confirmation. */
  /** Go ahead; `automatic`: approved by switching to Automatic, not a click. */
  confirm: (automatic?: boolean) => void;
  /** Stop waiting for confirmation or a slot; the run ends as cancelled. */
  abandon: () => void;
  /** Windows following phases and partial results. */
  phaseListeners: Set<(phase: TRunPhase) => void>;
  listeners: Set<(partial: TAnalysisResult) => void>;
};

// Kept outside reactive state: promises and results shared between windows.
const sharedRuns = new Map<string, TSharedRun>();
/** Runs a publication took out of sharing, by run ID, while they last. */
const detachedRuns = new Map<string, TSharedRun>();

/** The run a window or companion is bound to, shared or detached. */
function boundRun(binding: { key: string; runId: string }) {
  const shared = sharedRuns.get(binding.key);
  return shared?.runId === binding.runId
    ? shared
    : detachedRuns.get(binding.runId);
}
const resultCache = new Map<
  string,
  { result: TAnalysisResult; bytes: number; outline?: object }
>();
const RESULT_CACHE_BYTES = 64 * 2 ** 20;
let resultCacheBytes = 0;
/**
 * The outlines cached results keep, each charged once however many share it.
 */
const cachedOutlines = new Map<object, { count: number; bytes: number }>();

/** Keep a result in the cache, its own bytes and its outline once. */
function keepCached(key: string, result: TAnalysisResult) {
  const outline = outlineOf(result.query?.geometry);
  const bytes = resultBytes(result) - (outline?.bytes ?? 0);
  if (outline) {
    const held = cachedOutlines.get(outline.key);
    if (held) {
      held.count++;
    } else {
      cachedOutlines.set(outline.key, { count: 1, bytes: outline.bytes });
      resultCacheBytes += outline.bytes;
    }
  }
  resultCache.set(key, { result, bytes, outline: outline?.key });
  resultCacheBytes += bytes;
}

/** Let a cached result go, and its outline with the last that held it. */
function dropCached(key: string) {
  const entry = resultCache.get(key);
  if (!entry) {
    return;
  }
  resultCache.delete(key);
  resultCacheBytes -= entry.bytes;
  const held = entry.outline && cachedOutlines.get(entry.outline);
  if (held && --held.count === 0) {
    cachedOutlines.delete(entry.outline!);
    resultCacheBytes -= held.bytes;
  }
}

/** A drawn or imported outline's vertices, as numbers kept (8 bytes each). */
function outlineOf(geometry: TAnalysisQuery["geometry"] | undefined) {
  const g = geometry as
    | { kind?: string; polygons?: number[][][][]; vertices?: unknown[] }
    | undefined;
  if (g?.kind === "shape" && Array.isArray(g.polygons)) {
    let points = 0;
    for (const polygon of g.polygons) {
      for (const ring of polygon) {
        points += ring.length;
      }
    }
    return { key: g.polygons as object, bytes: points * 2 * 8 + 64 };
  }
  if (Array.isArray(g?.vertices)) {
    return { key: g.vertices as object, bytes: g.vertices.length * 2 * 8 + 64 };
  }
  return undefined;
}
/** Results shown with dates that a live source has since (re)published. */
const staleResults = new WeakSet<TAnalysisResult>();
/** The steps republished since each shown result was read (inclusive). */
const republished = new WeakMap<TAnalysisResult, [number, number][]>();
/** Windows refreshed once after a publication spanned their read. */
const refreshedAfterPublication = new Map<string, string>();

/**
 * Whether a stopped result's dates `start`…`readUntil` (exclusive) were
 * republished since they were read: only those, not the unread rest.
 */
function prefixRepublished(
  result: TAnalysisResult,
  start: number,
  readUntil: number
) {
  return (republished.get(result) ?? []).some(
    ([from, to]) => from < readUntil && to >= start
  );
}
/**
 * Each window's kept dates while its continuation reads the rest: a publication
 * of them is recorded on them, not only in the journal, which keeps the last
 * 256.
 */
const continuing = new Map<string, TAnalysisResult>();

/** Counts live publications: a run that spans one is not kept. */
let publications = 0;

/** The publication count when each result's run started reading. */
const resultEpoch = new WeakMap<TAnalysisResult, number>();
/** Recent publications: their count and the steps they changed. */
const published: { at: number; from: number; to: number }[] = [];

/**
 * Whether any publication after `epoch` may touch what `query` reads (or
 * the journal no longer reaches back that far).
 */
function publishedFor(epoch: number, query: TAnalysisQuery) {
  if (publications === epoch) {
    return false;
  }
  if ((published[0]?.at ?? Infinity) > epoch + 1) {
    return true;
  }
  return published.some((p) => p.at > epoch && queryReads(query, p.from, p.to));
}

/**
 * Whether a live source published any of the steps `from`..`to` after its
 * publication `at` (or more publications came since than are remembered).
 */
function publishedSince(at: number, from: number, to: number) {
  return (
    (at < publications && (published[0]?.at ?? Infinity) > at + 1) ||
    published.some((p) => p.at > at && p.from <= to && p.to >= from)
  );
}

/** Whether a query reads any time step from `from` to `to` (inclusive). */
function queryReads(
  query: TAnalysisQuery | undefined,
  from: number,
  to: number
) {
  const time = query?.time;
  return !time || readsIndices(time, from, to);
}

/** Whether a result read any time step from `from` to `to` (inclusive). */
function readsSteps(result: TAnalysisResult, from: number, to: number) {
  return queryReads(result.query, from, to);
}

/**
 * Whether a result may hold values a live source has since republished:
 * shown when that happened, or read by a run that started before it.
 */
function isStale(result: TAnalysisResult) {
  if (staleResults.has(result)) {
    return true;
  }
  // Its run's own record first: the journal keeps the last 256.
  if (
    (republished.get(result) ?? []).some(([from, to]) =>
      readsSteps(result, from, to)
    )
  ) {
    return true;
  }
  const epoch = resultEpoch.get(result);
  return (
    epoch !== undefined &&
    published.some((p) => p.at > epoch && readsSteps(result, p.from, p.to))
  );
}
const windowRuns = new Map<string, { key: string; runId: string }>();
/** Shared runs each window's companions subscribe to. */
const companionRuns = new Map<string, { key: string; runId: string }[]>();

const NO_WIND =
  "No eastward and northward wind components were found in this dataset.";

/** The query companions are read with: the finished result's. */
function finishedQuery(w: TPlotWindow | undefined, wanted: unknown) {
  return wanted && w?.status === PLOT_STATUS.DONE && !w.result?.partial
    ? w.result?.query
    : undefined;
}

/** A variable's ensemble dimension with more than one member. */
/**
 * The other members' reads beyond the plot's own, in reads of its size: members
 * stored together in one chunk are one read.
 */
export function otherMemberReads(
  member: { size: number; chunk?: number },
  /** Decoded bytes of one member's read: past the chunk cache, a reread. */
  pieceBytes = 0
) {
  const passes = Math.max(
    0,
    Math.ceil(member.size / Math.max(1, member.chunk ?? 1)) - 1
  );
  // Members stored together are read with the plot's chunks while those stay
  // cached; past the decoded-chunk cache they may be read once more, and both
  // quotes say so alike.
  return passes === 0 && pieceBytes > MEMBER_CACHE_BYTES ? 1 : passes;
}

/** The analysis worker's decoded-chunk cache (chunkVisitor's budget). */
const MEMBER_CACHE_BYTES = 64 * 2 ** 20;

export function ensembleOf(summary: TVariableSummary | undefined) {
  return summary?.others.find((other) => other.ensemble && other.size > 1);
}

/**
 * The switch of a chart found or suggested (anomaly, barbs, members…), as
 * the window's own fields, for the window opening now (not one restored
 * from a link) if chosen within two minutes; taken once. A scatter partner
 * is chosen from the dataset: the salinity for T–S, else the first other.
 */
function takeTurnOn(
  state: { nextTurnOn?: { turnOn: TTurnOn; at: number } },
  restored: boolean,
  partners: string[]
): Partial<TPlotWindow> {
  const next = state.nextTurnOn;
  state.nextTurnOn = undefined;
  if (restored || !next || Date.now() - next.at >= 120_000) {
    return {};
  }
  const { pair, shareAbove, ...fields } = next.turnOn;
  // Never by a name's substring: the partner the caller resolved from metadata,
  // if it is still a candidate.
  const partner =
    typeof pair === "object"
      ? partners.find((name) => name === pair.variable)
      : pair === "any"
        ? partners[0]
        : undefined;
  return {
    ...fields,
    ...(partner
      ? { pairWith: partner, figure: "scatter" as const }
      : pair === "choose" || pair === "salinity"
        ? { figure: "scatter" as const }
        : {}),
    ...(shareAbove ? { shareAboveMean: true as const } : {}),
  };
}

/** Every member's result for the plot's query, in member order. */
async function readMembers(
  id: string,
  w: TPlotWindow,
  query: TAnalysisQuery,
  dimension: string,
  total: number,
  onProgress: (done: number) => void,
  /** The members read before the plot was extended: only new dates read. */
  previous?: Record<string, TAnalysisResult>
): Promise<{
  results?: Record<string, TAnalysisResult>;
  message?: string;
}> {
  const own = query.fixed[dimension] ?? 0;
  const length = w.result!.values.length;
  let done = 0;
  try {
    const list = await Promise.all(
      Array.from({ length: total }, async (_, member) => {
        const asked = {
          ...query,
          fixed: { ...query.fixed, [dimension]: member },
        };
        const result =
          member === own
            ? w.result!
            : await grownMember(id, w, asked, previous?.[member]);
        onProgress(++done);
        return result;
      })
    );
    if (list.some((result) => result.values.length !== length)) {
      throw new Error("the members do not line up with this plot.");
    }
    return {
      results: markRaw(Object.fromEntries(list.map((r, at) => [at, r]))),
    };
  } catch (error) {
    return { message: `Members: ${(error as Error).message}` };
  }
}

/** Whether two queries ask the same apart from their dates. */
function sameBesidesTime(a: TAnalysisQuery, b: TAnalysisQuery) {
  const rest = (q: TAnalysisQuery) =>
    JSON.stringify({ ...q, time: undefined, geometry: undefined }, (_, v) =>
      typeof v === "bigint" ? String(v) : v
    );
  return (
    (a.geometry === b.geometry ||
      geometryDigest(a.geometry) === geometryDigest(b.geometry)) &&
    rest(a) === rest(b)
  );
}

/** A geometry's text, made once per geometry object. */
const digests = new WeakMap<object, string>();
export function geometryDigest(geometry: TAnalysisQuery["geometry"]) {
  let digest = digests.get(geometry);
  if (digest === undefined) {
    digest = JSON.stringify(geometry);
    digests.set(geometry, digest);
  }
  return digest;
}

/**
 * A member's result for `asked`: its earlier one with only the dates added at
 * either end read.
 */
async function grownMember(
  id: string,
  w: TPlotWindow,
  asked: TAnalysisQuery,
  before: TAnalysisResult | undefined
) {
  const read = (query: TAnalysisQuery) =>
    companionResult(`${id}:members`, shownSource(w), query);
  const [was, now] = [before?.query?.time, asked.time];
  const same =
    before &&
    !before.partial &&
    was &&
    now &&
    !was.runs &&
    !now.runs &&
    // Everything but the dates: the place, level, region, fixed entries,
    // statistic.
    sameBesidesTime(before.query, asked);
  if (!same) {
    return read(asked);
  }
  if (was.start === now.start && was.stop < now.stop) {
    const rest = await read({
      ...asked,
      time: { start: was.stop, stop: now.stop },
    });
    return { ...extendResult(before, rest, false), query: asked };
  }
  if (was.stop === now.stop && now.start < was.start) {
    const rest = await read({
      ...asked,
      time: { start: now.start, stop: was.start },
    });
    return { ...extendResult(before, rest, true), query: asked };
  }
  return read(asked);
}

/**
 * The pairs to try for a window's barbs: the chosen components as they are
 * (unless grid-relative), else every candidate, most likely first.
 */
function windCandidates(
  variables: Record<string, { standardName?: string; units?: string }>,
  chosen: { u: string; v: string } | undefined,
  plotted: string
) {
  if (!chosen) {
    return { ...windPairs(variables, plotted), choice: "auto" };
  }
  // The same checks as a pair found by name.
  const reason =
    gridRelative(variables, chosen) ??
    contradicted(variables, { ...chosen, kind: "custom" }) ??
    notASpeed(variables, chosen);
  return {
    pairs: reason ? [] : [{ ...chosen, kind: "custom" as const }],
    reason,
    choice: `${chosen.u}|${chosen.v}`,
  };
}

/**
 * Whether a pair is an ocean current (drawn going *to*, the oceanographic
 * convention) rather than a wind (coming *from*): by its kind, its
 * standard names, or its base names in any group (`ocean/uo`); and,
 * when its own standard names say neither, by an ocean field beside it in
 * its group (25 Nov: CIOFS `u_eastward` beside `salt` is a current).
 */
export function isCurrentPair(
  pair: { u: string; v: string; kind?: string },
  variables: Record<string, { standardName?: string }>,
  /** The plot is on an ocean's vertical axis (depth): `oceanVertical`. */
  ocean = false
) {
  const base = (name: string) => name.slice(name.lastIndexOf("/") + 1);
  const seaNamed = /sea_water|ocean_current|surface_current/;
  const named = [pair.u, pair.v].map((name) => variables[name]?.standardName);
  if (named.some((sn) => seaNamed.test(sn ?? ""))) {
    return true;
  }
  // Standard names that say wind outrank a name like `uo`.
  if (named.some((sn) => /_wind\b|air_velocity/.test(sn ?? ""))) {
    return false;
  }
  if (
    pair.kind === "uo/vo" ||
    [pair.u, pair.v].some((name) =>
      /^(uo|vo|uoce|voce|u_current|v_current)$/i.test(base(name))
    )
  ) {
    return true;
  }
  if (named.some(Boolean)) {
    return false;
  }
  if (ocean) {
    return true;
  }
  const group = pair.u.slice(0, pair.u.lastIndexOf("/") + 1);
  return Object.entries(variables).some(
    ([name, meta]) =>
      name.startsWith(group) &&
      !name.slice(group.length).includes("/") &&
      (/^sea_water_salinity|^sea_surface_height|^sea_water_(potential_)?temperature/.test(
        meta.standardName ?? ""
      ) ||
        /^(salt|so|sss|salinity)$/i.test(base(name)))
  );
}

/**
 * Whether a plot's vertical axis is an ocean's: depth by its standard
 * name (an ocean formula's too), its dimension's name, or metres counted down
 * (25 Nov: CIOFS `Depth`; there u and v are currents, not winds).
 */
export function oceanVertical(
  vertical:
    | {
        dimension: string;
        kind: string;
        units?: string;
        positive?: "up" | "down";
        standardName?: string;
      }
    | undefined
) {
  return Boolean(
    vertical &&
    (/depth|ocean|sea_water|sea_floor/i.test(vertical.standardName ?? "") ||
      /depth/i.test(vertical.dimension) ||
      (vertical.positive === "down" &&
        /^(m|meters?|metres?)$/i.test(vertical.units ?? "")))
  );
}

/** Whether a result was taken at a level or across levels. */
const hasLevels = (r: TAnalysisResult) => Boolean(r.fixedLevel ?? r.vertical);

/** Where a result sits vertically: its level, or its levels. */
const verticalOf = (r: TAnalysisResult) =>
  JSON.stringify([
    r.fixedLevel?.value ?? r.fixedLevel?.index ?? null,
    r.vertical?.values ?? null,
  ]);

/**
 * Whether a component is at the plot's level: the same physical level in
 * either's units, else the same model level.
 */
export function sameLevel(a: TAnalysisResult, b: TAnalysisResult) {
  const close = (x: number, y: number) =>
    Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(y));
  const [la, lb] = [a.fixedLevel, b.fixedLevel];
  if (la?.value !== undefined && lb?.value !== undefined) {
    const to =
      la.units === lb.units ? (x: number) => x : converter(la.units, lb.units);
    return Boolean(to) && close(to!(la.value), lb.value);
  }
  if (a.vertical && b.vertical) {
    const to =
      a.vertical.units === b.vertical.units
        ? (x: number) => x
        : converter(a.vertical.units, b.vertical.units);
    return (
      Boolean(to) &&
      a.vertical.values.length === b.vertical.values.length &&
      a.vertical.values.every((v, at) => close(to!(v), b.vertical!.values[at]))
    );
  }
  return verticalOf(a) === verticalOf(b);
}

/**
 * The first pair whose components read at the plot's own level (a
 * surface temperature takes uas/vas, not ua/va at the first level).
 */
// eslint-disable-next-line max-lines-per-function
async function firstWindAtLevel(
  id: string,
  pairs: TWindPair[],
  shown: TAnalysisResult,
  own: TVariableSummary | undefined,
  wanted: () => boolean,
  sourceOf: (variable: string) => TRunSource,
  onUpdate: (update: TWindUpdate) => void
): Promise<{
  results?: Record<string, TAnalysisResult>;
  pair?: TWindPair;
  message?: string;
}> {
  let message: string | undefined;
  for (const pair of pairs) {
    try {
      // Metadata first: a pair with levels for a plot without (or the
      // reverse) is skipped before any of its data is read.
      const described = await describeVariable(sourceOf(pair.u), pair.u);
      // Closed or superseded while its metadata was read: start nothing.
      if (!wanted()) {
        return { message: "superseded" };
      }
      if (Boolean(described.vertical) !== hasLevels(shown)) {
        message ??= `Wind barbs: ${pair.u} and ${pair.v} are not at this plot's level.`;
        continue;
      }
      const results = await windComponents(
        id,
        pair,
        shown,
        own,
        sourceOf,
        // Parts are shown only from a pair at the plot's own level.
        (update) =>
          onUpdate(
            update.results && !sameLevel(update.results.u, shown)
              ? { progress: update.progress }
              : { ...update, pair }
          ),
        wanted
      );
      if (!results) {
        return { message: "superseded" };
      }
      if (sameLevel(results.u, shown)) {
        return { results, pair };
      }
      message ??= `Wind barbs: ${pair.u} and ${pair.v} are not at this plot's level.`;
    } catch (error) {
      message ??= `Wind barbs: ${(error as Error).message}`;
    }
  }
  return { message };
}

/** Both components so far, and the parts read of both together. */
type TWindUpdate = {
  results?: { u: TAnalysisResult; v: TAnalysisResult };
  /** The pair they are of (set once their level is known to match). */
  pair?: TWindPair;
  progress?: { done: number; total: number };
};

/**
 * The plot's query for `variable` on that variable's own time and level
 * axes (described first), so it is read where the plot's samples are.
 */
async function queryFor(
  shown: TAnalysisResult,
  own: TVariableSummary | undefined,
  source: TRunSource,
  variable: string
) {
  const partner = await describeVariable(source, variable);
  const query = partnerQuery(shown.query, own ?? {}, partner, variable);
  if ("reason" in query) {
    throw new Error(
      `${variable} cannot be read with this plot: ${query.reason}.`
    );
  }
  return query;
}

/**
 * Both components at the plot's own samples (matched by time or level,
 * not by index) and in the eastward one's units; or why they cannot be.
 */
// eslint-disable-next-line max-lines-per-function
export function windAt(
  shown: TAnalysisResult,
  pair: { u: string; v: string },
  u: TAnalysisResult,
  v: TAnalysisResult
) {
  // The two components of one vector with each other first (their run,
  // times and support), then on the plotted series: plotted temperature
  // must not pair U and V of different forecasts.
  const vu = shown === u ? undefined : alignTo(u, v);
  if (vu && "reason" in vu) {
    return `${pair.u} and ${pair.v} cannot be drawn as one vector: ${vu.reason}.`;
  }
  const [au, av] = [
    alignTo(shown, u),
    alignTo(shown, vu ? { ...u, values: vu.values } : v),
  ];
  if ("reason" in au || "reason" in av) {
    const why = "reason" in au ? au.reason : (av as { reason: string }).reason;
    return `${pair.u} and ${pair.v} cannot be drawn with this plot: ${why}.`;
  }
  // At a point too, not only over an area.
  const methods = vectorMethodProblem(
    { cellMethods: u.cellMethods, timeDimension: u.time?.dimension },
    { cellMethods: v.cellMethods, timeDimension: v.time?.dimension }
  );
  if (methods) {
    return `${pair.u} and ${pair.v} cannot be drawn as one vector: ${methods}.`;
  }
  // Speeds by the factors that validated them: m s-1 beside mm s-1 (a current)
  // converts.
  const [fu, fv] = [speedFactor(u.units), speedFactor(v.units)];
  const toU =
    fu && fv
      ? (value: number) => (value * fv) / fu
      : converter(v.units, u.units);
  if (!toU) {
    return `${pair.u} (${u.units ?? "no units"}) and ${pair.v} (${v.units ?? "no units"}) are in units that do not convert to each other.`;
  }
  // One place: components stored on different cells (a staggered grid) are no
  // vector there.
  const staggered = apart(u.cell, v.cell);
  if (staggered) {
    return `${pair.u} and ${pair.v} are stored on different cells (${staggered}): a staggered grid, so they are not drawn as one vector here.`;
  }
  // Over a region, a vector only where both are valid together: at least cu +
  // cv − 1 of the area, held to the plot's coverage threshold.
  const joint = jointCoverage(shown, u, v);
  const keep = (at: number) =>
    !joint || joint[at] >= Math.max(shown.query.minCoverage ?? 0, 1e-9);
  const region = (r: TAnalysisResult) =>
    joint && r.region ? { region: { ...r.region, coverage: joint } } : {};
  return markRaw({
    u: {
      ...u,
      ...region(u),
      values: au.values.map((x, at) => (keep(at) ? x : Number.NaN)),
    },
    v: {
      ...v,
      ...region(v),
      units: u.units,
      values: av.values.map((x, at) => (keep(at) ? toU(x) : Number.NaN)),
    },
  });
}

/** How two components' cells differ, when their centres are not one. */
function apart(a: TAnalysisResult["cell"], b: TAnalysisResult["cell"]) {
  if (!a || !b || a.stored === false || b.stored === false) {
    return undefined;
  }
  const dLon = Math.abs(((((a.lon - b.lon) % 360) + 540) % 360) - 180);
  const dLat = Math.abs(a.lat - b.lat);
  const tolerance = (size?: number) => Math.max(1e-6, (size ?? 0) * 0.01);
  return dLat > tolerance(a.footprint?.lat) ||
    dLon > tolerance(a.footprint?.lon)
    ? `${a.lat.toFixed(3)}°, ${a.lon.toFixed(3)}° and ${b.lat.toFixed(3)}°, ${b.lon.toFixed(3)}°`
    : undefined;
}

/**
 * The share of a region where two components are both valid, at least,
 * at the plot's samples: max(0, cu + cv − 1); undefined for points.
 */
function jointCoverage(
  shown: TAnalysisResult,
  u: TAnalysisResult,
  v: TAnalysisResult
) {
  if (!u.region?.coverage || !v.region?.coverage) {
    return undefined;
  }
  const [cu, cv] = [u, v].map((r) =>
    alignTo(shown, { ...r, values: r.region!.coverage })
  );
  if ("reason" in cu || "reason" in cv) {
    return undefined;
  }
  // Read on common cells: their coverage is the shared area itself.
  if (u.region.joint && v.region.joint) {
    return cu.values.map((a, at) => Math.min(a, cv.values[at]) || 0);
  }
  return cu.values.map((a, at) =>
    Number.isFinite(a) && Number.isFinite(cv.values[at])
      ? Math.max(0, a + cv.values[at] - 1)
      : 0
  );
}

/**
 * Both wind components with the plot's query, at the plot's samples and in
 * one unit. While a series streams, `onUpdate` gets the parts read so far
 * of both.
 */
// eslint-disable-next-line max-lines-per-function
async function windComponents(
  id: string,
  pair: { u: string; v: string },
  shown: TAnalysisResult,
  own: TVariableSummary | undefined,
  sourceOf: (variable: string) => TRunSource,
  onUpdate?: (update: TWindUpdate) => void,
  /** Still wanted (not turned off, closed or superseded). */
  wanted: () => boolean = () => true
) {
  const queries = (
    await Promise.all(
      [pair.u, pair.v].map((variable) =>
        queryFor(shown, own, sourceOf(variable), variable)
      )
    )
  ).map((query, at) => {
    // Over an area, each counted where the other is valid too: both means over
    // the same cells, in one store or two. The worker refuses unlike cells.
    if (query.kind !== ANALYSIS_KINDS.REGION_SERIES) {
      return query;
    }
    const other = at ? pair.u : pair.v;
    const otherSource = sourceOf(other);
    return withPieces(query, {
      ...query,
      jointWith: other,
      ...(otherSource.key !== sourceOf(at ? pair.v : pair.u).key
        ? { jointSource: otherSource }
        : {}),
    });
  });
  // Turned off while the components were described: read nothing.
  if (!wanted()) {
    return undefined;
  }
  const latest: (TAnalysisResult | undefined)[] = [undefined, undefined];
  const finished = [false, false];
  // Each component's share read, averaged: one not started counts 0, one
  // finished 1. Pairing walks the whole series: past WIND_REPORT_ROWS dates
  // it is done at most once per WIND_REPORT_MS, updates meanwhile taken by
  // one trailing report (65,536 dates take about 14 ms a pairing).
  let reported = -Infinity;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const report = () => {
    const wait = reported + WIND_REPORT_MS - performance.now();
    if (
      wait > 0 &&
      latest[0] &&
      latest[1] &&
      shown.values.length > WIND_REPORT_ROWS
    ) {
      trailing ??= setTimeout(() => {
        trailing = undefined;
        if (!settled) {
          report();
        }
      }, wait);
      return;
    }
    const [u, v] = latest;
    const share = latest.map((r, at) =>
      finished[at]
        ? 1
        : r?.partial
          ? r.partial.done / Math.max(1, r.partial.total)
          : 0
    );
    const both = u && v ? windAt(shown, pair, u, v) : undefined;
    // Only a pairing counts, from its end: a long one is not run again at
    // once.
    if (u && v) {
      reported = performance.now();
    }
    onUpdate?.({
      results: typeof both === "object" ? both : undefined,
      progress: {
        done: Math.round(500 * (share[0] + share[1])),
        total: 1000,
      },
    });
  };
  // Each component as read before an Extend: its rows kept, only the new dates
  // read.
  const owner = `${id}:wind`;
  // Not across a publication that touches what they read, or while one is
  // pending for them: those dates are read again. Nor from another source: a
  // component's route changed, its rows are another store's.
  const kept = windRead.get(owner);
  const earlierOf = (variable: string, source: TRunSource) => {
    const result = kept?.results[variable];
    return result &&
      !staleCompanions.has(owner) &&
      kept!.sources[variable] === source.key &&
      !(result.query && publishedFor(kept!.epoch, result.query))
      ? result
      : undefined;
  };
  const epoch = publications;
  const generation = tokenOf(windGenerations, owner);
  const sources = [pair.u, pair.v].map((variable) => sourceOf(variable));
  const [u, v] = await Promise.all(
    [pair.u, pair.v].map(async (variable, at) => {
      const result = await partnerResult(
        owner,
        sources[at],
        queries[at],
        earlierOf(variable, sources[at]),
        (partial) => {
          latest[at] = partial;
          report();
        }
      );
      // Its final rows pair the other's as they come, a cached one too.
      latest[at] = result;
      finished[at] = true;
      report();
      return result;
    })
  ).finally(() => {
    // No report after the read is over, whichever way it ended.
    settled = true;
    clearTimeout(trailing);
  });
  // Kept only for a window still open.
  if (
    windGenerations.get(owner) === generation &&
    !staleCompanions.has(owner) &&
    !publishedFor(epoch, queries[0]) &&
    !publishedFor(epoch, queries[1])
  ) {
    windRead.set(owner, {
      epoch,
      results: { [pair.u]: u, [pair.v]: v },
      sources: { [pair.u]: sources[0].key, [pair.v]: sources[1].key },
    });
  } else {
    windRead.delete(owner);
  }
  const both = windAt(shown, pair, u, v);
  if (typeof both === "string") {
    throw new Error(both);
  }
  return both;
}

/** The least time between two wind pairings of a long series while reading. */
const WIND_REPORT_MS = 100;
const WIND_REPORT_ROWS = 4096;

/**
 * What the plot's overlays (barbs' components, a scatter partner) read for a
 * request of `time`: the stored chunks of each component that the new dates
 * touch and the shown ones did not, at the component's price a chunk. Undefined
 * when a component's price is not known yet.
 */
export function overlayBytes(
  w: TPlotWindow,
  time: NonNullable<TAnalysisQuery["time"]>,
  rereadShown = false
) {
  const shown = w.result?.query;
  if (!shown) {
    return undefined;
  }
  let bytes = 0;
  for (const purpose of ["wind", "pair"] as const) {
    const companion = shownCompanions(w, purpose);
    // Being read, or waiting for approval, and not priced yet: unknown, said
    // as such, not left out.
    if (
      (companion?.status === "loading" || companion?.status === "confirm") &&
      !companion.quote?.length
    ) {
      return undefined;
    }
    for (const part of companion?.quote ?? []) {
      // The plot's own variable is in its own price: counted once.
      if (part.variable === shown.variable) {
        continue;
      }
      const price = chunkPrices.get(part.owner)?.get(part.variable);
      const chunksOf = (query: TAnalysisQuery) =>
        partnerTimeChunks(query, part.own, part.partner, part.variable);
      const wanted = chunksOf({ ...shown, time });
      const had = rereadShown ? new Set<number>() : chunksOf(shown);
      if (price === undefined || !wanted || !had) {
        return undefined;
      }
      let fresh = 0;
      wanted.forEach((chunk) => (fresh += Number(!had.has(chunk))));
      bytes += fresh * price;
    }
  }
  return bytes;
}

/**
 * The source the shown result was read from: the committed binding, not a draft
 * not yet applied.
 */
function shownSource(w: TPlotWindow) {
  return w.committedBinding?.source ?? w.source;
}

/** A window's companions, when they belong to the result it shows. */
export function shownCompanions(w: TPlotWindow, purpose: TCompanionPurpose) {
  const c = w.companions?.[purpose];
  return c && w.result && c.key === queryKey(shownSource(w), w.result.query)
    ? c
    : undefined;
}

/** Each window's wind components as read, by variable: an Extend grows them. */
const windRead = new Map<
  string,
  {
    epoch: number;
    results: Record<string, TAnalysisResult>;
    /** Each component's source key as read. */
    sources: Record<string, string>;
  }
>();
/**
 * Per owner, a token of its companions' current reads, dropped as they are let
 * go: a read that began under another token (or none now) is stale. Nothing is
 * kept for a window once it is closed.
 */
const windGenerations = new Map<string, object>();
/** Likewise for a piece loop: one let go starts no later piece. */
const releases = new Map<string, object>();

/** Owners with a token: what closed windows must not leave behind. */
export function companionTokens() {
  return windGenerations.size + releases.size;
}

/** The owner's current token, made if it has none. */
function tokenOf(tokens: Map<string, object>, owner: string) {
  let token = tokens.get(owner);
  if (!token) {
    token = {};
    tokens.set(owner, token);
  }
  return token;
}

/** Unsubscribe a window's companions; the last subscriber stops a run. */
function releaseCompanions(id: string, purpose?: TCompanionPurpose) {
  if (!purpose) {
    windRead.delete(`${id}:wind`);
    windGenerations.delete(`${id}:wind`);
    releaseCompanions(id, "wind");
    releaseCompanions(id, "members");
    releaseCompanions(id, "pair");
    return;
  }
  const owner = `${id}:${purpose}`;
  releases.delete(owner);
  chunkPrices.delete(owner);
  // A load waiting for its Read ends here, unread.
  const gate = memberGates.get(owner);
  memberGates.delete(owner);
  gate?.(false);
  for (const binding of companionRuns.get(owner) ?? []) {
    const shared = boundRun(binding);
    if (shared && --shared.subscribers <= 0) {
      // A newer run under the same key (after a publication) is not this one.
      if (sharedRuns.get(binding.key) === shared) {
        sharedRuns.delete(binding.key);
      }
      shared.abandon();
      cancelRun(shared.runId, shared.source);
    }
  }
  companionRuns.delete(owner);
}

/**
 * The partner of a scatter, read no more than needed: sparse times as separate
 * runs of chunks, joined; and when the plot grew (Extend), the rows read before
 * kept and only the new ones read.
 */
async function partnerResult(
  owner: string,
  source: TRunSource,
  query: TAnalysisQuery,
  before: TAnalysisResult | undefined,
  onPartial?: (partial: TAnalysisResult) => void
) {
  const time = query.time;
  const was = before?.query?.time;
  const same =
    before &&
    was &&
    time &&
    !isStale(before) &&
    queryKey(source, { ...before.query, time }) === queryKey(source, query);
  // Grown: the rows read before kept piece by piece, only the dates not read
  // yet read, as sparse runs when the partner's times are sparse.
  if (same) {
    const segments = await grownSegments(
      before,
      partnerPieces(before.query!) ?? [was],
      partnerPieces(query) ?? [time],
      (within, publish) =>
        piecewiseResult(owner, source, query, publish, within),
      onPartial
    );
    return { ...joinInOrder(segments), query };
  }
  return piecewiseResult(owner, source, query, onPartial);
}

/**
 * Results in order, joined only when shown, and a long one shown at most every
 * WIND_REPORT_MS: n pieces of a long series cost a bounded number of joins of
 * it, not n.
 */
function growingJoin() {
  let joined: TAnalysisResult | undefined;
  let pending: TAnalysisResult[] = [];
  let rows = 0;
  let shown = -Infinity;
  let held: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    add(result: TAnalysisResult) {
      pending.push(result);
      rows += result.values.length;
    },
    /** Everything added so far, as one result. */
    now() {
      if (pending.length) {
        joined = joinInOrder([...(joined ? [joined] : []), ...pending]);
        pending = [];
      }
      return joined;
    },
    /**
     * A publication with `more` rows besides: made now if due, else the latest
     * one held for the end of the interval (a burst before the worker goes
     * quiet still shows its last update).
     */
    offer(send: () => void, more = 0) {
      const wait = shown + WIND_REPORT_MS - performance.now();
      if (rows + more > WIND_REPORT_ROWS && wait > 0) {
        held = send;
        timer ??= setTimeout(() => {
          timer = undefined;
          const last = held;
          held = undefined;
          if (last) {
            shown = performance.now();
            last();
          }
        }, wait);
        return;
      }
      held = undefined;
      shown = performance.now();
      send();
    },
    /** No held publication sent any more (the result is in, or let go). */
    stop() {
      clearTimeout(timer);
      [timer, held] = [undefined, undefined];
    },
  };
}

/**
 * A grown companion's rows in piece order: those of `before` (read for
 * `old` pieces, joined in order) where they cover a new piece, the rest
 * read by `read` for each uncovered interval.
 */
// eslint-disable-next-line max-lines-per-function
export async function grownSegments(
  before: TAnalysisResult,
  old: TRange[],
  pieces: (TRange & { chunk?: number })[],
  read: (
    within: TRange & { chunk?: number },
    publish?: (partial: TAnalysisResult) => void
  ) => Promise<TAnalysisResult>,
  /** Partial results: the rows kept and read so far, in order. */
  onPartial?: (partial: TAnalysisResult) => void
) {
  const offsets: number[] = [];
  old.reduce((at, p) => (offsets.push(at), at + p.stop - p.start), 0);
  // Each interval to read with its piece's chunk length: read as it is, not
  // intersected with every piece again.
  const plan: (TAnalysisResult | (TRange & { chunk?: number }))[] = [];
  // Both lists ascend: one pass through each, not every old piece for every new
  // one.
  let first = 0;
  for (const piece of pieces) {
    let at = piece.start;
    while (first < old.length && old[first].stop <= piece.start) {
      first++;
    }
    for (let k = first; k < old.length && old[k].start < piece.stop; k++) {
      const o = old[k];
      const from = Math.max(o.start, piece.start);
      const to = Math.min(o.stop, piece.stop);
      if (to <= from) {
        continue;
      }
      if (at < from) {
        plan.push({ start: at, stop: from, chunk: piece.chunk });
      }
      const row = offsets[k] - o.start;
      plan.push(rowsBetween(before, row + from, row + to));
      at = to;
    }
    if (at < piece.stop) {
      plan.push({ start: at, stop: piece.stop, chunk: piece.chunk });
    }
  }
  // The intervals not read yet, one after another. While they are read, the
  // rows kept stay published with them: the rows before as one result grown
  // a segment at a time, those after as one slice of the kept rows, so a
  // partial costs one three-way join, not one of every segment.
  const segments: TAnalysisResult[] = [];
  const keptSteps = plan.filter(
    (step): step is TAnalysisResult => "values" in step
  );
  const keptRows = keptSteps.length ? joinInOrder(keptSteps) : undefined;
  // Kept rows at or after each step of the plan.
  const keptFrom: number[] = new Array(plan.length + 1).fill(0);
  for (let at = plan.length - 1; at >= 0; at--) {
    const step = plan[at];
    keptFrom[at] =
      keptFrom[at + 1] + ("values" in step ? step.values.length : 0);
  }
  const total = keptRows?.values.length ?? 0;
  const after = (at: number) =>
    keptRows && keptFrom[at]
      ? [rowsBetween(keptRows, total - keptFrom[at], total)]
      : [];
  if (onPartial && keptRows && plan.some((step) => !("values" in step))) {
    onPartial(keptRows);
  }
  const head = growingJoin();
  for (const [at, step] of plan.entries()) {
    const segment =
      "values" in step
        ? step
        : await read(
            step,
            onPartial &&
              ((partial) => {
                // The kept rows after it sliced only when shown.
                head.offer(
                  () => {
                    const before = head.now();
                    onPartial({
                      ...joinInOrder([
                        ...(before ? [before] : []),
                        partial,
                        ...after(at + 1),
                      ]),
                      partial: partial.partial,
                    });
                  },
                  partial.values.length + keptFrom[at + 1]
                );
              })
          );
    segments.push(segment);
    if (onPartial) {
      head.stop();
      head.add(segment);
    }
  }
  return segments;
}

type TRange = { start: number; stop: number };

/**
 * A companion query read as its planned runs of time chunks when its times are
 * sparse on its own axis (a plot of two dates 10,000 steps apart reads two
 * chunks, not 10,000), joined; else as one run. Wind, scatter partners and
 * members alike.
 */

/** Steps of one piece in a piecewise read's progress. */
const PIECE_SCALE = 1000;

// eslint-disable-next-line max-lines-per-function
async function piecewiseResult(
  owner: string,
  source: TRunSource,
  query: TAnalysisQuery,
  onPartial?: (partial: TAnalysisResult) => void,
  /**
   * Only these of its times (the dates an Extend added): within one of its
   * pieces, with that piece's chunk length.
   */
  within?: { start: number; stop: number; chunk?: number }
) {
  const pieces = (within ? [within] : partnerPieces(query))?.filter(
    (piece) => piece.stop > piece.start
  );
  // Every stored chunk its pieces read: a quote prices them all, each piece by
  // its own chunks.
  const unitsOf = (piece: { start: number; stop: number; chunk?: number }) =>
    piece.chunk
      ? Math.floor((piece.stop - 1) / piece.chunk) -
        Math.floor(piece.start / piece.chunk) +
        1
      : 1;
  const queries = pieces?.length
    ? pieces.map((piece) => {
        const { chunk: _chunk, ...time } = piece;
        void _chunk;
        const q = { ...query, time };
        queryUnits.set(q, unitsOf(piece));
        return q;
      })
    : undefined;
  const units = pieces?.length ? pieces.reduce((n, p) => n + unitsOf(p), 0) : 1;
  plannedRuns.set(owner, (plannedRuns.get(owner) ?? 0) + units);
  const byVariable = plannedByVariable.get(owner) ?? new Map<string, number>();
  byVariable.set(query.variable, (byVariable.get(query.variable) ?? 0) + units);
  plannedByVariable.set(owner, byVariable);
  if (!queries) {
    return companionResult(
      owner,
      source,
      within ? { ...query, time: within } : query,
      onPartial
    );
  }
  // Progress over all pieces, not each piece's own from 0 again; the pieces
  // already read stay published with the one being read, joined as one
  // result grown a piece at a time.
  const parts: TAnalysisResult[] = [];
  const done = growingJoin();
  const released = tokenOf(releases, owner);
  for (const [k, q] of queries.entries()) {
    // Let go while a sibling kept the last piece alive: no later piece starts.
    if (releases.get(owner) !== released) {
      done.stop();
      throw new DOMException("Aborted", "AbortError");
    }
    const part = await companionResult(
      owner,
      source,
      q,
      onPartial &&
        ((partial) =>
          done.offer(() => {
            const before = done.now();
            onPartial({
              ...(before ? joinInOrder([before, partial]) : partial),
              partial: partial.partial && {
                ...partial.partial,
                done:
                  k * PIECE_SCALE +
                  Math.round(
                    (PIECE_SCALE * partial.partial.done) /
                      Math.max(1, partial.partial.total)
                  ),
                total: queries.length * PIECE_SCALE,
              },
            });
          }, partial.values.length))
    ).finally(() => done.stop());
    parts.push(part);
    // Published as soon as it is in, a cached piece too: its pairs show while
    // the next piece is read.
    if (onPartial) {
      done.add(part);
      if (k + 1 < queries.length) {
        done.offer(() => {
          const sofar = done.now()!;
          onPartial({
            ...sofar,
            partial: {
              done: (k + 1) * PIECE_SCALE,
              total: queries.length * PIECE_SCALE,
              readUntil: sofar.values.length,
            },
          });
        });
      }
    }
  }
  done.stop();
  // Each piece as of now: one read before a publication of its dates is stale
  // even if it finished first.
  if (parts.some(isStale)) {
    staleCompanions.add(owner);
  }
  return {
    ...joinInOrder(parts),
    query: within ? { ...query, time: within } : query,
  };
}

/**
 * Pieces in time order joined pairwise, level by level: each value copied about
 * log₂(n) times, not n.
 */
export function joinInOrder(parts: TAnalysisResult[]) {
  let level = parts;
  while (level.length > 1) {
    const next: TAnalysisResult[] = [];
    for (let at = 0; at < level.length; at += 2) {
      next.push(
        at + 1 < level.length
          ? extendResult(level[at], level[at + 1], false)
          : level[at]
      );
    }
    level = next;
  }
  return level[0];
}

/**
 * A companion for `owner` (a window and purpose): its query's result from
 * the cache, else from a shared run. It follows a plot the user has accepted, at its size, so
 * a request to confirm is answered for it.
 */
// eslint-disable-next-line max-lines-per-function
async function companionResult(
  owner: string,
  source: TRunSource,
  query: TAnalysisQuery,
  onPartial?: (partial: TAnalysisResult) => void
) {
  const key = queryKey(source, query);
  const cached = cachedResult(key, query);
  if (cached) {
    // Priced as the read that made it: Extend and All quote the same whether
    // the partner was cold or cached.
    const priced =
      plannedBytes.get(cached) ?? cached.counters.decodedBytes ?? 0;
    companionSpent.set(owner, (companionSpent.get(owner) ?? 0) + priced);
    settleCached(owner, query);
    notePrice(owner, query.variable, priced / unitsOfQuery(query));
    return cached;
  }
  const shared =
    sharedRuns.get(key) ??
    createSharedRun(key, source, query, (estimate) =>
      groupAsks(owner, query, estimate)
    );
  shared.subscribers++;
  const bindings = companionRuns.get(owner) ?? [];
  bindings.push({ key, runId: shared.runId });
  companionRuns.set(owner, bindings);
  // A read that asks to be confirmed waits for the user's Read: it is
  // priced, not started because the plot beside it was small. An approval
  // covers the stage it was priced for: locating cells is one, the field
  // read after it another.
  const confirm = (phase: TRunPhase) => {
    if (phase !== RUN_PHASES.CONFIRM) {
      return;
    }
    const stage: TStage = shared.estimate?.needsConfirmation
      ? "geometry"
      : "field";
    // A sparse companion's pieces are read one after another under one
    // approval: Automatic's cap holds for all of them, as the quote does.
    const whole = shared.estimate && {
      decodedBytes:
        stage === "field"
          ? groupBytes(owner, shared.query, shared.estimate)
          : shared.estimate.decodedBytes,
    };
    if (stage === "field" && unpriced(owner)) {
      const held = pricingWaits.get(owner) ?? new Set();
      held.add(() => confirm(shared.phase));
      pricingWaits.set(owner, held);
      return;
    }
    // Held only for the group's price, which now needs no asking.
    if (
      stage === "field" &&
      shared.estimate?.modest &&
      !groupAsks(owner, shared.query, shared.estimate)
    ) {
      shared.confirm();
      return;
    }
    if (
      approvedFor(owner, stage, whole?.decodedBytes) ||
      startsUnasked(whole)
    ) {
      shared.confirm();
      return;
    }
    const waiting = companionWaits.get(owner) ?? new Map<string, TWait>();
    waiting.set(shared.runId, {
      stage,
      estimate: shared.estimate,
      units: unitsOfQuery(shared.query),
      variable: shared.query.variable,
      go: () => shared.confirm(),
    });
    companionWaits.set(owner, waiting);
    costListeners.get(owner)?.(
      [...waiting.values()].filter((w) => w.stage === stage)
    );
  };
  shared.phaseListeners.add(confirm);
  confirm(shared.phase);
  // Streamed parts as they arrive (a series reads in parts).
  const listener = (partial: TAnalysisResult) => onPartial?.(partial);
  if (onPartial) {
    shared.listeners.add(listener);
    if (shared.latestPartial) {
      listener(shared.latestPartial);
    }
  }
  try {
    const value = await shared.promise.catch((error: unknown) => {
      // A component that never priced holds no other piece back.
      if (!unitPrices.get(owner)?.has(query.variable)) {
        notePrice(owner, query.variable, 0);
      }
      throw error;
    });
    // Read across a live publication of its steps: shown, marked stale, and
    // read again on the next load.
    if (isStale(value)) {
      staleCompanions.add(owner);
    }
    companionSpent.set(
      owner,
      (companionSpent.get(owner) ?? 0) + (shared.estimate?.decodedBytes ?? 0)
    );
    // Its price a stored chunk, for the quotes of a later extension.
    notePrice(
      owner,
      query.variable,
      (shared.estimate?.decodedBytes ?? 0) / unitsOfQuery(query)
    );
    return value;
  } finally {
    companionWaits.get(owner)?.delete(shared.runId);
    shared.phaseListeners.delete(confirm);
    shared.listeners.delete(listener);
  }
}

type TStage = "geometry" | "field";
type TWait = {
  stage: TStage;
  estimate?: TPlanEstimate;
  /** The stored chunks along time its read covers (1 when unknown). */
  units: number;
  /** The component it reads (U or V of a wind). */
  variable?: string;
  go: () => void;
};

/** Stored time chunks a companion piece reads (1 when unknown). */
const queryUnits = new WeakMap<TAnalysisQuery, number>();
const unitsOfQuery = (query: TAnalysisQuery) => queryUnits.get(query) ?? 1;

/**
 * What all of an owner's planned pieces need, from one piece's plan: its
 * price a stored chunk times every chunk planned (both components).
 */
function groupBytes(
  owner: string,
  query: TAnalysisQuery,
  estimate: { decodedBytes: number }
) {
  const planned = plannedRuns.get(owner) ?? 0;
  const own = unitsOfQuery(query);
  notePrice(owner, query.variable, estimate.decodedBytes / own);
  // A component not priced yet at the dearest price known, not at this piece's:
  // a cheap U does not start before a dear V is known.
  const known = [...(unitPrices.get(owner)?.values() ?? [])];
  return planned > own
    ? componentBytes(owner, Math.max(estimate.decodedBytes / own, ...known))
    : estimate.decodedBytes;
}

/**
 * Each component's price a stored chunk, as its own plans say: U in 1 MiB
 * chunks beside V in 32 MiB ones is no 32 MiB a chunk for both.
 */
const unitPrices = new Map<string, Map<string, number>>();
/** Stored chunks planned per component of each owner. */
const plannedByVariable = new Map<string, Map<string, number>>();

function notePrice(owner: string, variable: string, perUnit: number) {
  for (const map of [unitPrices, chunkPrices]) {
    const prices = map.get(owner) ?? new Map<string, number>();
    prices.set(variable, Math.max(prices.get(variable) ?? 0, perUnit));
    map.set(owner, prices);
  }
  decideHeld(owner);
}

/**
 * Each component's price a stored chunk as its last load found it: kept
 * after the load (unlike unitPrices) for an extension's quote, until the
 * next load or the companion's release.
 */
const chunkPrices = new Map<string, Map<string, number>>();

/** Pieces held until every component had a price decide again now. */
function decideHeld(owner: string) {
  const held = pricingWaits.get(owner);
  if (held && !unpriced(owner)) {
    pricingWaits.delete(owner);
    queueMicrotask(() => held.forEach((decide) => decide()));
  }
}

/**
 * A piece served from the cache reads nothing: its chunks leave the group's
 * plan, and a component wholly cached needs no price.
 */
function settleCached(owner: string, query: TAnalysisQuery) {
  const units = unitsOfQuery(query);
  plannedRuns.set(owner, Math.max(0, (plannedRuns.get(owner) ?? 0) - units));
  const byVariable = plannedByVariable.get(owner);
  if (byVariable) {
    const left = (byVariable.get(query.variable) ?? 0) - units;
    if (left > 0) {
      byVariable.set(query.variable, left);
    } else {
      byVariable.delete(query.variable);
    }
  }
  decideHeld(owner);
}

/**
 * Pieces of an owner waiting for its other components' prices: no piece starts
 * before the group's price is known.
 */
const pricingWaits = new Map<string, Set<() => void>>();

/** Whether a component of an owner's group has no price yet. */
function unpriced(owner: string) {
  const prices = unitPrices.get(owner);
  return [...(plannedByVariable.get(owner)?.keys() ?? [])].some(
    (variable) => !prices?.has(variable)
  );
}

/**
 * All planned chunks of every component at its own price; one not priced
 * yet at `fallback` (the price a chunk of what is priced).
 */
function componentBytes(owner: string, fallback: number) {
  const prices = unitPrices.get(owner);
  let bytes = 0;
  for (const [variable, units] of plannedByVariable.get(owner) ?? []) {
    bytes += units * (prices?.get(variable) ?? fallback);
  }
  return bytes;
}

/**
 * Whether a piece, modest alone, must ask for the group it belongs to:
 * Automatic's cap, or (asking first) the modest read, holds for all of them.
 */
function groupAsks(
  owner: string,
  query: TAnalysisQuery,
  estimate: { decodedBytes: number }
) {
  const own = unitsOfQuery(query);
  if ((plannedRuns.get(owner) ?? 0) <= own) {
    return false;
  }
  const whole = groupBytes(owner, query, estimate);
  // Another component unpriced: held until it is (pricingWaits).
  if (unpriced(owner)) {
    return true;
  }
  return computeMode === "auto"
    ? whole > AUTO_COMPUTE_BYTES
    : whole > MEMBERS_UNASKED_BYTES;
}

/**
 * What the waiting reads of one stage need, all together; with `count`,
 * what that many reads of the same shape need (Read starts them all);
 * with `dates`, the dates all pieces read, at the waiting reads' price a
 * date.
 */
function companionCost(
  waits: TWait[],
  count = waits.length,
  dates?: number,
  owner?: string
) {
  const waitingDates = waits.reduce((n, w) => n + w.units, 0);
  if (dates && owner && plannedByVariable.get(owner)?.size && waitingDates) {
    const perUnit =
      waits.reduce((sum, w) => sum + (w.estimate?.decodedBytes ?? 0), 0) /
      waitingDates;
    const chunksPerUnit =
      waits.reduce((sum, w) => sum + (w.estimate?.chunks ?? 0), 0) /
      waitingDates;
    for (const w of waits) {
      if (w.variable && w.estimate) {
        notePrice(owner, w.variable, w.estimate.decodedBytes / w.units);
      }
    }
    const bytes = componentBytes(owner, perUnit);
    const chunks = Math.round(chunksPerUnit * dates);
    const stage = waits[0]?.stage ?? ("field" as TStage);
    return {
      stage,
      size: formatBytes(bytes),
      bytes,
      text: `about ${formatBytes(bytes)} in ${chunks.toLocaleString("en-US")} chunks${stage === "geometry" ? " to locate cells" : ""}`,
    };
  }
  const scale = dates
    ? waitingDates
      ? dates / waitingDates
      : 0
    : waits.length
      ? count / waits.length
      : 0;
  const bytes =
    scale * waits.reduce((sum, w) => sum + (w.estimate?.decodedBytes ?? 0), 0);
  const chunks = Math.round(
    scale * waits.reduce((sum, w) => sum + (w.estimate?.chunks ?? 0), 0)
  );
  const stage = waits[0]?.stage ?? ("field" as TStage);
  return {
    stage,
    /** The size alone, for the button that starts it ("Read 240 MiB"). */
    size: formatBytes(bytes),
    bytes,
    /** "about 240 MiB in 32 chunks" (to locate cells, when that is next). */
    text: `about ${formatBytes(bytes)} in ${chunks.toLocaleString("en-US")} chunks${stage === "geometry" ? " to locate cells" : ""}`,
  };
}

/**
 * Members priced together, waiting for Read before any is read: true reads
 * them; false (the window closed, members turned off or loaded anew) lets the
 * waiting load go, holding nothing.
 */
const memberGates = new Map<string, (go: boolean) => void>();
/** Members read together unasked up to this (one plot's modest read). */
const MEMBERS_UNASKED_BYTES = 64 * 2 ** 20;

/** Owners whose companion reads spanned a live publication of their steps. */
const staleCompanions = new Set<string>();

/** Owners (`window:purpose`) allowed to start a large read, by stage. */
const approvedCompanions = new Map<string, TStage>();
/**
 * The bytes each approval was quoted at: a later plan of the group that costs
 * more is asked about again.
 */
const approvedBytes = new Map<string, number>();

/** Whether an approval of `stage` covers `bytes` for `owner`. */
function approvedFor(owner: string, stage: TStage, bytes: number | undefined) {
  if (approvedCompanions.get(owner) !== stage) {
    return false;
  }
  const agreed = approvedBytes.get(owner);
  return agreed === undefined || bytes === undefined || bytes <= agreed * 1.05;
}
/** Reads of each owner waiting for Read, by run. */
const companionWaits = new Map<string, Map<string, TWait>>();
/** Each loading owner's way of showing what Read would start. */
const costListeners = new Map<string, (waits: TWait[]) => void>();
/**
 * Dates one Read starts for each owner: a sparse companion is read in pieces,
 * one after another, all approved by it; its first are priced for all, a date
 * at a time.
 */
const plannedRuns = new Map<string, number>();

/**
 * Show `owner`'s priced reads with `show` while one load lasts; the
 * returned call ends it, unless a newer load of the same owner took over.
 */
function listenCost(
  owner: string,
  show: (cost: ReturnType<typeof companionCost>) => void,
  count?: number
) {
  plannedRuns.delete(owner);
  plannedByVariable.delete(owner);
  unitPrices.delete(owner);
  chunkPrices.delete(owner);
  pricingWaits.delete(owner);
  // Cells are located once for every piece; the field is read per piece.
  const listener = (waits: TWait[]) =>
    show(
      companionCost(
        waits,
        count,
        count !== undefined || waits[0]?.stage === "geometry"
          ? undefined
          : plannedRuns.get(owner),
        owner
      )
    );
  costListeners.set(owner, listener);
  return () => {
    if (costListeners.get(owner) === listener) {
      costListeners.delete(owner);
      approvedCompanions.delete(owner);
      approvedBytes.delete(owner);
      plannedRuns.delete(owner);
      plannedByVariable.delete(owner);
      unitPrices.delete(owner);
      pricingWaits.delete(owner);
    }
  };
}

function formatBytes(bytes: number) {
  return bytes >= 2 ** 30
    ? `${(bytes / 2 ** 30).toFixed(1)} GiB`
    : `${Math.max(1, Math.round(bytes / 2 ** 20))} MiB`;
}
const runQueue: Array<{ start: () => void }> = [];
// Page lifetime, not component lifetime: the plot layer remounts while the
// viewer detects a variable, and must not rebind or restore again then.
let boundDatasources: object | undefined;
let sourceGeneration = 0;
// Every source the analysis opened (windows and the menu), to release later.
let highlightTimer: ReturnType<typeof setTimeout> | undefined;
/** Descriptions in flight per window, aborted when the window closes. */
const describing = new Map<string, AbortController>();
const openedSources = new Map<string, TRunSource>();
let activeRuns = 0;
let nextRun = 0;

/** Past this many characters the address bar keeps the map only. */
const MAX_LINK_LENGTH = 500_000;

/**
 * The session a link carries: each shareable window's query as shown (its
 * committed query, not an unapplied edit), how it is shown, where, and
 * Compare; with what had to be left out, and why.
 */
export function sessionOf(
  windows: TPlotWindow[],
  compare?: { ids: string[]; reference?: string }
) {
  const leftOut: string[] = [];
  // A window reopening from a link keeps its place in the link until it
  // runs: restoring plots one by one does not rewrite the link without
  // the slower ones.
  // A preview shares the request as asked, not its first dates.
  const queryOf = (w: TPlotWindow) =>
    w.preview?.intent ?? w.committed ?? w.opening?.restored ?? w.heldIntent;
  const shared = windows.filter((w) => {
    const why = !queryOf(w)
      ? "not run yet"
      : w.snapshot
        ? "from another dataset"
        : w.sourceRef.versionStatus === "session"
          ? "a local file"
          : "";
    if (why) {
      leftOut.push(`${w.label} (${why})`);
    }
    return !why;
  });
  const index = (id?: string) => shared.findIndex((w) => w.id === id);
  const ids = (compare?.ids ?? []).map(index).filter((at) => at >= 0);
  const session: TSession = {
    plots: shared.map((w) => ({
      query: { ...queryOf(w)!, source: undefined } as TSessionPlot["query"],
      ...(viewOf(w) ? { view: viewOf(w) } : {}),
      rect: { ...w.rect },
    })),
    ...(typeof innerWidth === "number"
      ? { screen: { w: innerWidth, h: innerHeight } }
      : {}),
    ...(ids.length && index(compare?.reference) >= 0
      ? { compare: { ids, reference: index(compare?.reference) } }
      : {}),
  };
  return {
    session,
    leftOut,
    // Shared as shown: edits not yet applied are not in the link.
    edited: shared.filter((w) => w.changed).length,
  };
}

/** A window's shared view: its settings, and the dates a preview shows. */
function viewOf(w: TPlotWindow) {
  const time = w.preview ? w.committed?.time : undefined;
  return cleanView(
    time ? { ...w, shownRange: { start: time.start, stop: time.stop } } : w
  );
}

/** The URL hash with the plots component set to `value` (or removed). */
function hashWithPlots(value: string | undefined) {
  // Only the plots component changes; every other one is kept verbatim (a
  // decode and rewrite would unescape a `%26` or `+` in another setting).
  const [resource, ...rest] = location.hash.substring(1).split("::");
  const key = URL_PARAMETERS.PLOTS;
  const others = rest.filter(
    (part) => part !== "" && part.split("=")[0] !== key
  );
  const entries = value ? [...others, `${key}=${value}`] : others;
  return `#${[resource, ...entries].join("::")}`;
}

/** Whether the page was opened with plots in its address. */
function incomingPlots() {
  try {
    const parts = globalThis.location?.hash?.substring(1).split("::") ?? [];
    return parts
      .slice(1)
      .some((part) => part.split("=")[0] === URL_PARAMETERS.PLOTS);
  } catch {
    return false;
  }
}

/** A session file's plots, handed to the next load of this tab. */
const PENDING_SESSION = "gridlook-pending-session";
/** The hash parameter naming the one handoff this load may take. */
const PENDING_PARAMETER = "session";

/**
 * Open a session file's link: a short one through the address bar; a long
 * one (2.5 million characters were blocked as a navigation) through this
 * tab's session storage, the address keeping the map only. False when
 * neither can carry it.
 */
export function openSessionLink(link: string) {
  // Only the view (the hash) is taken: the file cannot send this page elsewhere.
  const hash = new URL(link).hash;
  const [, ...rest] = hash.substring(1).split("::");
  const value = new URLSearchParams(rest.join("&")).get(URL_PARAMETERS.PLOTS);
  const [resource, ...parts] = hash.substring(1).split("::");
  const mapOnly = `#${[
    resource,
    ...parts.filter(
      (part) => part && part.split("=")[0] !== URL_PARAMETERS.PLOTS
    ),
  ].join("::")}`;
  if (value && hash.length > MAX_LINK_LENGTH / 5) {
    // Bound to one load of this resource: a one-use id in the address and
    // the resource itself (another link opened meanwhile never takes it).
    const id = Math.random().toString(36).slice(2, 10);
    try {
      sessionStorage.setItem(
        PENDING_SESSION,
        JSON.stringify({ id, resource, value })
      );
    } catch {
      return false;
    }
    location.hash = `${mapOnly}::${PENDING_PARAMETER}=${id}`;
  } else {
    location.hash = hash;
  }
  location.reload();
  return true;
}

/**
 * The session of this page load: a session file's, handed over in this
 * tab's storage (once), else the URL hash's (version 1, 2 or 3).
 */
export function readSessionParam() {
  const [resource, ...rest] = location.hash.substring(1).split("::");
  const params = new URLSearchParams(rest.join("&"));
  const value = params.get(URL_PARAMETERS.PLOTS);
  const wanted = params.get(PENDING_PARAMETER);
  let handed: string | undefined;
  try {
    const stored = sessionStorage.getItem(PENDING_SESSION);
    // Taken once, whoever loads next; used only by the load it was made
    // for: its id in the address, the same resource, no plots of its own.
    if (stored) {
      sessionStorage.removeItem(PENDING_SESSION);
      const pending = JSON.parse(stored) as {
        id?: string;
        resource?: string;
        value?: string;
      };
      if (
        wanted &&
        pending.id === wanted &&
        pending.resource === resource &&
        !value &&
        typeof pending.value === "string"
      ) {
        handed = pending.value;
      }
    }
  } catch {
    // No storage, or not ours: the hash alone.
  }
  if (wanted) {
    // The id has done its work: the address keeps the map and plots only.
    const kept = rest.filter(
      (part) => part.split("=")[0] !== PENDING_PARAMETER
    );
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${location.search}#${[resource, ...kept].join("::")}`
    );
  }
  const chosen = handed ?? value;
  return chosen ? decodeSession(chosen) : { plots: [] };
}

/** The computation's identity: a display threshold does not change it. */
export function queryKey(source: TRunSource, query: TAnalysisQuery) {
  const selection = { ...query, geometry: geometryKey(query.geometry) };
  return `${source.key}|${JSON.stringify({ ...selection, minCoverage: undefined })}`;
}

function readHintSeen() {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

/** Wait for one of the run slots; abandoning removes the queued entry. */
function acquireSlot(onQueued: () => void, abandoned: Promise<never>) {
  if (activeRuns < MAX_CONCURRENT_RUNS) {
    activeRuns++;
    return Promise.resolve();
  }
  onQueued();
  return new Promise<void>((resolve, reject) => {
    const entry = {
      start: () => {
        activeRuns++;
        resolve();
      },
    };
    runQueue.push(entry);
    abandoned.catch((error: unknown) => {
      const at = runQueue.indexOf(entry);
      if (at >= 0) {
        runQueue.splice(at, 1);
        reject(error);
      }
    });
  });
}

function releaseSlot() {
  activeRuns--;
  runQueue.shift()?.start();
}

/**
 * Resume a paused run once a slot is free (the window says Paused till then):
 * one request per run, however often Resume is clicked; ended, or paused again
 * meanwhile, the slot goes back.
 */
async function resumeWithSlot(shared: TSharedRun, resume: () => void) {
  shared.resuming = true;
  try {
    await acquireSlot(() => undefined, shared.abandoned);
  } catch {
    shared.resuming = false;
    return;
  }
  const wanted = shared.resuming && !shared.ended && !shared.holdsSlot;
  shared.resuming = false;
  if (!wanted) {
    releaseSlot();
    return;
  }
  shared.holdsSlot = true;
  resume();
}

/** Approximate retained size of a result: its numeric arrays and labels. */
/**
 * Retained size of a result: every numeric array it holds (values,
 * coverage and counts, vertical and per-column coordinates, time,
 * sample coordinates, a distribution's cells, bins and curve) and its
 * strings (time labels, cell ids, statuses).
 */
export function resultBytes(result: TAnalysisResult) {
  const samples = result.samples;
  const arrays =
    result.values.length +
    (result.region
      ? result.region.coverage.length * (result.region.spread ? 5 : 2)
      : 0) +
    (result.vertical?.values.length ?? 0) +
    // A profile's layer bounds, model and native coordinates too.
    (result.vertical?.bounds?.length ?? 0) +
    (result.vertical?.model?.values.length ?? 0) +
    (result.vertical?.auxiliary?.native?.length ?? 0) +
    (result.columnVertical?.length ?? 0) +
    (result.time?.raw.length ?? 0) +
    (samples ? samples.distances.length * 3 : 0) +
    (result.cellCoverage?.length ?? 0) +
    (result.time?.bounds?.length ?? 0) +
    (result.axis?.bounds?.length ?? 0) +
    (samples?.index
      ? samples.index.values.length * samples.index.dims.length
      : 0) +
    // A distribution's cells for a map, its bins and curve.
    (result.field ? result.field.values.length * 3 : 0) +
    (result.histogram
      ? result.histogram.edges.length * 2 +
        (result.histogram.summary?.percentiles.length ?? 0) +
        (result.histogram.summary?.density?.x.length ?? 0) * 2
      : 0);
  const strings =
    (result.time?.raw.length ?? 0) * 8 +
    (result.vertical?.auxiliary?.nativeIds?.length ?? 0) * 40 +
    (samples ? samples.cells.length * 40 + samples.status.length * 16 : 0);
  // The outline the query keeps (a 6,001-vertex ring is 96 KB of numbers).
  const outline = outlineOf(result.query?.geometry)?.bytes ?? 0;
  return arrays * 8 + strings + outline + 4096;
}

/**
 * The result kept for `query`, when its dates are the query's: one of another
 * range is let go was returned for [2, 4) under the shorter label).
 */
function cachedResult(key: string, query: TAnalysisQuery) {
  const entry = resultCache.get(key);
  const asked = query.time;
  const kept = entry?.result.query?.time;
  const rows = entry?.result.time?.raw.length;
  if (
    entry &&
    asked &&
    // The same stored rows, counted as rows.
    ((kept && !sameSelection(kept, asked)) ||
      (rows !== undefined && rows !== rowCount(asked)))
  ) {
    dropCached(key);
    return undefined;
  }
  return entry?.result;
}

function cacheResult(key: string, result: TAnalysisResult) {
  const bytes = resultBytes(result);
  if (bytes > RESULT_CACHE_BYTES / 4) {
    return;
  }
  dropCached(key);
  keepCached(key, result);
  for (const oldest of [...resultCache.keys()]) {
    if (resultCacheBytes <= RESULT_CACHE_BYTES) {
      break;
    }
    dropCached(oldest);
  }
}

/** Times a run plans again after live data made its plan stale. */
const STALE_REPLANS = 2;

/** The runner refused a plan made before a live publication. */
export function isStalePlan(error: unknown) {
  return /published new data since this plot was planned/.test(
    (error as Error | undefined)?.message ?? ""
  );
}

/**
 * Whether a fresh plan needs asking again: a modest plan that no longer
 * is, or more than a quarter past the bytes the scientist agreed to.
 */
/**
 * How large reads start: "ask" waits for Compute (or Read beside a plot);
 * "auto" starts them at once up to AUTO_COMPUTE_BYTES decoded, and still
 * asks above that. Remembered in this browser.
 */
export type TComputeMode = "ask" | "auto";
export const AUTO_COMPUTE_BYTES = 2 * 2 ** 30;
const COMPUTE_MODE_KEY = "gridlook-compute-mode";
function storedComputeMode(): TComputeMode {
  try {
    return globalThis.localStorage?.getItem(COMPUTE_MODE_KEY) === "auto"
      ? "auto"
      : "ask";
  } catch {
    return "ask";
  }
}
/** The pending trailing link write (writeLinkSoon). */
let linkTimer: ReturnType<typeof setTimeout> | undefined;
const LINK_WRITE_MS = 120;

/** The mode as the run machinery sees it (kept in step with the store). */
let computeMode: TComputeMode = storedComputeMode();
/** Whether a priced read starts without asking in the current mode. */
function startsUnasked(
  estimate: { decodedBytes: number } | undefined,
  mode: TComputeMode = computeMode
) {
  return (
    mode === "auto" &&
    estimate !== undefined &&
    estimate.decodedBytes <= AUTO_COMPUTE_BYTES
  );
}

export function exceedsApproval(
  estimate: TPlanEstimate,
  approved: number | undefined
) {
  if (estimate.modest) {
    return false;
  }
  return approved === undefined || estimate.decodedBytes > approved * 1.25;
}

const PHASE_STATUS: Record<TRunPhase, TPlotStatus> = {
  [RUN_PHASES.PLANNING]: PLOT_STATUS.PLANNING,
  [RUN_PHASES.CONFIRM]: PLOT_STATUS.CONFIRM,
  [RUN_PHASES.QUEUED]: PLOT_STATUS.QUEUED,
  [RUN_PHASES.RUNNING]: PLOT_STATUS.RUNNING,
};

/** A run's result or partial: as old as the run, with its republished steps. */
function markRun(
  result: TAnalysisResult,
  run: TSharedRun,
  publication: number
) {
  resultEpoch.set(result, publication);
  if (run.republished.length) {
    republished.set(result, [...run.republished]);
  }
}

/**
 * What a run's plan priced its read at: a cached companion quotes as the read
 * that made it, not the bytes that read happened to decode.
 */
const plannedBytes = new WeakMap<TAnalysisResult, number>();

/**
 * Create and register a shared run synchronously: plan; ask before many
 * cold coordinate reads (Locate cells), then plan the field; ask before a
 * large field read (Compute), series included; wait for a slot; execute,
 * cache. A 31,411-day series is not read in gigabytes without asking.
 */
// eslint-disable-next-line max-lines-per-function
function createSharedRun(
  key: string,
  source: TRunSource,
  query: TAnalysisQuery,
  /** Ask even for a modest plan: a piece of a larger group (companions). */
  asksAnyway?: (estimate: TPlanEstimate) => boolean
): TSharedRun {
  const runId = `r${++nextRun}`;
  let abandon!: (error: Error) => void;
  const abandoned = new Promise<never>(
    (_resolve, reject) => (abandon = reject)
  );
  abandoned.catch(() => undefined);
  const shared: TSharedRun = {
    key,
    runId,
    source,
    query,
    subscribers: 0,
    phase: RUN_PHASES.PLANNING,
    paused: false,
    holdsSlot: false,
    ended: false,
    abandoned,
    promise: Promise.resolve() as never,
    confirm: () => undefined,
    abandon: () => abandon(new AnalysisRunError("Cancelled", "cancelled")),
    phaseListeners: new Set(),
    listeners: new Set(),
    republished: [],
  };
  const setPhase = (phase: TRunPhase) => {
    shared.phase = phase;
    shared.phaseListeners.forEach((listener) => listener(phase));
  };
  const setEstimate = (estimate: TPlanEstimate) => {
    shared.estimate = markRaw(estimate);
    return estimate;
  };
  // Approved by switching to Automatic: held to Automatic's cap from then on,
  // like a run it started.
  let automaticApproval = false;
  const waitForConfirmation = async () => {
    const confirmation = new Promise<boolean | undefined>(
      (resolve) => (shared.confirm = resolve)
    );
    setPhase(RUN_PHASES.CONFIRM);
    automaticApproval = Boolean(await Promise.race([confirmation, abandoned]));
  };
  // Asked again while reading: the slot goes to other plots while the scientist
  // decides.
  const confirmWithoutSlot = async () => {
    if (shared.holdsSlot) {
      shared.holdsSlot = false;
      releaseSlot();
    }
    await waitForConfirmation();
    setPhase(RUN_PHASES.QUEUED);
    await acquireSlot(() => undefined, abandoned);
    shared.holdsSlot = true;
  };
  sharedRuns.set(key, shared);
  shared.promise = (async () => {
    try {
      let estimate = setEstimate(
        await Promise.race([planRun(runId, source, query), abandoned])
      );
      // Live publications when last planned: a plan priced before one is
      // planned again before it reads (it may hold data that changed).
      let plannedAt = publications;
      if (estimate.needsConfirmation) {
        await waitForConfirmation();
        if (sharedRuns.get(key) !== shared) {
          throw new AnalysisRunError("Cancelled", "cancelled");
        }
        setPhase(RUN_PHASES.PLANNING);
        estimate = setEstimate(
          await Promise.race([planRun(runId, source, query, true), abandoned])
        );
        plannedAt = publications;
      }
      // What the scientist agreed to read (Compute), if they were asked.
      let approved = estimate.modest ? undefined : estimate.decodedBytes;
      // Started by Automatic under its ceiling, not by a click: a replan past
      // the ceiling asks.
      let unasked = startsUnasked(estimate);
      if (!estimate.modest || asksAnyway?.(estimate)) {
        await waitForConfirmation();
        unasked ||= automaticApproval;
      }
      // A piece of a group asks again when the group's price, with this replan,
      // needs asking.
      const asksAgain = (next: TPlanEstimate) =>
        exceedsApproval(next, approved) ||
        (unasked && !next.modest && !startsUnasked(next)) ||
        Boolean(asksAnyway?.(next));
      setPhase(RUN_PHASES.QUEUED);
      const queuedAt = performance.now();
      await acquireSlot(() => undefined, abandoned);
      shared.holdsSlot = true;
      const queuedMs = performance.now() - queuedAt;
      try {
        if (sharedRuns.get(key) !== shared) {
          throw new AnalysisRunError("Cancelled", "cancelled");
        }
        if (plannedAt !== publications) {
          setPhase(RUN_PHASES.PLANNING);
          estimate = setEstimate(
            await Promise.race([planRun(runId, source, query, true), abandoned])
          );
          plannedAt = publications;
          // Approved at one price, planned again at another: past what was
          // agreed it asks again.
          if (asksAgain(estimate)) {
            unasked = startsUnasked(estimate);
            await confirmWithoutSlot();
            unasked ||= automaticApproval;
            approved = estimate.decodedBytes;
            if (sharedRuns.get(key) !== shared) {
              throw new AnalysisRunError("Cancelled", "cancelled");
            }
          }
        }
        setPhase(RUN_PHASES.RUNNING);
        let publication = plannedAt;
        const read = () =>
          // Abandoning frees the slot at once; the worker stops on cancelRun.
          Promise.race([
            executeRun(runId, source, (partial) => {
              markRun(partial, shared, publication);
              shared.latestPartial = partial;
              shared.listeners.forEach((listener) => listener(partial));
            }),
            abandoned,
          ]);
        let result!: TAnalysisResult;
        // New data arrived between planning and reading: plan again here
        // rather than tell the scientist to; ask again only past the price
        // they agreed to (or a modest plan that no longer is).
        for (let attempt = 0, settled = false; !settled; attempt++) {
          try {
            result = await read();
            settled = true;
          } catch (error) {
            if (attempt >= STALE_REPLANS || !isStalePlan(error)) {
              throw error;
            }
            setPhase(RUN_PHASES.PLANNING);
            estimate = setEstimate(
              await Promise.race([
                planRun(runId, source, query, true),
                abandoned,
              ])
            );
            publication = publications;
            if (asksAgain(estimate)) {
              unasked = startsUnasked(estimate);
              await confirmWithoutSlot();
              unasked ||= automaticApproval;
              approved = estimate.decodedBytes;
              if (sharedRuns.get(key) !== shared) {
                throw new AnalysisRunError("Cancelled", "cancelled");
              }
            }
            setPhase(RUN_PHASES.RUNNING);
          }
        }
        result.counters.queuedMs = queuedMs;
        markRun(result, shared, publication);
        // Unless a publication since touched the dates it read.
        if (!shared.republished.length && !publishedFor(publication, query)) {
          // Under the query it read, whatever key the run was asked by.
          cacheResult(queryKey(source, query), result);
        }
        plannedBytes.set(result, estimate.decodedBytes);
        return result;
      } finally {
        if (shared.holdsSlot) {
          shared.holdsSlot = false;
          releaseSlot();
        }
      }
    } finally {
      shared.ended = true;
      if (sharedRuns.get(key) === shared) {
        sharedRuns.delete(key);
      }
      detachedRuns.delete(shared.runId);
    }
  })();
  return shared;
}

/**
 * A window becoming a snapshot: what its values are, decided now with this
 * dataset's metadata, so another dataset's same-named variable does not
 * reinterpret them.
 */
function keepMeaning(
  w: TPlotWindow,
  variables: Record<string, { standardName?: string }>
) {
  const r = w.result;
  if (!r) {
    return;
  }
  // Frozen with the values: the next dataset's catalog may call a field of the
  // same name an anomaly, or an ocean temperature. The name and the units'
  // meaning are frozen each on its own.
  const standardName = standardNameOf(r, variables) ?? "";
  const meaning = /on_scale|difference/.test(r.unitsMetadata ?? "")
    ? undefined
    : (temperatureMetadata(r, standardName) ??
      (r.units && converter(r.units, "K")
        ? "temperature: on_scale"
        : undefined));
  if (r.standardName === standardName && !meaning) {
    return;
  }
  w.result = markRaw({
    ...r,
    standardName,
    ...(meaning ? { unitsMetadata: meaning } : {}),
  });
}

/**
 * A result's CF standard name: as frozen with it (a snapshot's, or a
 * closed plot's kept for Undo), else as the open dataset describes it.
 */
export function standardNameOf(
  result: Pick<TAnalysisResult, "standardName" | "query">,
  variables: Record<string, { standardName?: string }>
) {
  return result.standardName !== undefined
    ? result.standardName || undefined
    : variables[result.query.variable]?.standardName;
}

/** Initial draft of a window from the map's current settings. */
/** The draft of a plot restored from a link: its request as it was. */
function draftOfRestored(
  restored: Omit<TAnalysisQuery, "source">
): TPlotWindow["draft"] {
  return {
    geometry: restored.geometry,
    variable: restored.variable,
    time: restored.time,
    level: restored.level,
    fixed: restored.fixed,
    sectionSamples: restored.sectionSamples ?? 400,
    minCoverage: restored.minCoverage,
    binDegrees: restored.binDegrees,
    valueBins: restored.valueBins,
  };
}

function draftFrom(
  kind: TAnalysisKind,
  geometry: TGeometry,
  summary: TVariableSummary,
  map: TMapSettings
): TPlotDraft {
  const fixed: Record<string, number> = {};
  for (const { dimension, size } of summary.others) {
    fixed[dimension] = Math.min(
      size - 1,
      Math.max(0, map.indices[dimension] ?? 0)
    );
  }
  const timeLength = summary.time?.raw.length ?? 0;
  const timeIndex = summary.time
    ? Math.min(timeLength - 1, map.indices[summary.time.dimension] ?? 0)
    : 0;
  const series = TIME_RANGE_KINDS.includes(kind);
  return {
    geometry,
    variable: summary.variable,
    time: summary.time
      ? series
        ? { start: 0, stop: timeLength }
        : { start: timeIndex, stop: timeIndex + 1 }
      : undefined,
    level: summary.vertical
      ? Math.min(
          summary.vertical.values.length - 1,
          map.indices[summary.vertical.dimension] ?? 0
        )
      : undefined,
    fixed,
    sectionSamples: 400,
  };
}

export const useAnalysisStore = defineStore("analysis", {
  // eslint-disable-next-line max-lines-per-function
  state: () => ({
    windows: [] as TPlotWindow[],
    nextZ: 10,
    labelCounters: {} as Record<string, number>,
    focusedId: undefined as string | undefined,
    drawMode: DRAW_MODES.NONE as TDrawMode,
    shapeEdit: undefined as TShapeEdit | undefined,
    drawKind: undefined as TAnalysisKind | undefined,
    /** A place along a path plot: from its chart, or (`fromMap`) its route. */
    pathHover: undefined as TPathHover | undefined,
    drawVertices: [] as { lat: number; lon: number }[],
    /**
     * Pairs of edges of the polygon being drawn that cross (edge k from
     * point k to point k + 1, the closing edge included): none to finish.
     */
    drawCrossings: [] as [number, number][],
    /** While a box is drawn: the pointer's place, its opposite corner. */
    drawHover: undefined as { lat: number; lon: number } | undefined,
    /**
     * The box a drag describes so far (its swept longitude, a pole it
     * reached) and what it will compute: "270° of longitude, 10°N–40°N".
     */
    drawBox: undefined as TGeometry | undefined,
    drawBoxLabel: "",
    /** The box being drawn on a latitude/longitude map, on screen (px). */
    drawBoxScreen: undefined as
      { x0: number; y0: number; x1: number; y1: number } | undefined,
    /** Elsewhere, the box being drawn as clipped to the visible map (px). */
    drawBoxOutline: undefined as { x: number; y: number }[] | undefined,
    /** Window whose geometry is being edited by drawing, if any. */
    drawTargetId: undefined as string | undefined,
    /** Window whose country is being chosen again on the map, if any. */
    countryFor: undefined as string | undefined,
    rotationBeforeDrawing: undefined as boolean | undefined,
    hintSeen: readHintSeen(),
    /** The URL's plots were reopened once for this page. */
    urlRestored: false,
    /**
     * The URL's plots wait to be read: no write may replace them. Set from the
     * address the page opened with, before anything can write it.
     */
    restorePending: incomingPlots(),
    /** The plot closed last, for Undo. */
    recentlyClosed: undefined as
      { window: TPlotWindow; at: number } | undefined,
    activeSource: undefined as TRunSource | undefined,
    /** Large reads: ask first, or start them (up to a cap). */
    computeMode: computeMode as TComputeMode,
    /**
     * What each variable of the current source can plot, by source key and
     * variable (`${key}|${variable}`): recorded by every description, kept
     * when windows close, dropped when the source changes. Menus read it;
     * they never borrow a window's summary.
     */
    summaries: {} as Record<string, TVariableSummary>,
    /** Store and dataset of each variable: a JSON index may mix stores. */
    variableSources: {} as Record<
      string,
      {
        store: string;
        dataset: string;
        file?: File;
        standardName?: string;
        units?: string;
        /** A coordinate, bound or formula term: not a field to plot. */
        support?: boolean;
        /** Its dimensions and shape, when listed (no request made). */
        dims?: string[];
        shape?: number[];
        /** CF `axis` ("E" names ensemble members). */
        axis?: string;
      }
    >,
    activeSourceRef: undefined as TSourceRef | undefined,
    activeDatasetName: "",
    announcement: "",
    /** A plot whose map outline is briefly highlighted (its ID hovered). */
    highlightId: undefined as string | undefined,
    /** What the link holds, for the Share dialog. */
    link: { plots: 0, leftOut: [] as string[], edited: 0, tooLong: false },
    /**
     * A chart found or suggested for the next plot: what to turn on once
     * it opens. Taken by the next window opened within two minutes.
     */
    nextTurnOn: undefined as { turnOn: TTurnOn; at: number } | undefined,
    /** A right-click's place, marked on the map while the dial is open. */
    pendingStart: undefined as { lat: number; lon: number } | undefined,
    /** The country chosen in the country panel, outlined before a plot exists. */
    countryPreview: undefined as TCountryGeometry | undefined,
    /** The imported shape being chosen, outlined before a plot exists. */
    shapePreview: undefined as TShapeGeometry | undefined,
    /** While a country is chosen on the map: the country under the pointer. */
    countryHover: undefined as TCountryGeometry | undefined,
    compare: undefined as TCompare | undefined,
  }),
  getters: {
    visibleWindows: (state) => state.windows.filter((w) => !w.minimized),
  },
  actions: {
    /**
     * A generation for a newly loaded dataset, or undefined when these are
     * the datasources already bound (the layer remounted).
     */
    bindDatasources(sources: object | undefined) {
      if (sources && sources === boundDatasources) {
        return undefined;
      }
      boundDatasources = sources;
      // Another source (or generation): its variables are described anew.
      this.summaries = {};
      return ++sourceGeneration;
    },

    /** The recorded description of a variable of this source, if any. */
    summaryOf(sourceKey: string | undefined, variable: string) {
      return sourceKey ? this.summaries[`${sourceKey}|${variable}`] : undefined;
    },

    /**
     * Describe a variable, remembering the source so it can be released.
     * With an owner window, closing it cancels the description.
     */
    describe(source: TRunSource, variable: string, owner?: string) {
      openedSources.set(source.key, source);
      // Recorded under the variable described (not a window's committed
      // one), and only while its source is still the current generation.
      const record = (summary: TVariableSummary) => {
        if (openedSources.has(source.key)) {
          this.summaries[`${source.key}|${variable}`] = markRaw(summary);
        }
        return summary;
      };
      if (!owner) {
        return describeVariable(source, variable).then(record);
      }
      describing.get(owner)?.abort();
      const controller = new AbortController();
      describing.set(owner, controller);
      const done = () => {
        if (describing.get(owner) === controller) {
          describing.delete(owner);
        }
      };
      // A minimized window waits for the ones on screen (a large session).
      const later = this.windows.find((w) => w.id === owner)?.minimized;
      const answer = describeVariable(
        source,
        variable,
        controller.signal,
        later ? 1 : 0
      ).then(record);
      void answer.finally(done).catch(() => undefined);
      return answer;
    },

    /**
     * The live source published time steps `from`..`to`. Results that read
     * any of them are recomputed when asked for again, from chunks read
     * afresh; other results and chunks stay cached.
     */
    // eslint-disable-next-line max-lines-per-function
    livePublished(from: number, to: number) {
      const source = this.activeSource;
      if (!source) {
        return;
      }
      publications++;
      published.push({ at: publications, from, to });
      if (published.length > 256) {
        published.shift();
      }
      // A run already reading those steps keeps its windows, but a window
      // asking from now on gets a run of its own, reading afresh.
      for (const [key, run] of [...sharedRuns]) {
        if (
          key.startsWith(`${source.key}|`) &&
          run.phase === RUN_PHASES.RUNNING &&
          queryReads(run.query, from, to)
        ) {
          sharedRuns.delete(key);
          detachedRuns.set(run.runId, run);
        }
      }
      // Every run reading those steps remembers it, for all it gives later.
      for (const run of detachedRuns.values()) {
        if (
          run.key.startsWith(`${source.key}|`) &&
          queryReads(run.query, from, to)
        ) {
          run.republished.push([from, to]);
        }
      }
      for (const [key, entry] of resultCache) {
        if (
          key.startsWith(`${source.key}|`) &&
          readsSteps(entry.result, from, to)
        ) {
          dropCached(key);
        }
      }
      for (const w of this.windows) {
        const kept = continuing.get(w.id);
        if (kept && readsSteps(kept, from, to)) {
          republished.set(kept, [...(republished.get(kept) ?? []), [from, to]]);
        }
        if (w.result && readsSteps(w.result, from, to)) {
          staleResults.add(w.result);
          republished.set(w.result, [
            ...(republished.get(w.result) ?? []),
            [from, to],
          ]);
        }
        // Wind, partners and members read those steps too: shown until the
        // plot is read again, then read again with it.
        for (const c of Object.values(w.companions ?? {})) {
          if (
            c &&
            Object.values(c.results ?? {}).some((r) => readsSteps(r, from, to))
          ) {
            c.stale = true;
          }
        }
      }
      sourcePublished(source, from, to);
    },

    setActiveSource(
      source: TRunSource | undefined,
      ref: TSourceRef | undefined,
      name: string,
      variableSources: Record<
        string,
        {
          store: string;
          dataset: string;
          file?: File;
          standardName?: string;
          /** A coordinate, bound or formula term: not a field to plot. */
          support?: boolean;
          dims?: string[];
          shape?: number[];
          axis?: string;
        }
      > = {}
    ) {
      const previous = this.activeSource;
      if (previous && previous.key !== source?.key) {
        // Pending work bound to the old source stops; finished results stay
        // with their windows as snapshots.
        const prefix = `${previous.key}|`;
        for (const w of this.windows) {
          if (w.source.key.startsWith(prefix)) {
            this.cancel(w.id);
            w.snapshot = true;
            keepMeaning(w, this.variableSources);
          }
        }
        for (const [key, opened] of openedSources) {
          if (key.startsWith(prefix)) {
            releaseSource(opened);
            openedSources.delete(key);
          }
        }
        // The old dataset may have changed behind the same address.
        for (const key of [...resultCache.keys()]) {
          if (key.startsWith(prefix)) {
            dropCached(key);
          }
        }
      }
      this.variableSources = variableSources;
      this.activeSource = source;
      this.activeSourceRef = ref;
      this.activeDatasetName = name;
    },

    /** The run source of one variable of the active dataset. */
    sourceFor(variable: string): TRunSource | undefined {
      const base = this.activeSource;
      if (!base) {
        return undefined;
      }
      const own = this.variableSources[variable] ?? base;
      return {
        key: `${base.key}|${own.store}|${own.dataset}`,
        store: own.store,
        dataset: own.dataset,
        format: base.format,
        file: own.file,
        ...(base.routes ? { routes: base.routes } : {}),
        // The catalog level read, said in Method and provenance.
        ...(base.level ? { level: base.level } : {}),
      };
    },

    markHintSeen() {
      this.hintSeen = true;
      try {
        localStorage.setItem(HINT_KEY, "1");
      } catch {
        // storage unavailable: the hint simply shows again next time
      }
    },

    focus(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      if (w) {
        w.z = ++this.nextZ;
        this.focusedId = id;
      }
    },

    /** Compare in front of the plots (opened, restored or clicked). */
    raiseCompare() {
      const compare = this.compare;
      if (compare && compare.z !== this.nextZ) {
        this.compare = { ...compare, z: ++this.nextZ };
      }
    },

    // eslint-disable-next-line max-lines-per-function
    async openWindow(
      kind: TAnalysisKind,
      geometry: TGeometry,
      map: TMapSettings,
      rect: TPlotWindow["rect"],
      restored?: Omit<TAnalysisQuery, "source">,
      emergeFrom?: TPlotWindow["emergeFrom"],
      /** How a shared window showed its plot (checked by cleanView). */
      view?: Partial<TPlotWindow>
    ) {
      const source = this.sourceFor(restored?.variable ?? map.variable);
      if (!source || !this.activeSourceRef) {
        return;
      }
      const prefix = LABEL_PREFIX[kind];
      this.labelCounters[prefix] = (this.labelCounters[prefix] ?? 0) + 1;
      const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      this.windows.push({
        id,
        label: `${prefix}${this.labelCounters[prefix]}`,
        kind,
        source,
        sourceRef: this.activeSourceRef,
        datasetName: this.activeDatasetName,
        snapshot: false,
        draft: {
          geometry,
          variable: map.variable,
          fixed: {},
          sectionSamples: 400,
        },
        changed: false,
        status: PLOT_STATUS.LOADING,
        revision: 0,
        rect,
        z: ++this.nextZ,
        minimized: false,
        maximized: false,
        showSettings: false,
        showTable: false,
        paused: false,
        ...(emergeFrom ? { emergeFrom } : {}),
        ...view,
        ...takeTurnOn(
          this,
          Boolean(restored),
          pairCandidates(this.variableSources, map.variable)
        ),
        opening: markRaw({
          map: { ...map, indices: { ...map.indices } },
          restored,
        }),
      });
      this.focusedId = id;
      this.markHintSeen();
      await this.prepare(id);
    },

    /**
     * Describe the variable and set the draft from the opening request,
     * then run. Retry after a failed description comes here again.
     */
    async prepare(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      if (!w?.opening || w.snapshot) {
        return;
      }
      const { map, restored } = w.opening;
      const kind = w.kind;
      w.status = PLOT_STATUS.LOADING;
      w.message = undefined;
      try {
        const summary = await this.describe(
          w.source,
          restored?.variable ?? map.variable,
          id
        );
        // Closed (or frozen as a snapshot) while describing: nothing to do.
        if (w.snapshot || !this.windows.includes(w)) {
          return;
        }
        w.summary = markRaw(summary);
      } catch (error) {
        if (w.snapshot || !this.windows.includes(w)) {
          return;
        }
        w.status = PLOT_STATUS.ERROR;
        w.message = (error as Error).message;
        return;
      }
      w.opening = undefined;
      w.anchor = map.indices[w.summary.time?.dimension ?? ""];
      w.draft = restored
        ? draftOfRestored(restored)
        : draftFrom(kind, w.draft.geometry, w.summary, map);
      const capability = w.summary.capabilities[kind];
      if (!capability.available) {
        w.status = PLOT_STATUS.UNAVAILABLE;
        w.message = capability.reason;
        w.heldIntent = restored && markRaw(restored);
        return;
      }
      await this.apply(id);
    },

    /**
     * Retry after an error: the opening request when the variable was
     * never described; otherwise the committed query, not unapplied edits.
     */
    async retry(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      if (!w || w.snapshot) {
        return;
      }
      if (w.opening) {
        await this.prepare(id);
      } else if (w.committed) {
        await this.commit(
          id,
          structuredCloneQuery(w.committed),
          w.committedBinding
        );
      }
    },

    updateDraft(id: string, patch: Partial<TPlotDraft>) {
      const w = this.windows.find((entry) => entry.id === id);
      if (!w) {
        return;
      }
      w.draft = { ...w.draft, ...patch };
      w.changed = Boolean(w.committed);
    },

    /** Drop pending edits: the draft returns to the committed query. */
    discardDraft(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      // A preview's draft is the request as asked, not its first dates.
      const query = w?.preview?.intent ?? w?.committed;
      if (!w || !query) {
        return;
      }
      w.draft = {
        geometry: JSON.parse(JSON.stringify(query.geometry)),
        variable: query.variable,
        time: query.time && { ...query.time },
        level: query.level,
        fixed: { ...query.fixed },
        sectionSamples: query.sectionSamples ?? w.draft.sectionSamples,
        minCoverage: query.minCoverage,
        // A custom band width or bin count returns with the rest.
        binDegrees: query.binDegrees,
        valueBins: query.valueBins ?? w.draft.valueBins,
      };
      // Variable, source and summary return together.
      if (w.committedBinding) {
        w.source = w.committedBinding.source;
        w.summary = w.committedBinding.summary;
      }
      w.bindingRevision = (w.bindingRevision ?? 0) + 1;
      w.changed = false;
    },

    async useMapSettings(id: string, map: TMapSettings) {
      const w = this.windows.find((entry) => entry.id === id);
      if (!w || !w.summary) {
        return;
      }
      const revision = (w.bindingRevision ?? 0) + 1;
      w.bindingRevision = revision;
      if (map.variable !== w.draft.variable) {
        const source = this.sourceFor(map.variable) ?? w.source;
        try {
          const summary = markRaw(
            await this.describe(source, map.variable, id)
          );
          // A later edit (another variable, Discard) wins over this answer.
          if (w.bindingRevision !== revision) {
            return;
          }
          w.source = source;
          w.summary = summary;
        } catch (error) {
          w.message = (error as Error).message;
          return;
        }
      }
      const fresh = draftFrom(w.kind, w.draft.geometry, w.summary, map);
      this.updateDraft(id, {
        ...fresh,
        // One-time plots take the map's time; range plots keep theirs.
        time: TIME_RANGE_KINDS.includes(w.kind) ? w.draft.time : fresh.time,
      });
    },

    /** Commit the draft as a new immutable query and run it. */

    // eslint-disable-next-line max-lines-per-function
    async apply(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      if (!w || w.snapshot) {
        return;
      }
      // Never described (its first description failed): Retry starts over
      // from the opening request, not from an empty draft.
      if (w.opening) {
        await this.prepare(id);
        return;
      }
      // An edited polygon that crosses itself is not applied: the last plot
      // stays, and Settings marks the crossing edges.
      if (
        w.draft.geometry.kind === GEOMETRY_KINDS.POLYGON &&
        polygonCrossings(w.draft.geometry.vertices).length
      ) {
        return;
      }
      const query: TAnalysisQuery = {
        version: ALGORITHM_VERSION,
        kind: w.kind,
        // Provenance names the catalog level this variable is read from.
        source: withLevel(
          w.sourceRef,
          this.sourceFor(w.draft.variable) ?? w.source,
          w.draft.variable
        ),
        variable: w.draft.variable,
        geometry: JSON.parse(JSON.stringify(w.draft.geometry)),
        time: w.draft.time && {
          ...w.draft.time,
          ...(w.draft.time.runs
            ? { runs: w.draft.time.runs.map(([a, b]) => [a, b]) }
            : {}),
        },
        level: w.draft.level,
        fixed: { ...w.draft.fixed },
        analysisOrder:
          w.summary?.overviews.find(
            (overview) => overview.variable === w.draft.variable
          )?.order ?? w.summary?.order,
        sectionSamples: PATH_KINDS.includes(w.kind)
          ? w.draft.sectionSamples
          : undefined,
        minCoverage:
          w.kind === ANALYSIS_KINDS.REGION_SERIES
            ? w.draft.minCoverage
            : undefined,
        binDegrees:
          w.kind === ANALYSIS_KINDS.HOVMOLLER_LON ||
          w.kind === ANALYSIS_KINDS.HOVMOLLER_LAT ||
          w.kind === ANALYSIS_KINDS.LAT_VERTICAL ||
          w.kind === ANALYSIS_KINDS.LON_VERTICAL
            ? w.draft.binDegrees
            : undefined,
        valueBins:
          w.kind === ANALYSIS_KINDS.DISTRIBUTION
            ? (w.draft.valueBins ?? 30)
            : undefined,
      };
      w.changed = false;
      await this.commit(id, query);
    },

    /**
     * Follow map time: the committed query at another time, and nothing
     * else. Pending edits of location, variable or settings stay pending.
     */
    async followTime(id: string, index: number) {
      const w = this.windows.find((entry) => entry.id === id);
      const committed = w?.committed;
      if (!w || w.snapshot || !committed) {
        return;
      }
      const time = { start: index, stop: index + 1 };
      const pending = w.changed;
      w.draft = { ...w.draft, time: { ...time } };
      // The draft's time now matches the commit; other edits still differ.
      w.changed = pending;
      // Run on the committed source, not one an unapplied edit chose.
      await this.commit(
        id,
        { ...structuredCloneQuery(committed), time },
        w.committedBinding
      );
    },

    /**
     * Follow map level: the committed query at another level, and nothing
     * else (as Follow map time does for the time).
     */
    async followLevel(
      id: string,
      level: number,
      /** Read again at the same level too (a stopped plot resumed). */
      again = false
    ) {
      const w = this.windows.find((entry) => entry.id === id);
      const committed = w?.committed;
      if (
        !w ||
        w.snapshot ||
        !committed ||
        (committed.level === level && !again)
      ) {
        return;
      }
      const pending = w.changed;
      w.draft = { ...w.draft, level };
      w.changed = pending;
      await this.commit(
        id,
        { ...structuredCloneQuery(committed), level },
        w.committedBinding
      );
    },

    /** Make `query` the window's committed query and show its result. */
    async commit(
      id: string,
      query: TAnalysisQuery,
      binding?: { source: TRunSource; summary?: TVariableSummary },
      /** A first preview of a larger request (any other commit ends it). */
      preview?: TPreviewState
    ) {
      const w = this.windows.find((entry) => entry.id === id);
      if (!w) {
        return;
      }
      this.cancel(id);
      w.preview = preview;
      w.pendingExtend = undefined;
      // A request of its own replaces one held from a link.
      w.heldIntent = undefined;
      const previous = w.result;
      const { source, summary } = binding ?? w;
      const key = queryKey(source, query);
      // Read all applies to its own request only.
      if (w.autoConfirm !== key) {
        w.autoConfirm = undefined;
      }
      w.committed = query;
      w.committedBinding = markRaw({ source, summary });
      this.writeLinkSoon();
      const revision = ++w.revision;
      // Only the display threshold changed: the computed values stand.
      if (
        previous &&
        !previous.partial &&
        !isStale(previous) &&
        queryKey(source, previous.query) === key
      ) {
        w.result = presentResult(w, previous);
        w.status = PLOT_STATUS.DONE;
        return;
      }
      const cached = cachedResult(key, query);
      if (cached) {
        w.result = presentResult(w, cached);
        w.status = PLOT_STATUS.DONE;
        return;
      }
      await this.execute(id, revision, key);
    },

    /**
     * Show the first dates of a request that would wait for Compute or is
     * too large to hold: whole stored chunks around the map's date, within
     * the preview budget. False when the request has no dates to cut (it
     * then waits or fails as before).
     */
    // eslint-disable-next-line max-lines-per-function
    startPreview(
      id: string,
      priced: {
        estimate?: TPlanEstimate;
        values?: number;
        limit?: number;
        refused?: string;
        decodedBytes?: number;
      }
    ) {
      const w = this.windows.find((entry) => entry.id === id);
      const summary = w?.committedBinding?.summary ?? w?.summary;
      const chunk = summary?.time?.chunk;
      const full = w && wholeRequest(w.committed, summary);
      if (
        !w ||
        !full?.time ||
        w.preview ||
        w.autoConfirm ||
        !chunk ||
        !TIME_RANGE_KINDS.includes(w.kind)
      ) {
        return false;
      }
      const span = full.time;
      const total = rowCount(span);
      const { estimate, values } = priced;
      // A refusal names its chunks and their size: priced as such.
      const decoded = estimate?.decodedBytes ?? priced.decodedBytes;
      // Per stored chunk of the selected slices, not of the span between.
      const groups = groupsIn(span, chunk);
      const perGroup = decoded ? decoded / groups : undefined;
      const outputs = estimate?.outputValues ?? values;
      // The dates a shared link showed, once, when they are the request's:
      // within its span, cut to its own runs (inRequest) when it has them.
      const shared = w.shownRange;
      w.shownRange = undefined;
      const range =
        shared && shared.start >= span.start && shared.stop <= span.stop
          ? shared
          : previewIn(span, w.anchor, chunk, perGroup, {
              perDate: outputs ? outputs / total : undefined,
              chunksPerGroup: estimate?.chunks
                ? estimate.chunks / groupsIn(span, chunk)
                : undefined,
            });
      if (!range) {
        return false;
      }
      void this.commit(
        id,
        { ...full, time: inRequest(span, range) },
        w.committedBinding,
        markRaw(previewState(full, total, priced, perGroup))
      );
      return true;
    },

    /** More dates of a preview: as many again, later first. */
    extendDates(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      const preview = w?.preview;
      const chunk = (w?.committedBinding?.summary ?? w?.summary)?.time?.chunk;
      const shown = w?.committed?.time;
      if (!w || !preview?.intent.time || !shown || !chunk) {
        return;
      }
      const kept = w.result;
      const rows = kept?.shape[0];
      const complete = kept && !kept.partial && w.status === PLOT_STATUS.DONE;
      // After a stop or failure, Extend reaches what was asked, no further.
      const pending = complete ? w.pendingExtend : undefined;
      w.pendingExtend = undefined;
      if (pending && kept) {
        this.resumeExtend(w, kept, pending, preview);
        return;
      }
      const all = preview.intent.time;
      const most =
        kept && rows
          ? maxDatesFor(kept.values.length / rows, preview.limit)
          : undefined;
      const next = nextDates(all, shown, chunk, most);
      if (next.start === shown.start && next.stop === shown.stop) {
        return; // as many as the plot may hold
      }
      const whole = sameRange(next, all);
      const source = w.committedBinding?.source ?? w.source;
      // A complete result is kept: only the new dates are read, joined before
      // or after it.
      if (complete) {
        this.readMoreDates(w, kept, next, whole ? undefined : preview);
        return;
      }
      const query = {
        ...w.committed!,
        time: inRequest(preview.intent.time, next),
      };
      armExtend(
        w,
        queryKey(source, query),
        query.time,
        chunk,
        preview.perGroup
      );
      void this.commit(
        id,
        query,
        w.committedBinding,
        whole ? undefined : preview
      );
    },

    /** Extend after a stop or failure: on to what was asked and priced. */
    resumeExtend(
      w: TPlotWindow,
      kept: TAnalysisResult,
      pending: TPendingExtend,
      preview: TPreviewState
    ) {
      const end = pending.then ?? pending.target;
      const all = sameRange(end, preview.intent.time!);
      this.readMoreDates(
        w,
        kept,
        pending.target,
        all ? undefined : preview,
        pending.then
      );
    },

    /** Extend from a complete result: read the dates of `next` not shown. */
    readMoreDates(
      w: TPlotWindow,
      kept: TAnalysisResult,
      next: { start: number; stop: number },
      preview: TPlotWindow["preview"],
      then?: { start: number; stop: number },
      origin?: { start: number; stop: number }
    ) {
      const shown = w.committed!.time!;
      const source = w.committedBinding?.source ?? w.source;
      const all = preview?.intent.time ?? w.preview?.intent.time;
      // Dates kept from before a publication are not joined to new ones: the
      // whole range is read again, at its own price.
      if (isStale(kept)) {
        void this.commit(
          w.id,
          { ...w.committed!, time: inRequest(all, then ?? next) },
          w.committedBinding,
          preview
        );
        return;
      }
      const before = next.start < shown.start;
      const chunk = (w.committedBinding?.summary ?? w.summary)?.time?.chunk;
      const piece = extensionPiece(shown, next, chunk, all);
      const query = { ...w.committed!, time: inRequest(all, piece) };
      const key = queryKey(source, query);
      const perGroup = preview?.perGroup ?? w.preview?.perGroup;
      armExtend(w, key, query.time, chunk, perGroup);
      w.extending = markRaw({
        kept: frozenResult(kept),
        shown: { ...shown },
        target: next,
        before,
        preview,
        dates: all,
        then,
        origin: origin ?? { ...shown },
        publication: publications,
        step: { start: piece.start, stop: piece.stop },
      });
      w.status = PLOT_STATUS.PLANNING;
      void this.execute(w.id, ++w.revision, key, {
        query,
        prefix: w.extending.kept,
        before,
      });
    },

    /**
     * An Extend that stopped or failed: the plot keeps every date read. Later
     * dates read part way are kept up to where the read reached (its range
     * says exactly those); earlier ones, read from their start, only whole.
     */
    settleExtension(w: TPlotWindow, why: string) {
      const ext = w.extending;
      if (!ext) {
        return false;
      }
      w.extending = undefined;
      const partial = w.result?.partial;
      const reached =
        !ext.before && w.result && partial ? partial.readUntil : ext.shown.stop;
      const earlier = earlierRead(ext, w.committed!);
      const all = ext.dates;
      if (reached > ext.shown.stop && w.result) {
        const range = inRequest(all, { start: ext.shown.start, stop: reached });
        const query = { ...w.committed!, time: range };
        w.result = inheritAge(
          markRaw({ ...firstRows(w.result, rowCount(range)), query }),
          w.result,
          ext.kept
        );
        w.committed = query;
      } else if (earlier) {
        // Earlier dates read from their end: those beside the plot stay.
        w.result = earlier.result;
        w.committed = earlier.query;
      } else {
        // Earlier dates: every whole step is in the plot already.
        w.result = ext.kept;
      }
      const shown = w.committed!.time!;
      const added =
        rowCount(inRequest(all, shown)) - rowCount(inRequest(all, ext.origin));
      w.message = added
        ? `${why}: ${added.toLocaleString("en-US")} more ${added === 1 ? "date" : "dates"} added.`
        : `${why}: no dates added.`;
      // What was asked and priced stays the goal of the next Extend.
      if (
        shown.start > ext.target.start ||
        shown.stop < ext.target.stop ||
        ext.then
      ) {
        w.pendingExtend = { target: { ...ext.target }, then: ext.then };
      }
      w.status = PLOT_STATUS.DONE;
      w.progress = undefined;
      w.paused = false;
      return true;
    },

    /**
     * Read on after Stop: the dates not read yet, joined to those kept. The
     * request is unchanged (Settings and the link still show all of it);
     * the read was sized and chosen before, so it does not ask again.
     */
    continueRead(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      const prefix = w?.result;
      const query = w?.committed;
      const readUntil = prefix?.partial?.readUntil;
      if (
        !w ||
        !prefix ||
        !query?.time ||
        readUntil === undefined ||
        readUntil >= query.time.stop ||
        // A failed read is retried the same way.
        (w.status !== PLOT_STATUS.CANCELLED && w.status !== PLOT_STATUS.ERROR)
      ) {
        return;
      }
      const source = w.committedBinding?.source ?? w.source;
      // The kept dates join only their own request: the same query but for its
      // end, from the same source. A partial of another place (stopped, then
      // another point applied and stopped before its first values) is not this
      // request's beginning. Then this request is read from its start.
      const own =
        queryKey(source, { ...prefix.query, time: query.time }) ===
          queryKey(source, query) &&
        prefix.query.time?.start === query.time.start &&
        // The same stored rows: a prefix read for other slices is not this
        // request's beginning.
        sameSelection(prefix.query.time, query.time) &&
        JSON.stringify(prefix.query.source) === JSON.stringify(query.source);
      // Kept dates a live source has republished since are not joined to newer
      // ones: the request is read again, from one publication. A publication of
      // unread dates changes nothing. A section stopped part way through its
      // chunks holds no whole date: it is read again from its start, never
      // joined as time rows.
      const keep =
        own &&
        !prefix.partial?.chunks &&
        !prefixRepublished(prefix, query.time.start, readUntil);
      const rest = keep ? restOf(query, readUntil) : query;
      const key = queryKey(source, rest);
      // Approved already only when it is this request's continuation: a request
      // never approved (another place, a price the user cancelled) is planned
      // and priced as any. Its dates as stopped, too: a range widened since
      // (its prompt then cancelled) was never approved.
      const approved = own && prefix.query.time?.stop === query.time.stop;
      w.autoConfirm = approved ? key : undefined;
      // Up to the price that was agreed: a replacement read of republished
      // dates priced far higher is asked for.
      w.autoConfirmUpTo = approved
        ? { key, bytes: w.estimate?.decodedBytes ?? 0 }
        : undefined;
      w.status = PLOT_STATUS.PLANNING;
      if (!keep) {
        // Its beginning is not kept: the committed request, from its start.
        w.result = undefined;
      }
      const kept = keep ? frozenResult(prefix) : undefined;
      if (kept) {
        continuing.set(id, kept);
      } else {
        continuing.delete(id);
      }
      void this.execute(
        id,
        ++w.revision,
        key,
        kept ? { query: rest, prefix: kept } : undefined
      );
    },

    /** Every date asked for, at its price (the scientist chose it). */
    readAll(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      if (!w?.preview || w.preview.tooMany) {
        return;
      }
      const source = w.committedBinding?.source ?? w.source;
      const all = w.preview.intent.time;
      const shown = w.committed?.time;
      const kept = w.result;
      // Refused whole: only what is left of it, when that fits.
      if (
        w.preview.refused &&
        (kept?.partial ||
          w.status !== PLOT_STATUS.DONE ||
          remainingChunks(
            w.preview.refused,
            w.preview.total,
            shown ? rowCount(shown) : 0
          ) === undefined)
      ) {
        return;
      }
      // A complete result is kept: only the dates before and after it are read,
      // as priced.
      if (
        all &&
        shown &&
        kept &&
        !kept.partial &&
        w.status === PLOT_STATUS.DONE &&
        all.start <= shown.start &&
        shown.stop <= all.stop &&
        (all.start < shown.start || shown.stop < all.stop)
      ) {
        const both = all.start < shown.start && shown.stop < all.stop;
        const first = both ? { start: all.start, stop: shown.stop } : all;
        this.readMoreDates(
          w,
          kept,
          first,
          both ? w.preview : undefined,
          both ? all : undefined
        );
        return;
      }
      // Up to the price Read all showed: a plan made again at more asks.
      const key = queryKey(source, w.preview.intent);
      w.autoConfirm = w.preview.fullBytes ? key : undefined;
      w.autoConfirmUpTo = w.preview.fullBytes
        ? { key, bytes: w.preview.fullBytes }
        : undefined;
      void this.commit(id, w.preview.intent, w.committedBinding);
    },

    /**
     * Ask before large reads, or start them by themselves (up to
     * AUTO_COMPUTE_BYTES). Switching to Automatic starts what waits now.
     */
    setComputeMode(mode: TComputeMode) {
      computeMode = mode;
      this.computeMode = mode;
      try {
        globalThis.localStorage?.setItem(COMPUTE_MODE_KEY, mode);
      } catch {
        // Not remembered (private mode): it holds for this page.
      }
      if (mode !== "auto") {
        return;
      }
      for (const w of this.windows) {
        if (w.status === PLOT_STATUS.CONFIRM && startsUnasked(w.estimate)) {
          void this.confirm(w.id, true);
        }
        // Wind, members and a scatter partner start within the same cap
        // as the plot itself; above it they keep asking.
        for (const purpose of ["wind", "members", "pair"] as const) {
          const c = w.companions?.[purpose];
          if (
            c?.status === "confirm" &&
            c.bytes !== undefined &&
            c.bytes <= AUTO_COMPUTE_BYTES
          ) {
            this.approveCompanions(w.id, purpose);
          }
        }
      }
    },

    /** Compute a planned run that waits for confirmation, without replanning. */
    async confirm(id: string, automatic = false) {
      const binding = windowRuns.get(id);
      const shared = binding && boundRun(binding);
      if (
        shared?.runId === binding?.runId &&
        shared?.phase === RUN_PHASES.CONFIRM
      ) {
        shared.confirm(automatic);
      }
    },

    /**
     * Subscribe a window to the shared run of its committed query, or of
     * the dates after a stop (`resume`: that query, and the dates read
     * before it, which every part joins).
     */
    // eslint-disable-next-line max-lines-per-function
    async execute(
      id: string,
      revision: number,
      key: string,
      resume?: {
        query: TAnalysisQuery;
        prefix: TAnalysisResult;
        /** Extend: the dates read go before (or after) the kept ones. */
        before?: boolean;
      }
    ) {
      const current = () =>
        this.windows.find(
          (entry) => entry.id === id && entry.revision === revision
        );
      const w = current();
      if (!w) {
        return;
      }
      let shared = sharedRuns.get(key);
      if (!shared) {
        shared = createSharedRun(
          key,
          w.committedBinding?.source ?? w.source,
          resume?.query ?? w.committed!
        );
      }
      const run = shared;
      const extendedDates = resume ? w.extending?.dates : undefined;
      run.subscribers++;
      windowRuns.set(id, { key, runId: run.runId });
      w.message = undefined;
      w.progress = undefined;
      w.paused = run.paused;
      const showPhase = (phase: TRunPhase) => {
        const target = current();
        if (!target) {
          return;
        }
        // Read all was chosen (the price was seen), or reads start by
        // themselves (Automatic, under its cap): the read goes ahead.
        const limit = target.autoConfirmUpTo;
        const withinApproval =
          limit?.key !== key ||
          !run.estimate ||
          !exceedsApproval(run.estimate, limit.bytes);
        if (
          phase === RUN_PHASES.CONFIRM &&
          ((target.autoConfirm === key && withinApproval) ||
            startsUnasked(run.estimate))
        ) {
          run.confirm();
          return;
        }
        // A request that would wait for Compute shows its first dates now.
        if (
          phase === RUN_PHASES.CONFIRM &&
          !run.estimate?.needsConfirmation &&
          this.startPreview(id, { estimate: run.estimate })
        ) {
          return;
        }
        target.status = PHASE_STATUS[phase];
        target.estimate = run.estimate;
      };
      // A continued read joins once, then writes its new rows in place.
      const continued =
        resume && resume.before === undefined
          ? continueJoiner(resume.prefix)
          : undefined;
      // A forward Extend likewise: its new rows only, after the first.
      const extended =
        resume && resume.before === false
          ? extendJoiner(resume.prefix)
          : undefined;
      // Show what has been read so far; a later revision ignores old parts.
      const joined = (result: TAnalysisResult) => {
        if (!resume) {
          return result;
        }
        // Continued: the request as asked now, from the kept dates' start to
        // the rest's end (not the stopped request's end). An Extend's dates are
        // the whole selection's, not the kept prefix's was checked against [50,
        // 60), and 62 was kept and cached).
        const asked = extendedDates ?? resume.prefix.query.time;
        const rest = resume.query.time;
        const parts = continued
          ? continued(result)
          : extended
            ? extended(result)
            : extendResult(resume.prefix, result, Boolean(resume.before));
        const whole =
          asked && rest
            ? {
                ...parts,
                query: {
                  ...(continued ? resume.query : parts.query),
                  time: inRequest(
                    asked,
                    extendedDates
                      ? spanOf(resume.prefix.query.time ?? rest, rest)
                      : { start: asked.start, stop: rest.stop }
                  ),
                },
              }
            : parts;
        // As old as its oldest part, and carrying what was republished of
        // either: a publication since either reads again.
        return inheritAge(whole, resume.prefix, result);
      };
      const showPartial = (update: TAnalysisResult) => {
        const target = current();
        if (target && target.status === PLOT_STATUS.RUNNING) {
          // Earlier dates come in from their start, away from the plot: it
          // stays as it is until the step is whole.
          if (resume?.before) {
            if (target.extending) {
              target.extending.read = update;
            }
            target.progress = update.partial && {
              done: update.partial.done,
              total: update.partial.total,
            };
            return;
          }
          const partial = joined(update);
          target.result = presentResult(target, partial);
          target.progress = partial.partial && {
            done: partial.partial.done,
            total: partial.partial.total,
          };
        }
      };
      showPhase(run.phase);
      run.phaseListeners.add(showPhase);
      run.listeners.add(showPartial);
      // Joining a run under way: what it has read so far, at once.
      if (run.latestPartial) {
        showPartial(run.latestPartial);
      }
      try {
        const result = await run.promise;
        const done = current();
        const ext = done?.extending;
        // An earlier step in: the next one, until the dates asked for are.
        let after: (() => void) | undefined;
        if (done && ext) {
          done.extending = undefined;
          const time = ext.before
            ? { start: resume!.query.time!.start, stop: ext.shown.stop }
            : ext.target;
          // The request's own slices over that range (in slices: never
          // the dates between them).
          done.committed = {
            ...done.committed!,
            time: inRequest(ext.dates, time),
          };
          const whole = time.start <= ext.target.start;
          if (whole) {
            done.preview = ext.preview;
          }
          done.message = undefined;
          done.autoConfirm = undefined; // it was for these dates only
          after = !whole
            ? () =>
                this.readMoreDates(
                  done,
                  done.result!,
                  ext.target,
                  ext.preview,
                  ext.then,
                  ext.origin
                )
            : ext.then
              ? () =>
                  this.readMoreDates(done, done.result!, ext.then!, undefined)
              : undefined;
        }
        if (done) {
          const whole = joined(result);
          // A whole join is kept under the request it answers, as a single read
          // is again read 66 chunks). A publication of its dates drops it.
          const asked = done.committed;
          if (
            resume &&
            asked?.time &&
            !whole.partial &&
            !isStale(whole) &&
            (whole.time?.raw.length ?? whole.shape?.[0]) ===
              rowCount(asked.time)
          ) {
            const entry = { ...whole, query: asked };
            const epoch = resultEpoch.get(whole);
            if (epoch !== undefined) {
              resultEpoch.set(entry, epoch);
            }
            cacheResult(queryKey(shownSource(done), asked), entry);
          }
          done.result = presentResult(done, whole);
          done.status = PLOT_STATUS.DONE;
          done.progress = undefined;
          done.paused = false;
          // Read across a publication of its dates (paused, resumed, slow):
          // some values may be older than others. Read once more, from one
          // publication; if that too spans one, say so. The whole request,
          // under its own key: not a continuation's was cached as [2, 4)).
          const wholeKey = asked ? queryKey(shownSource(done), asked) : key;
          // An Extend, too, once its last step is in.
          if (isStale(whole) && !after) {
            if (refreshedAfterPublication.get(id) !== wholeKey) {
              refreshedAfterPublication.set(id, wholeKey);
              const again = done;
              // Bound to this window's revision and source: a switch, edit or
              // close meanwhile leaves it alone.
              const owner = {
                revision: again.revision,
                generation: sourceGeneration,
                source: again.source?.key,
              };
              setTimeout(() => {
                if (
                  this.windows.includes(again) &&
                  !again.snapshot &&
                  again.revision === owner.revision &&
                  sourceGeneration === owner.generation &&
                  again.source?.key === owner.source &&
                  again.status === PLOT_STATUS.DONE &&
                  again.result
                ) {
                  again.autoConfirm = wholeKey;
                  // At the price a date of the last read, for every date
                  // shown: an Extend read again whole is what was agreed,
                  // a much larger plan is asked for.
                  const last = again.estimate?.decodedBytes ?? 0;
                  const dates = (n?: number) => Math.max(1, n ?? 1);
                  again.autoConfirmUpTo = {
                    key: wholeKey,
                    bytes:
                      (last /
                        dates(
                          result.time?.raw.length ?? result.values.length
                        )) *
                      dates(whole.time?.raw.length ?? whole.values.length),
                  };
                  again.status = PLOT_STATUS.PLANNING;
                  void this.execute(id, ++again.revision, wholeKey);
                }
              });
            } else {
              done.message =
                "The source published new data for these dates while they were read twice; the newest are shown when it is read again.";
            }
          } else {
            refreshedAfterPublication.delete(id);
          }
          this.announcement = `${done.label} ${PLOT_KIND_NAMES[done.kind]} ready.`;
          // More earlier dates, or (Read all) the later ones.
          after?.();
        }
      } catch (error) {
        // Too large to hold (values, chunks, memory): the first dates.
        const refusal =
          error instanceof AnalysisRunError && error.kind === "input"
            ? sizeRefusal(error.message, error.detail)
            : undefined;
        if (!(refusal && current() && this.startPreview(id, refusal))) {
          this.fail(current(), error);
        }
      } finally {
        const settled = current();
        if (settled?.autoConfirm === key) {
          settled.autoConfirm = undefined;
        }
        run.phaseListeners.delete(showPhase);
        run.listeners.delete(showPartial);
        if (windowRuns.get(id)?.runId === run.runId) {
          windowRuns.delete(id);
        }
        // Its kept dates were joined (their records with them) or the
        // continuation ended: no longer held for it.
        if (resume && continuing.get(id) === resume.prefix) {
          continuing.delete(id);
        }
      }
    },

    /** Pause or resume a streaming series; every window on the run follows. */
    setPaused(id: string, paused: boolean) {
      const binding = windowRuns.get(id);
      const shared = binding && boundRun(binding);
      if (!shared || shared.runId !== binding.runId) {
        return;
      }
      const show = (state: boolean) => {
        shared.paused = state;
        for (const [windowId, other] of windowRuns) {
          if (other.runId === shared.runId) {
            const w = this.windows.find((entry) => entry.id === windowId);
            if (w) {
              w.paused = state;
            }
          }
        }
        setRunPaused(shared.runId, shared.source, state);
      };
      if (paused) {
        shared.resuming = false;
        show(true);
        // Its slot goes to the next plot waiting.
        if (shared.holdsSlot) {
          shared.holdsSlot = false;
          releaseSlot();
        }
        return;
      }
      if (shared.holdsSlot || shared.ended) {
        show(false);
        return;
      }
      if (!shared.resuming) {
        void resumeWithSlot(shared, () => show(false));
      }
    },

    fail(w: TPlotWindow | undefined, error: unknown) {
      if (!w) {
        return;
      }
      const kind = error instanceof AnalysisRunError ? error.kind : "failure";
      // A failed Extend keeps the plot; Extend again reads what is missing.
      if (
        kind !== "cancelled" &&
        this.settleExtension(
          w,
          `More dates could not be read (${(error as Error).message}). Extend tries again`
        )
      ) {
        this.announcement = `${w.label}: ${w.message}`;
        return;
      }
      w.status =
        kind === "cancelled" ? PLOT_STATUS.CANCELLED : PLOT_STATUS.ERROR;
      w.message =
        kind === "cancelled" ? "Cancelled." : (error as Error).message;
      w.failure = error instanceof AnalysisRunError ? error.detail : undefined;
      // Dates read before the failure stay, and Retry rest reads the others.
      const partial = w.result?.partial;
      const span = w.committed?.time;
      if (kind !== "cancelled" && w.result && partial && span) {
        w.result = frozenResult(w.result);
        w.message = `${w.message}; ${rowsBefore(span, partial.readUntil).toLocaleString("en-US")} of ${rowCount(span).toLocaleString("en-US")} dates read are kept`;
      }
      this.announcement = `${w.label}: ${w.message}`;
    },

    /** Stop this window's run; shared work continues for other windows. */
    cancel(id: string) {
      const binding = windowRuns.get(id);
      const w = this.windows.find((entry) => entry.id === id);
      if (
        w &&
        (w.status === PLOT_STATUS.RUNNING ||
          w.status === PLOT_STATUS.QUEUED ||
          w.status === PLOT_STATUS.PLANNING ||
          w.status === PLOT_STATUS.CONFIRM)
      ) {
        const asked = w.status === PLOT_STATUS.CONFIRM;
        w.revision++;
        // A stopped Extend keeps the plot with every date read (its range
        // says which); otherwise the series stops where it is.
        if (!this.settleExtension(w, "Stopped")) {
          w.status = PLOT_STATUS.CANCELLED;
          // A stopped series keeps the parts already read, frozen: a run
          // that continues for another window must not change them.
          const partial = w.result?.partial;
          if (w.result && partial) {
            w.result = frozenResult(w.result);
          }
          w.message = partial
            ? `Stopped: ${partial.done} of ${partial.total} parts read; times from ${timeLabelAt(w.summary?.time, partial.readUntil) || "there"} on were not read.`
            : asked
              ? w.result
                ? "Not computed: the chart shows the earlier request."
                : "Not computed: nothing was read."
              : "Cancelled.";
          w.paused = false;
        }
      }
      releaseCompanions(id);
      if (!binding) {
        return;
      }
      windowRuns.delete(id);
      const shared = boundRun(binding);
      // A closed window detaches only itself; the last one stops the run.
      if (shared && --shared.subscribers <= 0) {
        if (sharedRuns.get(binding.key) === shared) {
          sharedRuns.delete(binding.key);
        }
        if (w?.status === PLOT_STATUS.CANCELLED) {
          this.keepStoppedSnapshot(id, w.revision, shared);
        }
        shared.abandon();
        cancelRun(shared.runId, shared.source);
      }
    },

    /**
     * What a stopped run had read when it stopped: its last snapshot, sent as
     * it stops, kept by the stopped window. Only more of the same request,
     * while the window stays stopped as it is.
     */
    keepStoppedSnapshot(id: string, revision: number, run: TSharedRun) {
      const late = (partial: TAnalysisResult) => {
        const w = this.windows.find(
          (entry) => entry.id === id && entry.revision === revision
        );
        const shown = w?.result;
        if (
          !w ||
          w.status !== PLOT_STATUS.CANCELLED ||
          !partial.partial ||
          partial.partial.chunks ||
          (shown &&
            (JSON.stringify(shown.query.time) !==
              JSON.stringify(partial.query.time) ||
              (shown.partial?.done ?? Infinity) >= partial.partial.done))
        ) {
          return;
        }
        w.result = frozenResult(presentResult(w, partial));
        w.message = `Stopped: ${partial.partial.done} of ${partial.partial.total} parts read; times from ${timeLabelAt(w.summary?.time, partial.partial.readUntil) || "there"} on were not read.`;
      };
      run.listeners.add(late);
      void run.promise
        .catch(() => undefined)
        .finally(() => run.listeners.delete(late));
    },

    /**
     * Close a plot. A finished one can come back with Undo until the next
     * close; a running or edited one is closed after the window confirmed.
     */
    close(id: string, offerUndo = false) {
      const at = this.windows.findIndex((entry) => entry.id === id);
      const w = this.windows[at];
      if (!w) {
        return;
      }
      this.cancel(id);
      // A description still loading for it has no one left to tell.
      describing.get(id)?.abort();
      // Its downloads stop with it; minimizing (or a narrow map showing
      // only the focused plot) unmounts the window but keeps them going.
      void import("@/lib/analysis/exportClient.ts").then(
        ({ cancelDownloads }) => cancelDownloads(id)
      );
      this.windows = this.windows.filter((entry) => entry.id !== id);
      continuing.delete(id);
      // Undo may bring it back beside another dataset: its meaning goes with
      // it.
      if (offerUndo) {
        keepMeaning(w, this.variableSources);
      }
      this.recentlyClosed =
        offerUndo && w.result ? markRaw({ window: w, at }) : undefined;
      this.announcement = `${w.label} closed.`;
      this.writeLinkSoon();
      if (this.drawTargetId === id) {
        this.stopDrawing();
      }
    },

    /**
     * Whether a window's downloads may still start or be delivered: it is
     * open or minimized (unmounted), not closed. Checked after every wait.
     */
    ownsDownloads(id: string) {
      return this.windows.some((entry) => entry.id === id);
    },

    /** Show or hide wind barbs on a plot; showing reads the components. */
    setWind(id: string, on: boolean) {
      const w = this.windows.find((entry) => entry.id === id);
      if (!w) {
        return;
      }
      w.wind = on;
      if (!on) {
        releaseCompanions(id, "wind");
        // The components read go too: a window with Barbs off held both whole
        // results until it closed.
        windRead.delete(`${id}:wind`);
        w.companions = { ...w.companions, wind: undefined };
        return;
      }
      void this.loadWind(id);
    },

    /** Whether the dataset has wind components to draw barbs with. */
    windAvailable(variable: string) {
      const { pairs, reason } = windPairs(this.variableSources, variable);
      return {
        pair: pairs[0],
        pairs,
        reason,
        // None recognized: the likeliest components, to choose from.
        guess: pairs.length
          ? undefined
          : guessComponents(this.variableSources, variable),
      };
    },

    /** Barbs from chosen components, or automatic ones (no pair). */
    setWindChoice(id: string, pair: { u: string; v: string } | undefined) {
      const w = this.windows.find((entry) => entry.id === id);
      if (!w) {
        return;
      }
      w.windChoice = pair && { u: pair.u, v: pair.v };
      w.wind = true;
      void this.loadWind(id);
    },

    /**
     * Read the wind's eastward and northward components with the plot's
     * own query (same place, times and level), once its result is done.
     */
    // eslint-disable-next-line max-lines-per-function
    async loadWind(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      const query = finishedQuery(w, w?.wind);
      if (!w || !query) {
        return;
      }
      const key = queryKey(shownSource(w), query);
      const { pairs, reason, choice } = windCandidates(
        this.variableSources,
        w.windChoice,
        query.variable
      );
      const previous = w.companions?.wind;
      if (
        previous?.key === key &&
        previous.choice === choice &&
        previous.status !== "failed" &&
        previous.status !== "confirm" &&
        !previous.stale
      ) {
        return;
      }
      releaseCompanions(id, "wind");
      const generation = ++companionGeneration;
      const state = (rest: Partial<TCompanions>): TCompanions => ({
        purpose: "wind",
        key,
        status: "loading",
        choice,
        generation,
        ...rest,
      });
      this.setCompanions(id, state({}));
      const owner = `${id}:wind`;
      staleCompanions.delete(owner);
      const done = listenCost(owner, (cost) =>
        this.setCompanions(
          id,
          state({
            status: "confirm",
            stage: cost.stage,
            message: `Wind barbs: the u and v components need ${cost.text}.`,
            size: cost.size,
            bytes: cost.bytes,
          }),
          key
        )
      );
      let outcome: Awaited<ReturnType<typeof firstWindAtLevel>>;
      try {
        outcome = await firstWindAtLevel(
          id,
          pairs,
          w.result!,
          w.resultSummary ?? w.summary,
          // Still this window's current load (not closed, not superseded).
          () =>
            this.windows.find((entry) => entry.id === id)?.companions?.wind
              ?.generation === generation,
          (variable) => this.sourceFor(variable) ?? w.source,
          ({ results, progress, pair }) =>
            this.setCompanions(
              id,
              state({
                ...stillAsking(w.companions?.wind, owner),
                results,
                progress,
                current:
                  pair &&
                  isCurrentPair(
                    pair,
                    this.variableSources,
                    oceanVertical((w.resultSummary ?? w.summary)?.vertical)
                  ),
              }),
              key
            )
        );
      } finally {
        done();
      }
      // How an extension prices both components (overlayBytes).
      const own = (w.resultSummary ?? w.summary) as TAxes;
      const quote = outcome.pair
        ? await Promise.all(
            [outcome.pair.u, outcome.pair.v].map(async (variable) => ({
              owner,
              variable,
              own,
              partner: (await Promise.resolve()
                .then(() =>
                  describeVariable(
                    this.sourceFor(variable) ?? w.source,
                    variable
                  )
                )
                .catch(() => undefined)) as TAxes,
            }))
          ).then((parts) => parts.filter((part) => part.partner))
        : undefined;
      this.setCompanions(
        id,
        state(
          outcome.results
            ? {
                status: "ready",
                results: outcome.results,
                ...(quote?.length ? { quote: markRaw(quote) } : {}),
                current: isCurrentPair(
                  outcome.pair!,
                  this.variableSources,
                  oceanVertical((w.resultSummary ?? w.summary)?.vertical)
                ),
                ...(staleCompanions.has(owner) ? { stale: true } : {}),
              }
            : {
                status: "failed",
                message: outcome.message ?? reason ?? NO_WIND,
              }
        ),
        key
      );
    },

    /**
     * Store companions on a window; with `onlyFor`, only while the window
     * still waits for that query's (a newer result supersedes them).
     */
    setCompanions(id: string, companions: TCompanions, onlyFor?: string) {
      const w = this.windows.find((entry) => entry.id === id);
      const now = w?.companions?.[companions.purpose];
      if (
        !w ||
        (onlyFor && now?.key !== onlyFor) ||
        (onlyFor &&
          companions.generation !== undefined &&
          now?.generation !== companions.generation)
      ) {
        return;
      }
      w.companions = { ...w.companions, [companions.purpose]: companions };
    },

    /**
     * Write the session to the URL hash (the map's own settings kept as
     * they are). Past MAX_LINK_LENGTH the address bar keeps the map only,
     * and the Share dialog says so and offers the session file.
     */
    /**
     * The link after a burst of changes: one encoding for a restored
     * session of many plots (each commit asks), LINK_WRITE_MS after the
     * last. Share writes at once (writeLink).
     */
    writeLinkSoon() {
      clearTimeout(linkTimer);
      linkTimer = setTimeout(() => {
        // No address left to write (a page unloading, a test torn down).
        if (typeof location !== "undefined") {
          this.writeLink();
        }
      }, LINK_WRITE_MS);
    },

    writeLink() {
      clearTimeout(linkTimer);
      linkTimer = undefined;
      if (this.restorePending) {
        return;
      }
      const { session, leftOut, edited } = sessionOf(
        this.windows,
        this.compare
      );
      const encoded = session.plots.length
        ? encodedSession(session)
        : undefined;
      const hash = hashWithPlots(encoded?.value);
      const tooLong = hash.length > MAX_LINK_LENGTH;
      // The link holds the first MAX_SESSION_PLOTS, and only as many as a
      // reader unpacks (large outlines): the dialog says so.
      const past = session.plots.length - MAX_SESSION_PLOTS;
      const kept = encoded?.kept ?? 0;
      const tooBig = Math.min(session.plots.length, MAX_SESSION_PLOTS) - kept;
      this.link = {
        plots: kept,
        leftOut: [
          ...leftOut,
          ...(past > 0
            ? [
                `${past} plot${past === 1 ? "" : "s"} past the first ${MAX_SESSION_PLOTS}`,
              ]
            : []),
          ...(tooBig > 0
            ? [
                `${tooBig} plot${tooBig === 1 ? "" : "s"} whose outlines go past the ${MAX_SESSION_TEXT_BYTES / 2 ** 20} MiB a session holds`,
              ]
            : []),
        ],
        edited,
        tooLong,
      };
      history.replaceState(
        null,
        "",
        `${location.pathname}${location.search}${tooLong ? hashWithPlots(undefined) : hash}`
      );
    },

    /** The whole link, plots included however long (for a session file). */
    sessionLink() {
      const { session } = sessionOf(this.windows, this.compare);
      const hash = hashWithPlots(
        session.plots.length ? encodeSession(session) : undefined
      );
      return `${location.origin}${location.pathname}${location.search}${hash}`;
    },

    /** Scatter this plot against another variable, or stop. */
    setPair(id: string, variable: string | undefined) {
      const w = this.windows.find((entry) => entry.id === id);
      if (!w) {
        return;
      }
      w.pairWith = variable;
      if (!variable) {
        releaseCompanions(id, "pair");
        w.companions = { ...w.companions, pair: undefined };
        if (w.figure === "scatter") {
          w.figure = undefined;
        }
        return;
      }
      w.figure = "scatter";
      void this.loadPair(id);
    },

    /**
     * Read the other variable with the plot's own query (same place, times
     * and level), once its result is done; it must line up sample for
     * sample.
     */
    // eslint-disable-next-line max-lines-per-function
    async loadPair(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      const query = finishedQuery(w, w?.pairWith);
      const variable = w?.pairWith;
      if (!w || !query || !variable) {
        return;
      }
      const key = queryKey(shownSource(w), query);
      const previous = w.companions?.pair;
      if (
        previous?.key === key &&
        previous.choice === variable &&
        previous.status !== "failed" &&
        previous.status !== "confirm" &&
        !previous.stale
      ) {
        return;
      }
      releaseCompanions(id, "pair");
      const generation = ++companionGeneration;
      const state = (rest: Partial<TCompanions>): TCompanions => ({
        purpose: "pair",
        key,
        status: "loading",
        choice: variable,
        generation,
        ...rest,
      });
      this.setCompanions(id, state({}));
      const done = listenCost(`${id}:pair`, (cost) =>
        this.setCompanions(
          id,
          state({
            status: "confirm",
            stage: cost.stage,
            message: `Scatter: ${variable} needs ${cost.text}.`,
            size: cost.size,
            bytes: cost.bytes,
          }),
          key
        )
      );
      try {
        const source = this.sourceFor(variable) ?? w.source;
        const partner = await queryFor(
          w.result!,
          w.resultSummary ?? w.summary,
          source,
          variable
        );
        // Another choice (or Off) while it was described: read nothing for this
        // one.
        if (w.companions?.pair?.generation !== generation) {
          return;
        }
        const reused =
          previous?.choice === variable && !previous.stale
            ? previous.results?.raw
            : undefined;
        companionSpent.delete(`${id}:pair`);
        staleCompanions.delete(`${id}:pair`);
        const other = await partnerResult(
          `${id}:pair`,
          source,
          partner,
          reused,
          (partial) =>
            partial.partial &&
            this.setCompanions(
              id,
              state({
                progress: {
                  done: partial.partial.done,
                  total: partial.partial.total,
                },
                ...stillAsking(w.companions?.pair, `${id}:pair`),
              }),
              key
            )
        );
        // At the plot's own samples, by time or level (never by index); its
        // valid area too, for the same threshold.
        const lined = alignTo(w.result!, other);
        // Priced per plot date from a whole read; an extension keeps it.
        const spent = companionSpent.get(`${id}:pair`) ?? 0;
        const dates = w.result!.time?.raw.length ?? 0;
        const perDate = reused
          ? previous?.perDate
          : spent && dates
            ? spent / dates
            : undefined;
        const covered = other.region?.coverage
          ? alignTo(w.result!, { ...other, values: other.region.coverage })
          : undefined;
        const described = await Promise.resolve()
          .then(() => describeVariable(source, variable))
          .catch(() => undefined);
        const quote: TOverlayQuote[] | undefined = described && [
          {
            owner: `${id}:pair`,
            variable,
            own: (w.resultSummary ?? w.summary) as TAxes,
            partner: described as TAxes,
          },
        ];
        this.setCompanions(
          id,
          state(
            "values" in lined
              ? {
                  status: "ready",
                  ...(perDate ? { perDate } : {}),
                  ...(quote ? { quote: markRaw(quote) } : {}),
                  ...(staleCompanions.has(`${id}:pair`) ? { stale: true } : {}),
                  results: markRaw({
                    // As read, with the query it was read for (reused
                    // when the plot extends).
                    raw: inheritAge({ ...other, query: partner }, other),
                    other: {
                      ...other,
                      values: lined.values,
                      ...(other.region && covered && "values" in covered
                        ? {
                            region: {
                              ...other.region,
                              coverage: covered.values,
                            },
                          }
                        : {}),
                    },
                  }),
                }
              : {
                  status: "failed",
                  message: `${variable} cannot be scattered against this plot: ${lined.reason}.`,
                }
          ),
          key
        );
      } catch (error) {
        this.setCompanions(
          id,
          state({
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          }),
          key
        );
      } finally {
        done();
      }
    },

    /** Show an ensemble series' members (plume, percentiles) or not. */
    setMembers(id: string, view: TMemberView | undefined) {
      const w = this.windows.find((entry) => entry.id === id);
      if (!w) {
        return;
      }
      w.members = view;
      if (!view) {
        releaseCompanions(id, "members");
        w.companions = { ...w.companions, members: undefined };
        return;
      }
      void this.loadMembers(id);
    },

    /**
     * Read every member with the plot's own query (its member changed),
     * reusing the plot's own result for its member.
     */
    // eslint-disable-next-line max-lines-per-function
    async loadMembers(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      const query = finishedQuery(w, w?.members);
      const member = ensembleOf(w?.resultSummary ?? w?.summary);
      if (!w || !query || !member) {
        return;
      }
      const key = queryKey(shownSource(w), query);
      const previous = w.companions?.members;
      if (
        previous?.key === key &&
        previous.status !== "failed" &&
        previous.status !== "confirm" &&
        !previous.stale
      ) {
        return;
      }
      // Its members as read before an Extend: their dates are kept, unless a
      // publication since corrected them.
      const earlier =
        previous?.status === "ready" && !previous.stale
          ? previous.results
          : undefined;
      releaseCompanions(id, "members");
      const total = member.size;
      const generation = ++companionGeneration;
      const state = (rest: Partial<TCompanions>): TCompanions => ({
        purpose: "members",
        key,
        status: "loading",
        generation,
        ...rest,
      });
      if (total > MAX_MEMBERS) {
        this.setCompanions(
          id,
          state({
            status: "failed",
            message: `${total} members: more than ${MAX_MEMBERS} are not read for one plot.`,
          })
        );
        return;
      }
      this.setCompanions(id, state({ progress: { done: 0, total } }));
      // All the other members together, priced before any is read: each may be
      // modest, or under Automatic's cap, while together they are not.
      const owner = `${id}:members`;
      staleCompanions.delete(owner);
      // Each at the larger of its plan and what the first decoded: a first
      // member read from cache decoded nothing, the others will not be. After
      // an Extend, the members grow by the same dates the plot just read, not
      // by all it holds.
      const each =
        earlier && w.estimate
          ? w.estimate.decodedBytes
          : Math.max(
              w.estimate?.decodedBytes ?? 0,
              w.result?.counters?.decodedBytes ?? 0
            );
      const together = each ? each * otherMemberReads(member, each) : 0;
      const ask =
        computeMode === "auto"
          ? together > AUTO_COMPUTE_BYTES
          : together > MEMBERS_UNASKED_BYTES;
      if (ask && approvedCompanions.get(owner) !== "field") {
        this.setCompanions(
          id,
          state({
            status: "confirm",
            stage: "field",
            message: `Members: the other ${(total - 1).toLocaleString("en-US")} members need about ${formatBytes(together)} together.`,
            size: formatBytes(together),
            bytes: together,
          }),
          key
        );
        const go = await new Promise<boolean>((resolve) =>
          memberGates.set(owner, resolve)
        );
        // Let go: the gate is gone already (a newer load may hold its own).
        if (!go) {
          return;
        }
        memberGates.delete(owner);
        if (w.companions?.members?.generation !== generation) {
          return;
        }
      }
      const done = listenCost(
        `${id}:members`,
        (cost) =>
          this.setCompanions(
            id,
            state({
              status: "confirm",
              stage: cost.stage,
              message: `Members: the other ${(total - 1).toLocaleString("en-US")} members need ${cost.text}.`,
              size: cost.size,
              bytes: cost.bytes,
            }),
            key
          ),
        // Every member that reads on its own, priced together: members
        // stored with the plot's are one more pass at most.
        Math.max(1, otherMemberReads(member, each))
      );
      // Each member's plan prices the whole group: a plot with no price of its
      // own (a duplicate showing a cached result) does not start 99 modest
      // members unasked.
      const units = unitsOfQuery(query) * (total - 1);
      plannedRuns.set(owner, units);
      plannedByVariable.set(owner, new Map([[query.variable, units]]));
      const outcome = await readMembers(
        id,
        w,
        query,
        member.dimension,
        total,
        (done) =>
          this.setCompanions(
            id,
            state({
              progress: { done, total },
              ...stillAsking(w.companions?.members, owner),
            }),
            key
          ),
        earlier
      );
      done();
      this.setCompanions(
        id,
        outcome.results
          ? state({
              status: "ready",
              results: outcome.results,
              ...(staleCompanions.has(owner) ? { stale: true } : {}),
            })
          : state({ status: "failed", message: outcome.message }),
        key
      );
    },

    /** Read a companion the window was asked to confirm (once). */
    approveCompanions(id: string, purpose: TCompanionPurpose) {
      const w = this.windows.find((entry) => entry.id === id);
      const c = w?.companions?.[purpose];
      if (!w || !c || c.status !== "confirm") {
        return;
      }
      // Approves the stage shown, for every read of it waiting (all the
      // members together); a later stage is asked for again.
      const owner = `${id}:${purpose}`;
      const stage = c.stage ?? "field";
      approvedCompanions.set(owner, stage);
      if (c.bytes !== undefined) {
        approvedBytes.set(owner, c.bytes);
      } else {
        approvedBytes.delete(owner);
      }
      memberGates.get(owner)?.(true);
      w.companions = {
        ...w.companions,
        [purpose]: { ...c, status: "loading", message: undefined },
      };
      for (const [runId, wait] of [...(companionWaits.get(owner) ?? [])]) {
        if (wait.stage === stage) {
          companionWaits.get(owner)?.delete(runId);
          wait.go();
        }
      }
    },

    /** Bring back the plot closed last, where it was. */
    undoClose() {
      const closed = this.recentlyClosed;
      if (!closed) {
        return;
      }
      this.recentlyClosed = undefined;
      const w = closed.window;
      // Closed on another dataset: it comes back as a snapshot of that one,
      // left out of this dataset's link (a recipient would read other data).
      const active = this.activeSource?.key;
      if (!active || !w.source.key.startsWith(`${active}|`)) {
        w.snapshot = true;
      }
      this.windows.splice(Math.min(closed.at, this.windows.length), 0, w);
      this.focus(w.id);
      this.writeLinkSoon();
      this.announcement = `${w.label} restored.`;
    },

    patchWindow(
      id: string,
      patch: Partial<
        Pick<
          TPlotWindow,
          | "rect"
          | "restoreRect"
          | "emergeFrom"
          | "maximized"
          | "showSettings"
          | "showTable"
          | "spread"
          | "pathAxis"
          | "memberThreshold"
          | "displayUnits"
          | "chartStyle"
          | "timeView"
          | "timeWindow"
          | "timeThreshold"
          | "trend"
          | "curve"
          | "centralRange"
          | "shareAbove"
          | "shareAboveMean"
          | "figure"
          | "followMapTime"
          | "followMapLevel"
        >
      >
    ) {
      const w = this.windows.find((entry) => entry.id === id);
      if (w) {
        Object.assign(w, patch);
      }
    },

    /**
     * Highlight a plot's map outline: while its ID is hovered or focused
     * (`hold`, until `unhighlight`), else for a moment.
     */
    highlight(id: string | undefined, hold = false) {
      this.highlightId = id;
      clearTimeout(highlightTimer);
      if (id && !hold) {
        highlightTimer = setTimeout(() => {
          if (this.highlightId === id) {
            this.highlightId = undefined;
          }
        }, 1600);
      }
    },

    /** The pointer or focus left a plot's ID: its outline goes back. */
    unhighlight(id: string) {
      if (this.highlightId === id) {
        this.highlight(undefined);
      }
    },

    setMinimized(id: string, minimized: boolean) {
      const w = this.windows.find((entry) => entry.id === id);
      if (w) {
        w.minimized = minimized;
        if (!minimized) {
          this.focus(id);
        } else {
          this.announcement = `${w.label} minimized to Plotting tools.`;
        }
      }
    },

    /**
     * Edit a plot's shape on the map: its window steps aside (minimized),
     * the shape gets handles; the draft follows every move.
     */
    startShapeEdit(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      if (!w) {
        return;
      }
      const form = editableForm(w.draft.geometry);
      if (!form) {
        return;
      }
      this.shapeEdit = {
        id,
        before: w.draft.geometry,
        start: form,
        minimized: w.minimized,
      };
      // A shape edited in another form (none today: a drawn rectangle keeps
      // its traced sides).
      if (form !== w.draft.geometry) {
        this.updateDraft(id, { geometry: form });
      }
      w.showSettings = false;
      this.setMinimized(id, true);
      this.announcement = `Editing ${w.label}'s shape: drag its handles, then Apply.`;
    },

    /**
     * Choose a plot's country again on the map (25 Nov): Settings closes,
     * the plots step aside, the country bar opens at the top; choosing
     * applies it, Cancel keeps the plot as it was.
     */
    chooseCountryFor(id: string) {
      const w = this.windows.find((entry) => entry.id === id);
      if (w?.draft.geometry.kind === GEOMETRY_KINDS.COUNTRY) {
        w.showSettings = false;
        this.countryFor = id;
      }
    },

    /** Finish editing: Apply reads the new shape; Cancel restores it. */
    /** Select one point of the shape being edited (none: undefined). */
    selectEditPoint(index: number | undefined) {
      if (this.shapeEdit) {
        this.shapeEdit = { ...this.shapeEdit, selected: index };
      }
    },

    /**
     * Delete the selected point, if the shape keeps enough (an area 3, a
     * path 2); the selection goes with it.
     */
    deleteEditPoint() {
      const edit = this.shapeEdit;
      const w = edit && this.windows.find((entry) => entry.id === edit.id);
      if (!edit || !w || edit.selected === undefined) {
        return;
      }
      const next = removeVertex(w.draft.geometry, edit.selected);
      if (next) {
        this.updateDraft(w.id, { geometry: next });
        this.shapeEdit = { ...edit, selected: undefined };
      }
    },

    endShapeEdit(apply: boolean) {
      const edit = this.shapeEdit;
      this.shapeEdit = undefined;
      const w = edit && this.windows.find((entry) => entry.id === edit.id);
      if (!edit || !w) {
        return;
      }
      // Nothing moved: the shape stays as it was.
      const moved = geometryKey(w.draft.geometry) !== geometryKey(edit.start);
      if (!apply || !moved) {
        this.updateDraft(w.id, { geometry: edit.before });
      }
      this.setMinimized(w.id, edit.minimized);
      if (apply && moved) {
        void this.apply(w.id);
      }
    },

    /**
     * Open Compare with every finished time series; with fewer than two it
     * asks for places or areas, and the series made for it join it.
     */
    openCompare(view?: TCompare["view"]) {
      const ids = this.windows
        .filter(
          (w) =>
            w.result?.time &&
            !w.result.partial &&
            (w.kind === ANALYSIS_KINDS.POINT_SERIES ||
              w.kind === ANALYSIS_KINDS.REGION_SERIES)
        )
        .map((w) => w.id);
      this.compare = {
        ids,
        reference: ids[0] ?? "",
        collect: true,
        ...(view ? { view } : {}),
      };
    },

    startDrawing(
      mode: TDrawMode,
      kind: TAnalysisKind | undefined,
      first?: { lat: number; lon: number },
      targetId?: string,
      rotating?: boolean
    ) {
      this.drawMode = mode;
      this.drawKind = kind;
      this.drawVertices = first ? [first] : [];
      this.drawHover = undefined;
      this.drawTargetId = targetId;
      this.rotationBeforeDrawing = rotating;
    },

    stopDrawing() {
      this.drawMode = DRAW_MODES.NONE;
      this.drawKind = undefined;
      this.drawVertices = [];
      this.drawHover = undefined;
      this.drawBox = undefined;
      this.drawBoxLabel = "";
      this.drawBoxScreen = undefined;
      this.drawBoxOutline = undefined;
      this.drawTargetId = undefined;
    },
  },
});
