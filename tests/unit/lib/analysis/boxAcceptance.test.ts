/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
/**
 * The user's acceptance check for drawn boxes (22 Nov): a 270° box, a 2°
 * date-line box and a full southern cap drawn on a flat map, and boxes
 * drawn on a globe round the South Pole and beside it; saved and reopened,
 * and read on a 1° grid: the cells selected are the cells inside the
 * footprint shown.
 */
import { geoEquirectangular } from "d3-geo";
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import {
  countryContains,
  prepareCountry,
} from "@/lib/analysis/countryRegion.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { decodeSession, encodeSession } from "@/lib/analysis/sessionLink.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { boxLonSpan } from "@/lib/analysis/sphere.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  GEOMETRY_KINDS,
  type TAnalysisQuery,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";
import { rectangleSelection } from "@/ui/analysis/boxFootprint.ts";

type TStore = Map<string, Uint8Array>;
const DEG = Math.PI / 180;
const wrapped = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** An equirectangular map, 2 px a degree, centred on `centre`° E. */
function flat(centre: number) {
  return {
    pick: (x: number, y: number) =>
      x >= 0 && x <= 720 && y >= 0 && y <= 360
        ? { lat: 90 - y / 2, lon: wrapped(x / 2 - 180 + centre) }
        : null,
    project: (lat: number, lon: number) => ({
      x: ((((lon - centre + 180) % 360) + 360) % 360) * 2,
      y: (90 - lat) * 2,
      visible: true,
    }),
  };
}

/** An orthographic globe (radius 300 px at 500, 500) over the South Pole. */
const southGlobe = {
  pick: (x: number, y: number) => {
    const [u, v] = [(x - 500) / 300, (y - 500) / 300];
    const r = Math.hypot(u, v);
    return r > 1
      ? null
      : { lat: Math.asin(r) / DEG - 90, lon: Math.atan2(u, -v) / DEG };
  },
  project: (lat: number, lon: number) => {
    const c = (90 + lat) * DEG;
    return {
      x: 500 + 300 * Math.sin(c) * Math.sin(lon * DEG),
      y: 500 - 300 * Math.sin(c) * Math.cos(lon * DEG),
      visible: c < Math.PI / 2,
    };
  },
};

/** The box a drag from screen `from` to `to` draws on `map`. */
function drawn(
  map: typeof southGlobe,
  from: [number, number],
  to: [number, number]
) {
  return rectangleSelection(
    map.pick,
    map.project,
    { x: from[0], y: from[1] },
    { x: to[0], y: to[1] },
    false,
    true // as committed on release
  )!.geometry;
}

const BOXES: { name: string; box: TGeometry; cells?: number }[] = [
  // 270° from 135°W eastward, 10°N–40°N: 270 × 30 one-degree cells.
  {
    name: "270° box",
    box: drawn(flat(0), [90, 100], [630, 160]),
    cells: 270 * 30,
  },
  // 2° over the date line (a map centred on it), 5°S–5°N: 2 × 10.
  {
    name: "2° date-line box",
    box: drawn(flat(180), [358, 170], [362, 190]),
    cells: 2 * 10,
  },
  // Edge to edge from 60°S down past the map's bottom: 360 × 30.
  {
    name: "southern cap",
    box: drawn(flat(0), [0, 300], [800, 420]),
    cells: 360 * 30,
  },
  // On the globe: a rectangle holding the South Pole, and one beside it.
  {
    name: "globe, round the pole",
    box: drawn(southGlobe, [380, 420], [610, 590]),
  },
  {
    name: "globe, beside the pole",
    box: drawn(southGlobe, [560, 380], [700, 470]),
  },
];

async function write(
  store: TStore,
  path: string,
  data: ArrayLike<number>,
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {}
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride: shape.map((_, d) => shape.slice(d + 1).reduce((p, n) => p * n, 1)),
  } as never);
}

