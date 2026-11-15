import { describe, expect, it } from "vitest";

import { alignTo, partnerQuery } from "@/lib/analysis/companionAlign.ts";
import type { TAnalysisQuery, TAnalysisResult } from "@/lib/analysis/types.ts";
import { pairSeries, portrait } from "@/ui/analysis/compare.ts";
import { samplingNote } from "@/ui/analysis/scatterFigure.ts";

const series = (
  raw: number[],
  units: string,
  bounds?: number[]
): TAnalysisResult =>
  ({
    values: raw.map((_, at) => at + 1),
    dims: ["time"],
    shape: [raw.length],
    time: { dimension: "time", raw, units, calendar: "standard", bounds },
  }) as unknown as TAnalysisResult;

// eslint-disable-next-line max-lines-per-function
describe("one observation per pair", () => {
  const days = Array.from({ length: 24 }, (_, at) => at + 1);

  it("pairs means by their interval, not by a stamp they share", () => {
    // A's day d covers [d−1, d], B's [d, d+1]: no row is paired with the
    // other's row of the same stamp (zero overlap); A's day d+1 and B's day
    // d are the same interval, one observation of both.
    const a = series(
      days,
      "days since 2000-01-01",
      days.flatMap((d) => [d - 1, d])
    );
    const b = series(
      days,
      "days since 2000-01-01",
      days.flatMap((d) => [d, d + 1])
    );
    const aligned = alignTo(a, b) as { values: number[]; matched: number };
    expect(aligned.matched).toBe(23);
    expect(aligned.values[0]).toBeNaN();
    // A's row k (interval [k, k+1]) takes B's row k−1 (the same interval).
    expect(aligned.values.slice(1, 4)).toEqual([1, 2, 3]);
  });

  it("refuses when no interval is shared", () => {
    const a = series([0.5, 1.5], "days since 2000-01-01", [0, 1, 1, 2]);
    const b = series([0.5, 1.5], "days since 2000-01-01", [0.5, 1.5, 1.5, 2.5]);
    expect(
      "reason" in alignTo(a, b) && (alignTo(a, b) as { reason: string }).reason
    ).toBe("its time cells are other intervals than this plot's");
  });

  it("pairs the same intervals, and one mismatched interval is left out", () => {
    const a = series(
      [0.5, 1.5, 15.5],
      "days since 2000-01-01",
      [0, 1, 1, 2, 0, 31]
    );
    const b = series(
      [0.5, 1.5, 15.5],
      "days since 2000-01-01",
      [0, 1, 1, 2, 15, 16]
    );
    expect(alignTo(a, b)).toEqual({ values: [1, 2, NaN], matched: 2 });
  });

  it("tells 10 µs from 11 µs whatever the units", () => {
    const a = series(
      days.map((i) => 10e-6 + i * 1e-3),
      "seconds since 2000-01-01"
    );
    const b = series(
      days.map((i) => 11e-6 + i * 1e-3),
      "seconds since 2000-01-01"
    );
    expect("reason" in alignTo(a, b)).toBe(true);
  });

  it("matches one instant in integer microseconds and in fractional seconds", () => {
    const us = days.map((i) => 10 + i * 1000);
    const a = series(us, "microseconds since 2000-01-01");
    const b = series(
      us.map((v) => v / 1e6),
      "seconds since 2000-01-01"
    );
    const ab = alignTo(a, b);
    const ba = alignTo(b, a);
    expect("matched" in ab && ab.matched).toBe(24);
    expect("matched" in ba && ba.matched).toBe(24);
  });
});

describe("members known by ID on one side only", () => {
  it("are not paired by position", () => {
    const query = {
      variable: "a",
      fixed: { member: 2 },
      time: { start: 0, stop: 1 },
    } as unknown as TAnalysisQuery;
    const own = {
      others: [{ dimension: "member", size: 3, ids: ["10", "20", "30"] }],
    };
    const partner = { others: [{ dimension: "member", size: 3 }] };
    const result = partnerQuery(query, own, partner, "b");
    expect("reason" in result && result.reason).toMatch(/member IDs/);
  });
});

