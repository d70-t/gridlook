import { durationSeconds, timeLabelAt, timeLabelOf } from "./calendar.ts";
import {
  COUNTRY_ATLAS_VERSION,
  isCountryId,
  countriesName,
  MAX_COUNTRIES,
} from "./countryAtlas.ts";
import { SHAPE_POINT_LIMIT } from "./shapeImport.ts";
import { DRAWING_SPHERE_RADIUS_METERS } from "./sphere.ts";
import { rowIndices, rowsUntil } from "./timeRows.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  GEOMETRY_KINDS,
  MAX_VALUE_BINS,
  MIN_BIN_DEGREES,
  SAMPLE_STATUS,
  SECTION_MODES,
  type TAnalysisQuery,
  type TAnalysisResult,
  countryIds,
} from "./types.ts";

import { isLocalNetCDFSource } from "@/lib/data/localNetCDF.ts";
import { isLocalZarrSource } from "@/lib/data/localZarr.ts";
import { splitSourceType, withSourceType } from "@/lib/data/sourceType.ts";

/**
 * A shareable form of a source address: protocol, host and path only. User
 * info, every query parameter and the fragment are dropped (a credential
 * can hide under any parameter name), and only network protocols count as
 * shareable. Local files and session names have no shareable address.
 */
export function publicSourceRef(src: string) {
  const reference = src.startsWith("reference+") ? "reference+" : "";
  const { format, url: address } = splitSourceType(src.slice(reference.length));
  if (isLocalZarrSource(address) || isLocalNetCDFSource(address)) {
    return { ref: address.split(/[?#]/, 1)[0], shareable: false };
  }
  if (!URL.canParse(address)) {
    // Plain session names (including test and in-memory sources).
    const ref =
      /^[\w./ -]+(?:[?#].*)?$/.test(address) && !address.startsWith("//")
        ? address.split(/[?#]/, 1)[0]
        : "session source";
    return { ref, shareable: false };
  }
  const url = new URL(address);
  if (
    !["http:", "https:", "s3:", "gs:", "az:"].includes(url.protocol) ||
    !url.host
  ) {
    return { ref: "session source", shareable: false };
  }
  return {
    ref:
      reference +
      withSourceType(`${url.protocol}//${url.host}${url.pathname}`, format),
    shareable: true,
  };
}

function csvCell(value: unknown) {
  const text =
    typeof value === "number" && Number.isNaN(value) ? "" : String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows of a result, produced on demand for the table and the CSV. */
export type TResultTable = {
  header: string[];
  rowCount: number;
  row(at: number): (string | number)[];
};

const VALUE_STATUS = {
  OK: "ok",
  MISSING: "missing",
  UNREAD: "not read",
} as const;

/** A point no stored cell holds: outside the grid, or absent from a packed source. */
export function hasNoStoredCell(result: TAnalysisResult) {
  return result.cell?.stored === false || result.cell?.id === "";
}

function missingStatus(result: TAnalysisResult, sample?: string) {
  if (hasNoStoredCell(result)) {
    return SAMPLE_STATUS.OUTSIDE;
  }
  return sample && sample !== SAMPLE_STATUS.OK ? sample : VALUE_STATUS.MISSING;
}

/** Column names the tables use themselves. */
const TABLE_COLUMNS = new Set([
  "time_index",
  "status",
  "coverage",
  "valid_cells",
  "selected_cells",
  "site_coverage",
  "valid_sites",
  "selected_sites",
  "area_std",
  "area_min",
  "area_max",
  "site_std",
  "site_min",
  "site_max",
  "share_of_valid_area",
]);

// eslint-disable-next-line max-lines-per-function
function seriesTable(result: TAnalysisResult, header: string): TResultTable {
  const time = result.time!;
  const asked = result.query.time;
  // Each row's stored index, listed once.
  const ids = asked?.runs ? rowIndices(asked) : undefined;
  const start = asked?.start ?? 0;
  // A stopped or streaming series: times from readUntil on were not read.
  const unreadFrom = result.partial
    ? rowsUntil(asked, result.partial.readUntil)
    : Infinity;
  // A forecast along its reference times: those, its valid times and the lead,
  // each named.
  const forecast = forecastColumns(result);
  return {
    header: [
      "time_index",
      `${time.dimension} (${time.units ?? "raw"})`,
      ...(forecast
        ? [
            `forecast_reference_time (${time.calendar ?? "raw"})`,
            `valid_time (${time.calendar ?? "raw"})`,
            ...(forecast.value !== undefined
              ? [`forecast_period (${forecast.units})`]
              : []),
          ]
        : [`time (${time.calendar ?? "raw"})`]),
      header,
      "status",
      // A mean of sites: shares of sites, not of an area.
      ...(result.region
        ? result.region.sites
          ? ["site_coverage", "valid_sites", "selected_sites"]
          : ["coverage", "valid_cells", "selected_cells"]
        : []),
      ...(result.region?.spread
        ? result.region.sites
          ? ["site_std", "site_min", "site_max"]
          : ["area_std", "area_min", "area_max"]
        : []),
    ],
    rowCount: result.values.length,
    row: (at) => [
      ids ? ids[at] : start + at,
      time.raw[at],
      timeLabelAt(time, at),
      ...(forecast
        ? [
            forecast.validAt(at),
            ...(forecast.value !== undefined ? [forecast.value] : []),
          ]
        : []),
      result.values[at],
      at >= unreadFrom
        ? VALUE_STATUS.UNREAD
        : Number.isNaN(result.values[at])
          ? missingStatus(result)
          : VALUE_STATUS.OK,
      ...(result.region
        ? [
            result.region.coverage[at],
            result.region.validCells[at],
            result.region.totalCells,
          ]
        : []),
      ...(result.region?.spread
        ? [
            result.region.spread.std[at],
            result.region.spread.min[at],
            result.region.spread.max[at],
          ]
        : []),
    ],
  };
}

/**
 * A forecast result's valid times (reference time plus its one lead) and
 * the lead, when its times are reference times and the lead is known.
 */
function forecastColumns(result: TAnalysisResult) {
  const time = result.time;
  // Valid times published beside the reference times: those, no lead.
  if (
    time?.standardName === "forecast_reference_time" &&
    time.valid?.length === time.raw.length
  ) {
    const valid = time.valid;
    return {
      validAt: (at: number) => timeLabelOf(time, valid[at]),
      value: undefined,
      units: undefined,
      calendar: time.calendar ?? "raw",
    };
  }
  const lead = result.selections?.find(
    (s) => s.standardName === "forecast_period" && s.value !== undefined
  );
  const perUnit = durationSeconds(time?.units);
  const seconds = lead?.seconds ?? durationSeconds(lead?.units);
  if (
    time?.standardName !== "forecast_reference_time" ||
    !lead ||
    !perUnit ||
    seconds === undefined
  ) {
    return undefined;
  }
  const shift = (lead.value! * seconds) / perUnit;
  // Each valid time on demand: a 500-row preview formats 500, not a shifted
  // copy of the whole axis.
  return {
    validAt: (at: number) => timeLabelOf(time, time.raw[at] + shift),
    value: lead.value!,
    units: lead.units ?? "raw",
    calendar: time.calendar ?? "raw",
  };
}

function sectionTable(result: TAnalysisResult, header: string): TResultTable {
  const samples = result.samples!;
  const place = (s: number) => [
    s,
    samples.distances[s],
    samples.lats[s],
    samples.lons[s],
    samples.cells[s],
  ];
  if (result.sectionMode === SECTION_MODES.PATH) {
    return {
      header: ["sample", "distance_m", "lat", "lon", "cell", header, "status"],
      rowCount: result.values.length,
      row: (s) => [...place(s), result.values[s], samples.status[s]],
    };
  }
  const vertical = result.vertical!;
  const [, nk] = result.shape;
  return {
    header: [
      "sample",
      "distance_m",
      "lat",
      "lon",
      "cell",
      "level_index",
      result.columnVertical ? "vertical (from formula)" : vertical.label,
      header,
      "status",
    ],
    rowCount: result.values.length,
    row: (at) => {
      const s = Math.floor(at / nk);
      const k = at % nk;
      return [
        ...place(s),
        k,
        result.columnVertical ? result.columnVertical[at] : vertical.values[k],
        result.values[at],
        // A section stopped part way: cells not read yet say so.
        result.partial?.chunks && !result.cellRead?.[at]
          ? VALUE_STATUS.UNREAD
          : Number.isNaN(result.values[at])
            ? samples.status[s] === "ok" || result.partial?.chunks
              ? VALUE_STATUS.MISSING
              : samples.status[s]
            : VALUE_STATUS.OK,
      ];
    },
  };
}

/** A time × axis result (time–depth, Hovmöller): one row per pair. */
// eslint-disable-next-line max-lines-per-function
function gridTable(result: TAnalysisResult, header: string): TResultTable {
  const time = result.time!;
  const axis = result.axis!;
  const [, width] = result.shape;
  const asked = result.query.time;
  const ids = asked?.runs ? rowIndices(asked) : undefined;
  const start = asked?.start ?? 0;
  const unreadFrom = result.partial
    ? rowsUntil(asked, result.partial.readUntil) * width
    : Infinity;
  const axisName = `${axis.dimension}${axis.units ? ` (${axis.units})` : ""}`;
  const cells =
    time.bounds?.length === 2 * time.raw.length ? time.bounds : undefined;
  // A forecast's valid time and lead too, as in the series table.
  const forecast = forecastColumns(result);
  // Rows run time-major: format each date once, not once per sample.
  const memo = { t: -1, text: "", valid: "" };
  const label = (t: number) => {
    if (memo.t !== t) {
      memo.t = t;
      memo.text = timeLabelAt(time, t);
      memo.valid = forecast ? forecast.validAt(t) : "";
    }
    return memo.text;
  };
  return {
    header: [
      "time_index",
      forecast
        ? `forecast_reference_time (${forecast.calendar})`
        : `time (${time.calendar ?? "raw"})`,
      `${axis.dimension}_index`,
      axisName,
      header,
      "status",
      ...(result.cellCoverage ? ["coverage"] : []),
      ...(forecast
        ? [
            `valid_time (${forecast.calendar})`,
            ...(forecast.value !== undefined
              ? [`forecast_period (${forecast.units})`]
              : []),
          ]
        : []),
      // Declared time cells, in the coordinate's units: a script too large to
      // embed its values reads them here, not from a literal.
      ...(cells ? [`${time.dimension}_low`, `${time.dimension}_high`] : []),
      // The source's own time coordinate (a script places rows by it
      // in any calendar, without embedding the time axis).
      `${time.dimension} (${time.units ?? "raw"})`,
    ],
    rowCount: result.values.length,
    row: (at) => {
      const t = Math.floor(at / width);
      const k = at % width;
      return [
        ids ? ids[t] : start + t,
        label(t),
        k,
        axis.values[k],
        result.values[at],
        at >= unreadFrom
          ? VALUE_STATUS.UNREAD
          : Number.isNaN(result.values[at])
            ? missingStatus(result, result.samples?.status[k])
            : VALUE_STATUS.OK,
        ...(result.cellCoverage ? [result.cellCoverage[at]] : []),
        ...(forecast
          ? [
              memo.valid,
              ...(forecast.value !== undefined ? [forecast.value] : []),
            ]
          : []),
        ...(cells ? [cells[2 * t], cells[2 * t + 1]] : []),
        time.raw[t],
      ];
    },
  };
}

/** Latitude × vertical: one row per (latitude bin, level). */
function latitudeVerticalTable(
  result: TAnalysisResult,
  header: string
): TResultTable {
  const axis = result.axis!;
  const vertical = result.vertical!;
  const [, nk] = result.shape;
  const bounds = axis.bounds;
  // Bins along latitude, or (a longitude section) along longitude.
  const a = axis.dimension === "longitude" ? "lon" : "lat";
  return {
    header: [
      `${a}_bin`,
      `${a} (${axis.units})`,
      `${a}_low`,
      `${a}_high`,
      "level_index",
      // The label may name its units already: "depth (m, positive down)".
      `${vertical.label}${vertical.units && vertical.physical && !vertical.label.includes(`(${vertical.units}`) ? ` (${vertical.units})` : ""}`,
      header,
      "status",
      "coverage",
    ],
    rowCount: result.values.length,
    row: (at) => {
      const b = Math.floor(at / nk);
      const k = at % nk;
      return [
        b,
        axis.values[b],
        bounds?.[b] ?? "",
        bounds?.[b + 1] ?? "",
        k,
        vertical.values[k] ?? k,
        result.values[at],
        Number.isNaN(result.values[at])
          ? VALUE_STATUS.MISSING
          : VALUE_STATUS.OK,
        result.cellCoverage?.[at] ?? "",
      ];
    },
  };
}

function histogramTable(result: TAnalysisResult): TResultTable {
  const edges = result.histogram!.edges;
  const units = result.units ? ` (${result.units})` : "";
  return {
    header: [`bin_low${units}`, `bin_high${units}`, "share_of_valid_area"],
    rowCount: result.values.length,
    row: (at) => [edges[at], edges[at + 1], result.values[at]],
  };
}

/**
 * A table whose headings are all different: a later heading the same as an
 * earlier one is renamed, `(value)` first.
 */
function distinctHeadings(table: TResultTable): TResultTable {
  const seen = new Set<string>();
  const header = table.header.map((name) => {
    let unique = name;
    for (let k = 2; seen.has(unique); k++) {
      unique = k === 2 ? `${name} (value)` : `${name} (${k})`;
    }
    seen.add(unique);
    return unique;
  });
  return { ...table, header };
}

export function resultTable(result: TAnalysisResult): TResultTable {
  return distinctHeadings(tableOf(result));
}

function tableOf(result: TAnalysisResult): TResultTable {
  const named = `${result.query.variable}${result.units ? ` (${result.units})` : ""}`;
  // Never one of the table's own columns: a unitless variable called `coverage`
  // was masked by its own values in the Python.
  const header = TABLE_COLUMNS.has(named) ? `${named} (value)` : named;
  if (result.histogram) {
    return histogramTable(result);
  }
  if (
    result.kind === ANALYSIS_KINDS.LAT_VERTICAL ||
    result.kind === ANALYSIS_KINDS.LON_VERTICAL
  ) {
    return latitudeVerticalTable(result, header);
  }
  if (result.axis && result.time) {
    return gridTable(result, header);
  }
  if (
    result.kind === ANALYSIS_KINDS.POINT_SERIES ||
    result.kind === ANALYSIS_KINDS.REGION_SERIES
  ) {
    return seriesTable(result, header);
  }
  if (result.kind === ANALYSIS_KINDS.PROFILE) {
    const vertical = result.vertical!;
    return {
      header: ["level_index", vertical.label, header, "status"],
      rowCount: result.values.length,
      row: (k) => [
        k,
        vertical.values[k],
        result.values[k],
        Number.isNaN(result.values[k])
          ? missingStatus(result)
          : VALUE_STATUS.OK,
      ],
    };
  }
  return sectionTable(result, header);
}

/**
 * The CSV in slices of rows, yielding to the page between slices so a large
 * export does not block input; join or wrap the parts in a Blob.
 */
export async function resultCsvParts(
  result: TAnalysisResult,
  rowsPerSlice = 20000
): Promise<string[]> {
  const table = resultTable(result);
  const parts = [`${table.header.map(csvCell).join(",")}\n`];
  for (let start = 0; start < table.rowCount; start += rowsPerSlice) {
    const lines: string[] = [];
    const end = Math.min(table.rowCount, start + rowsPerSlice);
    for (let at = start; at < end; at++) {
      lines.push(table.row(at).map(csvCell).join(","));
    }
    parts.push(`${lines.join("\n")}\n`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return parts;
}

/** Complete computed values; missing values are empty cells. */
export function resultToCsv(result: TAnalysisResult): string {
  const table = resultTable(result);
  const lines = [table.header.map(csvCell).join(",")];
  for (let at = 0; at < table.rowCount; at++) {
    lines.push(table.row(at).map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Reproducible query and provenance; contains no credentials or values. */
// eslint-disable-next-line max-lines-per-function
export function resultProvenance(result: TAnalysisResult) {
  // Sanitized again on the way out: a dataset name can be the raw address.
  const level = result.query.source.level;
  const source = {
    ...result.query.source,
    ref: publicSourceRef(result.query.source.ref).ref,
    // A level labelled by its store's address (saved before labels were made
    // public) loses that address's access parameters too.
    ...(level
      ? {
          level: level.replace(
            /[a-z][\w+.-]*:\/\/\S+/gi,
            (address) => publicSourceRef(address).ref
          ),
        }
      : {}),
  };
  if (
    source.name &&
    (source.name === result.query.source.ref ||
      /:\/\/|\?[^ ]+=/.test(source.name))
  ) {
    source.name = publicSourceRef(source.name).ref;
  }
  const geometry = result.query.geometry;
  return {
    format: "gridlook-analysis",
    version: ALGORITHM_VERSION,
    query: { ...result.query, source },
    source,
    ...(geometry.kind === GEOMETRY_KINDS.COUNTRY
      ? {
          countryBoundary: {
            id: countryIds(geometry).join("+"),
            name: countriesName(countryIds(geometry), geometry.resolution),
            resolution: geometry.resolution,
            atlas: COUNTRY_ATLAS_VERSION,
          },
        }
      : {}),
    variable: {
      path: result.query.variable,
      units: result.units,
      ...(result.unitsMetadata ? { unitsMetadata: result.unitsMetadata } : {}),
      ...(result.cellMethods ? { cellMethods: result.cellMethods } : {}),
      longName: result.longName,
    },
    grid: result.grid,
    decoding: result.decoding,
    time: result.time && {
      dimension: result.time.dimension,
      units: result.time.units,
      calendar: result.time.calendar,
      note: result.time.note,
      ...(result.time.standardName
        ? { standardName: result.time.standardName }
        : {}),
    },
    // The fixed choices decoded: a lead as its duration and interval, not only
    // its index.
    ...(result.selections?.length
      ? {
          selections: result.selections.map((s) => ({
            dimension: s.dimension,
            index: s.index,
            ...(s.id !== undefined ? { id: s.id } : {}),
            ...(s.value !== undefined ? { value: s.value } : {}),
            ...(s.units ? { units: s.units } : {}),
            ...(s.valueBounds ? { bounds: s.valueBounds } : {}),
            ...(s.standardName ? { standardName: s.standardName } : {}),
          })),
        }
      : {}),
    vertical: result.vertical && {
      dimension: result.vertical.dimension,
      label: result.vertical.label,
      physical: result.vertical.physical,
      note: result.vertical.note,
    },
    cell: result.cell,
    pointMethod: result.cell?.selection,
    region: result.region && {
      totalCells: result.region.totalCells,
      storedCells: result.region.storedCells,
      footprintCoverage: result.region.footprintCoverage,
      weighting: result.region.weighting,
      membership:
        "cells whose centres lie inside the selected region (no fractional clipping)",
      minCoverageDisplayed: result.query.minCoverage ?? null,
    },
    sampling: result.samples && {
      mode: result.sectionMode,
      spacingMeters: result.samples.spacingMeters,
      samples: result.samples.distances.length,
      vertices: result.samples.vertices,
      method: result.samples.method,
      rule: `${result.samples.method} of each sample on great-circle segments, endpoints and bends included; distances in metres along the path`,
    },
    completeness: result.partial
      ? {
          status: "partial",
          partsRead: result.partial.done,
          partsTotal: result.partial.total,
          readUntilTimeIndex: result.partial.readUntil,
          unread:
            "times from readUntilTimeIndex on were not read (status 'not read'), unlike measured missing values",
        }
      : { status: "complete" },
    distanceConvention: `great circles on a sphere of radius ${DRAWING_SPHERE_RADIUS_METERS} m; geodetic longitude/latitude`,
    axis: result.axis && {
      dimension: result.axis.dimension,
      label: result.axis.label,
      units: result.axis.units,
      reduction: result.axis.reduction,
    },
    distribution: result.histogram && {
      edges: result.histogram.edges,
      validFraction: result.histogram.validFraction,
      validCells: result.histogram.validCells,
      selectedCells: result.histogram.selectedCells,
      mean: result.histogram.mean,
      weighting: result.histogram.weighting,
      shares: "fraction of valid area per value bin [low, high)",
      ...(result.histogram.summary
        ? {
            std: result.histogram.summary.std,
            skewness: result.histogram.summary.skewness,
            percentiles: {
              fractions: "0 to 1 in steps of 0.005 (201 values)",
              values: result.histogram.summary.percentiles,
              rule: "area-weighted; the smallest value whose cumulative valid area reaches the fraction",
            },
            curve: {
              method:
                "Gaussian kernel density, area-weighted, Silverman bandwidth on the effective cell count, reflected at the range's ends",
              bandwidth: result.histogram.summary.density?.bandwidth,
            },
          }
        : {}),
    },
    approximation: result.approximation ?? "none",
    notes: result.notes,
    counters: result.counters,
  };
}

function toBase64Url(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0))
  );
}

const URL_VERSION = "1";
const MAX_URL_QUERY_LENGTH = 1800;

/** Compact versioned URL value for restorable queries, or undefined if too long. */
export function encodeQueriesForUrl(queries: TAnalysisQuery[]) {
  const compact = queries.map((query) => ({ ...query, source: undefined }));
  const value = `${URL_VERSION}.${toBase64Url(JSON.stringify(compact))}`;
  return value.length <= MAX_URL_QUERY_LENGTH ? value : undefined;
}

export function decodeQueriesFromUrl(
  value: string
): Omit<TAnalysisQuery, "source">[] {
  const [version, payload] = value.split(".");
  if (version !== URL_VERSION || !payload) {
    return [];
  }
  try {
    const parsed = JSON.parse(fromBase64Url(payload)) as unknown;
    return Array.isArray(parsed)
      ? parsed.slice(0, 16).filter((entry) => {
          // Each entry on its own: one malformed plot (time: null, say)
          // never discards its valid siblings.
          try {
            return validateRestoredQuery(entry);
          } catch {
            return false;
          }
        })
      : [];
  } catch {
    return [];
  }
}

/**
 * Reduce a series for display to about `buckets` buckets, at most three
 * points each: the minimum and maximum of the bucket's finite values and,
 * when the bucket has a gap, one break at the gap's position (all in time
 * order). Gaps wider than a bucket stay where they are; the work is bounded
 * however values and gaps alternate. `index` is each point's sample.
 */

/** First, lowest, highest and last valid sample of a bucket, in order. */
function bucketPicks(y: number[], from: number, to: number) {
  let first = -1;
  let final = -1;
  let minAt = -1;
  let maxAt = -1;
  for (let at = from; at < to; at++) {
    if (Number.isNaN(y[at])) {
      continue;
    }
    first = first < 0 ? at : first;
    final = at;
    if (minAt < 0 || y[at] < y[minAt]) {
      minAt = at;
    }
    if (maxAt < 0 || y[at] > y[maxAt]) {
      maxAt = at;
    }
  }
  return [...new Set([first, minAt, maxAt, final])]
    .filter((at) => at >= 0)
    .sort((p, q) => p - q);
}

/**
 * Index edges of `buckets` equal x intervals over ascending finite x (the
 * first index at or past each edge), or undefined for any other x.
 */
function xEdges(x: number[], n: number, buckets: number) {
  const [x0, x1] = [x[0], x[n - 1]];
  if (!(x1 > x0) || !Number.isFinite(x0) || !Number.isFinite(x1)) {
    return undefined;
  }
  const edges = new Int32Array(buckets + 1);
  let at = 0;
  // Each x read once: the one before is kept.
  let previous = x0;
  let current = x0;
  for (let b = 0; b <= buckets; b++) {
    const edge = b === buckets ? Infinity : x0 + ((x1 - x0) * b) / buckets;
    while (at < n && (current = x[at]) < edge) {
      if (at && !(current >= previous)) {
        return undefined;
      }
      previous = current;
      at++;
    }
    edges[b] = b === buckets ? n : at;
  }
  return edges;
}

type TBucket = {
  /** Its picks (first, lowest, highest, last of its finite values). */
  picks: number[];
  /** Their values, kept with them. */
  values: number[];
  /** The first missing sample after each pick, inside the bucket (−1). */
  gapAfter: number[];
  /** Its first missing sample (−1). */
  firstGap: number;
  /** Running state: rows up to `end` taken in, so later ones extend it. */
  end: number;
  run: TRun;
};

/** A column's first, lowest, highest and last finite rows, and gaps. */
type TRun = {
  first: number;
  final: number;
  minAt: number;
  maxAt: number;
  minV: number;
  maxV: number;
  firstV: number;
  finalV: number;
  /** The first missing row after each row that was a pick. */
  gaps: Map<number, number>;
};

const reductions = new WeakMap<
  number[],
  {
    x: number[];
    buckets: number;
    edges: Int32Array;
    read: number;
    columns: TBucket[];
  }
>();

/**
 * One column's picks and missing samples among rows [from, to), from its
 * earlier state when it had rows up to `before.end` already: only the new rows
 * are read.
 */
// eslint-disable-next-line max-lines-per-function
function bucketOf(
  y: number[],
  from: number,
  to: number,
  before?: TBucket
): TBucket {
  const run: TRun = before?.run ?? {
    first: -1,
    final: -1,
    minAt: -1,
    maxAt: -1,
    minV: Number.NaN,
    maxV: Number.NaN,
    firstV: Number.NaN,
    finalV: Number.NaN,
    gaps: new Map(),
  };
  let firstGap = before?.firstGap ?? -1;
  for (let at = before?.end ?? from; at < to; at++) {
    const v = y[at];
    if (Number.isNaN(v)) {
      firstGap = firstGap < 0 ? at : firstGap;
      for (const pick of [run.first, run.minAt, run.maxAt, run.final]) {
        if (pick >= 0 && !run.gaps.has(pick)) {
          run.gaps.set(pick, at);
        }
      }
      continue;
    }
    if (run.first < 0) {
      [run.first, run.firstV] = [at, v];
    }
    [run.final, run.finalV] = [at, v];
    if (run.minAt < 0 || v < run.minV) {
      [run.minAt, run.minV] = [at, v];
    }
    if (run.maxAt < 0 || v > run.maxV) {
      [run.maxAt, run.maxV] = [at, v];
    }
  }
  const valueOf = new Map([
    [run.first, run.firstV],
    [run.minAt, run.minV],
    [run.maxAt, run.maxV],
    [run.final, run.finalV],
  ]);
  const picks = [...new Set([run.first, run.minAt, run.maxAt, run.final])]
    .filter((at) => at >= 0)
    .sort((p, q) => p - q);
  return {
    picks,
    values: picks.map((at) => valueOf.get(at)!),
    gapAfter: picks.map((at) => run.gaps.get(at) ?? -1),
    firstGap,
    end: to,
    run,
  };
}

/**
 * The display reduction of rows [0, n) by the whole axis' columns, from
 * those of the last call on the same arrays: only the columns of the rows
 * read since are made again. Undefined where the axis is no ascending
 * finite one.
 */
// eslint-disable-next-line max-lines-per-function
function incremental(x: number[], y: number[], buckets: number, n: number) {
  let kept = reductions.get(y);
  if (!kept || kept.x !== x || kept.buckets !== buckets || kept.read > n) {
    const edges = xEdges(x, x.length, buckets);
    if (!edges) {
      return undefined;
    }
    kept = { x, buckets, edges, read: 0, columns: [] };
    reductions.set(y, kept);
  }
  const { edges, columns } = kept;
  // The column holding the last row read before, and every one after.
  let b = 0;
  while (b < buckets && edges[b + 1] <= Math.max(0, kept.read - 1)) {
    b++;
  }
  for (; b < buckets && edges[b] < n; b++) {
    const to = Math.min(edges[b + 1], n);
    const was = columns[b];
    columns[b] = bucketOf(
      y,
      edges[b],
      to,
      was && was.end <= to ? was : undefined
    );
  }
  columns.length = b;
  kept.read = n;
  const out = { x: [] as number[], y: [] as number[], index: [] as number[] };
  // The first missing sample after the last drawn one, as columns pass.
  let pending = -1;
  const mark = (gap: number) => {
    if (gap >= 0 && pending < 0) {
      pending = gap;
    }
  };
  for (const column of columns) {
    if (!column.picks.length) {
      mark(column.firstGap);
      continue;
    }
    if (column.firstGap >= 0 && column.firstGap < column.picks[0]) {
      mark(column.firstGap);
    }
    column.picks.forEach((pick, k) => {
      if (pending >= 0 && pending < pick) {
        out.x.push(x[pending]);
        out.y.push(Number.NaN);
        out.index.push(pending);
      }
      pending = -1;
      out.x.push(x[pick]);
      out.y.push(column.values[k]);
      out.index.push(pick);
      mark(column.gapAfter[k]);
    });
  }
  // A trailing gap ends the line.
  if (pending >= 0 && pending < n) {
    out.x.push(x[pending]);
    out.y.push(Number.NaN);
    out.index.push(pending);
  }
  return out;
}

// eslint-disable-next-line max-lines-per-function
export function reduceForDisplay(
  x: number[],
  y: number[],
  buckets: number,
  /** Samples read so far: the rest are not scanned (or drawn) at all. */
  read = y.length
) {
  const n = Math.min(read, y.length);
  if (n <= buckets * 3) {
    const xs = x.length === n ? x : x.slice(0, n);
    return {
      x: xs,
      y: y.length === n ? y : y.slice(0, n),
      index: xs.map((_, at) => at),
    };
  }
  // Part read of a known ascending axis: by the whole axis' columns, kept
  // between updates, only the columns new rows reach redone.
  if (n < x.length) {
    const kept = incremental(x, y, buckets, n);
    if (kept) {
      return kept;
    }
  }
  // The next missing sample at or after each index, to place line breaks.
  const nextGap = new Int32Array(n + 1).fill(n);
  for (let at = n - 1; at >= 0; at--) {
    nextGap[at] = Number.isNaN(y[at]) ? at : nextGap[at + 1];
  }
  const out = { x: [] as number[], y: [] as number[], index: [] as number[] };
  let last = -1;
  const emit = (at: number) => {
    // A missing sample between two drawn points breaks the line there, so
    // a reduced line never bridges a real gap.
    const gap = nextGap[last + 1];
    if (gap < at && !(out.y.length && Number.isNaN(out.y[out.y.length - 1]))) {
      out.x.push(x[gap]);
      out.y.push(Number.NaN);
      out.index.push(gap);
    }
    out.x.push(x[at]);
    out.y.push(y[at]);
    out.index.push(at);
    last = at;
  };
  // Buckets of equal width on the x axis (screen columns), so irregular
  // sampling keeps every peak where it is drawn; by index when x is not
  // ascending and finite. Integer index edges: (b + 1) × n / buckets is
  // exact, so the last bucket always ends at n.
  const edges = xEdges(x, n, buckets);
  for (let b = 0; b < buckets; b++) {
    const [from, to] = edges
      ? [edges[b], edges[b + 1]]
      : [Math.floor((b * n) / buckets), Math.floor(((b + 1) * n) / buckets)];
    if (to > from) {
      bucketPicks(y, from, to).forEach(emit);
    }
  }
  // A trailing gap ends the line.
  if (nextGap[last + 1] < n) {
    const gap = nextGap[last + 1];
    out.x.push(x[gap]);
    out.y.push(Number.NaN);
    out.index.push(gap);
  }
  return out;
}

const MAX_RESTORED_VERTICES = 1000;

function validLatLon(point: unknown) {
  const p = point as { lat?: unknown; lon?: unknown };
  return (
    typeof p?.lat === "number" &&
    typeof p.lon === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90
  );
}

/**
 * An imported shape: named polygons of closed [lon, lat] rings, within the
 * importer's point budget (a link's outline is no larger than an import).
 * Its digest is set again from these (shapeIdentity) before use.
 */
function validShape(
  shape: unknown,
  /** Outlines already checked in this decode (a link shares one). */
  checked?: WeakSet<object>
) {
  const s = shape as {
    name?: unknown;
    digest?: unknown;
    polygons?: unknown;
    poles?: { north?: unknown; south?: unknown };
  };
  let points = 0;
  const validRings = (polygons: unknown[]) => {
    if (checked?.has(polygons)) {
      return true;
    }
    const valid = polygons.every(
      (polygon) =>
        Array.isArray(polygon) && polygon.length > 0 && polygon.every(ring)
    );
    if (valid) {
      checked?.add(polygons);
    }
    return valid;
  };
  const ring = (r: unknown) =>
    Array.isArray(r) &&
    r.length >= 4 &&
    (points += r.length) <= SHAPE_POINT_LIMIT &&
    r.every(
      (p) =>
        Array.isArray(p) &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1]) &&
        Math.abs(p[1]) <= 90
    );
  return (
    typeof s?.name === "string" &&
    typeof s.digest === "string" &&
    (s.poles === undefined ||
      (typeof s.poles?.north === "boolean" &&
        typeof s.poles.south === "boolean")) &&
    Array.isArray(s.polygons) &&
    s.polygons.length > 0 &&
    validRings(s.polygons)
  );
}

function validVertices(vertices: unknown, minimum: number) {
  if (!Array.isArray(vertices) || vertices.length > MAX_RESTORED_VERTICES) {
    return false;
  }
  if (!vertices.every(validLatLon)) {
    return false;
  }
  const distinct = new Set(
    vertices.map((v: { lat: number; lon: number }) => `${v.lat},${v.lon}`)
  );
  return distinct.size >= minimum;
}

/**
 * A date range's stored slices, when given: two or more whole, ascending,
 * separate ranges from its start to its stop (timeRows.ts).
 */
function validRuns(range: { start?: unknown; stop?: unknown; runs?: unknown }) {
  const runs = range.runs;
  if (runs === undefined) {
    return true;
  }
  return (
    Array.isArray(runs) &&
    runs.length >= 2 &&
    runs.length <= MAX_RESTORED_VERTICES &&
    runs.every(
      (run, k) =>
        Array.isArray(run) &&
        run.length === 2 &&
        Number.isInteger(run[0]) &&
        Number.isInteger(run[1]) &&
        run[1] > run[0] &&
        (k === 0 || run[0] > (runs[k - 1] as number[])[1])
    ) &&
    runs[0][0] === range.start &&
    runs.at(-1)[1] === range.stop
  );
}

/** Whole, non-negative indices, and a half-open, non-empty time range. */
function validIndices(query: Partial<TAnalysisQuery>) {
  const index = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  const time = query.time as unknown;
  const range = time as {
    start?: unknown;
    stop?: unknown;
    runs?: unknown;
  } | null;
  return (
    (time === undefined ||
      (typeof time === "object" &&
        range !== null &&
        index(range.start) &&
        index(range.stop) &&
        (range.stop as number) > (range.start as number) &&
        validRuns(range))) &&
    (query.level === undefined || index(query.level)) &&
    (query.fixed === undefined ||
      (typeof query.fixed === "object" &&
        query.fixed !== null &&
        Object.values(query.fixed).every(index)))
  );
}

function validParameters(query: Partial<TAnalysisQuery>) {
  const { binDegrees, valueBins } = query;
  return (
    validIndices(query) &&
    (binDegrees === undefined ||
      (Number.isFinite(binDegrees) &&
        binDegrees >= MIN_BIN_DEGREES &&
        binDegrees <= 360)) &&
    (valueBins === undefined ||
      (Number.isInteger(valueBins) &&
        valueBins >= 2 &&
        valueBins <= MAX_VALUE_BINS))
  );
}

function validBox(geometry: TAnalysisQuery["geometry"] | undefined) {
  return (
    geometry?.kind === GEOMETRY_KINDS.BOX &&
    [geometry.west, geometry.east, geometry.south, geometry.north].every(
      Number.isFinite
    ) &&
    geometry.south < geometry.north &&
    Math.abs(geometry.south) <= 90 &&
    Math.abs(geometry.north) <= 90
  );
}

/** A query from a URL or file is checked before any window opens or reads. */
// eslint-disable-next-line max-lines-per-function
export function validateRestoredQuery(
  value: unknown,
  /**
   * Outlines already checked while decoding one link: plots sharing an outline
   * walk its vertices once.
   */
  checked?: WeakSet<object>
): value is Omit<TAnalysisQuery, "source"> {
  const query = value as Partial<TAnalysisQuery>;
  if (
    query?.version !== ALGORITHM_VERSION ||
    !Object.values(ANALYSIS_KINDS).includes(query.kind!) ||
    typeof query.variable !== "string" ||
    typeof query.fixed !== "object" ||
    query.fixed === null
  ) {
    return false;
  }
  if (!validParameters(query)) {
    return false;
  }
  const geometry = query.geometry as TAnalysisQuery["geometry"] | undefined;
  switch (query.kind) {
    case ANALYSIS_KINDS.POINT_SERIES:
    case ANALYSIS_KINDS.PROFILE:
    case ANALYSIS_KINDS.TIME_DEPTH:
      return geometry?.kind === GEOMETRY_KINDS.POINT && validLatLon(geometry);
    case ANALYSIS_KINDS.SECTION:
    case ANALYSIS_KINDS.HOVMOLLER_PATH:
      return (
        geometry?.kind === GEOMETRY_KINDS.POLYLINE &&
        validVertices(geometry.vertices, 2)
      );
    case ANALYSIS_KINDS.REGION_SERIES:
    case ANALYSIS_KINDS.DISTRIBUTION:
      if (geometry?.kind === GEOMETRY_KINDS.COUNTRY) {
        return (
          typeof geometry.id === "string" &&
          ["110m", "50m", "10m"].includes(geometry.resolution) &&
          isCountryId(geometry.id, geometry.resolution) &&
          (geometry.ids === undefined ||
            (Array.isArray(geometry.ids) &&
              geometry.ids.length >= 2 &&
              geometry.ids.length <= MAX_COUNTRIES &&
              geometry.ids.includes(geometry.id) &&
              geometry.ids.every(
                (id) =>
                  typeof id === "string" && isCountryId(id, geometry.resolution)
              )))
        );
      }
      if (geometry?.kind === GEOMETRY_KINDS.POLYGON) {
        return validVertices(geometry.vertices, 3);
      }
      if (geometry?.kind === GEOMETRY_KINDS.SHAPE) {
        return validShape(geometry, checked);
      }
      return validBox(geometry);
    case ANALYSIS_KINDS.HOVMOLLER_LON:
    case ANALYSIS_KINDS.HOVMOLLER_LAT:
    case ANALYSIS_KINDS.LAT_VERTICAL:
    case ANALYSIS_KINDS.LON_VERTICAL:
      return validBox(geometry);
    default:
      return false;
  }
}
