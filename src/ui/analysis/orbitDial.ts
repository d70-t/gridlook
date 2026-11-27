/**
 * The plot catalog and the Orbit dial. Five fixed sectors (Point, Path, Box,
 * Polygon, Country), the figures each one offers, and the ring's geometry.
 * The dial (OrbitDial.vue, from Plotting tools) and the right-click menu
 * (PlotMenu.vue) both offer exactly these. Pure data and geometry.
 */
import { timeVerticalName } from "./plotFigure.ts";

import { ANALYSIS_KINDS, type TAnalysisKind } from "@/lib/analysis/types.ts";
import { isTimeCoordinate } from "@/lib/data/timeHandling.ts";
import type { TDimInfo, TVarInfo } from "@/lib/types/GlobeTypes.ts";
import { DRAW_MODES, type TDrawMode } from "@/store/analysisStore.ts";

export const SECTORS = {
  POINT: "point",
  PATH: "path",
  BOX: "box",
  POLYGON: "polygon",
  COUNTRY: "country",
} as const;

export type TSector = (typeof SECTORS)[keyof typeof SECTORS];

export type TSectorInfo = {
  id: TSector;
  label: string;
  /** The hub's short cue for the active geometry. */
  cue: string;
  /** How the selection is drawn; a country is chosen by name instead. */
  mode?: TDrawMode;
  /** What the right-click location becomes. */
  origin: string;
  /** Main action of a selected figure row. */
  draw: string;
  /** Centre of the wedge, degrees clockwise from the top. */
  angle: number;
};

/**
 * Fixed positions, clockwise from the top (also the arrow-key order):
 * Point, Path, Box, Polygon, Country, each a 72° piece.
 */
export const SECTOR_LIST: TSectorInfo[] = [
  {
    id: SECTORS.POINT,
    label: "Point",
    cue: "Samples one location",
    mode: DRAW_MODES.POINT,
    origin: "the location",
    draw: "Click on map",
    angle: 0,
  },
  {
    id: SECTORS.PATH,
    label: "Path",
    cue: "Follows a route",
    mode: DRAW_MODES.POLYLINE,
    origin: "point 1",
    draw: "Draw path",
    angle: 72,
  },
  {
    id: SECTORS.BOX,
    label: "Box",
    cue: "Selects a rectangle",
    mode: DRAW_MODES.BOX,
    origin: "corner 1",
    draw: "Draw box",
    angle: 144,
  },
  {
    id: SECTORS.POLYGON,
    label: "Polygon",
    cue: "Outlines a custom area",
    mode: DRAW_MODES.POLYGON,
    origin: "point 1",
    draw: "Draw polygon",
    angle: 216,
  },
  {
    id: SECTORS.COUNTRY,
    label: "Country",
    cue: "Chooses a country by name",
    origin: "the country there",
    draw: "Choose country",
    angle: 288,
  },
];

/** Degrees of one piece of the ring. */
export const PIECE = 360 / SECTOR_LIST.length;

const GLYPHS = {
  LINE: "line",
  PROFILE: "profile",
  HEATMAP: "heatmap",
  CURTAIN: "curtain",
  BARS: "bars",
} as const;

export type TGlyph = (typeof GLYPHS)[keyof typeof GLYPHS];

export type TFigure = {
  kind: TAnalysisKind;
  title: string;
  /** One plain-language line on what the plot shows. */
  help: string;
  glyph: TGlyph;
};

type TVerticalInfo = { physical: boolean; label: string; units?: string };

const AREA_FIGURES: TFigure[] = [
  {
    kind: ANALYSIS_KINDS.REGION_SERIES,
    title: "Area-mean time series",
    help: "Follow the area-weighted mean through time.",
    glyph: GLYPHS.LINE,
  },
  {
    kind: ANALYSIS_KINDS.DISTRIBUTION,
    title: "Value distribution",
    help: "See how much of the valid area falls in each value range.",
    glyph: GLYPHS.BARS,
  },
];

