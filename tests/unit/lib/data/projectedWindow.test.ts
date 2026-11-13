import proj4 from "proj4";
import { expect, it } from "vitest";

import {
  extentsOverlap,
  projectedBounds,
  projectedExtent,
  projectedWindow,
  projectedWindowCovers,
  type TProjectedAxes,
} from "@/lib/data/projectedWindow.ts";

// The ISMIP6 Antarctic grid: south polar stereographic (EPSG:3031), 8 km
// cells, x ascending and y descending from 3040 km to -3040 km.
const ANTARCTIC_CRS =
  "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs";
const SPACING = 8000;
const COUNT = 761;
const x = Float32Array.from(
  { length: COUNT },
  (_, i) => -3_040_000 + i * SPACING
);
const y = Float32Array.from(
  { length: COUNT },
  (_, i) => 3_040_000 - i * SPACING
);
const converter = proj4("EPSG:4326", ANTARCTIC_CRS);
const projection = {
  forward: (lonLat: [number, number]) => converter.forward(lonLat),
  inverse: (xy: [number, number]) => converter.inverse(xy),
};
const axes: TProjectedAxes = {
  x,
  y,
  projection,
  extent: projectedExtent(x, y, projection),
};

// The Antarctic Peninsula, seen from above it.
const peninsula = {
  latMin: -70,
  latMax: -65,
  lonStart: -70,
  lonSpan: 10,
  centreLat: -67.5,
  centreLon: -65,
};

it("projects a footprint forward and takes its x/y box", () => {
  const bounds = projectedBounds(peninsula, projection.forward)!;
  // west of the central meridian and north of the pole: x < 0 < y
  expect(bounds.xMax).toBeLessThan(0);
  expect(bounds.yMin).toBeGreaterThan(0);
  // the corners are inside the box, and the far edge touches it
  for (const lon of [-70, -60]) {
    for (const lat of [-70, -65]) {
      const [px, py] = projection.forward([lon, lat]);
      expect(px).toBeGreaterThanOrEqual(bounds.xMin);
      expect(px).toBeLessThanOrEqual(bounds.xMax);
      expect(py).toBeGreaterThanOrEqual(bounds.yMin);
      expect(py).toBeLessThanOrEqual(bounds.yMax);
    }
  }
  expect(bounds.xMin).toBeCloseTo(projection.forward([-70, -65])[0], 3);
});

it("windows the cells in the box plus one neighbour on every side", () => {
  const bounds = projectedBounds(peninsula, projection.forward)!;
  const window = projectedWindow(axes, peninsula)!;
  // x ascending: the first column is just outside the box, the next inside
  expect(x[window.x.start]).toBeLessThan(bounds.xMin);
  expect(x[window.x.start + 1]).toBeGreaterThanOrEqual(bounds.xMin);
  expect(x[window.x.end - 1]).toBeGreaterThan(bounds.xMax);
  expect(x[window.x.end - 2]).toBeLessThanOrEqual(bounds.xMax);
  // y descending: the first row is north of the box, in storage order
  expect(y[window.y.start]).toBeGreaterThan(bounds.yMax);
  expect(y[window.y.start + 1]).toBeLessThanOrEqual(bounds.yMax);
  expect(y[window.y.end - 1]).toBeLessThan(bounds.yMin);
  expect(y[window.y.end - 2]).toBeGreaterThanOrEqual(bounds.yMin);
  // under a thousand kilometres: a small part of the grid
  expect(window.x.end - window.x.start).toBeLessThan(120);
  expect(window.y.end - window.y.start).toBeLessThan(120);
});

it("grows by the margin on every side", () => {
  const tight = projectedWindow(axes, peninsula)!;
  const padded = projectedWindow(axes, peninsula, { margin: 0.5 })!;
  const width = tight.x.end - tight.x.start;
  const height = tight.y.end - tight.y.start;
  expect(padded.x.start).toBeLessThan(tight.x.start);
  expect(padded.x.end).toBeGreaterThan(tight.x.end);
  expect(padded.x.end - padded.x.start).toBeGreaterThanOrEqual(2 * width - 4);
  expect(padded.y.end - padded.y.start).toBeGreaterThanOrEqual(2 * height - 4);
  expect(projectedWindowCovers(padded, tight)).toBe(true);
  expect(projectedWindowCovers(tight, padded)).toBe(false);
});

