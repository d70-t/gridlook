/**
 * One variable against another, read with the same query: a scatter of a
 * time series' samples, or a profile's levels joined from top to bottom.
 * Temperature with salinity is a temperature–salinity (T–S) diagram:
 * salinity on x and temperature on y, whichever was plotted. No density
 * contours (isopycnals) are drawn.
 */
import { extent, thinScatter } from "./chartBudget.ts";
import { niceTicks } from "./heatmapRaster.ts";

import { formatValue } from "@/utils/formatValue.ts";

export type TScatterInput = {
  name: string;
  values: number[];
  units?: string;
  standardName?: string;
  /** An area mean's valid-area share per sample (0–1). */
  coverage?: number[];
};

export type TScatter = {
  x: number[];
  y: number[];
  xTitle: string;
  yTitle: string;
  title: string;
  /** Join the points in order (a profile's levels). */
  joined: boolean;
  /** Labels of the first and last point (levels), when joined. */
  ends?: [string, string];
  /** Joined: points that start a new line (a missing level before them). */
  breaks?: number[];
  /**
   * What each point pairs, when it is not one observation of both: two grids'
   * own cells, or two independent area means.
   */
  sampling?: string;
  /** Each point's valid-area share of both area means (0–1), when both are. */
  coverage?: { x: number[]; y: number[] };
  /** Each point's date or level, for its readout. */
  labels?: string[];
};

/**
 * How the two variables were sampled for each point: the same cell, each
 * its own grid's containing cell, or independent area means over each
 * variable's own valid cells. Undefined when nothing is to be said.
 */
type TFootprint = {
  lat: number;
  lon: number;
  south?: number;
  west?: number;
};
type TSampled = {
  cell?: { lat: number; lon: number; footprint?: TFootprint };
  region?: unknown;
  name: string;
};

/** Longitudes apart by less than this (degrees), a whole turn ignored. */
const turnApart = (x: number, y: number) => {
  const d = x - y;
  return Math.abs(d - 360 * Math.round(d / 360));
};

/**
 * Whether two located cells are the same support: the same edges, whatever
 * longitude convention their files use; or why not, in words.
 */
function sameCell(fa: TFootprint, fb: TFootprint) {
  // To a thousandth of the narrower cell (and the old relative bound at most),
  // never below the numbers' own precision: scaled by latitude alone, two cells
  // at 80° N overlapping by 2.63 % were one.
  const tolerance = (x: number, y: number, width: number) => {
    const scale = Math.max(1, Math.abs(x), Math.abs(y));
    return Math.max(
      8 * Number.EPSILON * scale,
      Math.min(1e-6 * scale, 1e-3 * width)
    );
  };
  const [wLat, wLon] = [Math.min(fa.lat, fb.lat), Math.min(fa.lon, fb.lon)];
  const near = (x: number, y: number, width: number) =>
    Math.abs(x - y) <= tolerance(x, y, width);
  const fullTurn = fa.lon >= 360 - 1e-9 && fb.lon >= 360 - 1e-9;
  return (
    near(fa.south!, fb.south!, wLat) &&
    near(fa.lat, fb.lat, wLat) &&
    near(fa.lon, fb.lon, wLon) &&
    (fullTurn ||
      turnApart(fa.west!, fb.west!) <= tolerance(fa.west!, fb.west!, wLon))
  );
}

/** A located cell's extent in words: "0° E to 90° E, 1° S to 1° N". */
function cellExtent(f: TFootprint) {
  const lon = (x: number) => {
    const w = ((((x + 180) % 360) + 360) % 360) - 180;
    return `${formatValue(Math.abs(w))}° ${w >= 0 ? "E" : "W"}`;
  };
  const lat = (y: number) =>
    `${formatValue(Math.abs(y))}° ${y >= 0 ? "N" : "S"}`;
  return `${lon(f.west!)} to ${lon(f.west! + f.lon)}, ${lat(f.south!)} to ${lat(f.south! + f.lat)}`;
}