const FIGURES: Record<TSector, TFigure[]> = {
  [SECTORS.POINT]: [
    {
      kind: ANALYSIS_KINDS.POINT_SERIES,
      title: "Time series",
      help: "Follow the value at one location through time.",
      glyph: GLYPHS.LINE,
    },
    {
      kind: ANALYSIS_KINDS.PROFILE,
      title: "Vertical profile",
      help: "Compare levels at one location and time.",
      glyph: GLYPHS.PROFILE,
    },
    {
      kind: ANALYSIS_KINDS.TIME_DEPTH,
      title: "Time–vertical diagram",
      help: "See how the water column or atmosphere changes through time.",
      glyph: GLYPHS.HEATMAP,
    },
  ],
  [SECTORS.PATH]: [
    {
      kind: ANALYSIS_KINDS.SECTION,
      title: "Cross-section",
      help: "Sample along a route and across its available levels.",
      glyph: GLYPHS.CURTAIN,
    },
    {
      kind: ANALYSIS_KINDS.HOVMOLLER_PATH,
      title: "Distance × time (Hovmöller)",
      help: "Follow a signal along a route through time.",
      glyph: GLYPHS.HEATMAP,
    },
  ],
  [SECTORS.BOX]: [
    ...AREA_FIGURES,
    {
      kind: ANALYSIS_KINDS.HOVMOLLER_LON,
      title: "Longitude × time (Hovmöller)",
      help: "Average over latitude to see how the field varies by longitude and time.",
      glyph: GLYPHS.HEATMAP,
    },
    {
      kind: ANALYSIS_KINDS.HOVMOLLER_LAT,
      title: "Latitude × time (Hovmöller)",
      help: "Average over longitude to see how the field varies by latitude and time.",
      glyph: GLYPHS.HEATMAP,
    },
    {
      kind: ANALYSIS_KINDS.LAT_VERTICAL,
      title: "Latitude–vertical section",
      help: "Average over longitude to compare latitude and the vertical coordinate at one time.",
      glyph: GLYPHS.CURTAIN,
    },
    {
      kind: ANALYSIS_KINDS.LON_VERTICAL,
      title: "Longitude–vertical section",
      help: "Average over latitude to compare longitude and the vertical coordinate at one time (an equatorial thermocline).",
      glyph: GLYPHS.CURTAIN,
    },
  ],
  [SECTORS.POLYGON]: AREA_FIGURES,
  // Cell centres inside the country's Natural Earth boundary, area-weighted.
  [SECTORS.COUNTRY]: AREA_FIGURES,
};

/** Sector icons, centred on 0,0 (about 18 units across). */
export const ICONS: Record<TSector, string> = {
  point: "M0 -4.5 A4.5 4.5 0 1 1 -0.01 -4.5 Z",
  path: "M-9 6 L-3 -3 L3 3 L9 -6",
  box: "M-8 -6 H8 V6 H-8 Z",
  polygon: "M0 -8 L8 -2 L5 7 L-5 7 L-8 -2 Z",
  country: "M-6 8 V-8 M-6 -7 C-2 -9 1 -5 7 -7 V1 C1 3 -2 -1 -6 1",
};

/** A padlock, centred like the sector icons: shown where none can work. */
export const LOCK_ICON =
  "M-5.5 -1 H5.5 V8 H-5.5 Z M-3.5 -1 V-4 A3.5 3.5 0 0 1 3.5 -4 V-1 M0 2.5 V4.5";

/** Small plot glyphs in a 24 × 24 box. */
export const GLYPH_PATHS: Record<TGlyph, string> = {
  line: "M2 14 L7 8 L11 11 L16 4 L22 7",
  profile: "M12 2 C8 6 15 10 10 14 C7 17 13 19 12 22",
  heatmap: "M2 3 H22 V21 H2 Z M2 9 H22 M2 15 H22 M9 3 V21 M16 3 V21",
  curtain:
    "M2 4 H22 M2 4 V20 H22 V4 M2 10 C8 8 14 13 22 10 M2 15 C9 13 15 17 22 15",
  bars: "M3 21 V13 H7 V21 M9 21 V6 H13 V21 M15 21 V10 H19 V21",
};
/**
 * The figures of a sector, in order. Titles with a vertical coordinate name
 * it (Time–depth diagram) once the variable is known.
 */
export function figuresOf(
  sector: TSector,
  vertical?: TVerticalInfo
): TFigure[] {
  if (!vertical) {
    return FIGURES[sector];
  }
  const named: Partial<Record<TAnalysisKind, string>> = {
    [ANALYSIS_KINDS.TIME_DEPTH]: `${timeVerticalName(vertical)} diagram`,
    [ANALYSIS_KINDS.LAT_VERTICAL]: `${timeVerticalName(vertical, "Latitude")} section`,
    [ANALYSIS_KINDS.LON_VERTICAL]: `${timeVerticalName(vertical, "Longitude")} section`,
  };
  return FIGURES[sector].map((figure) =>
    named[figure.kind] ? { ...figure, title: named[figure.kind]! } : figure
  );
}

