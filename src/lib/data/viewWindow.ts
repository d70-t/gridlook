import type { TViewFootprint } from "@/lib/projection/viewFootprint.ts";

/** Indices `[start, end)` of a coordinate axis. */
export type TAxisRange = { start: number; end: number };

/**
 * The part of a regular lat/lon level that is loaded. Longitude is one range,
 * or two where the window crosses the seam of a global axis (west part
 * first, so stitching them keeps the columns in order). `lonStep` is above 1
 * where the window takes every longitude, around a pole: the columns there
 * are far narrower than the rows are tall, and only every n-th is read.
 */
export type TRegularWindow = {
  lat: TAxisRange;
  lon: TAxisRange[];
  lonStep: number;
};

export type TRegularWindowOptions = {
  /** Grow the footprint by this fraction of its size on every side. */
  margin?: number;
  /** Thin or shrink the window to hold at most this many cells. */
  maxCells?: number;
};

type TAxis = ArrayLike<number>;

function axisStep(values: TAxis) {
  return values.length > 1
    ? Math.abs(values[values.length - 1] - values[0]) / (values.length - 1)
    : 0;
}

/** First index of an ascending axis whose value is at least `target`. */
function lowerBound(values: TAxis, target: number, ascending: boolean) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const value = ascending ? values[mid] : values[values.length - 1 - mid];
    if (value < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Cells of a monotonic axis whose centres lie in `[min, max]`, plus one cell
 * on either side; null when the interval misses the axis.
 */
function axisRange(values: TAxis, min: number, max: number): TAxisRange | null {
  const count = values.length;
  const ascending = count < 2 || values[0] <= values[count - 1];
  const step = axisStep(values);
  const first = ascending ? values[0] : values[count - 1];
  const last = ascending ? values[count - 1] : values[0];
  if (count === 0 || max < first - step || min > last + step) {
    return null;
  }
  const lo = Math.max(lowerBound(values, min, ascending) - 1, 0);
  const hi = Math.min(lowerBound(values, max, ascending) + 1, count);
  return ascending
    ? { start: lo, end: hi }
    : { start: count - hi, end: count - lo };
}

function shrink(range: TAxisRange, factor: number): TAxisRange {
  const length = Math.max(1, Math.floor((range.end - range.start) * factor));
  const start =
    range.start + Math.floor((range.end - range.start - length) / 2);
  return { start, end: start + length };
}

/**
 * Shrink the columns of a window around their middle. The parts of a window
 * split over the seam are neighbours there, so they shrink as one run: the
 * west part keeps its east end and the east part its west end.
 */
function shrinkColumns(lon: TAxisRange[], factor: number): TAxisRange[] {
  let total = 0;
  for (const range of lon) {
    total += range.end - range.start;
  }
  const kept = shrink({ start: 0, end: total }, factor);
  const ranges: TAxisRange[] = [];
  let offset = 0;
  for (const range of lon) {
    const start = Math.max(kept.start - offset, 0);
    const end = Math.min(kept.end - offset, range.end - range.start);
    if (end > start) {
      ranges.push({ start: range.start + start, end: range.start + end });
    }
    offset += range.end - range.start;
  }
  return ranges;
}

/** Whether an ascending longitude axis closes on itself around the globe. */
function isGlobalLongitudeAxis(lons: TAxis) {
  return lons.length > 1 && lons[0] < lons[lons.length - 1]
    ? lons[lons.length - 1] - lons[0] + axisStep(lons) > 359.5
    : false;
}

/**
 * Longitude ranges covering the arc `[west, west + span]`. A global axis is
 * periodic: an arc over its seam gives two ranges. A regional axis gives the
 * part of the arc it holds.
 */
function longitudeRanges(
  lons: TAxis,
  west: number,
  span: number
): TAxisRange[] | null {
  const count = lons.length;
  const whole = [{ start: 0, end: count }];
  if (span >= 360 || count < 2 || lons[0] > lons[count - 1]) {
    // ponytail: a descending longitude axis is loaded across its full width.
    return whole;
  }
  // The arc, shifted to start within one turn east of the axis' first cell.
  const start = lons[0] + ((((west - lons[0]) % 360) + 360) % 360);
  const ranges: TAxisRange[] = [];
  for (const shift of [0, -360]) {
    const range = axisRange(lons, start + shift, start + span + shift);
    if (range) {
      ranges.push(range);
    }
  }
  if (ranges.length < 2) {
    return ranges.length === 1 ? ranges : null;
  }
  // West part first. Two parts that meet are the whole axis, and so are two
  // parts of a regional axis, which has no seam to stitch them across.
  return ranges[1].end >= ranges[0].start || !isGlobalLongitudeAxis(lons)
    ? whole
    : ranges;
}

function cellCount(lat: TAxisRange, lon: TAxisRange[]) {
  let columns = 0;
  for (const range of lon) {
    columns += range.end - range.start;
  }
  return (lat.end - lat.start) * columns;
}

/**
 * The index window of a regular lat/lon level that covers a view footprint;
 * null when the level holds nothing of the view.
 */
export function regularWindow(
  lats: TAxis,
  lons: TAxis,
  footprint: TViewFootprint,
  options: TRegularWindowOptions = {}
): TRegularWindow | null {
  const margin = options.margin ?? 0;
  const latMargin = (footprint.latMax - footprint.latMin) * margin;
  const lonMargin = footprint.lonSpan * margin;
  const lat = axisRange(
    lats,
    footprint.latMin - latMargin,
    footprint.latMax + latMargin
  );
  const lon = longitudeRanges(
    lons,
    footprint.lonStart - lonMargin,
    footprint.lonSpan + 2 * lonMargin
  );
  if (!lat || !lon) {
    return null;
  }
  const cells = cellCount(lat, lon);
  if (options.maxCells === undefined || cells <= options.maxCells) {
    return { lat, lon, lonStep: 1 };
  }
  if (lon[0].end - lon[0].start === lons.length) {
    return { lat, lon, lonStep: Math.ceil(cells / options.maxCells) };
  }
  const factor = Math.sqrt(options.maxCells / cells);
  return {
    lat: shrink(lat, factor),
    lon: shrinkColumns(lon, factor),
    lonStep: 1,
  };
}

function contains(outer: TAxisRange, inner: TAxisRange) {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * Whether `loaded` holds every cell of `needed`. A window thinned around a
 * pole only stands in for a view that takes every longitude itself.
 */
export function windowCovers(loaded: TRegularWindow, needed: TRegularWindow) {
  return (
    (loaded.lonStep === 1 || contains(needed.lon[0], loaded.lon[0])) &&
    contains(loaded.lat, needed.lat) &&
    needed.lon.every((range) =>
      loaded.lon.some((candidate) => contains(candidate, range))
    )
  );
}
