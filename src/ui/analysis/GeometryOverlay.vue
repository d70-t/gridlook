<script lang="ts" setup>
import {
  computed,
  onBeforeUnmount,
  ref,
  shallowReactive,
  shallowRef,
  watch,
} from "vue";

import { drawnOutline, screenBoxPaths } from "./boxFootprint.ts";
import { mapCountryPicker } from "./countryPicking.ts";
import { outlinePaths } from "./outlinePaths.ts";
import { pointAlongPath } from "./pathMarks.ts";
import {
  correspondingIndex,
  geometryVertices,
  mapCoordinateOf,
  mapSettingsFromStore,
} from "./plotLayout.ts";
import { besideInside, drawnBoxEdges } from "./regionModes.ts";
import { litPieces, ringAround, spotlightPath } from "./spotlight.ts";

import {
  countryBordersOf,
  countryOutlineOf,
} from "@/lib/analysis/analysisClient.ts";
import { countryOutline } from "@/lib/analysis/countryOutline.ts";
import { framedRings, type TScreenFrame } from "@/lib/analysis/screenFrame.ts";
import { editableForm } from "@/lib/analysis/shapeEdit.ts";
import {
  boxLonSpan,
  interpolateArc,
  toLatLon,
  toVec,
  angleBetween,
  type TLatLon,
} from "@/lib/analysis/sphere.ts";
import { rowOf, rowsUntil } from "@/lib/analysis/timeRows.ts";
import {
  ANALYSIS_KINDS,
  countryIds,
  GEOMETRY_KINDS,
  geometryKey,
  type TCountryGeometry,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import {
  DRAW_MODES,
  useAnalysisStore,
  type TPlotWindow,
} from "@/store/analysisStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import {
  getMapScene,
  mapFrame,
} from "@/ui/grids/composables/useMapInteraction.ts";
import { formatValue } from "@/utils/formatValue.ts";

const analysis = useAnalysisStore();
const globe = useGlobeControlStore();
const svg = ref<SVGSVGElement>();

type TShape = {
  id: string;
  label: string;
  focused: boolean;
  /** An edit not yet applied: dashed and labelled. */
  pending: boolean;
  /** The shape as applied, being edited or replaced: drawn faded. */
  replaced?: boolean;
  paths: string[];
  marker?: { x: number; y: number };
  /** A path's points, numbered from 1 as on its chart's distance axis. */
  numbers?: { x: number; y: number; label: string }[];
  /** A time series' value at the map's time, beside its label. */
  value?: string;
  closed: boolean;
  point: boolean;
  /** The country under the pointer while choosing one. */
  hover?: boolean;
  /**
   * A box's or drawn polygon's inside, as closed screen paths: what the
   * spotlight keeps lit (its outline is drawn as separate edges).
   */
  ring?: string[];
  /**
   * The inside as fill paths, built only when the spotlight lights this shape.
   */
  lit?: () => string[];
  /** Its inside has a hole: lit without seam hairlines. */
  holes?: boolean;
  /** Edges of the outline being drawn that cross another. */
  crossing?: boolean;
};

// Country outlines: loaded once per country and boundary scale shown.
const countryOutlines = shallowReactive(new Map<string, TLatLon[][]>());
const outlineErrors = shallowReactive(new Set<string>());
const retryOutlines = ref(0);
const countryKey = (g: TCountryGeometry) =>
  g.resolution + "/" + countryIds(g).join("+");
const countries = computed(() => {
  const selected = new Map<string, TCountryGeometry>();
  for (const g of [analysis.countryPreview, analysis.countryHover]) {
    if (g) {
      selected.set(countryKey(g), g);
    }
  }
  for (const w of analysis.windows) {
    const displayed = w.result?.query.geometry ?? w.committed?.geometry;
    for (const g of [displayed, w.draft.geometry]) {
      if (g?.kind === GEOMETRY_KINDS.COUNTRY) {
        selected.set(countryKey(g), g);
      }
    }
  }
  return selected;
});

watch(
  [() => [...countries.value.keys()].sort().join("|"), retryOutlines],
  (_, __, onCleanup) => {
    let current = true;
    onCleanup(() => {
      current = false;
    });
    outlineErrors.clear();
    for (const key of countryOutlines.keys()) {
      if (!countries.value.has(key)) {
        countryOutlines.delete(key);
      }
    }
    async function load(key: string, g: TCountryGeometry) {
      try {
        // Prepared in the analysis worker: a fine atlas is not parsed here.
        // Several countries: each outline once (shared by its other uses).
        const outline = (
          await Promise.all(
            countryIds(g).map((id) => countryOutlineOf(id, g.resolution))
          )
        ).flat();
        if (current) {
          countryOutlines.set(key, outline);
        }
      } catch {
        if (current) {
          outlineErrors.add(key);
        }
      }
    }
    for (const [key, g] of countries.value) {
      if (!countryOutlines.has(key)) {
        void load(key, g);
      }
    }
  },
  { immediate: true }
);

