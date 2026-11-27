/**
 * What the Method dialog says about a plot, read-only: the applied
 * selection, the calculation, the weighting, the coverage, statistics of
 * what was computed, and how the data were read. Every line the window
 * used to keep under "Details" is here, in its section.
 */
import { DEFAULT_RANGE, summaryText } from "./distribution.ts";
import { bytesRead, bytesText, datesRead } from "./readStatus.ts";

import { timeLabelAt } from "@/lib/analysis/calendar.ts";
import { percentileAt } from "@/lib/analysis/distributionStats.ts";
import {
  ANALYSIS_KINDS,
  SECTION_MODES,
  type TAnalysisResult,
} from "@/lib/analysis/types.ts";
import { formatValue } from "@/utils/formatValue.ts";

/** What a row offers to do about what it says (Read details). */
export type TRowAction = "dates" | "area" | "extend";

export type TMethodSection = {
  title: string;
  rows: {
    label: string;
    value: string;
    actions?: { id: TRowAction; label: string }[];
  }[];
};

type TContext = {
  /** The plot kind's name and where ("Time series — 5.68° N, 12.40° E"). */
  selection: string;
  /** The grid and decoding, from the variable's description. */
  grid?: string;
  /** What the chart shows when not the values as computed. */
  view?: string;
  /** The central range of a distribution, in percent. */
  centralRange?: number;
  /** The catalog level read, when the dataset has several. */
  level?: string;
};

const row = (label: string, value: string | undefined) =>
  value ? [{ label, value }] : [];
const count = (n: number) => n.toLocaleString("en-US");

/** How the values were formed, by kind. */
function calculation(r: TAnalysisResult) {
  switch (r.kind) {
    case ANALYSIS_KINDS.POINT_SERIES:
      return `The stored value of one cell (${r.cell?.selection ?? "the cell at the point"}) at every date; no interpolation.`;
    case ANALYSIS_KINDS.REGION_SERIES:
      return r.region?.sites
        ? "At every date, the mean of the sites inside the area, each counted once (equal weights; missing sites left out of the mean and counted in its coverage)."
        : "At every date, the area-weighted mean of the cells whose centres lie in the area (missing cells left out of the mean and counted in its coverage).";
    case ANALYSIS_KINDS.DISTRIBUTION:
      return "At one date, the share of the valid area in each value bin; percentiles, σ and skewness from the area-weighted cell values.";
    case ANALYSIS_KINDS.PROFILE:
      return `The stored values of one cell (${r.cell?.selection ?? "the cell at the point"}) on every level at one date.`;
    case ANALYSIS_KINDS.TIME_DEPTH:
      return "The stored values of one cell on every level at every date.";
    case ANALYSIS_KINDS.SECTION:
      return r.sectionMode === SECTION_MODES.PATH
        ? `Values at ${count(r.samples?.distances.length ?? 0)} samples along the great-circle path at one date, each from the cell containing it.`
        : `A curtain: every level at ${count(r.samples?.distances.length ?? 0)} samples along the great-circle path at one date.`;
    default:
      return r.axis?.reduction ? `${r.axis.reduction}.` : "";
  }
}

/**
 * The catalog level a result was read from, as its provenance says ("2 of 3:
 * 1/physics"), not "the first".
 */
export function levelReadText(level: string | undefined) {
  // A catalog's only level is no choice to explain.
  return level && !/^1 of 1: /.test(level)
    ? `Level ${level}: plots read this one, whichever level the map shows.`
    : undefined;
}