describe("Compare across calendars", () => {
  it("pairs no dates of a standard and a 360-day calendar", () => {
    const dates = ["2001-02-27", "2001-02-28", "2001-03-01"];
    const pair = pairSeries(
      { dates, values: [1, 2, 3], calendar: "standard" },
      { dates, values: [1, 2, 3], calendar: "360_day" }
    );
    expect(pair.keys).toEqual([]);
  });

  it("still pairs monthly means across them", () => {
    const months = ["2001-01-16", "2001-02-15", "2001-03-16"];
    const pair = pairSeries(
      {
        dates: months,
        values: [1, 2, 3],
        calendar: "standard",
        monthlyCells: true,
      },
      {
        dates: ["2001-01-15", "2001-02-15", "2001-03-15"],
        values: [1, 2, 3],
        calendar: "360_day",
        monthlyCells: true,
      }
    );
    expect(pair.by).toBe("month");
    expect(pair.keys).toHaveLength(3);
  });
});

describe("what a scatter point pairs", () => {
  it("names two grids' own cells when they are not co-located", () => {
    expect(
      samplingNote(
        { cell: { lat: 0, lon: 0 }, name: "a" },
        { cell: { lat: 1, lon: 2 }, name: "b" }
      )
    ).toMatch(/Not co-located.*a at 0\.00° N 0\.00° E, b at 1\.00° N 2\.00° E/);
    expect(
      samplingNote(
        { cell: { lat: 1, lon: 2 }, name: "a" },
        { cell: { lat: 1, lon: 2 }, name: "b" }
      )
    ).toBeUndefined();
  });

  it("names independent area means", () => {
    expect(
      samplingNote({ region: {}, name: "a" }, { region: {}, name: "b" })
    ).toMatch(/independent area means/);
  });
});

describe("levels of different vertical references", () => {
  it("does not take 30 m of altitude for 30 m of height", () => {
    const query = {
      variable: "a",
      fixed: {},
      level: 1,
    } as unknown as TAnalysisQuery;
    const vertical = (standardName: string) => ({
      dimension: "z",
      values: [0, 30, 90],
      units: "m",
      positive: "up" as const,
      standardName,
    });
    const refused = partnerQuery(
      query,
      { vertical: vertical("altitude") },
      { vertical: vertical("height") },
      "b"
    );
    expect("reason" in refused && refused.reason).toBe(
      "its levels are height, this plot's altitude"
    );
    const same = partnerQuery(
      query,
      { vertical: vertical("height") },
      { vertical: vertical("height") },
      "b"
    );
    expect("level" in same && same.level).toBe(1);
  });
});

it("pairs bounded point samples only at their actual observation times", () => {
  const units = "days since 2000-01-01";
  const bounds = [0, 1, 1, 2, 2, 3];
  const a = {
    ...series([0.25, 1.25, 2.25], units, bounds),
    cellMethods: "time: point",
  };
  const b = {
    ...series([0.25, 1.75, 2.25], units, bounds),
    cellMethods: "time: point",
  };

  // The requested span includes both matching endpoints and a middle day
  // whose two measurements are twelve hours apart.
  expect(alignTo(a, b)).toEqual({ values: [1, NaN, 3], matched: 2 });
});

