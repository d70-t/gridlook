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

it("builds no range tables for a series without residual groups", () => {
  const n = 131_072;
  const raw = Array.from({ length: n }, (_, i) => i + 0.5);
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
    const out = runningMeanOverCells(
      raw.map(() => 285),
      raw,
      raw.flatMap((t) => [t - 0.5, t + 0.5]),
      7
    );
    expect(out?.[n / 2]).toBe(285);
  } finally {
    globalThis.Float64Array = F;
  }
  expect(bytes).toBeLessThan(8 * 2 ** 20);
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