/** The applied selection: where, when, which level and member. */
function selectionRows(r: TAnalysisResult, context: TContext) {
  const dates = datesRead(r);
  const time = r.time;
  const span =
    time && time.raw.length > 1
      ? `${timeLabelAt(time, 0)} – ${timeLabelAt(time, time.raw.length - 1)} (${count(time.raw.length)} dates)`
      : time?.raw.length
        ? timeLabelAt(time, 0)
        : undefined;
  return [
    ...row("Where", context.selection),
    ...row("Level read", context.level),
    ...row(time && time.raw.length > 1 ? "Dates" : "Date", span),
    ...row(
      "Cell",
      r.cell
        ? `${r.cell.id} (${r.cell.selection}), centre ${r.cell.lat.toFixed(r.cell.decimals ?? 3)}°, ${r.cell.lon.toFixed(r.cell.decimals ?? 3)}°`
        : undefined
    ),
    ...row(
      "Fixed",
      Object.entries(r.query.fixed ?? {})
        .map(([dim, index]) => `${dim} = ${index}`)
        .join(", ")
    ),
    ...row(
      "Read",
      dates && dates.read < dates.total
        ? `${dates.text}, through ${dates.through}`
        : undefined
    ),
  ];
}

/** Coverage: the stored footprint, valid area, and the plot's threshold. */
// eslint-disable-next-line max-lines-per-function
function coverageRows(r: TAnalysisResult) {
  const rows: TMethodSection["rows"] = [];
  if (r.region) {
    let [low, high] = [Infinity, -Infinity];
    for (const v of r.region.coverage) {
      if (Number.isFinite(v)) {
        [low, high] = [Math.min(low, v), Math.max(high, v)];
      }
    }
    rows.push(
      ...row(
        "Cells selected",
        `${r.region.totalCells} (${count(r.region.storedCells)} stored)`
      ),
      ...row(
        "Stored footprint",
        `${Math.round(r.region.footprintCoverage * 100)} % of the selection`
      ),
      ...row(
        "Cells without an area",
        r.region.unweighedCells
          ? `${count(r.region.unweighedCells)}, left out: valid area is of the cells with one, and the region's whole area is unknown`
          : undefined
      ),
      ...row(
        "Valid area per date",
        low <= high
          ? low === high
            ? `${formatValue(low * 100)} %`
            : `${formatValue(low * 100)} – ${formatValue(high * 100)} %`
          : undefined
      ),
      ...row(
        "Hidden below",
        r.query.minCoverage !== undefined
          ? `${Math.round(r.query.minCoverage * 100)} % valid area (kept in Data and exports)`
          : undefined
      )
    );
  }
  const h = r.histogram;
  if (h) {
    rows.push(
      ...row(
        "Valid area",
        `${formatValue(h.validFraction * 100)} % of ${h.unweighedCells ? `the cells with an area (${count(h.unweighedCells)} without one left out; ${count(h.validCells)} of ${count(h.selectedCells)} cells valid)` : `the selection (${count(h.validCells)} of ${count(h.selectedCells)} cells)`}`
      )
    );
  }
  return rows;
}

/** Precise values of a distribution: moments and percentiles. */
function distributionRows(r: TAnalysisResult, context: TContext) {
  const h = r.histogram;
  if (!h) {
    return [];
  }
  const u = r.units ? ` ${r.units}` : "";
  if (h.constant !== undefined) {
    return row("Every valid value", `${formatValue(h.constant)}${u}`);
  }
  const s = h.summary;
  if (!s) {
    return row("Mean", `${formatValue(h.mean)}${u}`);
  }
  const p = (q: number) => `${formatValue(percentileAt(s.percentiles, q))}${u}`;
  return [
    ...row("Mean", `${formatValue(h.mean)}${u}`),
    ...row("Median", p(50)),
    ...row("σ (population)", `${formatValue(s.std)}${u}`),
    ...row("Skewness", formatValue(s.skewness)),
    ...row("Minimum – maximum", `${p(0)} – ${p(100)}`),
    ...row("P1, P5, P10", [1, 5, 10].map(p).join(", ")),
    ...row("P25, P75", [25, 75].map(p).join(", ")),
    ...row("P90, P95, P99", [90, 95, 99].map(p).join(", ")),
    ...row(
      "Summary",
      summaryText(h, r.units, context.centralRange ?? DEFAULT_RANGE)
    ),
    ...row(
      "Smoothing",
      s.density
        ? `Gaussian kernel, bandwidth ${formatValue(s.density.bandwidth)}${u}`
        : undefined
    ),
  ];
}