/** Short, plain reasons for figures the variable cannot make. */
const attrsOf = (info: TDimInfo | undefined) =>
  info && "attrs" in info ? info.attrs : {};

/** Plots that need a vertical axis (a profile, a time–vertical diagram…). */
const NEEDS_VERTICAL: TAnalysisKind[] = [
  ANALYSIS_KINDS.PROFILE,
  ANALYSIS_KINDS.TIME_DEPTH,
  ANALYSIS_KINDS.LAT_VERTICAL,
  ANALYSIS_KINDS.LON_VERTICAL,
];

/** Plots along several dates (a series is offered with one). */
const NEEDS_DATES: TAnalysisKind[] = [
  ANALYSIS_KINDS.TIME_DEPTH,
  ANALYSIS_KINDS.HOVMOLLER_LON,
  ANALYSIS_KINDS.HOVMOLLER_LAT,
  ANALYSIS_KINDS.HOVMOLLER_PATH,
];
/** Plots along a time axis of any length. */
const NEEDS_TIME: TAnalysisKind[] = [
  ANALYSIS_KINDS.POINT_SERIES,
  ANALYSIS_KINDS.REGION_SERIES,
  ...NEEDS_DATES,
];

/** Steps along each of the map's dimensions besides the horizontal ones. */
function mapSteps(map: Pick<TVarInfo, "dimRanges" | "dimInfo">) {
  return map.dimRanges.flatMap((range, i) => {
    if (range === null) {
      return [];
    }
    const info = map.dimInfo[i];
    return [info && "values" in info ? info.values.length : range.maxBound + 1];
  });
}

/**
 * Whether describing the map's variable is cheap enough to start when the
 * plot menu opens: every axis besides the horizontal ones is short, so
 * its coordinates are a few reads (a long axis stored one value a chunk
 * is tens of thousands; that waits until a plot is chosen).
 */
export function cheapToDescribe(map: Pick<TVarInfo, "dimRanges" | "dimInfo">) {
  return mapSteps(map).every((steps) => steps <= 256);
}

/**
 * Why each plot is unavailable ("" when it is offered). A described
 * variable decides. Before that, dimension names alone cannot rule a plot
 * out (`time(record)` runs along `record`, a pressure coordinate can
 * describe `layer_id`); only the map's own dimensions can: a variable with
 * no dimension besides time and the horizontal ones has no levels, one
 * with none at all has no time either, and one whose every other axis
 * holds a single step has one date at most.
 */
export function chooserReasons(
  summary?: {
    capabilities: Record<
      TAnalysisKind,
      { available: boolean; reason?: string }
    >;
  },
  map?: Pick<TVarInfo, "dimRanges" | "dimInfo">
) {
  const flat =
    !summary &&
    map !== undefined &&
    map.dimRanges.every(
      (range, i) =>
        range === null || isTimeCoordinate(range.name, attrsOf(map.dimInfo[i]))
    );
  const steps = !summary && map ? mapSteps(map) : undefined;
  const timeless = steps !== undefined && steps.length === 0;
  const oneDate = steps !== undefined && steps.every((n) => n <= 1);
  return Object.fromEntries(
    Object.values(ANALYSIS_KINDS).map((kind) => {
      const capability = summary?.capabilities[kind];
      if (timeless && NEEDS_TIME.includes(kind)) {
        return [kind, "The variable has no time dimension."];
      }
      if (oneDate && NEEDS_DATES.includes(kind)) {
        return [kind, "The variable has only one time step."];
      }
      if (flat && NEEDS_VERTICAL.includes(kind)) {
        return [kind, "The variable has no vertical dimension."];
      }
      return [
        kind,
        !capability || capability.available
          ? ""
          : (capability.reason ?? "unavailable"),
      ];
    })
  ) as Record<TAnalysisKind, string>;
}

/**
 * Why Compare cannot start ("" when it can). Compare compares finished
 * time series, a place's or an area's: two already open will do, and
 * otherwise this variable must make one (25 Nov: a Sentinel-2 scene with
 * no time axis offered Compare places, and every pick in it was locked).
 */
