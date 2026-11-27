import { expect, it } from "vitest";

import { alignTo } from "@/lib/analysis/companionAlign.ts";
import { pairSeries } from "@/ui/analysis/compare.ts";

const units = "days since 2001-01-01";
const days = Array.from({ length: 24 }, (_, d) => d);
const cells = days.flatMap((d) => [d, d + 1]);
const daily = (bounds: number[], extra: Record<string, unknown> = {}) => ({
  dates: days.map((d) => `2001-01-${String(d + 1).padStart(2, "0")}`),
  values: days.map((d) => d),
  time: {
    raw: days.map((d) => d + 0.5),
    units,
    calendar: "standard",
    bounds,
    cellMethods: "time: mean",
    dimension: "time",
    ...extra,
  },
});

it("pairs the intervals whose bounds are known beside one that is not (review of interim37)", () => {
  const partner = cells.slice();
  partner[14] = Number.NaN;
  const pair = pairSeries(
    daily(cells),
    daily(partner, {
      boundsUnread: "its declared bounds have missing values (1 of 24 steps)",
    })
  );
  expect(pair.reference).toHaveLength(23);
});

it("scores no interval means against readings at instants (review of interim37)", () => {
  const instants = daily(cells, { cellMethods: "time: point" });
  expect(pairSeries(daily(cells), instants).reference).toHaveLength(0);
});

it("pairs profile layers by their bounds, not only their centres (review of interim37)", () => {
  const profile = (bounds: number[]) =>
    ({
      kind: "profile",
      query: { variable: "thetao" },
      values: [270.25, 270.25, 270.25],
      dims: ["depth"],
      shape: [3],
      notes: [],
      vertical: {
        dimension: "depth",
        label: "depth (m)",
        units: "m",
        positive: "down",
        physical: true,
        values: [5, 15, 25],
        bounds,
      },
    }) as never;
  const broad = profile([0, 10, 10, 20, 20, 30]);
  const narrow = profile([4, 6, 14, 16, 24, 26]);
  const same = alignTo(broad, broad) as { values: number[] };
  expect(same.values.filter(Number.isFinite)).toHaveLength(3);
  const other = alignTo(broad, narrow);
  const paired =
    "values" in other ? other.values.filter(Number.isFinite).length : 0;
  expect(paired).toBe(0);
});

const column = (
  values: number[],
  vertical: Record<string, unknown>,
  cellMethods?: string
) =>
  ({
    kind: "profile",
    query: { variable: "thetao" },
    values,
    dims: ["depth"],
    shape: [values.length],
    notes: [],
    cellMethods,
    vertical: {
      dimension: "depth",
      label: "depth (m)",
      units: "m",
      physical: true,
      ...vertical,
    },
  }) as never;

it("independent review of interim41: point profiles pair by position whatever nominal bounds they carry", () => {
  const values = [5, 15, 25];
  const a = column(
    values,
    {
      positive: "down",
      values,
      bounds: [0, 10, 10, 20, 20, 30],
    },
    "depth: point"
  );
  const b = column(
    values,
    {
      positive: "down",
      values,
      bounds: [4, 6, 14, 16, 24, 26],
    },
    "depth: point"
  );
  const paired = alignTo(a, b) as { values: number[] };
  expect(paired.values.filter(Number.isFinite)).toHaveLength(3);
});

it("final review of interim41: a depth and a height of the same metres are no one level", () => {
  const levels = [0, 50, 100];
  const down = column([1, 2, 3], { positive: "down", values: levels });
  const up = column([1, 2, 3], { positive: "up", values: levels });
  const paired = alignTo(down, up);
  const matched =
    "values" in paired ? paired.values.filter(Number.isFinite).length : 0;
  // Only the surface is both.
  expect(matched).toBe(1);
});

it("independent review of interim41: a fixed level of another layer is no partner", () => {
  const series = (bounds: [number, number]) =>
    ({
      kind: "point-series",
      query: { variable: "thetao" },
      values: [1, 2],
      dims: ["time"],
      shape: [2],
      notes: [],
      cellMethods: "depth: mean",
      time: { dimension: "time", raw: [0, 1], units: "days since 2000-01-01" },
      fixedLevel: {
        dimension: "depth",
        index: 0,
        value: 5,
        units: "m",
        positive: "down",
        bounds,
      },
    }) as never;
  expect(alignTo(series([0, 10]), series([4, 6]))).toEqual({
    reason: "it is a statistic over another layer",
  });
  expect("values" in alignTo(series([0, 10]), series([0, 10]))).toBe(true);
});

it("independent review of interim41: an undated row of a two-axis result pairs nothing", () => {
  const curtain = (values: number[]) =>
    ({
      kind: "time-depth",
      query: { variable: "thetao" },
      values,
      dims: ["time", "depth"],
      shape: [3, 2],
      notes: [],
      time: {
        dimension: "time",
        raw: [0, Number.NaN, 2],
        units: "days since 2000-01-01",
      },
      vertical: {
        dimension: "depth",
        label: "depth (m)",
        units: "m",
        positive: "down",
        physical: true,
        values: [5, 15],
      },
    }) as never;
  const paired = alignTo(
    curtain([1, 2, 99, 98, 5, 6]),
    curtain([1, 2, 99, 98, 5, 6])
  ) as { values: number[] };
  expect(paired.values.slice(2, 4).every(Number.isNaN)).toBe(true);
  expect(paired.values.filter(Number.isFinite)).toHaveLength(4);
});

it("keeps the cells of interval pairs ending at one time in the CSV", async () => {
  const { compareViewCsv } = await import("@/ui/analysis/compare.ts");
  // Two sums ending at 1 Jan 01:00, over one hour and over two.
  const hour = 1 / 24;
  const series = (values: number[]) => ({
    dates: ["2001-01-01 01:00:00", "2001-01-01 01:00:00"],
    values,
    time: {
      raw: [hour, hour],
      units,
      calendar: "standard",
      bounds: [0, hour, -hour, hour],
      cellMethods: "time: sum",
      dimension: "time",
    },
  });
  const pair = pairSeries(series([1, 10]), series([3, 18]));
  expect(pair.reference).toEqual([1, 10]);
  const csv = compareViewCsv(
    "bias",
    [{ label: "P2", colour: "#000", pair } as never],
    "P1"
  ).split("\n");
  expect(csv[0]).toMatch(/,cell_start,cell_end$/);
  // Each row its own cell: one hour, then two.
  expect(csv[1]).toMatch(/,2,2001-01-01 00:00(:00)?,2001-01-01 01:00(:00)?$/);
  expect(csv[2]).toMatch(/,8,2000-12-31 23:00(:00)?,2001-01-01 01:00(:00)?$/);
});