// eslint-disable-next-line max-lines-per-function
describe("the same observation rule everywhere (reviews of interim26)", () => {
  const n = 24;
  const range = <T>(f: (i: number) => T) =>
    Array.from({ length: n }, (_, i) => f(i));
  const daily = range((i) => i).flatMap((i) => [i, i + 1]);
  const withMethod = (r: TAnalysisResult, cellMethods: string) =>
    ({ ...r, cellMethods }) as TAnalysisResult;
  const axes = (
    raw: number[],
    bounds: number[] | undefined,
    cellMethods: string,
    units = "days since 2000-01-01"
  ) => ({
    time: {
      dimension: "time",
      raw,
      units,
      calendar: "standard",
      chunk: n,
      ...(bounds ? { bounds } : {}),
      cellMethods,
    },
  });
  const query = {
    version: 1,
    kind: "point-series",
    variable: "a",
    fixed: {},
    geometry: { kind: "point", lat: 0, lon: 0 },
    time: { start: 0, stop: n },
  } as unknown as TAnalysisQuery;

  it("matches 24 daily means on the same bounds, stamped mid-cell and at the end", () => {
    const a = series(
      range((i) => i + 0.5),
      "days since 2000-01-01",
      daily
    );
    const b = series(
      range((i) => i + 1),
      "days since 2000-01-01",
      daily
    );
    const aligned = alignTo(
      withMethod(a, "time: mean"),
      withMethod(b, "time: mean")
    ) as { matched: number };
    expect(aligned.matched).toBe(24);
    // And before reading: the partner query keeps all 24 dates.
    const next = partnerQuery(
      query,
      axes(a.time!.raw, daily, "time: mean"),
      axes(b.time!.raw, daily, "time: mean"),
      "b"
    ) as TAnalysisQuery;
    expect(next.time).toEqual({ start: 0, stop: 24 });
  });

  it("pairs time: point readings by instant, whatever their nominal bounds", () => {
    const a = range((i) => i + 0.25);
    const b = range((i) => (i % 2 === 0 || i === 23 ? i + 0.25 : i + 0.75));
    const aligned = alignTo(
      withMethod(series(a, "days since 2000-01-01", daily), "time: point"),
      withMethod(series(b, "days since 2000-01-01", daily), "time: point")
    ) as { matched: number };
    expect(aligned.matched).toBe(13);
  });

  it("refuses intervals that are never the same from the bounds alone", () => {
    const quarter = range((i) => i).flatMap((i) => [i, i + 0.25]);
    const next = range((i) => i).flatMap((i) => [i + 0.25, i + 0.5]);
    const stamps = range((i) => i + 0.25);
    // No partner field read is needed to know: the query is refused.
    expect(
      partnerQuery(
        query,
        axes(stamps, quarter, "time: mean"),
        axes(stamps, next, "time: mean"),
        "b"
      )
    ).toEqual({
      reason: "its time cells are other intervals than this plot's",
    });
  });

  it("Compare: readings a microsecond apart are no pairs, no statistics", () => {
    const at = (offset: number) => range((i) => offset + i * 1e-3);
    const axis = (raw: number[]) => ({
      raw,
      units: "seconds since 2000-01-01",
      calendar: "standard",
    });
    const dates = range(
      (i) => `2000-01-01 00:00:00.${String(i).padStart(3, "0")}`
    );
    const pair = pairSeries(
      { dates, values: range((i) => i), time: axis(at(10e-6)) },
      { dates, values: range((i) => i + 100), time: axis(at(11e-6)) }
    );
    expect(pair.keys).toEqual([]);
  });

  it("Compare: a month-long bound does not make a reading a monthly mean", () => {
    const months = Array.from({ length: 24 }, (_, m) => m);
    const pair = pairSeries(
      {
        dates: months.map(
          (m) =>
            `20${String(1 + Math.floor(m / 12)).padStart(2, "0")}-${String((m % 12) + 1).padStart(2, "0")}-02`
        ),
        values: months,
        calendar: "standard",
        monthlyCells: true,
        time: {
          raw: months.map((m) => m * 30.4 + 1),
          units: "days since 2001-01-01",
          calendar: "standard",
          bounds: months.flatMap((m) => [m * 30.4, (m + 1) * 30.4]),
          cellMethods: "time: point",
        },
      },
      {
        dates: months.map(
          (m) =>
            `20${String(1 + Math.floor(m / 12)).padStart(2, "0")}-${String((m % 12) + 1).padStart(2, "0")}-27`
        ),
        values: months.map((m) => m + 100),
        calendar: "360_day",
        monthlyCells: true,
        time: {
          raw: months.map((m) => m * 30 + 26),
          units: "days since 2001-01-01",
          calendar: "360_day",
          bounds: months.flatMap((m) => [m * 30, (m + 1) * 30]),
          cellMethods: "time: point",
        },
      }
    );
    expect(pair.keys).toEqual([]);
  });

  it("Compare: monthly means on the same bounds pair by month whatever their stamps", () => {
    // Start-of-month versus end-boundary stamps, values
    // [0, 7, 1, 9]: correlation +1 and bias 0, not adjacent months.
    const bounds = [0, 31, 31, 59, 59, 90, 90, 120];
    const pair = pairSeries(
      {
        dates: ["2001-01-01", "2001-02-01", "2001-03-01", "2001-04-01"],
        values: [0, 7, 1, 9],
        calendar: "standard",
        time: {
          raw: [0, 31, 59, 90],
          units: "days since 2001-01-01",
          calendar: "standard",
          bounds,
          cellMethods: "time: mean",
        },
      },
      {
        dates: ["2001-02-01", "2001-03-01", "2001-04-01", "2001-05-01"],
        values: [0, 7, 1, 9],
        calendar: "standard",
        time: {
          raw: [31, 59, 90, 120],
          units: "days since 2001-01-01",
          calendar: "standard",
          bounds,
          cellMethods: "time: mean",
        },
      }
    );
    expect(pair.by).toBe("interval");
    expect(pair.reference).toEqual([0, 7, 1, 9]);
    expect(pair.other).toEqual([0, 7, 1, 9]);
  });
});

