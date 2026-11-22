import { expect, it } from "vitest";

import { maximaYears } from "@/ui/analysis/seriesViews.ts";

const day = 86400000;
const origin = Date.UTC(2001, 0, 1);
const t = (y: number, m: number, d = 1) => (Date.UTC(y, m, d) - origin) / day;
const label = (x: number) =>
  new Date(origin + x * day).toISOString().slice(0, 10);

/** Cells [start, end) in days since 2001, stamped at their middles. */
function series(cells: [number, number][], values: number[]) {
  const raw = cells.map(([a, b]) => (a + b) / 2);
  return {
    dates: raw.map(label),
    raw,
    values,
    bounds: cells.flat(),
    timeUnits: "days since 2001-01-01",
    calendar: "standard",
    cellMethods: "time: maximum",
    units: "mm",
    window: 3,
    threshold: 0,
  };
}

it("keeps a year of four bounded quarterly maxima (review of interim37)", () => {
  const cells: [number, number][] = [];
  const values: number[] = [];
  for (let y = 2001; y <= 2005; y++) {
    for (let m = 0; m < 12; m++) {
      cells.push([t(y, m), t(y, m + 1)]);
      values.push(y - 2000);
    }
  }
  for (let q = 0; q < 4; q++) {
    cells.push([t(2006, 3 * q), t(2006, 3 * q + 3)]);
    values.push(100);
  }
  const years = maximaYears(series(cells, values) as never).years;
  expect([...years].sort()).toEqual([
    "2001",
    "2002",
    "2003",
    "2004",
    "2005",
    "2006",
  ]);
});

it("fits no annual maxima of two-year rolling windows (review of interim37)", () => {
  // A window starting every month, two years long: one 100 mm event in
  // 2001 reaches every window that covers it.
  const cells: [number, number][] = [];
  const values: number[] = [];
  for (let y = 2001; y <= 2008; y++) {
    for (let m = 0; m < 12; m++) {
      cells.push([t(y, m), t(y + 2, m)]);
      values.push(y === 2001 || (y === 2000 && m > 0) ? 100 : 1);
    }
  }
  const years = maximaYears(series(cells, values) as never).years;
  expect(years.size).toBe(0);
});

it("review of interim43: one year's missing bound hides only that year", () => {
  // Six annual maxima; the last one's bounds are missing, and the reader
  // says so for the axis. The five complete years stay.
  const cells: [number, number][] = [];
  const values: number[] = [];
  for (let y = 2001; y <= 2006; y++) {
    cells.push([t(y, 0), t(y + 1, 0)]);
    values.push(y - 2000);
  }
  const ctx = series(cells, values);
  ctx.bounds.splice(10, 2, Number.NaN, Number.NaN);
  const years = maximaYears({
    ...ctx,
    boundsUnread: "its declared bounds have missing values (1 of 6 steps)",
  } as never).years;
  expect([...years].sort()).toEqual(["2001", "2002", "2003", "2004", "2005"]);
  // Bounds not read at all: no year has a known support.
  expect(
    maximaYears({
      ...ctx,
      bounds: undefined,
      boundsUnread: "its declared bounds tb could not be read",
    } as never).years.size
  ).toBe(0);
});