export function samplingNote(a: TSampled, b: TSampled) {
  const place = (c: { lat: number; lon: number }) =>
    `${Math.abs(c.lat).toFixed(2)}° ${c.lat >= 0 ? "N" : "S"} ${Math.abs(c.lon).toFixed(2)}° ${c.lon >= 0 ? "E" : "W"}`;
  // Cells located by their edges are compared where they lie, not by a centre
  // or a width.
  const [fa, fb] = [a.cell?.footprint, b.cell?.footprint];
  if (
    fa?.west !== undefined &&
    fa.south !== undefined &&
    fb?.west !== undefined &&
    fb.south !== undefined
  ) {
    return sameCell(fa, fb)
      ? undefined
      : `Other cells: ${a.name}'s spans ${cellExtent(fa)}, ${b.name}'s ${cellExtent(fb)}.`;
  }
  if (a.cell && b.cell) {
    const apart =
      Math.abs(a.cell.lat - b.cell.lat) > 1e-6 ||
      turnApart(a.cell.lon, b.cell.lon) > 1e-6;
    if (apart) {
      return `Not co-located: each value is its own grid's containing cell, ${a.name} at ${place(a.cell)}, ${b.name} at ${place(b.cell)}.`;
    }
    // One centre, cells of other sizes: not one support.
    const differs = (x: number, y: number) =>
      Math.abs(x - y) > 0.01 * Math.max(x, y);
    const size = (f: { lat: number; lon: number }) =>
      `${formatValue(f.lat)}° × ${formatValue(f.lon)}°`;
    return fa && fb && (differs(fa.lat, fb.lat) || differs(fa.lon, fb.lon))
      ? `Same centre, other cells: ${a.name}'s cell spans ${size(fa)}, ${b.name}'s ${size(fb)}.`
      : undefined;
  }
  if (a.region && b.region) {
    return `Each point pairs two independent area means, each over its own variable's valid cells (not the cells valid in both).`;
  }
  return undefined;
}

/**
 * Seawater salinity and temperature: by CF standard name when there is one, by
 * the CMIP ocean names only when there is none.
 */
const isSalinity = (v: TScatterInput) =>
  v.standardName
    ? /^sea_(water|surface)_(practical_|absolute_|preformed_)?salinity$/.test(
        v.standardName
      )
    : /^(so|sos)$/.test(v.name);
const isTemperature = (v: TScatterInput) =>
  v.standardName
    ? /^sea_(water|surface)_(potential_|conservative_)?temperature$/.test(
        v.standardName
      )
    : /^(thetao|tos|bigthetao)$/.test(v.name);

/** Whether two variables make a T–S diagram (ocean temperature, salinity). */
export function isTemperatureSalinity(a: TScatterInput, b: TScatterInput) {
  return (
    (isTemperature(a) && isSalinity(b)) || (isSalinity(a) && isTemperature(b))
  );
}

/**
 * Values whose valid area reaches the plot's threshold; the rest missing,
 * as the chart hides them.
 */
export function coveredValues(
  values: number[],
  coverage: number[] | undefined,
  threshold: number | undefined
) {
  return threshold === undefined || !coverage
    ? values
    : values.map((v, at) => ((coverage[at] ?? 0) < threshold ? Number.NaN : v));
}

const titled = (v: TScatterInput) =>
  `${v.name}${v.units ? ` (${v.units})` : ""}`;

/**
 * The scatter of `plotted` (y) against `other` (x), or salinity (x) against
 * temperature (y) for a T–S diagram; joined for a profile.
 */