/** A series' values: count, mean, extremes with their dates. */
function seriesRows(r: TAnalysisResult) {
  if (!r.time || r.histogram || r.values.length !== r.time.raw.length) {
    return [];
  }
  let n = 0;
  let undated = 0;
  let sum = 0;
  let low = -1;
  let high = -1;
  const time = r.time;
  r.values.forEach((value, at) => {
    if (Number.isFinite(value)) {
      n++;
      undated += Number.isFinite(time.raw[at]) ? 0 : 1;
      sum += value;
      low = low < 0 || value < r.values[low] ? at : low;
      high = high < 0 || value > r.values[high] ? at : high;
    }
  });
  if (!n) {
    return row("Valid dates", "none");
  }
  const u = r.units ? ` ${r.units}` : "";
  const mean = sum / n;
  let squares = 0;
  r.values.forEach((value) => {
    if (Number.isFinite(value)) {
      squares += (value - mean) ** 2;
    }
  });
  // A value on a row without a date is an extreme of unknown time, not of
  // an empty one.
  const when = (at: number) =>
    Number.isFinite(time.raw[at])
      ? `at ${timeLabelAt(time, at)}`
      : "at an unknown date";
  return [
    ...row(
      "Valid dates",
      `${count(n)} of ${count(r.values.length)}${undated ? ` (${count(undated)} without a date)` : ""}`
    ),
    ...row("Mean", `${formatValue(mean)}${u}`),
    ...row("σ (population)", `${formatValue(Math.sqrt(squares / n))}${u}`),
    ...row("Minimum", `${formatValue(r.values[low])}${u} ${when(low)}`),
    ...row("Maximum", `${formatValue(r.values[high])}${u} ${when(high)}`),
  ];
}

/** Where a read stands, from the window (the result alone cannot say). */
export type TReadState = {
  /** "Reading", "Paused", "Stopped", "First dates", "Complete"… */
  state: string;
  /** Request parts: "6 of 36". */
  parts?: string;
  /** The dates asked for, first and last (a preview reads fewer). */
  requested?: { first: string; last: string; count: number };
  /** Why Read all is not offered, when it is not, and the ways on. */
  allRefused?: string;
  allActions?: { id: TRowAction; label: string }[];
  /** How the figure is drawn (pixels holding several cells…). */
  drawing?: string[];
};

/**
 * Read diagnostics: where the read stands (dates, parts, the dates asked
 * for) and what it cost (chunks, bytes, requests, time, grid).
 */
