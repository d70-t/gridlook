/**
 * Wind (or current) figures from the eastward and northward components a
 * plot read for its barbs: a rose (how often the flow comes from, or for a
 * current goes towards, each of 16 directions, by speed class) and a
 * hodograph (the wind vector's tip through the levels of a profile).
 */
import { knotsPer } from "./windBarbs.ts";

const SECTORS = 16;
const COMPASS = ["N", "E", "S", "W"];

/** Speed classes in m s-1: winds, and currents (much slower). */
const CLASSES = {
  wind: [0.5, 2, 4, 6, 8, 10],
  current: [0.02, 0.1, 0.25, 0.5, 1],
};

export type TRose = {
  /** Percent of all valid samples, by sector (from north, clockwise) and class. */
  sectors: number[][];
  /** Speed classes, in m s-1 (whatever the source units). */
  classes: string[];
  /** Below this speed (m s-1) a sample is calm. */
  calmBelow: number;
  calm: number;
  n: number;
  /** "from": where a wind comes from; "towards": where a current goes. */
  convention: "from" | "towards";
};

/**
 * Bin samples by direction and speed. Below the first class edge is calm
 * (no direction). Speeds are compared in m s-1, whatever the units.
 */
export function roseOf(
  u: number[],
  v: number[],
  units: string | undefined,
  current: boolean
): TRose {
  const edges = current ? CLASSES.current : CLASSES.wind;
  const toMetres = knotsPer(units).factor / 1.943844;
  const counts = Array.from({ length: SECTORS }, () =>
    new Array<number>(edges.length).fill(0)
  );
  let calm = 0;
  let n = 0;
  u.forEach((east, at) => {
    const north = v[at];
    if (!Number.isFinite(east) || !Number.isFinite(north)) {
      return;
    }
    n++;
    const speed = Math.hypot(east, north) * toMetres;
    if (speed < edges[0]) {
      calm++;
      return;
    }
    // Clockwise from north; a wind is named for where it comes from.
    const towards = (Math.atan2(east, north) * 180) / Math.PI;
    const bearing = (((current ? towards : towards + 180) % 360) + 360) % 360;
    const sector = Math.round(bearing / (360 / SECTORS)) % SECTORS;
    let cls = edges.length - 1;
    while (cls > 0 && speed < edges[cls]) {
      cls--;
    }
    counts[sector][cls]++;
  });
  const share = (count: number) => (n ? (100 * count) / n : 0);
  return {
    sectors: counts.map((row) => row.map(share)),
    classes: edges.map((edge, at) =>
      at + 1 < edges.length ? `${edge}–${edges[at + 1]}` : `≥ ${edge}`
    ),
    calm: share(calm),
    calmBelow: edges[0],
    n,
    convention: current ? "towards" : "from",
  };
}

type TColours = {
  fg: string;
  muted: string;
  grid: string;
  ramp: string[];
  /** The figure's background, for halos behind labels. */
  bg?: string;
};

/** What a figure says about the place under the pointer. */
export type TProbe = {
  /** Where the readout points (canvas px). */
  x: number;
  y: number;
  title: string;
  lines: { colour?: string; text: string; strong?: boolean }[];
  /** A legend entry that a click toggles, and which. */
  toggles?: boolean;
  index?: number;
};