// eslint-disable-next-line max-lines-per-function
export function scatterOf(
  plotted: TScatterInput,
  other: TScatterInput,
  profile?: { levels: string[] },
  /** A time series' dates, one per sample. */
  dates?: string[]
): TScatter {
  const ts = isTemperatureSalinity(plotted, other);
  const [xv, yv] =
    ts && isSalinity(plotted) ? [plotted, other] : [other, plotted];
  const keep = xv.values
    .map((_, at) => at)
    .filter(
      (at) => Number.isFinite(xv.values[at]) && Number.isFinite(yv.values[at])
    );
  return {
    x: keep.map((at) => xv.values[at]),
    y: keep.map((at) => yv.values[at]),
    xTitle: titled(xv),
    yTitle: titled(yv),
    title: ts
      ? "Temperature–salinity diagram"
      : `${yv.name} against ${xv.name}`,
    joined: Boolean(profile),
    ...((profile?.levels ?? dates)
      ? { labels: keep.map((at) => (profile?.levels ?? dates)![at] ?? "") }
      : {}),
    ...(xv.coverage && yv.coverage
      ? {
          coverage: {
            x: keep.map((at) => xv.coverage![at]),
            y: keep.map((at) => yv.coverage![at]),
          },
        }
      : {}),
    ...(profile
      ? {
          breaks: keep
            .map((row, at) => (at && row !== keep[at - 1] + 1 ? at : -1))
            .filter((at) => at > 0),
        }
      : {}),
    ...(profile && keep.length
      ? {
          ends: [
            profile.levels[keep[0]] ?? "",
            profile.levels[keep[keep.length - 1]] ?? "",
          ] as [string, string],
        }
      : {}),
  };
}

/** About five round ticks: a bounded count, whatever the span. */
const ticks = (low: number, high: number) => niceTicks(low, high, 5);

type TColours = { fg: string; muted: string; grid: string; line: string };

/** Marks drawn one by one up to here; a density beyond. */
const DENSITY_FROM = 4000;
const DENSITY_CELL = 3;