it("loads nothing for a view outside the grid", () => {
  // Australia is beyond the grid's edge, and the Arctic is on the far side
  // of the projection: its points land far outside the grid or, around the
  // north pole, nowhere.
  const australia = {
    latMin: -30,
    latMax: -25,
    lonStart: 130,
    lonSpan: 10,
    centreLat: -27.5,
    centreLon: 135,
  };
  expect(projectedWindow(axes, australia)).toBeNull();
  const arctic = {
    latMin: 80,
    latMax: 90,
    lonStart: -180,
    lonSpan: 360,
    centreLat: 85,
    centreLon: 0,
  };
  expect(projectedWindow(axes, arctic)).toBeNull();
  // without the grid's extent the far side still projects onto the grid
  expect(projectedWindow({ ...axes, extent: undefined }, arctic)).toEqual({
    x: { start: 0, end: COUNT },
    y: { start: 0, end: COUNT },
  });
});

it("takes the disc around the pole for a view that wraps it", () => {
  const polar = {
    latMin: -90,
    latMax: -85,
    lonStart: -180,
    lonSpan: 360,
    centreLat: -89,
    centreLon: 40,
  };
  const window = projectedWindow(axes, polar)!;
  // centred on the pole, which is the middle cell of both axes
  expect(window.x.start + window.x.end).toBeCloseTo(COUNT, -0.5);
  expect(window.y.start + window.y.end).toBeCloseTo(COUNT, -0.5);
  const radius = Math.abs(projection.forward([0, -85])[1]);
  const columns = window.x.end - window.x.start;
  expect(columns * SPACING).toBeGreaterThan(2 * radius);
  expect(columns * SPACING).toBeLessThan(2 * radius + 4 * SPACING);
});

it("cuts a view over the budget down around the point below the camera", () => {
  // the horizon in view: a cap reaching 40°S, the camera over 78°S 90°W
  const cap = {
    latMin: -90,
    latMax: -40,
    lonStart: -180,
    lonSpan: 360,
    centreLat: -78,
    centreLon: -90,
  };
  expect(projectedWindow(axes, cap)).toEqual({
    x: { start: 0, end: COUNT },
    y: { start: 0, end: COUNT },
  });
  const window = projectedWindow(axes, cap, { maxCells: 10_000 })!;
  const width = window.x.end - window.x.start;
  const height = window.y.end - window.y.start;
  expect(width * height).toBeLessThanOrEqual(10_000);
  expect(width * height).toBeGreaterThan(9_000);
  // the camera's point is the middle cell of the window
  const [cx, cy] = projection.forward([-90, -78]);
  expect(x[window.x.start + Math.floor(width / 2)]).toBeCloseTo(cx, -4);
  expect(y[window.y.start + Math.floor(height / 2)]).toBeCloseTo(cy, -4);
  // the window stays inside the grid when the camera is near its edge
  const edge = { ...cap, centreLat: -60, centreLon: 0 };
  const clamped = projectedWindow(axes, edge, { maxCells: 10_000 })!;
  expect(clamped.y.start).toBe(0);
  expect(clamped.y.end).toBe(height);
});

it("finds the lat/lon box of the grid, reaching the pole it holds", () => {
  const extent = projectedExtent(x, y, projection)!;
  expect(extent.latMin).toBe(-90);
  expect(extent.lonSpan).toBe(360);
  // the corners of a 6 080 km square reach about 52°S
  expect(extent.latMax).toBeGreaterThan(-55);
  expect(extent.latMax).toBeLessThan(-50);

  // a regional grid away from the pole: the Peninsula alone
  const columns = x.subarray(100, 200);
  const rows = y.subarray(150, 250);
  const regional = projectedExtent(columns, rows, projection)!;
  expect(regional.latMin).toBeGreaterThan(-80);
  expect(regional.latMax).toBeLessThan(-60);
  expect(regional.lonSpan).toBeLessThan(60);
  expect(regional.lonStart).toBeLessThan(-60);
  expect(regional.lonStart).toBeGreaterThan(-120);
});

