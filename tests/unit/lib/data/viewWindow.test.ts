import { expect, it } from "vitest";

import { regularWindow, windowCovers } from "@/lib/data/viewWindow.ts";

function axis(start: number, end: number, step: number) {
  const count = Math.round((end - start) / step);
  return Float32Array.from(
    { length: count },
    (_, i) => start + step / 2 + i * step
  );
}

// one-degree global grid, latitude stored north to south
const centre = { centreLat: 0, centreLon: 0 };
const lats = axis(-90, 90, 1).reverse();
const lons = axis(-180, 180, 1);
const box = { latMin: 40, latMax: 45, lonStart: -100, lonSpan: 10, ...centre };

it("windows the cells in view plus one neighbour on every side", () => {
  const window = regularWindow(lats, lons, box)!;
  expect(window.lon).toEqual([{ start: 79, end: 91 }]);
  expect(lons[79]).toBe(-100.5);
  expect(lons[90]).toBe(-89.5);
  // descending latitudes: 45.5°N is row 44, 39.5°N is row 50
  expect(window.lat).toEqual({ start: 44, end: 51 });
  expect(lats[44]).toBe(45.5);
  expect(lats[50]).toBe(39.5);
});

it("grows by the margin on every side", () => {
  const window = regularWindow(lats, lons, box, { margin: 0.5 })!;
  // 2.5° of latitude and 5° of longitude further out
  expect(window.lat).toEqual({ start: 42, end: 54 });
  expect(window.lon).toEqual([{ start: 74, end: 96 }]);
  expect(window.lonStep).toBe(1);
});

it("splits a window over the seam of a global axis, west part first", () => {
  const seam = { latMin: -5, latMax: 5, lonStart: 175, lonSpan: 10, ...centre };
  const window = regularWindow(lats, lons, seam)!;
  expect(window.lon).toEqual([
    { start: 354, end: 360 },
    { start: 0, end: 6 },
  ]);
  // the same arc on a 0..360 axis does not touch its seam
  const shifted = regularWindow(lats, axis(0, 360, 1), seam)!;
  expect(shifted.lon).toEqual([{ start: 174, end: 186 }]);
});

it("takes every longitude when the view holds them all", () => {
  const polar = {
    latMin: 80,
    latMax: 90,
    lonStart: -180,
    lonSpan: 360,
    ...centre,
  };
  const window = regularWindow(lats, lons, polar)!;
  expect(window.lon).toEqual([{ start: 0, end: 360 }]);
  expect(window.lat).toEqual({ start: 0, end: 11 });
});

it("thins the columns of a polar window over the cell budget", () => {
  const polar = {
    latMin: 80,
    latMax: 90,
    lonStart: -180,
    lonSpan: 360,
    ...centre,
  };
  const window = regularWindow(lats, lons, polar, { maxCells: 1000 })!;
  // 11 rows of 360 columns: every fourth column keeps all rows in budget
  expect(window).toEqual({
    lat: { start: 0, end: 11 },
    lon: [{ start: 0, end: 360 }],
    lonStep: 4,
  });
  // the thinned window serves the polar view, not one beside the pole
  expect(windowCovers(window, regularWindow(lats, lons, polar)!)).toBe(true);
  const beside = {
    latMin: 82,
    latMax: 86,
    lonStart: 0,
    lonSpan: 40,
    ...centre,
  };
  expect(windowCovers(window, regularWindow(lats, lons, beside)!)).toBe(false);
});

it("returns the part a regional level holds, or nothing", () => {
  const regionalLats = axis(30, 48, 0.5);
  const regionalLons = axis(-108, -72, 0.5);
  const partly = regularWindow(regionalLats, regionalLons, box)!;
  expect(partly.lat).toEqual({ start: 19, end: 31 });
  expect(partly.lon).toEqual([{ start: 15, end: 37 }]);
  const elsewhere = {
    latMin: 0,
    latMax: 5,
    lonStart: 10,
    lonSpan: 10,
    ...centre,
  };
  expect(regularWindow(regionalLats, regionalLons, elsewhere)).toBeNull();
});

it("shrinks a window over the cell budget around its centre", () => {
  const wide = {
    latMin: -40,
    latMax: 40,
    lonStart: -80,
    lonSpan: 160,
    ...centre,
  };
  const window = regularWindow(lats, lons, wide, { maxCells: 800 })!;
  const rows = window.lat.end - window.lat.start;
  const columns = window.lon[0].end - window.lon[0].start;
  expect(rows * columns).toBeLessThanOrEqual(800);
  expect(Math.abs(window.lat.start + rows / 2 - 90)).toBeLessThanOrEqual(1);
  expect(Math.abs(window.lon[0].start + columns / 2 - 180)).toBeLessThanOrEqual(
    1
  );
});

it("shrinks a window split over the seam towards the seam", () => {
  // a view over Greenwich on a 0..360 axis: the seam is its middle
  const overSeam = {
    latMin: -20,
    latMax: 20,
    lonStart: -20,
    lonSpan: 40,
    ...centre,
  };
  const window = regularWindow(lats, axis(0, 360, 1), overSeam, {
    maxCells: 400,
  })!;
  expect(window.lon).toHaveLength(2);
  const [west, east] = window.lon;
  // the west part ends at the seam and the east part starts there
  expect(west.end).toBe(360);
  expect(east.start).toBe(0);
  const columns = west.end - west.start + east.end - east.start;
  expect((window.lat.end - window.lat.start) * columns).toBeLessThanOrEqual(
    400
  );
});

it("tells whether a loaded window still covers the view", () => {
  const loaded = regularWindow(lats, lons, box, { margin: 0.5 })!;
  expect(windowCovers(loaded, regularWindow(lats, lons, box)!)).toBe(true);
  const panned = { ...box, lonStart: -94 };
  expect(windowCovers(loaded, regularWindow(lats, lons, panned)!)).toBe(false);
});