// While a country is being chosen, the borders between countries show as a
// dotted guide (loaded once, at the coarse scale).
const borders = shallowRef<TLatLon[][]>();
watch(
  () => Boolean(mapCountryPicker.value),
  (picking) => {
    if (picking && !borders.value) {
      // Without them (an offline atlas), picking works as before.
      countryBordersOf()
        .then((lines) => (borders.value = lines))
        .catch(() => undefined);
    }
  },
  { immediate: true }
);
const borderPaths = computed(() => {
  void mapFrame.value;
  const origin = svg.value?.getBoundingClientRect();
  return mapCountryPicker.value && borders.value && origin
    ? toPaths(borders.value, origin)
    : [];
});

// Densified outlines per geometry, so map frames only reproject.
const outlineCache = new Map<string, TLatLon[][]>();

function cachedOutline(geometry: TGeometry) {
  if (geometry.kind === GEOMETRY_KINDS.COUNTRY) {
    return countryOutlines.get(countryKey(geometry)) ?? [];
  }
  // An imported shape: its rings sampled like a country's, keyed by hash
  // (a drawn box's footprint is outlined differently: its own key).
  const key = `${geometryKey(geometry)}${
    geometry.kind === GEOMETRY_KINDS.SHAPE && geometry.drawn ? "|drawn" : ""
  }`;
  let edges = outlineCache.get(key);
  if (!edges) {
    edges = outline(geometry);
    if (outlineCache.size > 64) {
      outlineCache.clear();
    }
    outlineCache.set(key, edges);
  }
  return edges;
}

const STEP_RADIANS = (1 * Math.PI) / 180;

/** Points along an edge: great circle for drawn edges, parallels for boxes. */
function densify(
  a: TLatLon,
  b: TLatLon,
  alongParallel: boolean,
  /** A box's own longitude span (a full turn is 360°, never 0°). */
  boxSpan?: number
): TLatLon[] {
  if (alongParallel) {
    let span = boxSpan ?? b.lon - a.lon;
    span = boxSpan ?? ((span % 360) + 360) % 360;
    const steps = Math.max(1, Math.ceil(span));
    return Array.from({ length: steps + 1 }, (_, at) => ({
      lat: a.lat,
      lon: a.lon + (span * at) / steps,
    }));
  }
  const va = toVec(a.lat, a.lon);
  const vb = toVec(b.lat, b.lon);
  const steps = Math.max(1, Math.ceil(angleBetween(va, vb) / STEP_RADIANS));
  return Array.from({ length: steps + 1 }, (_, at) =>
    toLatLon(interpolateArc(va, vb, at / steps))
  );
}

function outline(geometry: TGeometry): TLatLon[][] {
  if (geometry.kind === GEOMETRY_KINDS.SHAPE) {
    return geometry.drawn
      ? drawnOutline(geometry.polygons)
      : countryOutline(geometry.polygons);
  }
  const vertices = geometryVertices(geometry);
  if (geometry.kind === GEOMETRY_KINDS.POINT) {
    return [];
  }
  const closed = geometry.kind !== GEOMETRY_KINDS.POLYLINE;
  const edges: TLatLon[][] = [];
  for (let at = 0; at + (closed ? 0 : 1) < vertices.length; at++) {
    const next = vertices[(at + 1) % vertices.length];
    // Box: south and north edges follow parallels (eastward), sides meridians.
    const parallel =
      geometry.kind === GEOMETRY_KINDS.BOX && (at === 0 || at === 2);
    const from =
      geometry.kind === GEOMETRY_KINDS.BOX && at === 2 ? next : vertices[at];
    const to =
      geometry.kind === GEOMETRY_KINDS.BOX && at === 2 ? vertices[at] : next;
    const edge = densify(
      from,
      to,
      parallel,
      // The calculation's own rule: a box around the globe is 360° wide.
      parallel && geometry.kind === GEOMETRY_KINDS.BOX
        ? boxLonSpan(geometry)
        : undefined
    );
    // A box's east (1) and west (3) sides on the world copy beside its
    // inside: a side at 180°E is drawn at a flat map's right edge.
    edges.push(
      geometry.kind === GEOMETRY_KINDS.BOX && (at === 1 || at === 3)
        ? besideInside(edge, at === 1 ? "east" : "west")
        : edge
    );
  }
  return edges;
}

/**
 * Where the camera is, as three reference points on screen. The map renders
 * frames while loading with the camera still; outlines (cached edge arrays)
 * are projected again only when this changes.
 */
function viewKey(origin: DOMRect) {
  const scene = getMapScene();
  const probes = [
    [0, 0],
    [60, 120],
    [-60, -120],
  ].map(([lat, lon]) => {
    const p = scene?.project(lat, lon);
    return p ? `${p.x.toFixed(2)},${p.y.toFixed(2)}` : "-";
  });
  return `${probes.join("|")}|${origin.left},${origin.top},${origin.width},${origin.height}`;
}
const projected = new WeakMap<TLatLon[][], { key: string; paths: string[] }>();

function toPaths(edges: TLatLon[][], origin: DOMRect) {
  const key = viewKey(origin);
  const cached = projected.get(edges);
  if (cached?.key === key) {
    return cached.paths;
  }
  const paths = projectPaths(edges, origin);
  projected.set(edges, { key, paths });
  return paths;
}

function projectPaths(edges: TLatLon[][], origin: DOMRect) {
  const scene = getMapScene();
  if (!scene) {
    return [];
  }
  const viewport = scene.canvas()?.getBoundingClientRect();
  // Cut exactly at a flat map's seam and the globe's horizon (outlinePaths).
  return outlinePaths(edges, (lat, lon) => {
    const p = scene.project(lat, lon, viewport);
    return p
      ? { x: p.x - origin.left, y: p.y - origin.top, visible: p.visible }
      : null;
  });
}

