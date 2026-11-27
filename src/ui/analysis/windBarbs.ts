/**
 * Wind barbs beside a series or a profile: the dataset's eastward and
 * northward components (found as the map's streamlines find them), drawn
 * by the WMO convention. The staff points to where the wind comes from;
 * a half barb is 5 knots, a full barb 10, a pennant 50; barbs sit on the
 * staff's clockwise side in the Northern Hemisphere and the other side in
 * the Southern. Speeds are rounded to the nearest 5 knots.
 */
import { speedFactor } from "@/lib/analysis/windPair.ts";

/**
 * Knots per unit of the components' speed, and whether it was assumed
 * (undeclared units are taken as m s-1; pairs whose units are no speed are
 * refused before they are read). The same check as choosing the pair:
 * mm s-1, cm s^-1, km/h, mph and knots all convert.
 */
export function knotsPer(units: string | undefined) {
  const perMetre = 1 / 0.514444;
  const factor = speedFactor(units);
  return factor === undefined
    ? { factor: perMetre, assumed: true }
    : {
        factor: factor * perMetre,
        ...(units?.trim() ? {} : { assumed: true }),
      };
}

/** The most pennants a staff carries; faster winds get an overflow mark. */
const MOST_PENNANTS = 5;

/**
 * Pennants, full and half barbs for a speed in knots (nearest 5). Past
 * five pennants (250 kn) the barb is capped and marked `over` (the
 * readout gives the speed): a value of 1e20 draws six glyphs, not 2e18.
 */
export function barbParts(knots: number) {
  if (!(knots < MOST_PENNANTS * 50 + 2.5)) {
    return { pennants: MOST_PENNANTS, full: 0, half: 0, over: true };
  }
  let rest = Math.round(knots / 5) * 5;
  const pennants = Math.floor(rest / 50);
  rest -= pennants * 50;
  const full = Math.floor(rest / 10);
  rest -= full * 10;
  return { pennants, full, half: rest >= 5 ? 1 : 0, over: false };
}

/** Two significant figures for small speeds, one decimal for larger. */
const formatSpeed = (speed: number) =>
  speed < 10 ? speed.toPrecision(2) : speed.toFixed(1);

/** Direction the wind blows from, degrees clockwise from north. */
export function windFrom(u: number, v: number) {
  return ((((Math.atan2(-u, -v) * 180) / Math.PI) % 360) + 360) % 360;
}

const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/**
 * The wind of one sample, as the hover box reads it beside the value under
 * the pointer (25 Nov: barbs on a section had no readout).
 */
export function windLine(
  wind: { u: number[]; v: number[]; units?: string; current?: boolean },
  index: number
) {
  return (
    windText(wind.u[index], wind.v[index], wind.units, wind.current) ??
    (wind.current ? "No current here" : "No wind here")
  );
}

/**
 * The wind at one sample in words, for the readout: "Wind 14 kn (7.2 m s-1)
 * from 250° (WSW)", or undefined where a component is missing. An ocean
 * current says where it goes, in its own units: "Current 0.35 m s-1
 * towards 90° (E)".
 */
export function windText(
  u: number,
  v: number,
  units?: string,
  current = false
) {
  if (!Number.isFinite(u) || !Number.isFinite(v)) {
    return undefined;
  }
  const speed = Math.hypot(u, v);
  if (current) {
    const to = Math.round((windFrom(u, v) + 180) % 360) % 360;
    return `Current ${formatSpeed(speed)}${units ? ` ${units}` : ""} towards ${to}° (${COMPASS[Math.round(to / 22.5) % 16]})`;
  }
  const knots = speed * knotsPer(units).factor;
  const own =
    units && !/^(kt|kts|knots?)$/i.test(units.trim())
      ? ` (${speed.toFixed(1)} ${units})`
      : "";
  if (knots < 2.5) {
    return `Wind calm${own}`;
  }
  const from = Math.round(windFrom(u, v)) % 360;
  return `Wind ${Math.round(knots)} kn${own} from ${from}° (${COMPASS[Math.round(from / 22.5) % 16]})`;
}

/**
 * Samples to draw, at least `gap` pixels apart, from their pixel positions
 * (NaN where a sample has no position or no wind). Actual samples only: a
 * barb never shows an average the data does not have.
 */
export function thinned(positions: number[], gap: number) {
  const order = positions
    .map((p, at) => [p, at])
    .filter(([p]) => Number.isFinite(p))
    .sort((a, b) => a[0] - b[0]);
  const kept: number[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const [p, at] of order) {
    if (p - last >= gap) {
      kept.push(at);
      last = p;
    }
  }
  return kept;
}

/**
 * Evenly spaced positions kept at an even stride: every one when they are
 * `gap` apart, else every second, third… the first stride that keeps them
 * so. The greedy pick left single rows without barbs between rows with
 * them (26 Nov: two pressure rows of a cross-section looked empty of
 * wind); unevenly spaced ones are still picked a gap apart.
 */