it("tells apart overlapping and disjoint lat/lon boxes across the seam", () => {
  const box = { latMin: -70, latMax: -60, lonStart: 170, lonSpan: 20 };
  expect(extentsOverlap(box, { ...box, lonStart: -175, lonSpan: 5 })).toBe(
    true
  );
  expect(extentsOverlap(box, { ...box, lonStart: 165, lonSpan: 5 })).toBe(true);
  expect(extentsOverlap(box, { ...box, lonStart: -160, lonSpan: 5 })).toBe(
    false
  );
  expect(extentsOverlap(box, { ...box, latMin: -59, latMax: -50 })).toBe(false);
  expect(extentsOverlap(box, { ...box, lonStart: 0, lonSpan: 360 })).toBe(true);
});

// The ISMIP6 Greenland grid: north polar stereographic with its central
// meridian at 45°W (EPSG:3413), 4 km cells, x from -720 km, y from -3450 km.
const GREENLAND_CRS =
  "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs";
const greenland = proj4("EPSG:4326", GREENLAND_CRS);
const greenlandProjection = {
  forward: (lonLat: [number, number]) => greenland.forward(lonLat),
  inverse: (xy: [number, number]) => greenland.inverse(xy),
};
const gx = Float32Array.from({ length: 421 }, (_, i) => -720_000 + i * 4000);
const gyUp = Float32Array.from(
  { length: 721 },
  (_, i) => -3_450_000 + i * 4000
);
const gyDown = Float32Array.from(gyUp).reverse();

it.each([
  ["ascending", gyUp],
  ["descending", gyDown],
])("windows a grid with a turned central meridian, y %s", (_, gy) => {
  const axes: TProjectedAxes = {
    x: gx,
    y: gy,
    projection: greenlandProjection,
    extent: projectedExtent(gx, gy, greenlandProjection),
  };
  // the grid does not reach the pole: a regional lat/lon box around it
  expect(axes.extent!.latMax).toBeLessThan(90);
  expect(axes.extent!.latMin).toBeGreaterThan(55);
  // the west coast, seen from above it
  const coast = {
    latMin: 68,
    latMax: 70,
    lonStart: -54,
    lonSpan: 4,
    centreLat: 69,
    centreLon: -52,
  };
  const window = projectedWindow(axes, coast)!;
  const bounds = projectedBounds(coast, greenlandProjection.forward)!;
  // the window holds every projected point of the box, with one cell to spare
  const inside = (
    values: Float32Array,
    range: { start: number; end: number }
  ) => [values[range.start], values[range.end - 1]].sort((a, b) => a - b);
  const [xLow, xHigh] = inside(gx, window.x);
  const [yLow, yHigh] = inside(gy, window.y);
  expect(xLow).toBeLessThan(bounds.xMin);
  expect(xHigh).toBeGreaterThan(bounds.xMax);
  expect(yLow).toBeLessThan(bounds.yMin);
  expect(yHigh).toBeGreaterThan(bounds.yMax);
  expect(xLow + 4000).toBeGreaterThanOrEqual(bounds.xMin - 4000);
  expect(yHigh - 4000).toBeLessThanOrEqual(bounds.yMax + 4000);
  // the same cells whichever way y runs
  const other = projectedWindow(
    { ...axes, y: gy === gyUp ? gyDown : gyUp },
    coast
  )!;
  expect(other.x).toEqual(window.x);
  expect(other.y.end - other.y.start).toBe(window.y.end - window.y.start);
  expect(other.y.start).toBe(gy.length - window.y.end);
  // the far side of the pole is outside the grid
  expect(
    projectedWindow(axes, { ...coast, lonStart: 130, centreLon: 132 })
  ).toBeNull();
});