/**
 * The edges drawn for a selection: a band, cap or the whole globe (all
 * longitudes) has no side at ±180° and no edge at a pole; its latitude circles
 * are drawn where they show.
 */
const strokes = new WeakMap<TLatLon[][], TLatLon[][]>();
function strokeOf(geometry: TGeometry) {
  const edges = cachedOutline(geometry);
  if (geometry.kind !== GEOMETRY_KINDS.BOX) {
    return edges;
  }
  const keep = drawnBoxEdges(geometry);
  if (keep.length === edges.length) {
    return edges;
  }
  let drawn = strokes.get(edges);
  if (!drawn) {
    drawn = keep.map((at) => edges[at]);
    strokes.set(edges, drawn);
  }
  return drawn;
}

/** A box's or drawn polygon's outline as one ring, in order around. */
const rings = new WeakMap<object, TLatLon[]>();
function ringOf(geometry: TGeometry) {
  if (
    geometry.kind !== GEOMETRY_KINDS.BOX &&
    geometry.kind !== GEOMETRY_KINDS.POLYGON
  ) {
    return undefined;
  }
  const edges = cachedOutline(geometry);
  let ring = rings.get(edges);
  if (!ring) {
    ring = ringAround(edges, geometry.kind === GEOMETRY_KINDS.BOX);
    rings.set(edges, ring);
  }
  return ring;
}

/**
 * A box drawn on the globe or a curved map: every ring of its footprint (closed
 * along a pole it goes round; the whole globe less a hole), each lit across
 * seams and the limb, filled even–odd.
 */
const drawnRingCache = new WeakMap<object, TLatLon[][]>();
function drawnRings(geometry: TGeometry) {
  if (geometry.kind !== GEOMETRY_KINDS.SHAPE || !geometry.drawn) {
    return undefined;
  }
  let found = drawnRingCache.get(geometry.polygons);
  if (!found) {
    found = geometry.polygons
      .flat()
      .map((ring) => ring.map(([lon, lat]) => ({ lat, lon })));
    drawnRingCache.set(geometry.polygons, found);
  }
  return found;
}

/** A selection's inside as fill paths, if it has one to light. */
function insidePaths(geometry: TGeometry, origin: DOMRect) {
  const drawn = drawnRings(geometry);
  const frame =
    drawn && geometry.kind === GEOMETRY_KINDS.SHAPE && geometry.frame;
  if (frame && sameView(frame)) {
    // In the view it was drawn in, the rectangle itself: what the mean is over,
    // centres at its edges included.
    const { x0, y0, x1, y1 } = frame.rect;
    const [l, t] = [origin.left, origin.top];
    // A moved corner: the frame's quadrilateral, as the mean decides.
    if (frame.quad) {
      return [`M${frame.quad.map(([x, y]) => `${x - l},${y - t}`).join("L")}Z`];
    }
    return [`M${x0 - l},${y0 - t}H${x1 - l}V${y1 - t}H${x0 - l}Z`];
  }
  if (drawn) {
    // In another view: the rings on the boundary the frame decides by,
    // which magnified can lie pixels from the traced ones.
    const rings = frame ? snappedRings(drawn, frame) : drawn;
    return rings.flatMap((ring) => ringPaths(ring, origin));
  }
  const ring = ringOf(geometry);
  return ring ? ringPaths(ring, origin) : undefined;
}

const snappedCache = new WeakMap<object, TLatLon[][]>();
function snappedRings(drawn: TLatLon[][], frame: TScreenFrame) {
  let found = snappedCache.get(frame);
  if (!found) {
    found = framedRings(drawn, frame);
    snappedCache.set(frame, found);
  }
  return found;
}

/** Whether the map shows the view a Box was drawn in, as it was then. */
function sameView(frame: TScreenFrame) {
  const now = getMapScene()?.frame?.();
  const { projection, view, lens, eye, viewport } = frame;
  return (
    !!now &&
    JSON.stringify([
      now.projection,
      now.view,
      now.lens,
      now.eye,
      now.viewport,
    ]) === JSON.stringify([projection, view, lens, eye, viewport])
  );
}

/**
 * A ring's inside on screen as closed paths for a fill: lit where it
 * shows, across a flat map's seam and up to the globe's limb (see
 * litPieces).
 */
const projectedRings = new WeakMap<
  TLatLon[],
  { key: string; paths: string[] }
>();
function ringPaths(ring: TLatLon[], origin: DOMRect) {
  const key = viewKey(origin);
  const cached = projectedRings.get(ring);
  if (cached?.key === key) {
    return cached.paths;
  }
  const scene = getMapScene();
  const viewport = scene?.canvas()?.getBoundingClientRect();
  const paths = scene
    ? litPieces(
        ring,
        (lat, lon) => {
          const p = scene.project(lat, lon, viewport);
          return p
            ? { x: p.x - origin.left, y: p.y - origin.top, visible: p.visible }
            : null;
        },
        {}
      )
    : [];
  projectedRings.set(ring, { key, paths });
  return paths;
}