/** A 1° global grid, one date, every value 1 (or `valueAt(lat)`). */
async function oneDegree(valueAt: (lat: number) => number = () => 1) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  const lats = Array.from({ length: 180 }, (_, j) => -89.5 + j);
  const lons = Array.from({ length: 360 }, (_, i) => -179.5 + i);
  await write(store, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(store, "lat", lats, [180], ["lat"], {
    units: "degrees_north",
    standard_name: "latitude",
  });
  await write(store, "lon", lons, [360], ["lon"], {
    units: "degrees_east",
    standard_name: "longitude",
  });
  await write(
    store,
    "tas",
    Array.from({ length: 180 * 360 }, (_, k) =>
      valueAt(-89.5 + Math.floor(k / 360))
    ),
    [1, 180, 360],
    ["time", "lat", "lon"]
  );
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(store as never, "", ZARR_FORMAT.V3, "deg1"),
    "tas",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

/** Cells whose centres the footprint holds, counted from the footprint. */
function footprintCells(box: TGeometry) {
  const holds =
    box.kind === GEOMETRY_KINDS.SHAPE
      ? (() => {
          const region = prepareCountry(box.polygons);
          return (lat: number, lon: number) =>
            countryContains(region, lat, lon);
        })()
      : box.kind === GEOMETRY_KINDS.BOX
        ? (lat: number, lon: number) =>
            lat >= box.south &&
            lat <= box.north &&
            (boxLonSpan(box) >= 360 ||
              (((lon - box.west) % 360) + 360) % 360 <= boxLonSpan(box))
        : () => false;
  let count = 0;
  for (let j = 0; j < 180; j++) {
    for (let i = 0; i < 360; i++) {
      count += holds(-89.5 + j, -179.5 + i) ? 1 : 0;
    }
  }
  return count;
}

const query = (geometry: TGeometry): TAnalysisQuery => ({
  version: ALGORITHM_VERSION,
  kind: ANALYSIS_KINDS.REGION_SERIES,
  source: { ref: "memory", versionStatus: "session" },
  variable: "tas",
  geometry,
  fixed: {},
});

describe("drawn boxes: footprint, link and cells agree (user's acceptance check)", () => {
  it.each(BOXES)("$name", async ({ box, cells }) => {
    // Saved in a link and reopened: the same numbers (360° stays 360°).
    const reopened = decodeSession(
      encodeSession({ plots: [{ query: query(box) }] })
    ).plots[0].query.geometry;
    expect(reopened).toEqual(box);
    // The footprint as shown holds as many cells as were asked for...
    const shown = footprintCells(reopened);
    if (cells !== undefined) {
      expect(shown).toBe(cells);
    }
    expect(shown).toBeGreaterThan(0);
    // ...and the calculation selects exactly those.
    const ctx = await oneDegree();
    const planned = await planAnalysis(ctx, query(reopened), new ReadContext());
    const result = await planned.execute();
    expect(result.region?.storedCells).toBe(shown);
    expect(result.values[0]).toBe(1);
  });

  it("holds the polar cells only while the rectangle holds the pole", () => {
    const [round, beside] = [BOXES[3].box, BOXES[4].box];
    expect(round.kind).toBe(GEOMETRY_KINDS.SHAPE);
    const at = (g: TGeometry, lon: number) =>
      g.kind === GEOMETRY_KINDS.SHAPE &&
      countryContains(prepareCountry(g.polygons), -89.5, lon);
    for (const lon of [-179.5, -90.5, 0.5, 90.5, 179.5]) {
      expect(at(round, lon)).toBe(true);
      expect(at(beside, lon)).toBe(false);
    }
  });
});

/**
 * 720 × 360 px equirectangular, centred `lon`° E `lat`° N: tilted a little, its
 * pole is near but not at the true pole.
 */
function tiltedMap(lon: number, lat: number) {
  const tiltedView = geoEquirectangular()
    .rotate([-lon, -lat])
    .scale(360 / Math.PI)
    .translate([360, 180]);
  return {
    pick: (x: number, y: number) => {
      if (x < 0 || x > 720 || y < 0 || y > 360) {
        return null;
      }
      const ll = tiltedView.invert!([x, y]);
      const back = ll && tiltedView(ll);
      return ll && back && Math.hypot(back[0] - x, back[1] - y) < 1e-6
        ? { lat: ll[1], lon: ll[0] }
        : null;
    },
    project: (lat: number, lon: number) => {
      const [x, y] = tiltedView([lon, lat])!;
      return { x, y, visible: true };
    },
  };
}

/**
 * The independent reference: cell centres the drawing view shows inside
 * the rectangle, and their area-weighted mean of `valueAt`.
 */
function shownCells(
  tilted: ReturnType<typeof tiltedMap>,
  a: [number, number],
  b: [number, number],
  valueAt: (lat: number) => number
) {
  let [cells, sum, weight] = [0, 0, 0];
  for (let j = 0; j < 180; j++) {
    const lat = -89.5 + j;
    for (let i = 0; i < 360; i++) {
      const p = tilted.project(lat, -179.5 + i);
      const inside = p.x >= a[0] && p.x <= b[0] && p.y >= a[1] && p.y <= b[1];
      if (inside && tilted.pick(p.x, p.y)) {
        cells++;
        weight += Math.cos(lat * DEG);
        sum += Math.cos(lat * DEG) * valueAt(lat);
      }
    }
  }
  return { cells, mean: sum / weight };
}

describe("a drawn box near a tilted map's pole: cells and mean", () => {
  it.each([
    { lon: -6.36, lat: -0.5, a: [0.1, 300], b: [719.9, 359.7], cells: 10_765 },
    { lon: -6.36, lat: 0.05, a: [30, 270], b: [680, 359.6], cells: 14_616 },
  ])("centred $lon°E $lat°N: $cells cells", async ({ lon, lat, ...drag }) => {
    const map = tiltedMap(lon, lat);
    const [a, b] = [drag.a, drag.b] as [number, number][];
    const box = decodeSession(
      encodeSession({ plots: [{ query: query(drawn(map, a, b)) }] })
    ).plots[0].query.geometry;
    // Only the southernmost row is 1: its cells are what is at stake.
    const valueAt = (y: number) => (y === -89.5 ? 1 : 0);
    const reference = shownCells(map, a, b, valueAt);
    expect(reference.cells).toBe(drag.cells);
    expect(footprintCells(box)).toBe(reference.cells);
    const ctx = await oneDegree(valueAt);
    const planned = await planAnalysis(ctx, query(box), new ReadContext());
    const result = await planned.execute();
    expect(result.region?.storedCells).toBe(reference.cells);
    expect(result.values[0]).toBeCloseTo(reference.mean, 9);
  });
});

/**
 * A near-side perspective view: 720 × 360 px, centred 170°E 65°S, the camera
 * 3.64 Earth radii from the centre, the disc 170 px in radius. Picks the near
 * side; projects with visibility.
 */
const dot3 = (a: number[], b: number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vec3 = (lat: number, lon: number) => [
  Math.cos(lat * DEG) * Math.cos(lon * DEG),
  Math.cos(lat * DEG) * Math.sin(lon * DEG),
  Math.sin(lat * DEG),
];

function nearSide(
  lat0: number,
  lon0: number,
  distance: number,
  radius: number
) {
  const c = vec3(lat0, lon0);
  const e = [-Math.sin(lon0 * DEG), Math.cos(lon0 * DEG), 0];
  const n = vec3(lat0 + 90, lon0);
  const f = radius * Math.sqrt(distance * distance - 1);
  return {
    project: (lat: number, lon: number) => {
      const p = vec3(lat, lon);
      const z = distance - dot3(p, c);
      return {
        x: 360 + (f * dot3(p, e)) / z,
        y: 180 - (f * dot3(p, n)) / z,
        visible: dot3(p, c) > 1 / distance,
      };
    },
    pick: (x: number, y: number) => {
      const [u, v] = [(x - 360) / f, -(y - 180) / f];
      const d = [0, 1, 2].map((k) => -c[k] + u * e[k] + v * n[k]);
      const o = c.map((k) => k * distance);
      // |o + t d| = 1, the nearer root.
      const [a, b, q] = [dot3(d, d), 2 * dot3(o, d), dot3(o, o) - 1];
      const disc = b * b - 4 * a * q;
      if (disc < 0) {
        return null;
      }
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      const p = o.map((k, i) => k + t * d[i]);
      return {
        lat: Math.asin(Math.max(-1, Math.min(1, p[2]))) / DEG,
        lon: Math.atan2(p[1], p[0]) / DEG,
      };
    },
  };
}

/**
 * The independent reference for a view: cell centres it shows inside the
 * rectangle, their area-weighted sum, and those within 0.01 px of a side
 * (no drawing settles those).
 */
function projectedReference(
  view: ReturnType<typeof nearSide>,
  [a, b]: [number, number][],
  valueAt: (lat: number) => number
) {
  const reference = new Set<string>();
  let [sum, weight] = [0, 0];
  // Centres within 0.01 px of a side: no drawing settles those.
  const onEdge = new Set<string>();
  for (let j = 0; j < 180; j++) {
    const lat = -89.5 + j;
    for (let i = 0; i < 360; i++) {
      const p = view.project(lat, -179.5 + i);
      const inside =
        p.visible && p.x >= a[0] && p.x <= b[0] && p.y >= a[1] && p.y <= b[1];
      const near = Math.min(
        ...[p.x - a[0], b[0] - p.x, p.y - a[1], b[1] - p.y].map(Math.abs)
      );
      if (near < 0.01) {
        onEdge.add(`${j},${i}`);
      }
      if (inside) {
        reference.add(`${j},${i}`);
        weight += Math.cos(lat * DEG);
        sum += Math.cos(lat * DEG) * valueAt(lat);
      }
    }
  }
  return { reference, onEdge, sum, weight };
}

describe("a box clipped by the globe's horizon (review of interim7)", () => {
  it.each([
    // Its far corner beyond the horizon (a box starts on the map, so one way
    // round).
    { a: [243.3, 195.2], b: [890, 600], both: false, cells: 15_087 },
    // Both corners on the Earth: either way round.
    { a: [250, 120], b: [430, 300], both: true, cells: undefined },
  ])("cells the view shows in the rectangle, $a to $b", async (fixture) => {
    const view = nearSide(-65, 170, 3.64, 170);
    const [a, b] = [fixture.a, fixture.b] as [number, number][];
    const valueAt = (lat: number) => 280 + 20 * Math.sin(lat * DEG);
    const { reference, onEdge, sum, weight } = projectedReference(
      view,
      [a, b],
      valueAt
    );
    if (fixture.cells) {
      expect(reference.size).toBe(fixture.cells);
    }
    for (const [from, to] of fixture.both
      ? [
          [a, b],
          [b, a],
        ]
      : [[a, b]]) {
      const box = decodeSession(
        encodeSession({ plots: [{ query: query(drawn(view, from, to)) }] })
      ).plots[0].query.geometry;
      if (box.kind !== GEOMETRY_KINDS.SHAPE) {
        throw new Error("expected a drawn shape");
      }
      const region = prepareCountry(box.polygons);
      const differ: string[] = [];
      for (let j = 0; j < 180; j++) {
        for (let i = 0; i < 360; i++) {
          const key = `${j},${i}`;
          const held = countryContains(region, -89.5 + j, -179.5 + i);
          if (held !== reference.has(key) && !onEdge.has(key)) {
            differ.push(key);
          }
        }
      }
      expect(differ).toEqual([]);
      const ctx = await oneDegree(valueAt);
      const planned = await planAnalysis(ctx, query(box), new ReadContext());
      const result = await planned.execute();
      expect(result.region?.storedCells).toBe(footprintCells(box));
      expect(Math.abs(result.values[0]! - sum / weight)).toBeLessThan(1e-3);
    }
  });
});

describe("a box at the globe's limb (review of interim30)", () => {
  // 38 Earth radii out over 0°N 0°E, 7.5° vertical field of view on a
  // 720 × 360 map: the 89.5°S row is behind the globe at every longitude.
  const focal = 180 / Math.tan(3.75 * DEG);
  const view = nearSide(0, 0, 38, focal / Math.sqrt(38 * 38 - 1));
  const hidden = (lat: number) => (lat === -89.5 ? 1_000_000 : 0);
  it.each([
    { a: [349.879, 113.488], b: [370.844, 295.672] },
    { a: [291.319, 180], b: [439.525, 259.525] },
  ])("takes no cell from behind the globe, $a to $b", async (fixture) => {
    const [a, b] = [fixture.a, fixture.b] as [number, number][];
    const { reference, onEdge } = projectedReference(view, [a, b], hidden);
    const box = decodeSession(
      encodeSession({ plots: [{ query: query(drawn(view, a, b)) }] })
    ).plots[0].query.geometry;
    if (box.kind !== GEOMETRY_KINDS.SHAPE) {
      throw new Error("expected a drawn shape");
    }
    const region = prepareCountry(box.polygons);
    const extra: string[] = [];
    for (let i = 0; i < 360; i++) {
      // The hidden row: none of it may be held.
      if (countryContains(region, -89.5, -179.5 + i)) {
        extra.push(`0,${i}`);
      }
    }
    expect(extra).toEqual([]);
    let differ = 0;
    for (let j = 0; j < 180; j++) {
      for (let i = 0; i < 360; i++) {
        const key = `${j},${i}`;
        const held = countryContains(region, -89.5 + j, -179.5 + i);
        differ += held !== reference.has(key) && !onEdge.has(key) ? 1 : 0;
      }
    }
    expect(differ).toBe(0);
    const result = await (
      await planAnalysis(await oneDegree(hidden), query(box), new ReadContext())
    ).execute();
    expect(result.values[0]).toBe(0);
  });
});