it("matches cross-calendar monthly means by the month each interval covers", () => {
  const values = [0, 7, 1, 9];
  const months = (
    raw: number[],
    bounds: number[],
    dates: string[],
    calendar: string
  ) => ({
    dates,
    values,
    calendar,
    monthlyCells: true,
    time: {
      raw,
      bounds,
      calendar,
      units: "days since 2001-01-01",
      cellMethods: "time: mean",
    },
  });
  // Both series cover January through April. The Gregorian coordinate is
  // placed on each closing boundary and the 360-day one on each opening.
  const pair = pairSeries(
    months(
      [31, 59, 90, 120],
      [0, 31, 31, 59, 59, 90, 90, 120],
      ["2001-02-01", "2001-03-01", "2001-04-01", "2001-05-01"],
      "standard"
    ),
    months(
      [0, 30, 60, 90],
      [0, 30, 30, 60, 60, 90, 90, 120],
      ["2001-01-01", "2001-02-01", "2001-03-01", "2001-04-01"],
      "360_day"
    )
  );
  expect(pair.keys).toEqual(["2001-01", "2001-02", "2001-03", "2001-04"]);
  expect(pair.reference).toEqual(values);
  expect(pair.other).toEqual(values);
});

it("recognizes point observations declared on the time dimension named record", () => {
  const reading = (raw: number[]) => {
    const r = series(raw, "days since 2001-01-01", [0, 1, 1, 2, 2, 3]);
    return {
      ...r,
      dims: ["record"],
      time: { ...r.time!, dimension: "record" },
      cellMethods: "record: point",
    };
  };
  const a = reading([0.25, 1.25, 2.25]);
  const b = reading([0.25, 1.75, 2.25]);
  expect(alignTo(a, b)).toEqual({ values: [1, NaN, 3], matched: 2 });
});

it("review of interim30: a row of unknown support matches nothing, the others by interval", () => {
  const raw = Array.from({ length: 24 }, (_, i) => i + 0.25);
  const withMean = (r: TAnalysisResult) => ({
    ...r,
    cellMethods: "time: mean",
  });
  const a = withMean(
    series(
      raw,
      "days since 2001-01-01",
      raw.flatMap((_, i) => [i, i + 0.25])
    )
  );
  const bBounds = raw.flatMap((_, i) => [i + 0.25, i + 0.5]);
  bBounds[46] = bBounds[47] = Number.NaN; // the last row's bounds unknown
  const b = withMean(series(raw, "days since 2001-01-01", bBounds));
  // 23 disjoint intervals and one unknown: no pair, never by the stamps.
  const aligned = alignTo(a, b);
  expect("matched" in aligned).toBe(false);
  expect("reason" in aligned && aligned.reason).toMatch(/intervals/);
  // Both sides unknown in the same row: still not one observation.
  const same = withMean(series(raw, "days since 2001-01-01", bBounds));
  const both = alignTo(b, same);
  expect("matched" in both && both.matched).toBe(23);
});

it("attributes a February mean to winter when its reference is stamped at the closing boundary", () => {
  const units = "days since 2001-01-01";
  const a = {
    dates: ["2001-02-01", "2001-03-01", "2001-04-01"],
    values: [0, 0, 0],
    time: {
      raw: [31, 59, 90],
      units,
      bounds: [0, 31, 31, 59, 59, 90],
      cellMethods: "time: mean",
    },
  };
  const b = {
    ...a,
    dates: ["2001-01-01", "2001-02-01", "2001-03-01"],
    values: [0, 10, 0],
    time: { ...a.time, raw: [0, 31, 59] },
  };
  const pair = pairSeries(a, b);
  expect(pair.by).toBe("interval");
  const rms = portrait([pair]).errors[0];
  expect(rms[0]).toBeCloseTo(Math.sqrt(50));
  expect(rms[1]).toBe(0);
});

it("withholds pairs if one variable's declared mean intervals are unreadable", () => {
  const units = "days since 2001-01-01";
  const dates = ["2001-01-02", "2001-01-03", "2001-01-04", "2001-01-05"];
  const a = {
    dates,
    values: [10, 20, 30, 40],
    time: {
      raw: [1, 2, 3, 4],
      units,
      cellMethods: "time: mean",
      bounds: [0, 1, 1, 2, 2, 3, 3, 4],
    },
  };
  const b = {
    dates,
    values: [20, 30, 40, 50],
    time: {
      raw: [1, 2, 3, 4],
      units,
      cellMethods: "time: mean",
      boundsUnread: "its declared bounds tb could not be read",
    },
  };
  const overlap = pairSeries(a, b);
  expect(overlap.keys).toEqual([]);
});

