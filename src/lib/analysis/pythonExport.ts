/**
 * A Python script that redraws a plot from Gridlook's computed values with
 * pandas and matplotlib, and shows how to read the same selection from
 * the source with xarray. The values travel inside the script (as the CSV
 * export writes them) when they are few enough; otherwise the script reads
 * the CSV saved beside it.
 */
import {
  resultProvenance,
  resultTable,
  resultToCsv,
} from "./analysisExport.ts";
import { encodeTimeValue, parseTimeAxis, timeLabelAt } from "./calendar.ts";
import {
  ANALYSIS_KINDS,
  SECTION_MODES,
  type TAnalysisResult,
} from "./types.ts";

import { splitSourceType } from "@/lib/data/sourceType.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

/** Rows embedded in the script; above this it reads the CSV beside it. */
export const MAX_EMBEDDED_ROWS = 100_000;

/** A Python string literal (double-quoted, escaped). */
const py = (text: string) => JSON.stringify(text);

/** Numbers as a NumPy float array literal, NaN and infinities included. */
function pyFloats(values: ArrayLike<number>) {
  const item = (v: number) =>
    Number.isFinite(v)
      ? String(v)
      : Number.isNaN(v)
        ? "np.nan"
        : v > 0
          ? "np.inf"
          : "-np.inf";
  return `np.array([${Array.from(values, item).join(", ")}], dtype=float)`;
}

/**
 * Text for one `#` comment line: metadata may hold line breaks, and any
 * character Python or an editor ends a line at would end the comment.
 */
const oneLine = (text: string) =>
  text.replace(/[\s\u0085\u2028\u2029\v\f\0]+/g, " ").trim();

/** Calendars numpy dates keep evenly: others are plotted by raw time. */
const GREGORIAN = new Set(["standard", "gregorian", "proleptic_gregorian", ""]);
/** Before this, CF's standard calendar is Julian (numpy's is not). */
const GREGORIAN_START = "1582-10-15";

/**
 * Whether the result's times are dates numpy and matplotlib hold exactly:
 * proleptic Gregorian, or standard/Gregorian from 15 October 1582 on (the
 * mixed calendar is Julian before), in years 1 to 9999. Others are placed
 * by their source coordinate and labelled with the source calendar's dates.
 */
function hasDates(result: TAnalysisResult) {
  const time = result.time;
  if (
    !time?.raw.length ||
    !GREGORIAN.has(time.calendar ?? "") ||
    "unsupported" in parseTimeAxis(time.units, time.calendar)
  ) {
    return false;
  }
  let [lo, hi] = [0, 0];
  time.raw.forEach((value, at) => {
    lo = value < time.raw[lo] ? at : lo;
    hi = value > time.raw[hi] ? at : hi;
  });
  const [first, last] = [timeLabelAt(time, lo), timeLabelAt(time, hi)];
  const year = (label: string) => Number(/^(-?\d+)-/.exec(label)?.[1]);
  const mixed = time.calendar !== "proleptic_gregorian";
  return (
    year(first) >= 1 &&
    year(last) <= 9999 &&
    !(mixed && first < GREGORIAN_START)
  );
}

/**
 * Matplotlib date numbers (days since 1970-01-01) of raw time values, as
 * `[offset, scale]`: t = (raw − offset) × scale, in the axis' own calendar (its
 * 1970-01-01 found by encoding it), so microseconds survive and no label is
 * parsed.
 */
function dateNumbers(result: TAnalysisResult): [number, number] | undefined {
  const time = result.time!;
  const axis = parseTimeAxis(time.units, time.calendar);
  if ("unsupported" in axis) {
    return undefined;
  }
  const epoch = encodeTimeValue(axis, {
    year: 1970,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  });
  return [epoch, axis.unitSeconds / 86400];
}

/** A list of numbers as a NumPy array; missing ones `np.nan`. */
function numbers(values: number[]) {
  return `np.array([${values.map((v) => (Number.isFinite(v) ? String(v) : "np.nan")).join(", ")}])`;
}

/**
 * `t`: each row's time position. Dates (any year numpy keeps, 1500 too,
 * and their hours) as matplotlib date numbers from the date column;
 * otherwise the raw time coordinate, from its column or embedded by time
 * index. `dates` says which.
 */