export function compareReason(
  reasons: Record<TAnalysisKind, string>,
  note: string,
  comparable: number
) {
  if (comparable >= 2) {
    return "";
  }
  const point = note || reasons[ANALYSIS_KINDS.POINT_SERIES];
  const area = note || reasons[ANALYSIS_KINDS.REGION_SERIES];
  return point && area ? quietReason(point) : "";
}

export function quietReason(reason: string) {
  if (!reason) {
    return "";
  }
  if (/vertical|level/i.test(reason)) {
    return "Needs vertical levels";
  }
  if (/only one time step/i.test(reason)) {
    return "Needs more than one time step";
  }
  if (/time/i.test(reason)) {
    return "Needs a time axis";
  }
  if (/bounds|weights|area/i.test(reason)) {
    return "Needs cell areas";
  }
  if (/categor/i.test(reason)) {
    return "Not for categories";
  }
  return reason.length > 40 ? `${reason.slice(0, 38)}…` : reason;
}

// ---------------------------------------------------------------------------
// Geometry of the ring (SVG units; the ring is drawn in a size × size box).

export const RING = {
  size: 232,
  /** The continuous rim (a bezel with an engraved scale) around the pieces. */
  rim: 113,
  outer: 95,
  inner: 44,
  /** The recessed hub. */
  hub: 38,
  /** Seam between pieces: the same width from hub to rim (SVG units). */
  gap: 3,
  /**
   * The bezel's scale: a tick every `step` degrees, longer at the seams.
   * 6° divides the 36° half-piece, so the seam ticks fall on the seams.
   */
  tick: { step: 6, from: 101.5, to: 105.5, seamFrom: 99.5, seamTo: 108.5 },
  /** The bead that glides around the bezel to the chosen piece. */
  bead: 109.6,
} as const;

function polar(radius: number, degrees: number) {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return [
    RING.size / 2 + radius * Math.cos(radians),
    RING.size / 2 + radius * Math.sin(radians),
  ];
}

/**
 * The SVG path of a piece centred on `angle`. Its sides run parallel to
 * the seam line at half the gap, so every seam has one width from hub to
 * rim (an angular gap would widen outwards).
 */
export function wedgePath(angle: number) {
  const inset = (radius: number) =>
    (Math.asin(RING.gap / 2 / radius) * 180) / Math.PI;
  const edge = (radius: number, side: -1 | 1) =>
    polar(radius, angle + side * (PIECE / 2 - inset(radius)));
  const [ox0, oy0] = edge(RING.outer, -1);
  const [ox1, oy1] = edge(RING.outer, 1);
  const [ix1, iy1] = edge(RING.inner, 1);
  const [ix0, iy0] = edge(RING.inner, -1);
  const f = (n: number) => n.toFixed(2);
  return [
    `M ${f(ox0)} ${f(oy0)}`,
    `A ${RING.outer} ${RING.outer} 0 0 1 ${f(ox1)} ${f(oy1)}`,
    `L ${f(ix1)} ${f(iy1)}`,
    `A ${RING.inner} ${RING.inner} 0 0 0 ${f(ix0)} ${f(iy0)}`,
    "Z",
  ].join(" ");
}

/** Where a wedge's icon and label sit (its middle radius). */
export function wedgeCentre(angle: number) {
  const [x, y] = polar((RING.outer + RING.inner) / 2, angle);
  return { x, y };
}

// ---------------------------------------------------------------------------
// Placement and motion.

export type TBox = { x: number; y: number; w: number; h: number };

/**
 * The panel's bounds: always in the lower-left map corner, 10 px above the
 * Plotting tools button and aligned with its left edge (also for a
 * right-click, which only marks the starting point on the map). A panel
 * taller than the room above the button starts 8 px below the map's top
 * and scrolls.
 */
export function placeDial(
  button: TBox,
  size: { w: number; h: number },
  area: { width: number; height: number }
) {
  const margin = 8;
  const x = Math.max(margin, Math.min(button.x, area.width - size.w - margin));
  const room = button.y - 10 - margin;
  const h = Math.min(size.h, room);
  return { x, y: button.y - 10 - h, w: size.w, h };
}

/**
 * The right-click submenu, in map pixels, from the menu's box and its
 * entry's top. Wide maps put it beside the menu (right, else left); narrow
 * ones in the menu's place. Either way it stays inside the map, narrowed if
 * the map is narrower than the submenu.
 */