function screenOf(point: TLatLon | undefined, origin: DOMRect) {
  const p = point && getMapScene()?.project(point.lat, point.lon);
  return p && p.visible
    ? { x: p.x - origin.left, y: p.y - origin.top }
    : undefined;
}

function markerOf(geometry: TGeometry, origin: DOMRect) {
  return screenOf(
    geometry.kind === GEOMETRY_KINDS.COUNTRY ||
      geometry.kind === GEOMETRY_KINDS.SHAPE
      ? cachedOutline(geometry)[0]?.[0]
      : geometryVertices(geometry)[0],
    origin
  );
}

function shapeOf(
  id: string,
  label: string,
  geometry: TGeometry,
  origin: DOMRect,
  flags: { focused: boolean; pending: boolean }
): TShape {
  return {
    id,
    label,
    ...flags,
    paths: toPaths(strokeOf(geometry), origin),
    lit:
      drawnRings(geometry) || ringOf(geometry)
        ? () => insidePaths(geometry, origin) ?? []
        : undefined,
    holes: (drawnRings(geometry)?.length ?? 0) > 1,
    marker: markerOf(geometry, origin),
    numbers:
      geometry.kind === GEOMETRY_KINDS.POLYLINE && !flags.pending
        ? geometry.vertices.flatMap((v, at) => {
            const p = screenOf(v, origin);
            return p ? [{ ...p, label: String(at + 1) }] : [];
          })
        : undefined,
    closed:
      geometry.kind === GEOMETRY_KINDS.BOX ||
      geometry.kind === GEOMETRY_KINDS.POLYGON ||
      geometry.kind === GEOMETRY_KINDS.COUNTRY ||
      geometry.kind === GEOMETRY_KINDS.SHAPE,
    point: geometry.kind === GEOMETRY_KINDS.POINT,
  };
}

/** A window's shown selection, and a dashed preview of an unapplied edit. */
function windowShapes(w: TPlotWindow, origin: DOMRect): TShape[] {
  const focused = analysis.focusedId === w.id;
  const shown =
    w.result?.query.geometry ?? w.committed?.geometry ?? w.draft.geometry;
  // By identity first, then by key (a shape by its hash): no per-frame
  // serialisation of a large geometry.
  const moved =
    shown !== w.draft.geometry &&
    geometryKey(shown) !== geometryKey(w.draft.geometry);
  const list: TShape[] = [
    {
      ...shapeOf(w.id, w.label, shown, origin, { focused, pending: false }),
      value: valueAtMapTime(w),
      // Edited on the map, or changed and not applied: the shape as it is
      // fades, so the one taking its place reads as the change (23 Nov).
      replaced: moved || analysis.shapeEdit?.id === w.id,
    },
  ];
  if (moved) {
    list.push(
      shapeOf(
        `${w.id}-pending`,
        `${w.label} pending`,
        w.draft.geometry,
        origin,
        {
          focused,
          pending: true,
        }
      )
    );
  }
  return list;
}

/** The country under the pointer while choosing: its border lit. */
function hoverShape(origin: DOMRect): TShape[] {
  const hover = analysis.countryHover;
  const chosen = analysis.countryPreview;
  if (
    !hover ||
    (chosen &&
      chosen.resolution === hover.resolution &&
      countryIds(chosen).includes(hover.id))
  ) {
    return [];
  }
  const flags = { focused: false, pending: false };
  return [
    { ...shapeOf("country-hover", "", hover, origin, flags), hover: true },
  ];
}

const shapes = computed<TShape[]>(() => {
  void mapFrame.value;
  const origin = svg.value?.getBoundingClientRect();
  if (!origin) {
    return [];
  }
  // The solid shape is the selection the window shows; an edit not yet
  // displayed is a dashed, labelled preview beside it.
  const list: TShape[] = analysis.windows.flatMap((w) =>
    windowShapes(w, origin)
  );
  list.push(...hoverShape(origin));
  // The country being chosen, dashed, before its plot exists.
  if (analysis.shapePreview) {
    list.push(
      shapeOf("shape-preview", "", analysis.shapePreview, origin, {
        focused: true,
        pending: true,
      })
    );
  }
  if (analysis.countryPreview) {
    list.push(
      shapeOf("country-preview", "", analysis.countryPreview, origin, {
        focused: true,
        pending: true,
      })
    );
  }
  if (analysis.drawMode !== DRAW_MODES.NONE && analysis.drawVertices.length) {
    const vertices = analysis.drawVertices;
    const edges: TLatLon[][] = [];
    if (analysis.drawMode === DRAW_MODES.BOX && analysis.drawBox) {
      list.push(drawingBox(analysis.drawBox, origin));
    }
    for (let at = 0; at + 1 < vertices.length; at++) {
      edges.push(densify(vertices[at], vertices[at + 1], false));
    }
    list.push({
      id: "drawing",
      label: "",
      focused: true,
      pending: true,
      paths: toPaths(edges, origin),
      marker: markerOf({ kind: GEOMETRY_KINDS.POLYLINE, vertices }, origin),
      closed: false,
      point: false,
    });
    list.push(...crossingShapes(vertices, origin));
  }
  return list;
});

/**
 * The box being drawn, filled as it will be computed (analysis.drawBox,
 * boxFootprint.ts): a latitude/longitude box, or the rectangle's footprint
 * as traced on the map (new every frame: not cached).
 */