function timeLines(
  result: TAnalysisResult,
  header: string[],
  columns: { label: number; raw: number }
) {
  const time = result.time!;
  const linear = hasDates(result) ? dateNumbers(result) : undefined;
  if (linear) {
    // From the raw coordinate: a missing one stays NaN, and nothing is rounded
    // to the millisecond.
    return [
      "dates = True",
      `t = (df[${py(header[columns.raw])}].to_numpy(dtype=float) - ${linear[0]}) * ${linear[1]}`,
    ];
  }
  const what = `${time.units ?? "raw"}${time.calendar ? `, ${time.calendar} calendar` : ""}`;
  return [
    "dates = False",
    `# Time (${oneLine(what)}): placed by its source coordinate, as in the`,
    "# file; ticks stand at observed times, named by their own dates in the",
    "# source calendar (no tick in a gap takes a neighbour's date).",
    `t = df[${py(header[columns.raw])}].to_numpy(dtype=float)`,
    `LABELS = df[${py(header[columns.label])}].astype(str).to_numpy()`,
    "TICKS = np.flatnonzero(np.isfinite(t))",
    "TICKS = TICKS[np.unique(t[TICKS], return_index=True)[1]]",
    "if len(TICKS) > 8:",
    "    TICKS = TICKS[np.linspace(0, len(TICKS) - 1, 8).round().astype(int)]",
    "TICK_LABELS = [str(LABELS[k]) for k in TICKS]",
    "# Seconds, then the time of day, only where some tick has them (review",
    "# of interim43: 0, 10, 20 and 30 s all read 2001-01-01).",
    'for whole, zero in ((r" \\d\\d:\\d\\d:00$", ":00"), (r" 00:00$", " 00:00")):',
    "    if TICK_LABELS and all(re.search(whole, s) for s in TICK_LABELS):",
    "        TICK_LABELS = [s.removesuffix(zero) for s in TICK_LABELS]",
    "",
  ];
}

/** Ticks of a raw time axis as the source calendar's dates. */
const cfTicks = (axis: "x" | "y") => [
  "if not dates:",
  `    ax.${axis}axis.set_major_locator(FixedLocator(t[TICKS]))`,
  `    ax.${axis}axis.set_major_formatter(FixedFormatter(TICK_LABELS))`,
];

/**
 * Declared time cells as [low, high] offsets from each step's own time, in the
 * units `t` is drawn in (days for dates, else the raw units), so gaps between
 * cells stay empty.
 */
function timeCells(
  result: TAnalysisResult,
  /**
   * Read from the table's columns (values not embedded), not a literal: the
   * headings as the table resolved them.
   */
  fromTable?: { index: string; low: string; high: string }
) {
  const time = result.time;
  const bounds = time?.bounds;
  if (!time || !bounds || bounds.length !== 2 * time.raw.length) {
    return undefined;
  }
  // Where `t` is drawn: date numbers for dates, else the raw units. Each
  // cell's ends stand on their own, whatever its centre (a missing date
  // with finite bounds is still drawn where it was observed).
  const linear = hasDates(result) ? dateNumbers(result) : undefined;
  if (hasDates(result) && !linear) {
    return undefined;
  }
  const at = (v: number) => (linear ? (v - linear[0]) * linear[1] : v);
  if (fromTable) {
    // One [low, high] per time index, in index order, as `t` is drawn.
    const cells = `df.groupby(${py(fromTable.index)})[[${py(fromTable.low)}, ${py(fromTable.high)}]].first().to_numpy(dtype=float).ravel()`;
    return linear ? `((${cells}) - ${linear[0]}) * ${linear[1]}` : cells;
  }
  return numbers(bounds.map(at));
}

/** The time axis title. */
function timeTitle(result: TAnalysisResult) {
  const time = result.time!;
  const word =
    time.standardName === "forecast_reference_time"
      ? "initialization time"
      : "time";
  return hasDates(result)
    ? `${word} (${time.calendar || "standard"})`
    : `${time.dimension} (${time.units ?? "raw"}${time.calendar ? `, ${time.calendar} calendar` : ""})`;
}

/**
 * Below the plot's coverage threshold a mean is hidden in the app: the
 * script hides it too (the CSV keeps it, with its coverage).
 */
function thresholdLines(
  result: TAnalysisResult,
  header: string[],
  value: number
) {
  const threshold = result.query.minCoverage;
  const sites = header.includes("site_coverage");
  const coverage = header.indexOf(sites ? "site_coverage" : "coverage");
  return threshold !== undefined && coverage >= 0
    ? [
        `# Means over less than ${threshold * 100} % of their ${sites ? "sites" : "area"} are hidden, as in the plot.`,
        `df.loc[df[${py(header[coverage])}] < ${threshold}, ${py(header[value])}] = float("nan")`,
      ]
    : [];
}

