import { expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import { reshapedSpec } from "@/ui/analysis/seriesViews.ts";
import { runningMeanOverCells, TIME_VIEWS } from "@/ui/analysis/timeViews.ts";

type TCell = [number, number, number];

function running(cells: TCell[], window: number) {
  const raw = cells.map(([lo, hi]) => (lo + hi) / 2);
  const units = "days since 2004-01-01";
  const ctx = {
    raw,
    dates: timeLabels({ raw, units, calendar: "noleap" }),
    bounds: cells.flatMap((x) => x.slice(0, 2)),
    calendar: "noleap",
    timeUnits: units,
    units: "K",
    cellMethods: "time: mean",
    threshold: 290,
    window,
  };
  const base = {
    mode: "time",
    x: raw,
    y: cells.map((x) => x[2]),
    xTitle: "time",
    yTitle: "temperature",
    xLabel: String,
    readout: () => [],
  };
  return reshapedSpec(TIME_VIEWS.RUNNING, base as never, ctx as never)!.overlay!
    .values;
}

it("withholds each day of a residual that only its whole determines", () => {
  // A three-day mean of 290 K over days 2–4, one of them measured at 280 K:
  // the other two days' mean is 295 K, neither day's own value.
  for (const measured of [0, 1, 2]) {
    const daily: TCell[] = Array.from({ length: 7 }, (_, i) => [
      i,
      i + 1,
      i < 2 || i > 4 ? 290 : i === measured + 2 ? 280 : NaN,
    ]);
    const cells: TCell[] = [...daily, [2, 5, 290]];
    const days = running(cells, 1).slice(2, 5);
    expect(days).toEqual([0, 1, 2].map((d) => (d === measured ? 280 : NaN)));
    // The three days together are known.
    expect(running(cells, 3)[3]).toBeCloseTo(290);
  }
  // None of them measured: only their three-day mean is known.
  const coarse: TCell[] = [
    ...Array.from({ length: 7 }, (_, i): TCell => [
      i,
      i + 1,
      i < 2 || i > 4 ? 290 : NaN,
    ]),
    [2, 5, 290],
  ];
  expect(running(coarse, 1).slice(2, 5)).toEqual([NaN, NaN, NaN]);
  expect(running(coarse, 3)[3]).toBeCloseTo(290);
});

it.each([false, true])(
  "keeps range tables to the grouped cells; one coarse mean=%s",
  (coarse) => {
    const n = 131_072;
    const raw = Array.from({ length: n }, (_, i) => i + 0.5);
    const values = raw.map(() => 285);
    const bounds = raw.flatMap((t) => [t - 0.5, t + 0.5]);
    if (coarse) {
      // Three central hours missing, their three-hour mean given.
      values.fill(Number.NaN, n / 2 - 1, n / 2 + 2);
      raw.push(n / 2 + 0.5);
      values.push(285);
      bounds.push(n / 2 - 1, n / 2 + 2);
    }
    const F = Float64Array;
    let bytes = 0;
    try {
      globalThis.Float64Array = new Proxy(F, {
        construct(t, args, target) {
          const made = Reflect.construct(t, args, target) as Float64Array;
          bytes += made.byteLength;
          return made;
        },
      }) as typeof Float64Array;
      const out = runningMeanOverCells(values, raw, bounds, 7);
      expect(out?.[n / 4]).toBe(285);
      expect(out?.[n / 2]).toBe(285);
    } finally {
      globalThis.Float64Array = F;
    }
    expect(bytes).toBeLessThan(8 * 2 ** 20);
  }
);

it("keeps adjacent coarse means whole over missing days", () => {
  // Nine missing days and three three-day means over them.
  for (const measured of [0, 1, 2, 3]) {
    const cells: TCell[] = [
      ...Array.from({ length: 9 }, (_, i): TCell => [
        i,
        i + 1,
        i < measured ? 270 + 10 * i : NaN,
      ]),
      [0, 3, 280],
      [3, 6, 290],
      [6, 9, 300],
    ];
    const daily = running(cells, 1).slice(0, 9);
    // Only measured days are known one by one, and a single day the first
    // block's mean leaves (three times 280 K less the other two).
    const known = (i: number) =>
      i < measured ? 270 + 10 * i : measured === 2 && i === 2 ? 290 : NaN;
    daily.forEach((v, i) =>
      expect(v, `${measured}: day ${i}`).toEqual(known(i))
    );
    // Each block's three days together are.
    for (const [day, mean] of [
      [1, 280],
      [4, 290],
      [7, 300],
    ]) {
      expect(running(cells, 3)[day], `${measured}: block ${day}`).toBeCloseTo(
        mean
      );
    }
  }
});

it("checks grouped residuals in a wide window without scanning them", () => {
  // Per three-day group, its middle day and its mean: two residual days.
  const probe = (grouped: boolean) => {
    const [bounds, raw, values]: number[][] = [[], [], []];
    for (let i = 0; i < 2048; i++) {
      bounds.push(3 * i, 3 * i + 3, 3 * i + 1, 3 * i + 2);
      raw.push(3 * i + 1.5, 3 * i + 1.5);
      values.push(290, grouped ? 280 : NaN);
    }
    const started = performance.now();
    const out = runningMeanOverCells(values, raw, bounds, 3072);
    return { mid: out?.[2048], ms: performance.now() - started };
  };
  probe(true);
  const grouped = probe(true);
  expect(grouped.mid).toBeCloseTo(290);
  expect(grouped.ms).toBeLessThan(100);
});