/** The box being drawn: paths for its outline, and its inside to light. */
function drawingPaths(
  box: TGeometry,
  origin: DOMRect
): Pick<TShape, "paths" | "ring" | "closed"> {
  // Elsewhere the rectangle clipped to the visible map, as it is.
  const clipped = analysis.drawBoxOutline;
  if (clipped && box.kind === GEOMETRY_KINDS.SHAPE) {
    const d = `${clipped
      .map(
        (p, k) =>
          `${k ? "L" : "M"}${(p.x - origin.left).toFixed(1)},${(p.y - origin.top).toFixed(1)}`
      )
      .join("")}Z`;
    return { paths: [d], ring: [d], closed: true };
  }
  // On a latitude/longitude map the screen rectangle is the box.
  const rect = analysis.drawBoxScreen;
  if (rect && box.kind === GEOMETRY_KINDS.BOX) {
    const at = { x: origin.left, y: origin.top };
    return { ...screenBoxPaths(rect, drawnBoxEdges(box), at), closed: true };
  }
  if (box.kind === GEOMETRY_KINDS.BOX) {
    // The bounds a Hovmöller or section will use, elsewhere: their outline only
    // while dragging.
    const edges = outline(box);
    const shown = drawnBoxEdges(box).map((k) => edges[k]);
    return { paths: projectPaths(shown, origin), closed: false };
  }
  const inside = insidePaths(box, origin);
  return {
    paths: projectPaths(outline(box), origin),
    ...(inside ? { ring: inside } : {}),
    closed: true,
  };
}

function drawingBox(box: TGeometry, origin: DOMRect): TShape {
  return {
    id: "drawing-box",
    label: "",
    focused: true,
    pending: true,
    ...drawingPaths(box, origin),
    point: false,
  };
}

/** A polygon being drawn whose edges cross (closing edge included): lit. */
function crossingShapes(vertices: TLatLon[], origin: DOMRect): TShape[] {
  const crossed = [...new Set(analysis.drawCrossings.flat())];
  if (analysis.drawMode !== DRAW_MODES.POLYGON || !crossed.length) {
    return [];
  }
  const n = vertices.length;
  const edges = crossed.map((at) =>
    densify(vertices[at], vertices[(at + 1) % n], false)
  );
  return [
    {
      id: "drawing-crossings",
      label: "",
      focused: true,
      pending: false,
      crossing: true,
      paths: toPaths(edges, origin),
      closed: false,
      point: false,
    },
  ];
}

/** The area being chosen or pointed at: the map around it is dimmed. */
const spotlight = computed(() =>
  spotlightPath(shapes.value, analysis.highlightId)
);
/** A lit area with a hole (a drawn box's world less its outline). */
const spotlightHoles = computed(() =>
  shapes.value.some(
    (shape) =>
      shape.holes &&
      (shape.id === analysis.highlightId || shape.id === "drawing-box")
  )
);

/** A time series' value at the map's current time, with units. */
function valueAtMapTime(w: TPlotWindow) {
  const r = w.result;
  // A snapshot belongs to another dataset: the map's time index is not its.
  if (
    w.snapshot ||
    !r?.time ||
    (w.kind !== ANALYSIS_KINDS.POINT_SERIES &&
      w.kind !== ANALYSIS_KINDS.REGION_SERIES)
  ) {
    return undefined;
  }
  // The plot's row whose date is the map's, as the chart's cursor finds it.
  const index = mapSettingsFromStore(globe).indices[r.time.dimension];
  const map = mapCoordinateOf(globe, r.time.dimension);
  const at =
    index === undefined
      ? -1
      : map
        ? (correspondingIndex(
            map,
            index,
            {
              values: r.time.raw,
              units: r.time.units,
              calendar: r.time.calendar,
              rows: r.query.time,
            },
            "time"
          ) ?? -1)
        : rowOf(r.query.time, index);
  if (at < 0 || at >= r.values.length) {
    return undefined;
  }
  if (
    at >= (r.partial ? rowsUntil(r.query.time, r.partial.readUntil) : Infinity)
  ) {
    return "not read yet";
  }
  // The chart hides a mean below the coverage threshold; so does the map.
  const threshold = r.query.minCoverage;
  if (
    threshold !== undefined &&
    r.region &&
    r.region.coverage[at] < threshold
  ) {
    return "below coverage threshold";
  }
  const value = r.values[at];
  return Number.isFinite(value)
    ? `${formatValue(value)}${r.units ? ` ${r.units}` : ""}`
    : "no value";
}

/** The chart's pointer as a place on its path. */
const hoverPoint = computed(() => {
  void mapFrame.value;
  const hover = analysis.pathHover;
  const origin = svg.value?.getBoundingClientRect();
  const w = hover && analysis.windows.find((entry) => entry.id === hover.id);
  const geometry = w && (w.result?.query.geometry ?? w.committed?.geometry);
  if (!hover || !origin || geometry?.kind !== GEOMETRY_KINDS.POLYLINE) {
    return undefined;
  }
  const p = screenOf(pointAlongPath(geometry.vertices, hover.meters), origin);
  return (
    p && {
      ...p,
      label: `${formatValue(Math.round(hover.meters / 100) / 10)} km`,
    }
  );
});