/** Python: each position's cell, by the app's rule (see gridLines). */
const CELLS = [
  "",
  "",
  "def cells(v, bounds=None, time=False):",
  '    """[low, high] of each position, as the app draws it: bounds; else halfway to neighbours (in time, at most half the median step)."""',
  "    v = np.asarray(v, dtype=float)",
  "    lo, hi = np.full(v.shape, np.nan), np.full(v.shape, np.nan)",
  "    if bounds is not None and len(bounds) == len(v) + 1:",
  "        b = np.asarray(bounds, dtype=float)",
  "        return np.minimum(b[:-1], b[1:]), np.maximum(b[:-1], b[1:])",
  "    if bounds is not None and len(bounds) == 2 * len(v):",
  "        # A [low, high] pair per cell: gaps between cells stay empty.",
  "        b = np.asarray(bounds, dtype=float).reshape(-1, 2)",
  "        blo, bhi = b.min(axis=1), b.max(axis=1)",
  "        # Time cells that overlap heavily (totals since one start) are drawn around their times instead, as in the app.",
  "        if not (time and heavy_overlap(blo, bhi, 4 * len(v))):",
  "            return blo, bhi",
  "    ok = np.flatnonzero(np.isfinite(v))",
  "    if not len(ok):",
  "        return lo, hi",
  "    order = ok[np.argsort(v[ok], kind='stable')]",
  "    s = v[order]",
  "    if len(s) == 1:",
  "        lo[order], hi[order] = s - 0.5, s + 0.5",
  "        return lo, hi",
  "    mid = (s[:-1] + s[1:]) / 2",
  "    own_lo = np.concatenate([[s[0] - (mid[0] - s[0])], mid])",
  "    own_hi = np.concatenate([mid, [s[-1] + (s[-1] - mid[-1])]])",
  "    if not time:",
  "        lo[order], hi[order] = own_lo, own_hi",
  "        return lo, hi",
  "    # Per stored step when storage follows the axis: across a missing position the neighbours keep their width and the gap stays empty, as in the app.",
  "    stored = np.array_equal(order, ok) or np.array_equal(order, ok[::-1])",
  "    steps = np.diff(s) / (np.abs(np.diff(order)) if stored else 1)",
  "    step = np.sort(steps)[len(steps) // 2] if len(steps) else 0.0",
  "    half = (step or 1.0) / 2",
  "    lo[order] = np.maximum(own_lo, s - half)",
  "    hi[order] = np.minimum(own_hi, s + half)",
  "    return lo, hi",
  "",
  "",
  "def heavy_overlap(lo, hi, limit):",
  '    """Whether the cells active between consecutive boundaries sum past limit (the app\'s rule)."""',
  "    keep = np.isfinite(lo) & (hi > lo)",
  "    events = sorted([(a, 1) for a in lo[keep]] + [(b, -1) for b in hi[keep]])",
  "    active = total = 0",
  "    for k, (at, step) in enumerate(events):",
  "        active += step",
  "        if active > 0 and k + 1 < len(events) and events[k + 1][0] > at:",
  "            total += active",
  "            if total > limit:",
  "                return True",
  "    return False",
  "",
  "",
];

/**
 * A two-axis result as a grid by its native indices (sample, level, time,
 * bin): an all-missing column or row stays a gap, and a vertical position
 * that varies by column (a terrain-following or hybrid level) is drawn
 * where it is. `x`/`y` are the index columns, `xs`/`ys` their positions.
 * Each cell is a rectangle as in the app: declared bin bounds (`xb`/`yb`),
 * or halfway to its neighbours but no farther than half the typical
 * spacing, so a lone bin keeps its width and an unobserved stretch of time
 * stays empty.
 */