// eslint-disable-next-line max-lines-per-function
describe("review of interim33: Against before any partner read", () => {
  const day = (raw: number[], bounds: number[]) => ({
    dimension: "time",
    raw,
    units: "days since 2001-01-01",
    bounds,
    cellMethods: "time: mean",
  });
  it("matches no cell of unknown bounds with another", () => {
    // Index 7's bounds are missing on both sides; the known cells are 100
    // days apart.
    const bounds = (shift: number) =>
      Array.from({ length: 24 }, (_, i) =>
        i === 7 ? [Number.NaN, Number.NaN] : [i + shift, i + shift + 1]
      ).flat();
    const raw = Array.from({ length: 24 }, (_, i) => i + 0.5);
    const query = {
      variable: "a",
      fixed: {},
      time: { start: 7, stop: 8 },
    } as unknown as TAnalysisQuery;
    const result = partnerQuery(
      query,
      { time: day(raw, bounds(0)) },
      {
        time: day(
          raw.map((t) => t + 100),
          bounds(100)
        ),
      },
      "b"
    );
    expect("reason" in result).toBe(true);
  });

  it("refuses a partner that varies along a level or member axis the plot lacks", () => {
    const query = { variable: "sst", fixed: {} } as unknown as TAnalysisQuery;
    const levels = partnerQuery(
      query,
      {},
      {
        vertical: {
          dimension: "plev",
          values: [92500, 85000],
          units: "Pa",
        },
      },
      "ta"
    );
    expect("reason" in levels && levels.reason).toMatch(
      /2 levels.*single level/
    );
    const members = partnerQuery(
      query,
      {},
      { others: [{ dimension: "member", size: 2, ids: ["42", "57"] }] },
      "ta"
    );
    expect("reason" in members && members.reason).toMatch(
      /varies along member \(2: 42, 57\)/
    );
    // One level, or one member, is no choice to make.
    expect(
      "reason" in
        partnerQuery(
          query,
          {},
          { others: [{ dimension: "member", size: 1 }] },
          "ta"
        )
    ).toBe(false);
  });
});

it("pairs an intensive quantity without cell_methods by instant, as CF's default point (review of interim33)", () => {
  const n = 24;
  const bounds = Array.from({ length: n }, (_, i) => [i, i + 1]).flat();
  const a = Array.from({ length: n }, (_, i) => i + 0.25);
  // The same instant for 13 rows, three quarters of a day for 11.
  const b = a.map((t, i) => (i < 13 ? t : t + 0.5));
  const temperature = (raw: number[], cellMethods?: string) =>
    ({
      ...series(raw, "days since 2000-01-01", bounds),
      units: "K",
      cellMethods,
      time: {
        dimension: "time",
        raw,
        units: "days since 2000-01-01",
        calendar: "standard",
        bounds,
        quantity: "intensive",
      },
    }) as unknown as TAnalysisResult;
  const matched = (methods?: string) =>
    (
      alignTo(temperature(a, methods), temperature(b, methods)) as {
        matched: number;
      }
    ).matched;
  expect(matched()).toBe(13);
  expect(matched("time: point")).toBe(13);
  // Declared means over the cells: the same intervals, all 24.
  expect(matched("time: mean")).toBe(24);
});

it("withholds an Against alignment when a mean's declared time bounds are unreadable", () => {
  const raw = [1, 2, 3, 4];
  const units = "days since 2001-01-01";
  const a = series(raw, units, [0, 1, 1, 2, 2, 3, 3, 4]);
  const b = series(raw, units);
  a.cellMethods = b.cellMethods = "time: mean";
  b.time!.boundsUnread = "declared bounds tb could not be read";
  b.values = [11, 12, 13, 14];
  const aligned = alignTo(a, b);
  expect("matched" in aligned ? aligned.matched : 0).toBe(0);
});

it("keeps point temperatures comparable when only nominal bounds are unreadable", () => {
  const raw = [1, 2, 3, 4];
  const units = "days since 2001-01-01";
  const dates = raw.map((d) => `2001-01-0${d + 1}`);
  const seriesOf = (cellMethods?: string) => ({
    dates,
    values: [280, 281, 282, 283],
    time: { raw, units, quantity: "intensive" as const, cellMethods },
  });
  const compared = (cellMethods?: string) => {
    const a = seriesOf(cellMethods);
    return pairSeries(a, {
      ...a,
      time: { ...a.time, boundsUnread: "declared bounds tb could not be read" },
    });
  };
  expect(compared("time: point").keys).toHaveLength(4);
  expect(compared().keys).toHaveLength(4);
});