export function thinnedEvenly(positions: number[], gap: number) {
  const order = positions
    .map((p, at) => [p, at])
    .filter(([p]) => Number.isFinite(p))
    .sort((a, b) => a[0] - b[0]);
  // Levels spaced unevenly (depths dense at the top): kept a gap apart
  // from the last kept, so each part of the column keeps its own rows; an
  // even stride there would leave the deep half bare.
  const steps = order.slice(1).map(([p], k) => p - order[k][0]);
  const [least, most] = [Math.min(...steps), Math.max(...steps)];
  if (steps.length && !(most <= 1.5 * least)) {
    return thinned(positions, gap);
  }
  for (let stride = 1; stride <= Math.max(1, order.length); stride++) {
    const kept = order.filter((_, k) => k % stride === 0);
    if (kept.every(([p], k) => k === 0 || p - kept[k - 1][0] >= gap)) {
      return kept.map(([, at]) => at);
    }
  }
  return order.slice(0, 1).map(([, at]) => at);
}

type TBarbStyle = {
  length: number;
  color: string;
  /** Southern Hemisphere: barbs on the other side of the staff. */
  flip: boolean;
  /**
   * An outline under the barb in the background colour (light theme:
   * white; dark theme: near black), so it reads on any cell colour.
   */
  halo?: string;
  /** Line width (the outline pass is wider). */
  width?: number;
};

/**
 * A grid of barbs on a field: rows and columns thinned apart, each pair
 * drawn where both components have a value. `at(row, column)` gives the
 * station; `index(row, column)` the component values' index.
 */
export function drawBarbGrid(
  context: CanvasRenderingContext2D,
  grid: {
    rows: number[];
    columns: number[];
    gap: [number, number];
    at: (row: number, column: number) => [number, number];
    index: (row: number, column: number) => number;
    flip: (row: number, column: number) => boolean;
    /** Columns thinned at an even stride (a section's levels). */
    even?: boolean;
  },
  wind: { u: number[]; v: number[]; units?: string; current?: boolean },
  style: Omit<TBarbStyle, "flip">
) {
  const factor = knotsPer(wind.units).factor;
  const rows = thinned(grid.rows, grid.gap[0]);
  const columns = grid.even
    ? thinnedEvenly(grid.columns, grid.gap[1])
    : thinned(grid.columns, grid.gap[1]);
  // Arrows as long as the fastest one drawn, not one thinned away.
  const most = wind.current
    ? largestSpeed(
        wind.u,
        wind.v,
        rows.flatMap((row) => columns.map((column) => grid.index(row, column)))
      )
    : 0;
  for (const row of rows) {
    for (const column of columns) {
      const at = grid.index(row, column);
      const [x, y] = grid.at(row, column);
      if (
        Number.isFinite(wind.u[at]) &&
        Number.isFinite(wind.v[at]) &&
        Number.isFinite(x) &&
        Number.isFinite(y)
      ) {
        if (wind.current) {
          drawArrow(context, x, y, wind.u[at], wind.v[at], most, style);
        } else {
          drawBarb(context, x, y, wind.u[at] * factor, wind.v[at] * factor, {
            ...style,
            flip: grid.flip(row, column),
          });
        }
      }
    }
  }
}

/** The barb's outline, wider and slightly see-through, drawn first. */
function drawHalo(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  uKnots: number,
  vKnots: number,
  style: TBarbStyle
) {
  context.save();
  context.globalAlpha *= 0.75;
  drawBarb(context, x, y, uKnots, vKnots, {
    ...style,
    color: style.halo!,
    halo: undefined,
    width: 3,
  });
  context.restore();
}

/** One barb with its station at (x, y), from components in knots. */
export function drawBarb(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  uKnots: number,
  vKnots: number,
  style: TBarbStyle
) {
  if (style.halo) {
    drawHalo(context, x, y, uKnots, vKnots, style);
  }
  const speed = Math.hypot(uKnots, vKnots);
  context.save();
  context.strokeStyle = style.color;
  context.fillStyle = style.color;
  context.lineWidth = style.width ?? 1.2;
  context.lineCap = "round";
  context.lineJoin = "round";
  const parts = barbParts(speed);
  if (!parts.pennants && !parts.full && !parts.half) {
    // Calm: a small circle at the station.
    context.beginPath();
    context.arc(x, y, 3, 0, 2 * Math.PI);
    context.stroke();
    context.restore();
    return;
  }
  // Screen axes: x east, y south. Staff towards where the wind comes from.
  const sx = -uKnots / speed;
  const sy = vKnots / speed;
  const side = style.flip ? -1 : 1;
  const tip: [number, number] = [x + sx * style.length, y + sy * style.length];
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(tip[0], tip[1]);
  context.stroke();
  drawFeathers(context, tip, [sx, sy], [-sy * side, sx * side], {
    ...parts,
    length: style.length,
  });
  if (parts.over) {
    // Off the scale: a ring past the tip.
    context.beginPath();
    context.arc(tip[0] + sx * 4, tip[1] + sy * 4, 3, 0, 2 * Math.PI);
    context.stroke();
  }
  context.restore();
}