// eslint-disable-next-line max-lines-per-function
function gridLines(
  header: string[],
  spec: {
    x: number;
    xs: string;
    y: number;
    ys: string;
    value: number;
    xb?: string;
    yb?: string;
    /** Declared time cells, [low, high] per column's (row's) time, as `t`. */
    xr?: string;
    yr?: string;
  },
  options: { down: boolean }
) {
  const c = (at: number) => `df[${py(header[at])}]`;
  return [
    ...CELLS,
    // Positions by rank, not by distance from the first index: dates in
    // separate stored slices make adjacent columns.
    `xi = np.unique(${c(spec.x)}.to_numpy(), return_inverse=True)[1].reshape(-1)`,
    `yi = np.unique(${c(spec.y)}.to_numpy(), return_inverse=True)[1].reshape(-1)`,
    "Z = np.full((yi.max() + 1, xi.max() + 1), np.nan)",
    `Z[yi, xi] = ${c(spec.value)}.to_numpy(dtype=float)`,
    `X = np.full(Z.shape, np.nan); X[yi, xi] = ${spec.xs}`,
    `Y = np.full(Z.shape, np.nan); Y[yi, xi] = ${spec.ys}`,
    `XB = ${spec.xb ?? "None"}`,
    `YB = ${spec.yb ?? "None"}`,
    "if np.isnan(Z).all():",
    '    ax.text(0.5, 0.5, "No values in this selection", ha="center", transform=ax.transAxes)',
    "else:",
    // A missing position falls back to its index, but never a time: an undated
    // cell is not drawn at 1970. A position that is not known is left out,
    // never stood in for by its index: a curtain without any pressure draws
    // nothing, not cells at 0 and 1 Pa.
    "    # Rows without a known position (or time) are left out.",
    ...(spec.xr ? [`    XB = ${spec.xr}`] : []),
    ...(spec.yr ? [`    YB = ${spec.yr}`] : []),
    "    XL, XH, YL, YH = (np.full(Z.shape, np.nan) for _ in range(4))",
    "    for r in range(Z.shape[0]):",
    `        XL[r], XH[r] = cells(X[r], XB, time=${spec.xs === "t" ? "True" : "False"})`,
    "    for k in range(Z.shape[1]):",
    `        YL[:, k], YH[:, k] = cells(Y[:, k], YB, time=${spec.ys === "t" ? "True" : "False"})`,
    "    keep = np.isfinite(Z) & np.isfinite(XL) & np.isfinite(YL)",
    "if not np.isnan(Z).all() and not keep.any():",
    "    # Values, but none at a position that can be placed (every date missing).",
    '    ax.text(0.5, 0.5, "No values at a known position", ha="center", transform=ax.transAxes)',
    "elif not np.isnan(Z).all():",
    "    corners = [(XL, YL), (XH, YL), (XH, YH), (XL, YH)]",
    "    verts = np.stack([np.stack(p, axis=-1) for p in corners], axis=-2)[keep]",
    '    mesh = PolyCollection(verts, array=Z[keep], cmap="viridis", edgecolors="none")',
    "    ax.add_collection(mesh)",
    "    ax.set_xlim(np.nanmin(XL[keep]), np.nanmax(XH[keep]))",
    "    ax.set_ylim(np.nanmin(YL[keep]), np.nanmax(YH[keep]))",
    `    fig.colorbar(mesh, ax=ax, label=${py(header[spec.value])})`,
    ...(options.down ? ["ax.invert_yaxis()"] : []),
  ];
}

/** A column's values as floats, for a grid position. */
const floats = (header: string[], at: number, scale = "") =>
  `df[${py(header[at])}].to_numpy(dtype=float)${scale}`;