/** Points per screen cell of DENSITY_CELL px: keyed cell → count. */
function densityCells(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  toX: (x: number) => number,
  toY: (y: number) => number
) {
  const counts = new Map<number, number>();
  for (let at = 0; at < xs.length; at++) {
    const [px, py] = [toX(xs[at]), toY(ys[at])];
    if (Number.isFinite(px) && Number.isFinite(py)) {
      const key =
        Math.floor(px / DENSITY_CELL) * 65536 + Math.floor(py / DENSITY_CELL);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Each occupied cell a square, darker with more points (log scale). */
function drawDensity(
  context: CanvasRenderingContext2D,
  counts: Map<number, number>
) {
  let most = 1;
  for (const n of counts.values()) {
    most = Math.max(most, n);
  }
  const scale = Math.log(most + 1);
  for (const [key, n] of counts) {
    context.globalAlpha = 0.25 + (0.75 * Math.log(n + 1)) / scale;
    context.fillRect(
      Math.floor(key / 65536) * DENSITY_CELL,
      (key % 65536) * DENSITY_CELL,
      DENSITY_CELL,
      DENSITY_CELL
    );
  }
}

/** Where a scatter's points lie in a w × h box: margins, ranges, scales. */
function scatterLayout(width: number, height: number, s: TScatter) {
  const m = { left: 62, right: 18, top: 16, bottom: 44 };
  const pad = (a: number, b: number) =>
    b > a ? (b - a) * 0.05 : Math.max(1, Math.abs(a) * 1e-6);
  const ex = extent(s.x) ?? { low: 0, high: 1 };
  const ey = extent(s.y) ?? { low: 0, high: 1 };
  const bx = [ex.low - pad(ex.low, ex.high), ex.high + pad(ex.low, ex.high)];
  const by = [ey.low - pad(ey.low, ey.high), ey.high + pad(ey.low, ey.high)];
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;
  const sx = (x: number) => m.left + ((x - bx[0]) / (bx[1] - bx[0])) * pw;
  const sy = (y: number) => m.top + ph - ((y - by[0]) / (by[1] - by[0])) * ph;
  return { m, bx, by, pw, ph, sx, sy };
}

/**
 * The point nearest the pointer (within 12 px): its date or level and
 * both values (25 Nov).
 */
export function probeScatter(
  px: number,
  py: number,
  width: number,
  height: number,
  s: TScatter
) {
  const { sx, sy } = scatterLayout(width, height, s);
  let best: { at: number; d: number } | undefined;
  for (let at = 0; at < s.x.length; at++) {
    const d = Math.hypot(sx(s.x[at]) - px, sy(s.y[at]) - py);
    if (d < 12 && (!best || d < best.d)) {
      best = { at, d };
    }
  }
  if (!best) {
    return undefined;
  }
  const { at } = best;
  return {
    x: sx(s.x[at]),
    y: sy(s.y[at]),
    title: s.labels?.[at] ?? "",
    lines: [
      { text: `${s.xTitle}: ${formatValue(s.x[at])}` },
      { text: `${s.yTitle}: ${formatValue(s.y[at])}` },
    ],
  };
}

/** The scatter in a w × h box: grid, axes, points (joined for a profile). */
// eslint-disable-next-line max-lines-per-function
export function drawScatter(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  s: TScatter,
  colours: TColours
) {
  const { m, bx, by, pw, ph, sx, sy } = scatterLayout(width, height, s);
  context.save();
  context.font = "11px sans-serif";
  context.strokeStyle = colours.grid;
  context.lineWidth = 1;
  for (const t of ticks(by[0], by[1])) {
    context.beginPath();
    context.moveTo(m.left, sy(t));
    context.lineTo(width - m.right, sy(t));
    context.stroke();
  }
  for (const t of ticks(bx[0], bx[1])) {
    context.beginPath();
    context.moveTo(sx(t), m.top);
    context.lineTo(sx(t), m.top + ph);
    context.stroke();
  }
  context.fillStyle = colours.muted;
  context.textAlign = "center";
  context.textBaseline = "top";
  for (const t of ticks(bx[0], bx[1])) {
    context.fillText(formatValue(t), sx(t), m.top + ph + 4);
  }
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (const t of ticks(by[0], by[1])) {
    context.fillText(formatValue(t), m.left - 6, sy(t));
  }
  if (s.sampling) {
    // How the pairs were sampled, over the plot (and in every export).
    context.fillStyle = colours.muted;
    context.textAlign = "left";
    context.textBaseline = "top";
    context.font = "10px sans-serif";
    context.fillText(s.sampling, m.left, 2, pw);
    context.font = "11px sans-serif";
  }
  context.fillStyle = colours.fg;
  context.textAlign = "center";
  context.textBaseline = "bottom";
  context.fillText(s.xTitle, m.left + pw / 2, height - 4);
  context.save();
  context.translate(14, m.top + ph / 2);
  context.rotate(-Math.PI / 2);
  context.textBaseline = "middle";
  context.fillText(s.yTitle, 0, 0);
  context.restore();
  if (s.joined && s.x.length > 1) {
    context.strokeStyle = colours.line;
    context.lineWidth = 1.5;
    context.beginPath();
    // A missing level is a gap in the line, not a straight join across it.
    const breaks = new Set(s.breaks);
    s.x.forEach((x, at) =>
      at && !breaks.has(at)
        ? context.lineTo(sx(x), sy(s.y[at]))
        : context.moveTo(sx(x), sy(s.y[at]))
    );
    context.stroke();
  }
  context.fillStyle = colours.line;
  context.globalAlpha = s.joined ? 1 : 0.55;
  // One mark per occupied pixel cell: the picture, at screen cost. Past a few
  // thousand marks, a density of 3 px squares instead: work bounded by the
  // screen, not the data.
  const marks = thinScatter(s.x, s.y, sx, sy);
  if (!s.joined && marks.length > DENSITY_FROM) {
    drawDensity(context, densityCells(s.x, s.y, sx, sy));
  } else {
    for (const at of marks) {
      context.beginPath();
      context.arc(
        sx(s.x[at]),
        sy(s.y[at]),
        s.joined ? 2.5 : 2.2,
        0,
        2 * Math.PI
      );
      context.fill();
    }
  }
  context.globalAlpha = 1;
  if (s.ends && s.x.length) {
    context.fillStyle = colours.fg;
    context.textAlign = "left";
    context.textBaseline = "middle";
    const last = s.x.length - 1;
    context.fillText(s.ends[0], sx(s.x[0]) + 6, sy(s.y[0]));
    context.fillText(s.ends[1], sx(s.x[last]) + 6, sy(s.y[last]));
  }
  context.restore();
}
