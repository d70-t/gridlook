import { describe, expect, it } from "vitest";

import { pairSeries, portrait, taylorStats } from "@/ui/analysis/compare.ts";

const days = (n: number, month = "01") =>
  Array.from(
    { length: n },
    (_, d) => `2020-${month}-${String(d + 1).padStart(2, "0")} 00:00:00`
  );

// eslint-disable-next-line max-lines-per-function
describe("comparing series with a reference", () => {
  it("pairs at the same times, else by day, else by month", () => {
    const same = pairSeries(
      { dates: days(5), values: [1, 2, 3, 4, 5] },
      { dates: days(5).slice(1), values: [20, 30, 40, Number.NaN] }
    );
    expect(same.by).toBe("time");
    expect(same.reference).toEqual([2, 3, 4]);
    expect(same.other).toEqual([20, 30, 40]);
    // Daily values stamped at noon against midnight: daily means.
    const noon = days(5).map((d) => d.replace("00:00:00", "12:00:00"));
    const daily = pairSeries(
      { dates: days(5), values: [1, 2, 3, 4, 5] },
      { dates: noon, values: [2, 3, 4, 5, 6] }
    );
    expect(daily.by).toBe("day");
    expect(daily.other).toEqual([2, 3, 4, 5, 6]);
    // Monthly means (declared month cells) stamped on the 1st and the 15th.
    const monthly = pairSeries(
      {
        dates: ["2020-01-01", "2020-02-01", "2020-03-01"],
        values: [1, 2, 3],
        monthlyCells: true,
      },
      {
        dates: ["2020-01-15", "2020-02-15", "2020-03-15"],
        values: [1.5, 2.5, 3.5],
        monthlyCells: true,
      }
    );
    expect(monthly.by).toBe("month");
    expect(monthly.keys).toEqual(["2020-01", "2020-02", "2020-03"]);
    // Readings on the 1st and the 27th, no cells declared: not paired as
    // months.
    const readings = pairSeries(
      { dates: ["2020-01-01", "2020-02-01", "2020-03-01"], values: [1, 2, 3] },
      { dates: ["2020-01-27", "2020-02-27", "2020-03-27"], values: [1, 2, 3] }
    );
    expect(readings.by).not.toBe("month");
    expect(readings.keys).toEqual([]);
  });

  it("keeps subdaily series subdaily (v20 review)", () => {
    // Opposite twice-daily series for three days: equal daily means, but
    // at their own times an RMS difference of 10 and a correlation of −1.
    const dates = days(3).flatMap((d) => [
      d,
      d.replace("00:00:00", "12:00:00"),
    ]);
    const pair = pairSeries(
      { dates, values: [0, 10, 0, 10, 0, 10] },
      { dates, values: [10, 0, 10, 0, 10, 0] }
    );
    expect(pair.by).toBe("time");
    const stats = taylorStats(pair.reference, pair.other)!;
    expect(stats.correlation).toBeCloseTo(-1);
    expect(Math.sqrt(stats.crmsd ** 2 + stats.bias ** 2)).toBeCloseTo(10);
  });

  it("compares K against °C once converted: no bias (v20 review)", async () => {
    const { converter } = await import("@/lib/analysis/unitConvert.ts");
    const toK = converter("degC", "K")!;
    const stats = taylorStats([273.15, 274.15, 275.15], [0, 1, 2].map(toK))!;
    expect(stats.bias).toBeCloseTo(0, 9);
    expect(stats.crmsd).toBeCloseTo(0, 9);
  });

  it("gives Taylor statistics, the bias kept apart", () => {
    const reference = [1, 2, 3, 4];
    // Twice the variability, shifted: perfectly correlated.
    const stats = taylorStats(reference, [12, 14, 16, 18])!;
    expect(stats.correlation).toBeCloseTo(1);
    expect(stats.stdTest / stats.stdRef).toBeCloseTo(2);
    expect(stats.bias).toBe(12.5);
    // Centred RMS difference: the law of cosines on the diagram.
    const { stdRef, stdTest, correlation, crmsd } = stats;
    expect(crmsd ** 2).toBeCloseTo(
      stdRef ** 2 + stdTest ** 2 - 2 * stdRef * stdTest * correlation
    );
    expect(taylorStats([1], [2])).toBeUndefined();
  });

  it("portrays errors by season, relative to the median series", () => {
    const keys = ["2020-01", "2020-07"];
    const reference = [0, 0];
    const result = portrait([
      { keys, reference, other: [1, 1] },
      { keys, reference, other: [2, 2] },
      { keys, reference, other: [3, 3] },
    ]);
    // DJF holds January only; JJA July only; MAM has nothing.
    expect(result.errors[0][0]).toBe(1);
    expect(result.errors[2][2]).toBe(3);
    expect(result.errors[0][1]).toBeNaN();
    expect(result.relative.map((row) => row[4])).toEqual([-0.5, 0, 0.5]);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("more comparisons", () => {
  it("gives the bias at each common date", async () => {
    const { biasSeries, pairSeries } = await import("@/ui/analysis/compare.ts");
    const pair = pairSeries(
      { dates: ["2000-01-01", "2000-01-02", "2000-01-03"], values: [1, 2, 3] },
      { dates: ["2000-01-01", "2000-01-02", "2000-01-03"], values: [2, 2, 5] }
    );
    expect(biasSeries(pair)).toEqual({
      keys: ["2000-01-01", "2000-01-02", "2000-01-03"],
      values: [1, 0, 2],
    });
  });

  it("pairs percentiles for a Q–Q plot: a shifted series lies off the 1:1 line", async () => {
    const { pairSeries, quantilePairs } =
      await import("@/ui/analysis/compare.ts");
    const dates = Array.from(
      { length: 101 },
      (_, k) =>
        `2000-${String(1 + (k % 12)).padStart(2, "0")}-${String(1 + Math.floor(k / 12)).padStart(2, "0")}`
    );
    const values = dates.map((_, k) => k);
    const pair = pairSeries(
      { dates, values },
      { dates, values: values.map((v) => v + 5) }
    );
    const q = quantilePairs(pair);
    expect(q).toHaveLength(99);
    expect(q[49].p).toBeCloseTo(0.5);
    expect(q[49].other - q[49].reference).toBeCloseTo(5);
  });

  it("places scores on parallel axes, the better end at the top", async () => {
    const { parallelScores } = await import("@/ui/analysis/compare.ts");
    const good = {
      n: 10,
      correlation: 0.95,
      stdRef: 1,
      stdTest: 1.05,
      crmsd: 0.3,
      bias: 0.1,
    };
    const poor = {
      n: 10,
      correlation: 0.5,
      stdRef: 1,
      stdTest: 1.6,
      crmsd: 1.1,
      bias: -0.8,
    };
    const p = parallelScores([good, poor]);
    expect(p.axes.map((a) => a.name)).toEqual([
      "Correlation",
      "|1 − σ/σref|",
      "cRMSD / σref",
      "|bias| / σref",
    ]);
    // The ideal sits at the top of every axis; the good run above the poor.
    expect(p.ideal).toEqual([1, 1, 1, 1]);
    p.rows[0].placed.forEach((value, k) =>
      expect(value).toBeGreaterThan(p.rows[1].placed[k])
    );
    expect(p.rows[1].values[3]).toBeCloseTo(0.8);
    const same = { ...good, correlation: 1, stdTest: 1, crmsd: 0, bias: 0 };
    expect(parallelScores([same]).rows[0].placed).toEqual([1, 1, 1, 1]);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("v24 reviews: what Compare pairs", () => {
  it("keeps milliseconds apart: .100 is not .900", () => {
    const at = (ms: string) =>
      [1, 2, 3].map((s) => `2020-01-01 00:00:0${s}.${ms}`);
    const pair = pairSeries(
      { dates: [...at("100"), ...at("900")], values: [1, 2, 3, 4, 5, 6] },
      { dates: [...at("100"), ...at("900")], values: [1, 2, 3, 4, 5, 6] }
    );
    expect(pair.by).toBe("time");
    expect(pair.keys).toHaveLength(6);
    expect(taylorStats(pair.reference, pair.other)!.correlation).toBeCloseTo(
      1,
      12
    );
  });

  it("averages by month only series that are monthly", () => {
    // Daily against two sparse observations: two days, not two months.
    const sparse = pairSeries(
      { dates: [...days(28), ...days(28, "02")], values: Array(56).fill(1) },
      { dates: ["2020-01-03 00:00:00", "2020-02-09 00:00:00"], values: [5, 6] }
    );
    expect(sparse.by).not.toBe("month");
    expect(sparse.keys).toHaveLength(2);
  });

  it("raw offsets of an undecoded calendar pair only as written", () => {
    const raw = (origin: string) => ({
      dates: [0, 1, 2].map((r) => `${r} days since ${origin} all_leap`),
      values: [1, 2, 3],
      exact: true,
    });
    expect(pairSeries(raw("1980-01-01"), raw("2000-01-01")).keys).toEqual([]);
    expect(pairSeries(raw("1980-01-01"), raw("1980-01-01")).keys).toHaveLength(
      3
    );
  });

  it("places dates by elapsed time", async () => {
    const { keyDays } = await import("@/ui/analysis/compare.ts");
    const [a, b, c] = ["2020-01-01", "2020-01-02", "2020-12-30"].map((k) =>
      keyDays(k)
    );
    expect(b - a).toBe(1);
    expect(c - b).toBe(363);
    expect(keyDays("2020-01-01 12:00:00.500") - a).toBeCloseTo(
      0.5 + 0.5 / 86400,
      9
    );
    expect(keyDays("2020-02") - a).toBe(31);
  });

  it("compares what the plot shows: means below its coverage are left out", async () => {
    const { shownValues } = await import("@/ui/analysis/plotFigure.ts");
    const region = {
      values: [1, 2, 3, 400],
      query: { minCoverage: 0.8 },
      region: { coverage: [1, 1, 1, 0.1] },
    } as never;
    const shown = shownValues(region);
    expect(shown).toEqual([1, 2, 3, NaN]);
    const pair = pairSeries(
      { dates: days(4), values: [1, 2, 3, 4] },
      { dates: days(4), values: shown }
    );
    expect(pair.keys).toHaveLength(3);
    const stats = taylorStats(pair.reference, pair.other)!;
    expect(stats.bias).toBe(0);
    expect(stats.correlation).toBeCloseTo(1, 12);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("v24 review: every Compare view exports its numbers", () => {
  it("v27 review: a large pair table is written in parts, with turns between", async () => {
    const { compareViewCsv, compareViewCsvParts } =
      await import("@/ui/analysis/compare.ts");
    const n = 45_000;
    const values = Array.from({ length: n }, (_, k) => k % 97);
    const pair = pairSeries(
      { dates: days(n), values },
      { dates: days(n), values: values.map((v) => v + 1) }
    );
    const rows = [
      { label: "B1", pair, stats: taylorStats(pair.reference, pair.other)! },
    ];
    let turns = 0;
    const timer = setTimeout;
    const counting = ((fn: () => void, ms?: number) => {
      turns++;
      return timer(fn, ms);
    }) as typeof setTimeout;
    globalThis.setTimeout = counting;
    try {
      const parts = (await compareViewCsvParts("bias", rows, "A1"))!;
      // 45,001 lines: three parts, two turns of the page between them.
      expect(parts).toHaveLength(3);
      expect(turns).toBe(2);
      expect(parts.join("")).toBe(compareViewCsv("bias", rows, "A1"));
      const stop = new AbortController();
      stop.abort();
      expect(
        await compareViewCsvParts("bias", rows, "A1", stop.signal)
      ).toBeUndefined();
    } finally {
      globalThis.setTimeout = timer;
    }
  });

  it("names the values' units, and the units a converted plot came in", async () => {
    const { compareViewCsv } = await import("@/ui/analysis/compare.ts");
    const pair = pairSeries(
      { dates: days(4), values: [1, 2, 3, 4] },
      { dates: days(4), values: [2, 2, 4, 4] }
    );
    const rows = [
      { label: "B1", pair, stats: taylorStats(pair.reference, pair.other)! },
    ];
    const kelvin = compareViewCsv("bias", [{ ...rows[0], from: "degC" }], {
      label: "A1",
      units: "K",
    }).split("\n");
    expect(kelvin[0]).toBe(
      "plot,reference_plot,time,matched_by,reference (K),plot_value (K),difference (K),plot_converted_from"
    );
    expect(kelvin[1]).toBe("B1,A1,2020-01-01 00:00:00,time,1,2,1,degC");
    expect(
      compareViewCsv("qq", rows, { label: "A1", units: "K" }).split("\n")[0]
    ).toBe("plot,reference_plot,percentile,reference (K),plot_value (K)");
  });

  it("writes pairs, percentiles and scores; missing numbers are empty", async () => {
    const { compareViewCsv, csvCell } =
      await import("@/ui/analysis/compare.ts");
    const pair = pairSeries(
      { dates: days(4), values: [1, 2, 3, 4] },
      { dates: days(4), values: [2, 2, 4, 4] }
    );
    const stats = taylorStats(pair.reference, pair.other)!;
    const rows = [{ label: "B1", pair, stats }];
    const bias = compareViewCsv("bias", rows, "A1").split("\n");
    expect(bias[0]).toBe(
      "plot,reference_plot,time,matched_by,reference,plot_value,difference"
    );
    expect(bias[1]).toBe("B1,A1,2020-01-01 00:00:00,time,1,2,1");
    expect(compareViewCsv("qq", rows, "A1").split("\n")).toHaveLength(100);
    const scores = compareViewCsv("parallel", rows, "A1").split("\n");
    expect(scores[0]).toMatch(/^plot,reference_plot,Correlation,/);
    // A constant reference: no correlation, written as an empty cell.
    const flat = pairSeries(
      { dates: days(3), values: [1, 1, 1] },
      { dates: days(3), values: [1, 2, 3] }
    );
    const none = compareViewCsv(
      "parallel",
      [
        {
          label: "C1",
          pair: flat,
          stats: taylorStats(flat.reference, flat.other)!,
        },
      ],
      "A1"
    );
    expect(none).not.toMatch(/NaN|Infinity|undefined/);
    expect([NaN, Infinity, undefined, null, 2, "a,b"].map(csvCell)).toEqual([
      "",
      "",
      "",
      "",
      "2",
      '"a,b"',
    ]);
  });
});

describe("review of interim10: a 360-day calendar in Compare", () => {
  it("orders Feb 30 before Mar 1 and gives each its own place", async () => {
    const { keyDays } = await import("@/ui/analysis/compare.ts");
    const dates = ["2001-03-01", "2001-02-30", "2001-03-02"];
    const pair = pairSeries(
      { dates, values: [2, 1, 3], calendar: "360_day" },
      { dates, values: [2, 1, 3], calendar: "360_day" }
    );
    expect(pair.keys).toEqual(["2001-02-30", "2001-03-01", "2001-03-02"]);
    const at = pair.keys.map((k) => keyDays(k, "360_day"));
    expect([at[1] - at[0], at[2] - at[1]]).toEqual([1, 1]);
  });
});

it("review of interim30 N8: readings microseconds apart keep their own keys and places", async () => {
  const { keyDays } = await import("@/ui/analysis/compare.ts");
  const series = (values: number[]) => ({
    dates: [10, 20, 30].map(() => "2001-01-01 00:00:00.000"),
    values,
    calendar: "standard",
    time: {
      raw: [10, 20, 30],
      units: "microseconds since 2001-01-01",
      calendar: "standard",
      cellMethods: "time: point",
    },
  });
  const pair = pairSeries(series([1, 2, 3]), series([1.5, 2.5, 3.5]));
  expect(pair.keys).toEqual([
    "2001-01-01 00:00:00.000010",
    "2001-01-01 00:00:00.000020",
    "2001-01-01 00:00:00.000030",
  ]);
  const xs = pair.keys.map((key) => keyDays(key));
  expect(new Set(xs).size).toBe(3);
  // Days since 1970 hold about 0.2 µs: apart, in order.
  expect((xs[1] - xs[0]) * 86_400e6).toBeCloseTo(10, 0);
});

it("review of interim30: rows of unknown support pair with nothing in Compare", () => {
  const raw = [0.5, 1.5, 2.5, 3.5];
  const s = (values: number[]) => ({
    dates: ["2001-01-01", "2001-01-02", "2001-01-03", "2001-01-04"],
    values,
    calendar: "standard",
    time: {
      raw,
      units: "days since 2001-01-01",
      calendar: "standard",
      cellMethods: "time: mean",
      bounds: [0, 1, 1, 2, Number.NaN, Number.NaN, 3, 4],
    },
  });
  const pair = pairSeries(s([1, 2, 3, 4]), s([1, 2, 3, 4]));
  expect(pair.reference).toEqual([1, 2, 4]);
});

it("interim49: says why a forecast has no valid times without building them", async () => {
  const { validTimeProblem } = await import("@/ui/analysis/compare.ts");
  const raw = new Proxy([] as number[], {
    get(target, key, receiver) {
      if (key !== "length" && typeof key === "string" && /^\d+$/.test(key)) {
        throw new Error("read a date");
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const time = {
    standardName: "forecast_reference_time",
    units: "hours since 2000-01-01",
    raw,
  };
  expect(validTimeProblem(time, [])).toMatch(/no known lead/);
  expect(
    validTimeProblem(time, [
      { standardName: "forecast_period", value: 48, units: "hours" },
    ] as never)
  ).toBeUndefined();
});