/** The plotting lines for this kind of result, given its CSV columns. */
// eslint-disable-next-line max-lines-per-function
function plotLines(
  result: TAnalysisResult,
  header: string[],
  pathAxis?: "latitude"
) {
  const col = (at: number) => `df[${py(header[at])}]`;
  if (result.histogram) {
    return [
      "low, high = df.iloc[:, 0], df.iloc[:, 1]",
      'ax.bar(low, df["share_of_valid_area"] * 100, width=high - low, align="edge", edgecolor="#1d4ed8", color="#1d4ed855")',
      `ax.set_xlabel(${py(header[0].replace(/^bin_low\s*/, "value "))})`,
      'ax.set_ylabel("Share of valid area (%)")',
    ];
  }
  if (
    result.kind === ANALYSIS_KINDS.POINT_SERIES ||
    result.kind === ANALYSIS_KINDS.REGION_SERIES
  ) {
    // The field stands just before its status: forecast clocks add columns
    // before it.
    const value = header.indexOf("status") - 1;
    return [
      ...thresholdLines(result, header, value),
      ...timeLines(result, header, { label: 2, raw: 1 }),
      // In date order, as Gridlook draws it: rows stored out of order are not
      // joined back and forth, undated rows have no place on the axis.
      `raw = ${floats(header, 1)}`,
      "order = np.flatnonzero(np.isfinite(raw))",
      'order = order[np.argsort(raw[order], kind="stable")]',
      "x = t[order]",
      "# Markers keep single values between gaps visible.",
      `ax.plot(x, ${col(value)}.to_numpy(dtype=float)[order], lw=1.2, marker=".", ms=3)`,
      "if dates:",
      "    ax.xaxis_date()",
      ...cfTicks("x"),
      `ax.set_xlabel(${py(timeTitle(result))})`,
      `ax.set_ylabel(${py(header[value])})`,
    ];
  }
  if (result.kind === ANALYSIS_KINDS.PROFILE) {
    const down = result.vertical?.positive === "down";
    // In level order, as the chart connects them; rows without a known level
    // are left out.
    return [
      `lev = ${col(1)}.to_numpy(dtype=float)`,
      `val = ${col(2)}.to_numpy(dtype=float)`,
      "known = np.flatnonzero(np.isfinite(lev))",
      'order = known[np.argsort(lev[known], kind="stable")]',
      `ax.plot(val[order], lev[order], marker="o", ms=3)`,
      `ax.set_xlabel(${py(header[2])})`,
      `ax.set_ylabel(${py(header[1])})`,
      ...(down ? ["ax.invert_yaxis()"] : []),
    ];
  }
  if (result.sectionMode === SECTION_MODES.PATH) {
    // Against latitude as the window shows it, samples in walking order.
    return pathAxis === "latitude"
      ? [
          "# Markers keep single values between gaps visible; samples as walked.",
          `ax.plot(${col(2)}, ${col(5)}, marker=".", ms=3)`,
          'ax.set_xlabel("Latitude (degrees_north)")',
          `ax.set_ylabel(${py(header[5])})`,
        ]
      : [
          "# Markers keep single values between gaps visible.",
          `ax.plot(${col(1)} / 1000, ${col(5)}, marker=".", ms=3)`,
          'ax.set_xlabel("Distance along path (km)")',
          `ax.set_ylabel(${py(header[5])})`,
        ];
  }
  const down = result.vertical?.positive === "down";
  if (
    result.kind === ANALYSIS_KINDS.LAT_VERTICAL ||
    result.kind === ANALYSIS_KINDS.LON_VERTICAL
  ) {
    // Its bins' declared edges and the levels' published layers, as the chart
    // draws them.
    const edges = result.axis?.bounds;
    const layers =
      result.vertical?.bounds &&
      result.vertical.bounds.length === 2 * result.vertical.values.length
        ? result.vertical.bounds
        : undefined;
    return [
      ...gridLines(
        header,
        {
          x: 0,
          xs: floats(header, 1),
          y: 4,
          ys: floats(header, 5),
          value: 6,
          xb: edges ? numbers(edges) : undefined,
          yb: layers ? numbers(layers) : undefined,
        },
        { down }
      ),
      `ax.set_xlabel(${py(header[1])})`,
      `ax.set_ylabel(${py(header[5])})`,
    ];
  }
  if (result.samples && result.vertical) {
    // A curtain: samples along the path by distance, levels where they are, as
    // the app draws them: halfway between samples, the path's own ends (not
    // half a step past them), and published layers with their gaps.
    const d = result.samples.distances.map((m) => m / 1000);
    const pathEdges = d.length
      ? [d[0], ...d.slice(1).map((v, k) => (d[k] + v) / 2), d[d.length - 1]]
      : undefined;
    const v = result.vertical;
    const curtainLayers =
      v.physical &&
      !result.columnVertical &&
      v.bounds?.length === 2 * v.values.length
        ? v.bounds
        : undefined;
    return [
      ...gridLines(
        header,
        {
          x: 0,
          xs: floats(header, 1, " / 1000"),
          y: 5,
          ys: floats(header, 6),
          value: 7,
          xb: pathEdges ? numbers(pathEdges) : undefined,
          yb: curtainLayers ? numbers(curtainLayers) : undefined,
        },
        { down }
      ),
      'ax.set_xlabel("Distance along path (km)")',
      `ax.set_ylabel(${py(header[6])})`,
    ];
  }
  // Time × axis, oriented as in the app: time across for time–depth and
  // latitude × time; up the side for longitude × time and distance × time.
  const across =
    result.kind === ANALYSIS_KINDS.TIME_DEPTH ||
    result.kind === ANALYSIS_KINDS.HOVMOLLER_LAT;
  const distance = result.kind === ANALYSIS_KINDS.HOVMOLLER_PATH;
  const axisAt = floats(header, 3, distance ? " / 1000" : "");
  const axisTitle = distance ? "Distance along path (km)" : header[3];
  // Declared bin edges (a band of longitudes or latitudes) keep each bin's
  // width, a single one included.
  const edges = result.axis?.bounds?.map((b) => (distance ? b / 1000 : b));
  // A time–depth section's published layers: a [low, high] pair per level.
  const vertical = result.vertical;
  const layers =
    result.kind === ANALYSIS_KINDS.TIME_DEPTH &&
    vertical?.bounds &&
    vertical.bounds.length === 2 * vertical.values.length
      ? vertical.bounds
      : undefined;
  // Missing bounds as NaN, not JSON's null.
  const bounds = layers
    ? pyFloats(layers)
    : edges
      ? pyFloats(edges)
      : undefined;
  const embedded = resultTable(result).rowCount <= MAX_EMBEDDED_ROWS;
  // The cells' ends are the two columns before the raw time.
  const cells = timeCells(
    result,
    embedded
      ? undefined
      : {
          index: header[0],
          low: header[header.length - 3],
          high: header[header.length - 2],
        }
  );
  return [
    // The raw time travels as the table's last column.
    ...timeLines(result, header, { label: 1, raw: header.length - 1 }),
    ...gridLines(
      header,
      across
        ? { x: 0, xs: "t", y: 2, ys: axisAt, value: 4, yb: bounds, xr: cells }
        : { x: 2, xs: axisAt, y: 0, ys: "t", value: 4, xb: bounds, yr: cells },
      { down: across && down }
    ),
    "if dates:",
    `    ax.${across ? "x" : "y"}axis_date()`,
    ...cfTicks(across ? "x" : "y"),
    `ax.set_xlabel(${py(across ? timeTitle(result) : axisTitle)})`,
    `ax.set_ylabel(${py(across ? axisTitle : timeTitle(result))})`,
  ];
}

