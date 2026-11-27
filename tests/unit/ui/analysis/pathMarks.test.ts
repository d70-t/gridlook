import { describe, expect, it } from "vitest";

import { DRAWING_SPHERE_RADIUS_METERS } from "@/lib/analysis/sphere.ts";
import {
  axisMarks,
  distanceNear,
  pointAlongPath,
  routeDistanceNear,
  screenRoute,
  vertexDistances,
} from "@/ui/analysis/pathMarks.ts";

const DEGREE = (Math.PI / 180) * DRAWING_SPHERE_RADIUS_METERS;
const path = [
  { lat: 0, lon: 0 },
  { lat: 0, lon: 2 },
  { lat: 1, lon: 2 },
];

describe("path points on the chart axis and the map", () => {
  it("numbers each point at its distance along the path", () => {
    const d = vertexDistances(path);
    expect(d[1]).toBeCloseTo(2 * DEGREE, 3);
    expect(d[2]).toBeCloseTo(3 * DEGREE, 3);
    expect(axisMarks(path, 1 / 1000).map((m) => m.label)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(axisMarks(path, 1 / 1000)[1].value).toBeCloseTo(
      (2 * DEGREE) / 1000,
      6
    );
    expect(axisMarks([path[0]])).toEqual([]);
  });

  it("places the chart's pointer on the drawn path", () => {
    const mid = pointAlongPath(path, DEGREE)!;
    expect(mid.lat).toBeCloseTo(0, 9);
    expect(mid.lon).toBeCloseTo(1, 9);
    // Past the bend: on the second leg, going north.
    const after = pointAlongPath(path, 2.5 * DEGREE)!;
    expect(after.lon).toBeCloseTo(2, 9);
    expect(after.lat).toBeCloseTo(0.5, 6);
    // Outside the path: clamped to its ends.
    expect(pointAlongPath(path, -5)).toEqual(path[0]);
    expect(pointAlongPath(path, 1e9)).toEqual(path[2]);
  });
});

describe("published layer bounds", () => {
  it("become edges when the layers join, either orientation", async () => {
    const { edgesFromBounds } = await import("@/ui/analysis/pathMarks.ts");
    expect(edgesFromBounds([0, 2, 2, 18], 2)).toEqual([0, 2, 18]);
    expect(edgesFromBounds([2, 0, 18, 2], 2)).toEqual([0, 2, 18]);
    expect(edgesFromBounds([2, 18, 0, 2], 2)).toEqual([18, 2, 0]);
    expect(edgesFromBounds([0, 2, 5, 18], 2)).toBeUndefined();
    expect(edgesFromBounds(undefined, 2)).toBeUndefined();
  });
});

describe("independently bounded layers (v8 review)", () => {
  it("keep their own intervals and the gap between them", async () => {
    const { layerSpans, edgesFromBounds } =
      await import("@/ui/analysis/pathMarks.ts");
    const { axisCells } = await import("@/ui/analysis/heatmapRaster.ts");
    const bounds = [0, 2, 10, 12];
    expect(edgesFromBounds(bounds, 2)).toBeUndefined();
    expect(Array.from(layerSpans(bounds, 2)!)).toEqual([0, 2, 10, 12]);
    const cells = axisCells([1, 11], bounds);
    expect(Array.from(cells.lo)).toEqual([0, 10]);
    expect(Array.from(cells.hi)).toEqual([2, 12]);
  });
});

describe("the map's pointer on a section's route (23 Nov list)", () => {
  it("is the distance along the path nearest the pointer, within a few pixels", async () => {
    const { distanceNear, vertexDistances } =
      await import("@/ui/analysis/pathMarks.ts");
    // Along the equator, 10 px a degree.
    const path = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 10 },
    ];
    const project = (p: { lat: number; lon: number }) => ({
      x: p.lon * 10,
      y: -p.lat * 10,
    });
    const total = vertexDistances(path)[1];
    const meters = distanceNear(path, project, { x: 25, y: 3 })!;
    expect(meters / total).toBeCloseTo(0.25, 3);
    expect(distanceNear(path, project, { x: 25, y: 30 })).toBeUndefined();
  });

  it("review #30: a route across ±180° on a flat map does not answer at Greenwich", async () => {
    const { distanceNear } = await import("@/ui/analysis/pathMarks.ts");
    // Equirectangular, 2 px a degree, seam at ±180°.
    const flat = (p: { lat: number; lon: number }) => ({
      x: (((((p.lon + 180) % 360) + 360) % 360) - 180) * 2 + 360,
      y: 180 - p.lat * 2,
    });
    const route = [
      { lat: 0, lon: 170 },
      { lat: 0, lon: -170 },
    ];
    // Greenwich on the equator: nowhere near the drawn route.
    expect(distanceNear(route, flat, flat({ lat: 0, lon: 0 }))).toBeUndefined();
    // The route itself still answers, on both sides of the seam.
    expect(distanceNear(route, flat, flat({ lat: 0, lon: 175 }))).toBeDefined();
    expect(
      distanceNear(route, flat, flat({ lat: 0, lon: -175 }))
    ).toBeDefined();
  });
});