const LEGEND_WIDTH = 120;
const COMPASS_16 = [
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
 * Where a rose's parts lie in a w × h box: centre, radius, scale, and the
 * legend rows. Speed classes in `hidden` are left out of the petals (and
 * the scale follows what is shown), so the pattern without them shows.
 */
function roseLayout(
  width: number,
  height: number,
  rose: TRose,
  hidden: ReadonlySet<number> = new Set()
) {
  const cx = (width - LEGEND_WIDTH) / 2;
  const cy = height / 2 + 2;
  const radius = Math.max(20, Math.min(cx, height / 2) - 24);
  const shown = rose.sectors.map((row) =>
    row.map((percent, cls) => (hidden.has(cls) ? 0 : percent))
  );
  const totals = shown.map((row) => row.reduce((a, b) => a + b, 0));
  const most = Math.max(1, ...totals);
  const step = most > 20 ? 10 : most > 8 ? 5 : 2;
  const outer = Math.ceil(most / step) * step;
  const row = Math.max(
    14,
    Math.min(18, (height - 60) / (rose.classes.length + 3))
  );
  return {
    cx,
    cy,
    radius,
    shown,
    totals,
    step,
    outer,
    r: (percent: number) => (percent / outer) * radius,
    legend: { x: width - LEGEND_WIDTH + 6, row, top: 34 },
  };
}

/**
 * The rose under the pointer: a legend entry (a click hides or shows its
 * class), or a sector's shares by class, the class pointed at in bold.
 */
// eslint-disable-next-line max-lines-per-function
export function probeRose(
  x: number,
  y: number,
  width: number,
  height: number,
  rose: TRose,
  ramp: string[],
  hidden: ReadonlySet<number> = new Set()
): TProbe | undefined {
  const at = roseLayout(width, height, rose, hidden);
  const { legend } = at;
  if (x >= legend.x - 4) {
    const cls = Math.round((y - legend.top) / legend.row);
    if (cls < 0 || cls >= rose.classes.length) {
      return undefined;
    }
    const off = hidden.has(cls);
    return {
      x: legend.x,
      y: legend.top + cls * legend.row,
      title: `${rose.classes[cls]} m s-1`,
      lines: [{ text: off ? "Hidden: click to show" : "Click to hide" }],
      toggles: true,
      index: cls,
    };
  }
  const [dx, dy] = [x - at.cx, y - at.cy];
  const distance = Math.hypot(dx, dy);
  if (distance > at.radius + 4 || distance < 6) {
    return undefined;
  }
  const bearing = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  const sector = Math.round(bearing / (360 / SECTORS)) % SECTORS;
  if (!at.totals[sector]) {
    return undefined;
  }
  // The class whose band the pointer is in (none past the petal).
  let inner = 0;
  let pointed = -1;
  at.shown[sector].forEach((percent, cls) => {
    if (
      percent &&
      distance >= at.r(inner) &&
      distance < at.r(inner + percent)
    ) {
      pointed = cls;
    }
    inner += percent;
  });
  const share = (v: number) => `${v < 0.1 && v > 0 ? "< 0.1" : v.toFixed(1)} %`;
  const word = rose.convention === "from" ? "From" : "Towards";
  return {
    x,
    y,
    title: `${word} ${COMPASS_16[sector]}: ${share(at.totals[sector])}`,
    lines: rose.sectors[sector]
      .map((percent, cls) => ({ percent, cls }))
      .filter(({ percent, cls }) => percent > 0 && !hidden.has(cls))
      .reverse()
      .map(({ percent, cls }) => ({
        colour: ramp[cls % ramp.length],
        text: `${rose.classes[cls]} m s-1: ${share(percent)}`,
        strong: cls === pointed,
      })),
  };
}

/** A rose in a w × h box, with its rings, compass and speed legend. */

// eslint-disable-next-line max-lines-per-function
export function drawRose(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  rose: TRose,
  colours: TColours,
  hidden: ReadonlySet<number> = new Set()
) {
  const layout = roseLayout(width, height, rose, hidden);
  const { cx, cy, radius, totals, step, outer, r } = layout;
  // Ring labels go along the emptiest direction, clear of the petals.
  const quiet = totals.indexOf(Math.min(...totals));
  const labelAngle = (quiet * 2 * Math.PI) / SECTORS;
  const halo = colours.bg ?? "rgba(255, 255, 255, 0.85)";
  const label = (text: string, x: number, y: number) => {
    context.lineWidth = 3;
    context.strokeStyle = halo;
    context.strokeText(text, x, y);
    context.fillText(text, x, y);
  };
  context.save();
  context.font = "11px sans-serif";
  context.lineWidth = 1;
  // Rings and spokes under the petals.
  context.strokeStyle = colours.grid;
  for (let ring = step; ring <= outer; ring += step) {
    context.beginPath();
    context.arc(cx, cy, r(ring), 0, 2 * Math.PI);
    context.stroke();
  }
  COMPASS.forEach((_, at) => {
    const angle = (at * Math.PI) / 2;
    context.beginPath();
    context.moveTo(cx, cy);
    context.lineTo(
      cx + Math.sin(angle) * radius,
      cy - Math.cos(angle) * radius
    );
    context.stroke();
  });
  // Wedges: classes stacked outwards, each sector 22.5° wide.
  const half = (Math.PI / SECTORS) * 0.86;
  layout.shown.forEach((row, sector) => {
    const centre = (sector * 2 * Math.PI) / SECTORS - Math.PI / 2;
    let inner = 0;
    row.forEach((percent, cls) => {
      if (!percent) {
        return;
      }
      context.beginPath();
      context.arc(cx, cy, r(inner + percent), centre - half, centre + half);
      context.arc(cx, cy, r(inner), centre + half, centre - half, true);
      context.closePath();
      context.fillStyle = colours.ramp[cls % colours.ramp.length];
      context.fill();
      inner += percent;
    });
  });
  // Compass letters outside, ring shares along the quiet direction.
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = colours.fg;
  COMPASS.forEach((letter, at) => {
    const angle = (at * Math.PI) / 2;
    context.fillText(
      letter,
      cx + Math.sin(angle) * (radius + 12),
      cy - Math.cos(angle) * (radius + 12)
    );
  });
  context.font = "10px sans-serif";
  context.fillStyle = colours.muted;
  // Every ring while they are far enough apart, else every other; none
  // over the calm share in the middle.
  const every = r(step) < 26 ? 2 : 1;
  for (let ring = step * every; ring <= outer; ring += step * every) {
    if (r(ring) < 22) {
      continue;
    }
    label(
      `${ring} %`,
      cx + Math.sin(labelAngle) * r(ring),
      cy - Math.cos(labelAngle) * r(ring)
    );
  }
  // Calm in the middle, as wind roses show it.
  context.font = "600 10px sans-serif";
  context.fillStyle = colours.fg;
  label(`calm ${rose.calm.toFixed(0)} %`, cx, cy);
  // Legend: speed classes (m s-1), the direction convention, the count;
  // a hidden class an empty box, its name muted and struck through.
  const { x: lx, row, top } = layout.legend;
  context.font = "11px sans-serif";
  context.textAlign = "left";
  context.fillStyle = colours.muted;
  context.fillText("speed (m s-1)", lx, 16);
  rose.classes.forEach((name, cls) => {
    const y = top + cls * row;
    const colour = colours.ramp[cls % colours.ramp.length];
    const off = hidden.has(cls);
    context.fillStyle = colour;
    context.strokeStyle = colour;
    context.lineWidth = 1.5;
    if (off) {
      context.strokeRect(lx + 0.75, y - 5.25, 10.5, 10.5);
    } else {
      context.fillRect(lx, y - 6, 12, 12);
    }
    context.fillStyle = off ? colours.muted : colours.fg;
    context.fillText(name, lx + 18, y);
    if (off) {
      const w = context.measureText(name).width;
      context.strokeStyle = colours.muted;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(lx + 18, y);
      context.lineTo(lx + 18 + w, y);
      context.stroke();
    }
  });
  const below = top + rose.classes.length * row + 6;
  context.fillStyle = colours.muted;
  context.fillText(
    rose.convention === "from" ? "from the direction" : "towards the direction",
    lx,
    below
  );
  context.fillText(`${rose.n} samples`, lx, below + 16);
  context.restore();
}

/**
 * A hodograph: the wind vector's tip at each level, joined from the lowest
 * level up, with speed rings; levels labelled at both ends.
 */
/** A trace's points at least a pixel from the last one kept; ends kept. */
function thinTrace<T extends { u: number; v: number }>(
  points: T[],
  x: (u: number) => number,
  y: (v: number) => number
) {
  const kept: T[] = [];
  points.forEach((p, at) => {
    const q = kept.at(-1);
    if (
      !q ||
      at === points.length - 1 ||
      Math.hypot(x(p.u) - x(q.u), y(p.v) - y(q.v)) >= 1
    ) {
      kept.push(p);
    }
  });
  return kept;
}

/**
 * Rings every 5, 10 or 20 m s-1, and for anything faster a round step
 * giving at most five rings (a value of 1e20 draws five rings, not 5e18).
 */
export function ringStep(reach: number) {
  if (reach <= 100) {
    return reach > 40 ? 20 : reach > 15 ? 10 : 5;
  }
  const raw = reach / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
}

type THodographWind = {
  u: number[];
  v: number[];
  units?: string;
  levels: string[];
};

/** Where a hodograph's points lie in a w × h box (m s-1 to px). */
function hodographLayout(width: number, height: number, wind: THodographWind) {
  const toMetres = knotsPer(wind.units).factor / 1.943844;
  const points = wind.u
    .map((u, at) => ({
      u: u * toMetres,
      v: wind.v[at] * toMetres,
      label: wind.levels[at],
    }))
    .filter((p) => Number.isFinite(p.u) && Number.isFinite(p.v));
  // A loop, not a spread: 200,000 levels overflow the call stack.
  let reach = 5;
  for (const p of points) {
    reach = Math.max(reach, Math.abs(p.u), Math.abs(p.v));
  }
  const step = ringStep(reach);
  const outer = Math.ceil(reach / step) * step;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(20, Math.min(width, height) / 2 - 30);
  const x = (u: number) => cx + (u / outer) * radius;
  const y = (v: number) => cy - (v / outer) * radius;
  return { points, step, outer, cx, cy, radius, x, y };
}

/**
 * The level nearest the pointer (within 14 px): its components, speed
 * and the direction the wind comes from.
 */
export function probeHodograph(
  px: number,
  py: number,
  width: number,
  height: number,
  wind: THodographWind
): TProbe | undefined {
  const { points, x, y } = hodographLayout(width, height, wind);
  let best: { p: (typeof points)[number]; d: number } | undefined;
  for (const p of points) {
    const d = Math.hypot(x(p.u) - px, y(p.v) - py);
    if (d < 14 && (!best || d < best.d)) {
      best = { p, d };
    }
  }
  if (!best) {
    return undefined;
  }
  const { p } = best;
  const from = ((Math.atan2(-p.u, -p.v) * 180) / Math.PI + 360) % 360;
  const f = (v: number) => v.toFixed(Math.abs(v) < 10 ? 2 : 1);
  return {
    x: x(p.u),
    y: y(p.v),
    title: p.label,
    lines: [
      { text: `u ${f(p.u)}, v ${f(p.v)} m s-1` },
      {
        text: `${f(Math.hypot(p.u, p.v))} m s-1 from ${from.toFixed(0)}° (${
          COMPASS_16[Math.round(from / 22.5) % 16]
        })`,
      },
    ],
  };
}

// eslint-disable-next-line max-lines-per-function
export function drawHodograph(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  wind: THodographWind,
  colours: TColours
) {
  const { points, step, outer, cx, cy, radius, x, y } = hodographLayout(
    width,
    height,
    wind
  );
  context.save();
  context.font = "11px sans-serif";
  context.strokeStyle = colours.grid;
  context.fillStyle = colours.muted;
  context.lineWidth = 1;
  for (let ring = step; ring <= outer; ring += step) {
    context.beginPath();
    context.arc(cx, cy, (ring / outer) * radius, 0, 2 * Math.PI);
    context.stroke();
    context.fillText(`${ring}`, x(ring) + 3, cy - 3);
  }
  context.beginPath();
  context.moveTo(cx - radius, cy);
  context.lineTo(cx + radius, cy);
  context.moveTo(cx, cy - radius);
  context.lineTo(cx, cy + radius);
  context.stroke();
  context.textAlign = "center";
  context.fillText("u, eastward (m s-1)", cx, cy + radius + 18);
  context.save();
  context.translate(cx - radius - 14, cy);
  context.rotate(-Math.PI / 2);
  context.fillText("v, northward (m s-1)", 0, 0);
  context.restore();
  // The trace from the lowest level up, coloured along the ramp; levels
  // closer than a pixel to the last one drawn are passed over (the shape
  // stays, 200,000 levels do not mean 400,000 canvas calls).
  const drawn = thinTrace(points, x, y);
  drawn.forEach((p, at) => {
    const colour =
      colours.ramp[
        Math.min(
          colours.ramp.length - 1,
          Math.floor(
            (at / Math.max(1, drawn.length - 1)) * (colours.ramp.length - 1)
          )
        )
      ];
    if (at) {
      const q = drawn[at - 1];
      context.strokeStyle = colour;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x(q.u), y(q.v));
      context.lineTo(x(p.u), y(p.v));
      context.stroke();
    }
    context.fillStyle = colour;
    context.beginPath();
    context.arc(x(p.u), y(p.v), 3, 0, 2 * Math.PI);
    context.fill();
  });
  context.fillStyle = colours.fg;
  context.textAlign = "left";
  for (const p of [points[0], points[points.length - 1]]) {
    if (p) {
      context.fillText(p.label, x(p.u) + 6, y(p.v) - 6);
    }
  }
  context.restore();
}