// eslint-disable-next-line max-lines-per-function
export function readDiagnostics(
  r: TAnalysisResult,
  context: {
    grid?: string;
    read: TReadState;
    /** What opening the source downloaded, apart from this plot's reads. */
    opened?: {
      requests: number;
      bytes: number;
      unknown: number;
      uncounted?: boolean;
    };
    /** What reading the time axis whole took, apart from the field. */
    timeReads?: { reads: number; bytes: number };
  }
): TMethodSection["rows"] {
  const dates = datesRead(r);
  const time = r.time;
  return [
    ...row("State", context.read.state),
    ...row(
      "Dates read",
      dates
        ? context.read.requested && context.read.requested.count !== dates.total
          ? `${count(dates.read)} of ${count(context.read.requested.count)} asked for`
          : `${count(dates.read)} of ${count(dates.total)}`
        : undefined
    ),
    ...row("Read part", context.read.parts),
    ...row("Read all", context.read.allRefused).map((r) => ({
      ...r,
      ...(context.read.allActions?.length
        ? { actions: context.read.allActions }
        : {}),
    })),
    ...row("First date", time?.raw.length ? timeLabelAt(time, 0) : undefined),
    ...row("Read through", dates?.through || undefined),
    ...row(
      "Requested",
      context.read.requested
        ? `${context.read.requested.first} – ${context.read.requested.last}`
        : undefined
    ),
    ...readRows(r, { ...context, unmeasured: context.opened?.uncounted }),
    // Said apart: opening a NetCDF file over a server without ranges can
    // download all of it while the plot reads a few bytes.
    ...row(
      "Opening the source",
      context.opened?.uncounted
        ? "not counted: the map's NetCDF reader opens the file in a worker of its own (all of it when its server ignores range requests); plots read through it"
        : context.opened
          ? `${count(context.opened.requests)} HTTP (${bytesText(context.opened.bytes)}${context.opened.unknown ? `, ${count(context.opened.unknown)} of unknown size` : ""}), once for this source`
          : undefined
    ),
    // The time axis read whole before any field value, said apart from opening
    // the source.
    ...row(
      "Time axis",
      context.timeReads?.reads
        ? `${count(context.timeReads.reads)} stored chunk${context.timeReads.reads === 1 ? "" : "s"} (${bytesText(context.timeReads.bytes)} decoded) read to list its dates, once for this source`
        : undefined
    ),
    ...row("Drawing", context.read.drawing?.join("; ") || undefined),
  ];
}

/** How the data were read: chunks, bytes, time, cache, grid. */
function readRows(
  r: TAnalysisResult,
  context: { grid?: string; unmeasured?: boolean }
) {
  const c = r.counters;
  const bytes = bytesRead(c, context.unmeasured);
  // Times are summed over parallel reads: they can exceed the wall clock.
  const decodeMs = Math.max(0, c.readMs - c.fetchMs);
  return [
    ...row("Grid", context.grid),
    ...row(
      "Chunks read",
      c.chunkReads
        ? `${count(c.chunkReads)} stored chunk${c.chunkReads === 1 ? "" : "s"}${c.cacheHits ? `, ${count(c.cacheHits)} from the cache` : ""}${c.sharedReads ? `, ${count(c.sharedReads)} shared with another plot` : ""}`
        : undefined
    ),
    ...row("Fetched", bytes.fetched.replace(/ fetched$/, "")),
    ...row("Decoded", bytes.decoded.replace(/ decoded$/, "")),
    ...row(
      "Requests",
      context.unmeasured
        ? "not measured: the NetCDF reader requests in a worker of its own"
        : c.physicalRequests
          ? `${count(c.physicalRequests)} HTTP (${bytesText(c.physicalBytes)})`
          : undefined
    ),
    ...row(
      "Time",
      c.chunkReads
        ? `waiting for stored bytes ${(c.fetchMs / 1000).toFixed(1)} s, decompressing and decoding ${(decodeMs / 1000).toFixed(1)} s (summed over parallel reads)`
        : undefined
    ),
    ...row("Index", r.grid.indexValidation),
    ...r.grid.conflicts.map((line) => ({ label: "Note", value: line })),
  ];
}

/** The Method tab's sections, empty ones left out (reads: their own tab). */
export function methodSections(
  r: TAnalysisResult,
  context: TContext
): TMethodSection[] {
  const weighting = r.region?.weighting ?? r.histogram?.weighting;
  const sections: TMethodSection[] = [
    { title: "Selection", rows: selectionRows(r, context) },
    {
      title: "Calculation",
      rows: [
        ...row("Method", calculation(r)),
        ...row("Shown as", context.view),
        ...row("Approximation", r.approximation),
        ...r.notes.map((line) => ({ label: "Note", value: line })),
      ],
    },
    {
      title: "Weighting",
      rows: row(
        "Weights",
        weighting ?? (r.cell ? "None: one cell" : undefined)
      ),
    },
    { title: "Coverage", rows: coverageRows(r) },
    {
      title: "Statistics",
      rows: r.histogram ? distributionRows(r, context) : seriesRows(r),
    },
  ];
  return sections.filter((section) => section.rows.length);
}