const drawingPoints = computed(() => {
  void mapFrame.value;
  const origin = svg.value?.getBoundingClientRect();
  const scene = getMapScene();
  if (!origin || !scene || analysis.drawMode === DRAW_MODES.NONE) {
    return [];
  }
  return analysis.drawVertices
    .map((v) => scene.project(v.lat, v.lon))
    .filter((p): p is NonNullable<typeof p> => Boolean(p?.visible))
    .map((p) => ({ x: p.x - origin.left, y: p.y - origin.top }));
});

/** A polygon of three points or more: clicking point 1 closes it. */
const closable = computed(
  () =>
    analysis.drawMode === DRAW_MODES.POLYGON &&
    analysis.drawVertices.length >= 3
);

/** The right-clicked starting point, while the plot chooser is open. */
const startPoint = computed(() => {
  void mapFrame.value;
  const origin = svg.value?.getBoundingClientRect();
  if (!origin || analysis.drawMode !== DRAW_MODES.NONE) {
    return undefined;
  }
  return screenOf(analysis.pendingStart, origin);
});

/** A plot's own shape that handles can edit, when nothing else is drawn. */
function canEdit(id: string) {
  if (analysis.drawMode !== DRAW_MODES.NONE || analysis.shapeEdit) {
    return false;
  }
  const w = analysis.windows.find((entry) => entry.id === id);
  return Boolean(w && !w.snapshot && editableForm(w.draft.geometry));
}

/**
 * The pencil shows only for the place clicked (or, with a mouse, the one
 * under the pointer): always shown, pencils crowded the map (23 Nov). A
 * click anywhere else, or Escape, puts it away.
 */
const chosenShape = ref<string>();
const pointedShape = ref<string>();
const showsPencil = (id: string) =>
  canEdit(id) && (chosenShape.value === id || pointedShape.value === id);
/**
 * Leaving a shape keeps its pencil a moment: the pencil sits by the marker, and
 * the way there from a point along the outline crosses empty map. Entering
 * another shape moves it at once.
 */
const PENCIL_GRACE_MS = 1500;
let pencilTimer: ReturnType<typeof setTimeout> | undefined;
function pointShape(event: PointerEvent, id: string | undefined) {
  if (event.pointerType !== "mouse") {
    return;
  }
  clearTimeout(pencilTimer);
  if (id) {
    pointedShape.value = id;
    return;
  }
  pencilTimer = setTimeout(
    () => (pointedShape.value = undefined),
    PENCIL_GRACE_MS
  );
}
onBeforeUnmount(() => clearTimeout(pencilTimer));
function forgetChoice(event: Event) {
  const target = event.target as Element | null;
  if (
    !target?.closest?.(
      ".analysis-marker, .analysis-outline, .analysis-edit-chip"
    )
  ) {
    chosenShape.value = undefined;
  }
}
const escapeChoice = (event: KeyboardEvent) =>
  event.key === "Escape" && (chosenShape.value = undefined);
window.addEventListener("pointerdown", forgetChoice, true);
window.addEventListener("keydown", escapeChoice);
onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", forgetChoice, true);
  window.removeEventListener("keydown", escapeChoice);
});
watch(
  () => analysis.shapeEdit,
  (edit) => edit && (chosenShape.value = undefined)
);

function focusWindow(id: string) {
  if (id === "drawing") {
    return;
  }
  // On a touch screen the window covers the map: the first tap chooses
  // the place (its pencil shows), a second opens its plot.
  const firstTap =
    chosenShape.value !== id &&
    window.matchMedia?.("(pointer: coarse)").matches &&
    canEdit(id);
  chosenShape.value = id;
  if (firstTap) {
    return;
  }
  const windowId = id.replace(/-pending$/, "");
  analysis.setMinimized(windowId, false);
  analysis.focus(windowId);
}

/**
 * Outlines and markers take clicks (they focus their window), so a wheel
 * over one would stop there: it zooms the map, as it does beside them.
 */
function passWheel(event: WheelEvent) {
  const canvas = getMapScene()?.canvas();
  if (!canvas) {
    return;
  }
  event.preventDefault();
  canvas.dispatchEvent(new WheelEvent("wheel", event));
}
</script>