/**
 * How xarray opens the source: its viewer-only prefix taken off, and the engine
 * its format needs.
 */
// eslint-disable-next-line max-lines-per-function
function openLines(ref: string, level?: string, group = ""): string[] {
  // A variable in a nested group: xarray opens that group.
  const inGroup = group ? `, group=${py(group)}` : "";
  // A reference (kerchunk) file is no Zarr store: fsspec maps it to one.
  const reference = /^(?:reference|kerchunk)(?:\+|::)(.+)$/i.exec(ref);
  if (reference) {
    return [
      "# (A reference file: needs fsspec; its references point at the chunks)",
      "# import fsspec",
      `# fs = fsspec.filesystem("reference", fo=${py(reference[1])})`,
      `# ds = xr.open_dataset(fs.get_mapper(""), engine="zarr", backend_kwargs={"consolidated": False}${inGroup}, chunks={})`,
    ];
  }
  // A Gridlook catalog (JSON): the store it lists for the level read, not
  // the catalog itself; none to name, no command.
  if (/\.json(?:$|[?#])/i.test(ref)) {
    const store = /^\d+ of \d+: (\w+:\/\/\S+)$/.exec(level ?? "")?.[1];
    return store
      ? [
          `# (A catalog: the store of the level read, ${oneLine(level!)})`,
          ...openLines(store, undefined, group),
        ]
      : [
          "# (A Gridlook catalog: xarray opens the store it lists, not the catalog;",
          "#  open that store as below, with its address.)",
        ];
  }
  // Gridlook's own format prefix (`netcdf+https://…`) decides, as in the app;
  // else the file's extension.
  const { format, url } = splitSourceType(
    ref.replace(/^(?:zarr[23]?|netcdf|nc|kerchunk|reference|icechunk)::/i, "")
  );
  if (format === ZARR_FORMAT.ICECHUNK) {
    return [
      "# (Icechunk: needs the icechunk package; open the repository, then",
      `#  ds = xr.open_zarr(session.store${inGroup}) for ${oneLine(url)})`,
    ];
  }
  const netcdf =
    format === ZARR_FORMAT.NETCDF ||
    (format === undefined && /\.(nc|nc4|netcdf|h5|hdf5?)(?:$|[?#])/i.test(url));
  // A remote file by byte ranges, as Gridlook reads it: a bare URL makes
  // netCDF4 ask an OPeNDAP server for `.dds`.
  const remote = /^[a-z][\w+.-]*:\/\//i.test(url);
  return netcdf
    ? remote
      ? [
          // No engine: xarray picks one by the file's signature, so NetCDF-3
          // opens too.
          "# (NetCDF over the network: byte ranges, each reply checked; needs",
          "#  h5netcdf for NetCDF-4 or scipy for NetCDF-3, and dask)",
          "# import io, re, tempfile, urllib.error, urllib.request",
          "# class Ranges(io.RawIOBase):",
          '#     """The file by byte ranges, every reply checked against the bytes',
          "#     asked for, and every read bound to the first reply's validator:",
          '#     a republished file is refused, never mixed with the old one."""',
          "#     def __init__(self, url):",
          "#         self.url, self.at, self.tag = url, 0, None",
          "#         self.size = self.get(0, 0)[1]",
          "#     def get(self, start, end):",
          '#         headers = {"Range": f"bytes={start}-{end}"}',
          "#         if self.tag:",
          '#             headers["If-Match"] = self.tag',
          "#         ask = urllib.request.Request(self.url, headers=headers)",
          "#         try:",
          "#             response = urllib.request.urlopen(ask)",
          "#         except urllib.error.HTTPError as error:",
          "#             if error.code == 412:",
          '#                 raise ValueError("the file changed while it was read")',
          "#             raise",
          "#         with response:",
          '#             named = re.fullmatch(r"bytes (\\d+)-(\\d+)/(\\d+)", response.headers.get("Content-Range") or "")',
          "#             body = response.read(end - start + 2)",
          '#             tag = response.headers.get("ETag")',
          "#         # One publication throughout: the same size, and the validator of",
          "#         # the first reply on every later one (a reply without it cannot",
          "#         # show it is the same file). A server with no validator at all",
          "#         # is trusted on its size alone.",
          '#         if getattr(self, "size", None) not in (None, int(named[3]) if named else None) or (self.tag and tag != self.tag):',
          '#             raise ValueError("the file changed while it was read")',
          '#         if not getattr(self, "size", None) and tag and not tag.startswith("W/"):',
          "#             self.tag = tag",
          '#         if getattr(response, "status", None) != 206 or not named:',
          '#             raise ValueError("the server ignores byte ranges")',
          "#         if (int(named[1]), int(named[2])) != (start, end) or len(body) != end - start + 1:",
          '#             raise ValueError("the server sent other bytes than asked for")',
          "#         return body, int(named[3])",
          "#     def readable(self): return True",
          "#     def seekable(self): return True",
          "#     def tell(self): return self.at",
          "#     def seek(self, offset, whence=0):",
          "#         self.at = (offset, self.at + offset, self.size + offset)[whence]",
          "#         return self.at",
          "#     def readinto(self, into):",
          "#         end = min(self.at + len(into), self.size) - 1",
          "#         if end < self.at:",
          "#             return 0",
          "#         body = self.get(self.at, end)[0]",
          "#         into[: len(body)] = body",
          "#         self.at += len(body)",
          "#         return len(body)",
          `# url = ${py(url)}`,
          "# try:",
          `#     ds = xr.open_dataset(io.BufferedReader(Ranges(url), 1 << 20)${inGroup}, chunks={})`,
          "# except (OSError, ValueError):",
          "#     # A server ignoring byte ranges sends the whole file (HTTP 200):",
          "#     # read once, as Gridlook does, up to 4 GiB, counted as it arrives",
          "#     # whether or not its length is declared, into a spooled file, not",
          "#     # parts joined in memory.",
          "#     limit, total = 4 * 1024**3, 0",
          "#     whole = tempfile.SpooledTemporaryFile(max_size=64 * 1024**2)",
          "#     with urllib.request.urlopen(url) as response:",
          '#         if int(response.headers.get("Content-Length") or 0) > limit:',
          '#             raise RuntimeError("larger than Gridlook reads whole")',
          "#         while part := response.read(min(1 << 20, limit + 1 - total)):",
          "#             whole.write(part)",
          "#             total += len(part)",
          "#             if total > limit:",
          '#                 raise RuntimeError("larger than Gridlook reads whole")',
          "#     whole.seek(0)",
          `#     ds = xr.open_dataset(whole${inGroup})`,
        ]
      : [
          "# (NetCDF: needs netCDF4 or h5netcdf)",
          `# ds = xr.open_dataset(${py(url)}${inGroup}, chunks={})`,
        ]
    : [
        `# ds = xr.open_dataset(${py(url)}, engine="zarr"${inGroup}, chunks={})`,
      ];
}

/** A variable's group path ("1/physics" of "1/physics/tas"), or "". */
function groupOf(variable: string) {
  const path = variable.replace(/^\/+/, "");
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** The stored dates of a selection as an xarray index: a slice or a list. */
function pyTimeIndex(time: NonNullable<TAnalysisResult["query"]["time"]>) {
  return time.runs?.length
    ? `[${time.runs.map(([a, b]) => `*range(${a}, ${b})`).join(", ")}]`
    : `slice(${time.start}, ${time.stop})`;
}

/** The script for a result; `name` is the export's base file name. */
// eslint-disable-next-line max-lines-per-function
export function pythonScript(
  result: TAnalysisResult,
  name: string,
  title: string,
  /** What the window shows instead of the values, if anything (a view). */
  shownAs?: string,
  /** A path drawn against latitude (the window's Along setting). */
  pathAxis?: "latitude"
) {
  const table = resultTable(result);
  const provenance = resultProvenance(result);
  const embedded = table.rowCount <= MAX_EMBEDDED_ROWS;
  const source = provenance.source.ref;
  const query = JSON.stringify(provenance.query, null, 2);
  const time = result.time;
  return [
    "#!/usr/bin/env python3",
    // A backslash in a title would start an escape in the docstring.
    // Backslashes and every quote escaped: a title ending in a quote
    // would close the docstring early.
    `"""${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}`,
    "",
    "Redraws this Gridlook plot from its computed values (pandas,",
    "matplotlib). The last section shows how to read the same selection",
    "from the source with xarray; Gridlook's own weighting and masking are",
    "described in the provenance JSON (Export → Query and provenance).",
    ...(shownAs
      ? [
          "",
          `The window shows ${shownAs}; this script draws the values as`,
          "computed. Export → Chart values as shown (CSV) saves what it draws.",
        ]
      : []),
    `"""`,
    "import io",
    "import re",
    "from pathlib import Path",
    "",
    "import matplotlib.dates as mdates",
    "import matplotlib.pyplot as plt",
    "from matplotlib.collections import PolyCollection",
    "from matplotlib.ticker import FixedFormatter, FixedLocator",
    "import numpy as np",
    "import pandas as pd",
    "",
    ...(embedded
      ? [
          `CSV = ${py(resultToCsv(result))}`,
          "df = pd.read_csv(io.StringIO(CSV))",
        ]
      : [
          `# ${table.rowCount.toLocaleString("en-US")} rows: too many to embed. Export`,
          `# "Computed values (CSV)" from the same plot beside this script.`,
          "# Beside this script, wherever it is run from.",
          `df = pd.read_csv(Path(__file__).with_name(${py(`${name}.csv`)}))`,
        ]),
    "",
    "fig, ax = plt.subplots(figsize=(9.6, 5.4))",
    ...plotLines(result, table.header, pathAxis),
    `ax.set_title(${py(shownAs ? `${title} (values as computed)` : title)}, loc="left")`,
    "fig.tight_layout()",
    `fig.savefig(${py(`${name}.png`)}, dpi=200)`,
    "plt.show()",
    "",
    "# ---- The same selection from the source (xarray) ----------------",
    `# Source: ${oneLine(source)}`,
    "# Gridlook's query:",
    ...query
      .split("\n")
      .map((line) => `#   ${line.replace(/[\r\u0085\u2028\u2029\v\f]/g, " ")}`),
    "#",
    "# import xarray as xr",
    ...openLines(
      source,
      provenance.source.level,
      groupOf(result.query.variable)
    ),
    `# da = ds[${py(result.query.variable.split("/").pop()!)}]`,
    // Dimension names as quoted keys of a dict: any name, also one with a
    // hyphen or a line break, stays data.
    ...(time && result.query.time
      ? [
          // Dates in several stored slices: their indices, one list.
          `# da = da.isel({${py(time.dimension)}: ${pyTimeIndex(result.query.time)}})`,
        ]
      : []),
    ...Object.entries(result.query.fixed ?? {}).map(
      ([dim, index]) => `# da = da.isel({${py(dim)}: ${Number(index)}})`
    ),
    // The level read, too.
    ...(result.fixedLevel &&
    !Object.hasOwn(result.query.fixed ?? {}, result.fixedLevel.dimension)
      ? [
          // Its value and units on the same comment line, whatever the metadata
          // holds.
          `# da = da.isel({${py(result.fixedLevel.dimension)}: ${result.fixedLevel.index}})${result.fixedLevel.value !== undefined ? `  # ${oneLine(`${result.fixedLevel.value}${result.fixedLevel.units ? ` ${result.fixedLevel.units}` : ""}`)}` : ""}`,
        ]
      : []),
    ...(result.cell?.index !== undefined
      ? [
          `# The cell Gridlook used: ${JSON.stringify(result.cell.index)} (${oneLine(result.cell.selection ?? "")})`,
        ]
      : []),
    "",
  ].join("\n");
}