/** Pennants, then full and half barbs, from the staff's tip inwards. */
function drawFeathers(
  context: CanvasRenderingContext2D,
  [tipX, tipY]: [number, number],
  [sx, sy]: [number, number],
  [px, py]: [number, number],
  parts: { pennants: number; full: number; half: number; length: number }
) {
  const feather = parts.length * 0.42;
  const spacing = parts.length * 0.16;
  const at = (distance: number) => [tipX - sx * distance, tipY - sy * distance];
  let along = 0;
  for (let n = 0; n < parts.pennants; n++) {
    const [ax, ay] = at(along);
    const [bx, by] = at(along + spacing * 1.6);
    context.beginPath();
    context.moveTo(ax, ay);
    context.lineTo(ax + px * feather, ay + py * feather);
    context.lineTo(bx, by);
    context.closePath();
    context.fill();
    along += spacing * 2;
  }
  const barb = (distance: number, size: number) => {
    const [ax, ay] = at(distance);
    context.beginPath();
    context.moveTo(ax, ay);
    // Slanted outwards, away from the station.
    context.lineTo(
      ax + px * size + sx * size * 0.35,
      ay + py * size + sy * size * 0.35
    );
    context.stroke();
  };
  for (let n = 0; n < parts.full; n++) {
    barb(along, feather);
    along += spacing;
  }
  if (parts.half) {
    // A lone half barb stands off the tip, so it is not read as a full one.
    barb(along || spacing, feather / 2);
  }
}

/** The largest speed among a vector's samples, in its own units. */
export function largestSpeed(u: number[], v: number[], among?: number[]) {
  let most = 0;
  const count = among ? among.length : u.length;
  for (let k = 0; k < count; k++) {
    const at = among ? among[k] : k;
    const speed = Math.hypot(u[at], v[at]);
    if (Number.isFinite(speed) && speed > most) {
      most = speed;
    }
  }
  return most;
}

/**
 * An arrow's path from `at` along the screen direction `[dx, dy]` (x east,
 * y south) for `length` px, its head at the tip.
 */
function arrowPath(
  context: CanvasRenderingContext2D,
  [x, y]: [number, number],
  [dx, dy]: [number, number],
  length: number
) {
  const tip = [x + dx * length, y + dy * length];
  const head = Math.min(5, length / 2);
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(tip[0], tip[1]);
  context.moveTo(
    tip[0] - head * (dx - dy * 0.5),
    tip[1] - head * (dy + dx * 0.5)
  );
  context.lineTo(tip[0], tip[1]);
  context.lineTo(
    tip[0] - head * (dx + dy * 0.5),
    tip[1] - head * (dy - dx * 0.5)
  );
}

/**
 * An ocean current as oceanographers draw it (25 Nov): an arrow from the
 * station to where the water goes, as long as `style.length` at the
 * largest speed shown (`most`) and shorter in proportion. Barbs count in
 * 5-knot steps, so every current under 2.5 m/s drew a calm circle, and
 * they point where a flow comes from.
 */
export function drawArrow(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  u: number,
  v: number,
  most: number,
  style: Omit<TBarbStyle, "flip">
) {
  const speed = Math.hypot(u, v);
  const length = most > 0 ? (style.length * speed) / most : 0;
  const stroke = (color: string, width: number) => {
    context.save();
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = width;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (length < 1.5) {
      // Still water (or nearly): a dot at the station.
      context.beginPath();
      context.arc(x, y, 1.5, 0, 2 * Math.PI);
      context.fill();
      context.restore();
      return;
    }
    // Screen axes: x east, y south. Towards where the water goes.
    arrowPath(context, [x, y], [u / speed, -v / speed], length);
    context.stroke();
    context.restore();
  };
  if (style.halo) {
    context.save();
    context.globalAlpha *= 0.75;
    stroke(style.halo, 3);
    context.restore();
  }
  stroke(style.color, style.width ?? 1.2);
}

/**
 * Levels thinned along a representative column: per level, the one nearest the
 * middle with a position there (a column without coordinates, outside the
 * grid, hides only its own barbs).
 */
export function barbLevels(
  ns: number,
  nk: number,
  yOf: (s: number, k: number) => number
) {
  const middle = Math.floor(ns / 2);
  return Array.from({ length: nk }, (_, k) => {
    for (let d = 0; d <= ns; d++) {
      for (const s of [middle - d, middle + d]) {
        const y = s >= 0 && s < ns ? yOf(s, k) : Number.NaN;
        if (Number.isFinite(y)) {
          return y;
        }
      }
    }
    return Number.NaN;
  });
}