<template>
  <svg
    ref="svg"
    class="analysis-overlay"
    :class="{ drawing: analysis.drawMode !== DRAW_MODES.NONE }"
    aria-hidden="true"
    @wheel="passWheel"
  >
    <defs v-if="spotlight">
      <mask id="analysis-spotlight-mask">
        <rect width="100%" height="100%" fill="#ffffff" />
        <!-- A hairline stroke: lit cells meet without a dimmed seam;
             none round a hole (it would light lines through it). -->
        <path
          :d="spotlight"
          fill="#000000"
          fill-rule="evenodd"
          stroke="#000000"
          :stroke-width="spotlightHoles ? 0 : 0.6"
        />
      </mask>
    </defs>
    <rect
      v-if="spotlight"
      class="analysis-spotlight"
      width="100%"
      height="100%"
      mask="url(#analysis-spotlight-mask)"
    />
    <g v-if="borderPaths.length" class="analysis-borders">
      <path v-for="(d, at) in borderPaths" :key="at" :d="d" />
    </g>
    <g
      v-for="shape in shapes"
      :key="shape.id"
      :class="{
        focused: shape.focused,
        pending: shape.pending,
        replaced: shape.replaced,
        hovered: shape.hover,
        highlighted: shape.id === analysis.highlightId,
      }"
      @pointerenter="pointShape($event, shape.id)"
      @pointerleave="pointShape($event, undefined)"
    >
      <!-- A dark casing under every outline: the line shows on light and
           dark colour maps alike, and its dashes never vanish. -->
      <path
        v-for="(d, at) in shape.paths"
        :key="`casing-${at}`"
        :d="d"
        class="analysis-casing"
      />
      <path
        v-for="(d, at) in shape.paths"
        :key="at"
        :d="d"
        class="analysis-outline"
        :class="{ closed: shape.closed, crossing: shape.crossing }"
        @click="focusWindow(shape.id)"
      />
      <g
        v-if="shape.marker && shape.label"
        class="analysis-marker"
        @click="focusWindow(shape.id)"
      >
        <circle
          :cx="shape.marker.x"
          :cy="shape.marker.y"
          :r="shape.point ? 5 : 4"
        />
        <text
          :x="shape.marker.x + (shape.numbers ? 12 : 8)"
          :y="shape.marker.y - (shape.numbers ? 10 : 6)"
        >
          {{ shape.label }}{{ shape.value ? `: ${shape.value}` : "" }}
        </text>
      </g>
      <g
        v-for="n in shape.numbers ?? []"
        :key="`${shape.id}-${n.label}`"
        class="analysis-number"
      >
        <circle :cx="n.x" :cy="n.y" r="7" />
        <text :x="n.x" :y="n.y + 0.5">{{ n.label }}</text>
      </g>
    </g>
    <template v-for="shape in shapes" :key="`edit-${shape.id}`">
      <!-- Edit the shape right here: a small pencil beside the marker of
             the place clicked, or under a mouse pointer; above every line
             (25 Nov: another plot's outline covered it). -->
      <g
        v-if="shape.marker && showsPencil(shape.id)"
        class="analysis-edit-chip"
        role="button"
        :aria-label="`Edit ${shape.label}'s shape on the map`"
        :data-edit-on-map="shape.id"
        @pointerenter="pointShape($event, shape.id)"
        @pointerleave="pointShape($event, undefined)"
        @click.stop="analysis.startShapeEdit(shape.id)"
      >
        <title>Edit {{ shape.label }}'s shape on the map</title>
        <!-- A larger target than the drawn chip (easy to hit). -->
        <circle
          class="analysis-edit-target"
          :cx="shape.marker.x - 16"
          :cy="shape.marker.y - 12"
          r="16"
        />
        <circle :cx="shape.marker.x - 16" :cy="shape.marker.y - 12" r="10" />
        <path
          :transform="`translate(${shape.marker.x - 21} ${shape.marker.y - 17})`"
          d="M1 8.5 L1 10 L2.5 10 L8.6 3.9 L7.1 2.4 Z M7.8 1.7 L9.3 3.2 L10 2.5 Q10.3 2.1 10 1.7 L9.3 1 Q8.9 0.7 8.5 1 Z"
        />
      </g>
    </template>
    <g v-if="hoverPoint" class="analysis-hover">
      <circle :cx="hoverPoint.x" :cy="hoverPoint.y" r="8" class="ring" />
      <circle :cx="hoverPoint.x" :cy="hoverPoint.y" r="3" class="dot" />
      <text :x="hoverPoint.x + 11" :y="hoverPoint.y + 16">
        {{ hoverPoint.label }}
      </text>
    </g>
    <g v-if="startPoint" class="analysis-start">
      <circle :cx="startPoint.x" :cy="startPoint.y" r="9" class="ring" />
      <circle :cx="startPoint.x" :cy="startPoint.y" r="3.5" class="dot" />
    </g>
    <g v-for="(p, at) in drawingPoints" :key="`v${at}`">
      <!-- A polygon closes with a click on its first point: a target. -->
      <circle
        v-if="at === 0 && closable"
        :cx="p.x"
        :cy="p.y"
        r="12"
        class="analysis-vertex-close"
      />
      <circle :cx="p.x" :cy="p.y" r="4" class="analysis-vertex" />
      <text :x="p.x + 7" :y="p.y - 7" class="analysis-vertex-label">
        {{ at + 1 }}
      </text>
    </g>
  </svg>
  <button
    v-if="outlineErrors.size"
    type="button"
    class="button is-small country-outline-retry"
    @click="retryOutlines++"
  >
    Retry country outline
  </button>
</template>

<style scoped>
.country-outline-retry {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 6;
  pointer-events: auto;
}
/*
 * Outlines belong to the map: clipped to its area, and below the controls
 * panel (z-index 10), so a path projected past the map's left edge never
 * draws across the dashboard.
 */
.analysis-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none !important;
  overflow: hidden;
  z-index: 5;
}
/* Outside the area being chosen, the map is dimmed. */
.analysis-spotlight {
  fill: rgba(8, 12, 24, 0.28);
  pointer-events: none;
}
/* Under each outline: wider and dark, solid even under a dashed line. */
.analysis-casing {
  fill: none;
  stroke: rgba(8, 12, 24, 0.85);
  stroke-width: 5;
  stroke-linejoin: round;
  stroke-linecap: round;
  pointer-events: none;
}
.focused .analysis-casing,
.pending .analysis-casing {
  stroke-width: 6;
}
.highlighted .analysis-casing {
  stroke-width: 7;
}
.hovered .analysis-casing {
  stroke-width: 5;
}
/* The country under the pointer while choosing: its border lit, not a
   selection (no fill, no clicks). */