/**
 * A context menu where the pointer is, as desktop menus open: its corner
 * at the click, flipped left (or up) only where it would cross the map's
 * edge. `beside` says whether a submenu fits next to it on either side;
 * when it does not, the submenu replaces the menu (with Back).
 */
export function placeMenu(
  at: { x: number; y: number },
  size: { w: number; h: number },
  sub: number,
  area: { width: number; height: number }
) {
  const margin = 8;
  const flip = (p: number, len: number, room: number) => {
    const at = p + 2 + len <= room - margin ? p + 2 : p - 2 - len;
    return Math.max(margin, Math.min(at, room - len - margin));
  };
  const x = flip(at.x, size.w, area.width);
  const y = flip(at.y, size.h, area.height);
  const beside =
    x + size.w + 4 + sub <= area.width - margin || x - 4 - sub >= margin;
  return { x, y, beside };
}

export function placeSubmenu(
  menu: { left: number; right: number; top: number },
  entryTop: number,
  size: { w: number; h: number },
  area: { width: number; height: number },
  beside: boolean
) {
  const margin = 8;
  const w = Math.min(size.w, area.width - 2 * margin);
  const inside = (x: number) =>
    Math.max(margin, Math.min(x, area.width - w - margin));
  if (!beside) {
    return { x: inside(menu.left), y: menu.top, w };
  }
  const right = menu.right + 4;
  const x =
    right + w <= area.width - margin ? right : inside(menu.left - w - 4);
  const y = Math.max(
    margin,
    Math.min(entryTop - 6, area.height - size.h - margin)
  );
  return { x, y, w };
}

/** Opening and closing durations (ms) and the reduced-motion fade. */
export const DIAL_MOTION = { open: 240, close: 170, reduced: 120 } as const;

/**
 * Where a window should open beside a selection's screen bounds: to its
 * right when it fits, else to its left, else wherever the cascade put it.
 */
export function besideSelection(
  selection: TBox,
  rect: TBox,
  area: { width: number; height: number }
): TBox {
  const gap = 16;
  const y = Math.max(8, Math.min(selection.y, area.height - rect.h - 8));
  if (selection.x + selection.w + gap + rect.w <= area.width - 8) {
    return { ...rect, x: selection.x + selection.w + gap, y };
  }
  if (selection.x - gap - rect.w >= 8) {
    return { ...rect, x: selection.x - gap - rect.w, y };
  }
  return rect;
}

/** Where the bezel bead sits for a quarter (centre of the rim at its angle). */
export function beadAt(angle: number) {
  const [x, y] = polar(RING.bead, angle);
  return { x, y };
}

/**
 * The bezel's engraved scale as three SVG paths: the grooves, their light
 * lower-right lips (so they read as cut into the rim), and the grooves over
 * the chosen quarter, drawn in the accent. Seams get longer ticks.
 */
export function bezelPaths(selectedAngle?: number) {
  const { step, from, to, seamFrom, seamTo } = RING.tick;
  const half = PIECE / 2 - RING.gap;
  const f = (n: number) => n.toFixed(2);
  const groove: string[] = [];
  const lip: string[] = [];
  const lit: string[] = [];
  for (let angle = 0; angle < 360; angle += step) {
    const seam = (angle + PIECE / 2) % PIECE === 0;
    const [x0, y0] = polar(seam ? seamFrom : from, angle);
    const [x1, y1] = polar(seam ? seamTo : to, angle);
    const delta =
      selectedAngle === undefined
        ? Infinity
        : Math.abs(((angle - selectedAngle + 540) % 360) - 180);
    const line = `M ${f(x0)} ${f(y0)} L ${f(x1)} ${f(y1)}`;
    (!seam && delta < half ? lit : groove).push(line);
    lip.push(`M ${f(x0 + 0.6)} ${f(y0 + 0.6)} L ${f(x1 + 0.6)} ${f(y1 + 0.6)}`);
  }
  return { groove: groove.join(" "), lip: lip.join(" "), lit: lit.join(" ") };
}

/** The shortest turn from one bead angle to the next (keeps it unwrapped). */
export function nextBeadTurn(from: number, to: number) {
  const delta = ((to - from + 540) % 360) - 180;
  return from + delta;
}