describe("performance review of interim30: a route is projected once per view", () => {
  // A 1,000-vertex route along the equator, plate carrée at 10 px a degree.
  const vertices = Array.from({ length: 1000 }, (_, at) => ({
    lat: 0,
    lon: -100 + at * 0.2,
  }));
  let projected = 0;
  const project = (p: { lat: number; lon: number }) => {
    projected++;
    return { x: 1000 + p.lon * 10, y: 500 - p.lat * 10 };
  };

  it("hovers ask the kept route, projecting nothing more", () => {
    const route = screenRoute(vertices, project);
    projected = 0;
    // Far away: answered from the route's box alone.
    expect(routeDistanceNear(route, { x: 1000, y: 100 })).toBeUndefined();
    // On it: the same distance as projecting the route for the question.
    const at = { x: 1000 + 12.34 * 10, y: 503 };
    const kept = routeDistanceNear(route, at);
    expect(projected).toBe(0);
    expect(kept).toBeDefined();
    expect(kept).toBeCloseTo(distanceNear(vertices, project, at)!, 6);
  });
});

it("interim48: a curtain's columns along latitude are its samples', not bins of an axis", async () => {
  const { curtainEdges } = await import("@/ui/analysis/pathMarks.ts");
  const samples = { distances: [0, 111_000, 222_000], lats: [0, 1, 2] };
  expect(curtainEdges(samples, 3, false)).toEqual([
    0, 55_500, 166_500, 222_000,
  ]);
  expect(curtainEdges(samples, 3, true)).toEqual([0, 0.5, 1.5, 2]);
});

it("interim49: one damaged layer leaves the others' spans and the gap between them", async () => {
  const { layerSpans } = await import("@/ui/analysis/pathMarks.ts");
  const spans = Array.from(
    layerSpans([-1, 1, 9, 11, Number.NaN, Number.NaN], 3)!
  );
  expect(spans.slice(0, 4)).toEqual([-1, 1, 9, 11]);
  expect(spans.slice(4).every(Number.isNaN)).toBe(true);
  // 7 m lies in no known layer: drawn as nothing.
  const inside = (z: number) =>
    [0, 1, 2].some((k) => spans[2 * k] <= z && z <= spans[2 * k + 1]);
  expect(inside(7)).toBe(false);
  expect(layerSpans([Number.NaN, Number.NaN], 1)).toBeUndefined();
});

it("interim49: section levels are thinned at an even stride, not leaving single rows bare", async () => {
  const { thinned, thinnedEvenly } = await import("@/ui/analysis/windBarbs.ts");
  // Unevenly spaced pressure rows, as on screen (px).
  const ys = [10, 32, 54, 76, 98, 120, 142, 164, 186];
  // Greedy at 26 px leaves every other row bare; the even stride at a
  // barb's length keeps every row.
  expect(thinned(ys, 26)).toEqual([0, 2, 4, 6, 8]);
  expect(thinnedEvenly(ys, 20)).toEqual(ys.map((_, k) => k));
  // One tight pair: every second row, regularly, not a bare row here
  // and there.
  const tight = [10, 32, 54, 70, 92, 114, 136, 158, 180];
  expect(thinnedEvenly(tight, 20)).toEqual([0, 2, 4, 6, 8]);
  // Too dense for all: every second one, regularly.
  expect(thinnedEvenly([0, 10, 20, 30, 40, 50], 20)).toEqual([0, 2, 4]);
});

it("interim49: unevenly spaced depths keep rows down the whole column", async () => {
  const { thinnedEvenly } = await import("@/ui/analysis/windBarbs.ts");
  // 0–500 m on 300 px: dense at the top, wide below.
  const depths = [0, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500];
  const ys = depths.map((z) => 145 + z * 0.51);
  const kept = thinnedEvenly(ys, 20).sort((a, b) => a - b);
  expect(kept).toContain(11);
  expect(kept).toContain(10);
  expect(kept.length).toBeGreaterThanOrEqual(6);
});