.hovered .analysis-outline,
.hovered .analysis-outline.closed {
  stroke: #ffffff;
  stroke-width: 2.5;
  pointer-events: none;
}
/* Country borders while a country is chosen: dotted, under every outline. */
/* One shadow for the whole group: a filter per path repaints far more. */
.analysis-borders {
  filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.7));
}
.analysis-borders path {
  fill: none;
  stroke: rgba(255, 255, 255, 0.85);
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-dasharray: 0.1 3.5;
}
.analysis-outline {
  fill: none;
  stroke: #fbbf24;
  stroke-width: 2;
  pointer-events: visibleStroke;
  cursor: pointer;
}
.analysis-outline.closed {
  stroke: rgba(251, 191, 36, 0.75);
  stroke-width: 1.5;
}
/* The plot ID hovered or focused in its window: its outline pulses. */
.highlighted .analysis-outline {
  stroke: #38bdf8;
  stroke-width: 4;
  animation: analysis-pulse 0.8s ease-in-out 2;
}
.highlighted .analysis-marker circle {
  stroke-width: 3;
}
@keyframes analysis-pulse {
  50% {
    stroke-width: 7;
    stroke-opacity: 0.6;
  }
}
@media (prefers-reduced-motion: reduce) {
  .highlighted .analysis-outline {
    animation: none;
  }
}
.focused .analysis-outline {
  stroke: #38bdf8;
  stroke-width: 3;
}
.analysis-marker {
  pointer-events: all;
  cursor: pointer;
}
.analysis-edit-chip {
  pointer-events: all;
  cursor: pointer;
}
.analysis-edit-chip circle {
  fill: var(--plot-bg, #0f172a);
  stroke: var(--plot-accent, #60a5fa);
  stroke-width: 1.5;
}
.analysis-edit-chip circle.analysis-edit-target {
  fill: transparent;
  stroke: none;
}
.analysis-edit-chip:hover circle:not(.analysis-edit-target) {
  fill: var(--plot-accent, #60a5fa);
}
.analysis-edit-chip:hover path {
  fill: var(--plot-bg, #0f172a);
}
.analysis-edit-chip path {
  fill: var(--plot-accent, #60a5fa);
}
/* While drawing, every click goes to the map, even on another outline. */
.analysis-overlay.drawing .analysis-outline,
.analysis-overlay.drawing .analysis-marker {
  pointer-events: none;
}
.analysis-marker circle {
  fill: #fbbf24;
  stroke: #111827;
  stroke-width: 1.5;
}
.focused .analysis-marker circle {
  fill: #38bdf8;
}
.analysis-marker text {
  fill: #f8fafc;
  font-size: 12px;
  font-weight: 600;
  paint-order: stroke;
  stroke: #111827;
  stroke-width: 3px;
}
.analysis-vertex {
  fill: #38bdf8;
  stroke: #111827;
}
/* The shape as applied, while another takes its place: still there to
   compare with, plainly not the one being changed. */
.replaced {
  opacity: 0.4;
  transition: opacity 0.15s;
}
@media (prefers-reduced-motion: reduce) {
  .replaced {
    transition: none;
  }
}
.pending .analysis-outline {
  stroke: #fb923c;
  stroke-dasharray: 6 4;
  stroke-width: 2;
}
.pending .analysis-marker circle {
  fill: none;
  stroke: #fb923c;
  stroke-dasharray: 2 2;
  stroke-width: 2;
}
.analysis-number circle {
  fill: #111827;
  stroke: #fbbf24;
  stroke-width: 1.5;
}
.focused .analysis-number circle {
  stroke: #38bdf8;
}
.analysis-number text {
  fill: #f8fafc;
  font-size: 10px;
  font-weight: 700;
  text-anchor: middle;
  dominant-baseline: middle;
}
.analysis-hover .ring {
  fill: none;
  stroke: #f8fafc;
  stroke-width: 2.5;
}
.analysis-hover .dot {
  fill: #f43f5e;
  stroke: #111827;
  stroke-width: 1;
}
.analysis-start .ring {
  fill: rgba(17, 24, 39, 0.25);
  stroke: #f8fafc;
  stroke-width: 2;
  stroke-dasharray: 3 2;
}
.analysis-start .dot {
  fill: #f8fafc;
  stroke: #111827;
  stroke-width: 1.2;
}
.analysis-hover text {
  fill: #f8fafc;
  font-size: 11px;
  font-weight: 600;
  paint-order: stroke;
  stroke: #111827;
  stroke-width: 3px;
}
.analysis-vertex-label {
  fill: #f8fafc;
  font-size: 12px;
  font-weight: 600;
  paint-order: stroke;
  stroke: #111827;
  stroke-width: 3px;
}
.analysis-outline.crossing {
  stroke: #ef4444;
  stroke-width: 3;
  stroke-dasharray: none;
}
.analysis-vertex-close {
  fill: color-mix(in srgb, var(--plot-accent, #2563eb) 18%, transparent);
  stroke: var(--plot-accent, #2563eb);
  stroke-width: 1.5;
  stroke-dasharray: 3 2;
}
</style>
