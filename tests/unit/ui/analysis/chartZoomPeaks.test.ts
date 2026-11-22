import { expect, it } from "vitest";

import { quantityProblem } from "@/ui/analysis/compare.ts";
import { orderedPoints, seriesDateLayout } from "@/ui/analysis/seriesDates.ts";

it("retains resolved peaks inside a zoom between two much larger sampling gaps", () => {
  const times = Array.from({ length: 4800 }, (_, row) => row);
  const signals = times.map((row) => (row % 60 < 30 ? 0 : 10));
  // Every cycle occupies ten pixels. Bracketing the burst with two isolated
  // observations must not collapse its 80 peaks into one display bucket.
  const horizon = 90 * 86400;
  const xs = [-horizon, ...times, horizon];
  const ys = [0, ...signals, 0];
  const region = { min: 0, max: 4799 };
  const changes = (pts: ReturnType<typeof orderedPoints>) => {
    const shown = pts.filter((p) => p.x >= 0 && p.x <= region.max);
    return shown.slice(1).filter((point, i) => point.y !== shown[i].y).length;
  };
  const bare = orderedPoints(times, signals, 800, times.length, region);
  expect(changes(bare)).toBe(159);
  const withGaps = orderedPoints(xs, ys, 800, xs.length, region);
  expect(changes(withGaps)).toBe(159);
});

it("does not fetch values from the entire descending series for each narrow zoom", () => {
  const n = 200000;
  const dates = Array.from({ length: n }, (_, i) => n - i - 1);
  const stored = dates.map((date) => date % 12);
  let reads = 0;
  const values = new Proxy(stored, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  seriesDateLayout(dates);
  const reduced = orderedPoints(dates, values, 800, n, { min: 100, max: 120 });
  expect(reduced).toHaveLength(23);
  expect(reduced.find((p) => p.x === 110)?.y).toBe(2);
  // A generous allowance for the two neighbours and a binary search.
  expect(reads).toBeLessThan(1000);
});

const side = (cellMethods: string) => ({
  variable: "tasmax",
  standardName: "air_temperature",
  units: "K",
  cellMethods,
});

it("checks maxima sampling intervals when an independent spatial mean precedes only one time step", () => {
  const hourly = side("time: maximum (interval: 1 hour)");
  const daily = side("area: mean time: maximum (interval: 1 day)");
  expect(
    quantityProblem(hourly, side("time: maximum (interval: 1 day)"))
  ).toBeTruthy();
  expect(quantityProblem(hourly, daily)).toBeTruthy();
});

it("accepts equivalent sampling intervals expressed as hours and minutes", () => {
  expect(
    quantityProblem(
      side("time: maximum (interval: 1 hour)"),
      side("time: maximum (interval: 60 minutes)")
    )
  ).toBeUndefined();
});
it("independent review of interim45: a mean restricted to land is not a mean over all", () => {
  expect(
    quantityProblem(
      side("area: mean where land time: mean"),
      side("time: mean")
    )
  ).toMatch(/restriction/);
});
it("review of interim45: two unknown-scale temperatures in K and kelvin are compared", () => {
  const unknown = (units: string) => ({
    ...side(""),
    units,
    unitsMetadata: "temperature: unknown",
  });
  expect(quantityProblem(unknown("K"), unknown("kelvin"))).toBeUndefined();
  expect(quantityProblem(unknown("K"), unknown("degC"))).toMatch(
    /unknown scale/
  );
});

it("interim48: a repeated step is matched by occurrence, in either order", () => {
  const a = side(
    "time: mean within days (interval: 1 hour) time: mean over days (interval: 1 day)"
  );
  const b = side(
    "time: mean within days (interval: 60 minutes) time: mean over days (interval: 24 hours)"
  );
  expect(quantityProblem(a, b)).toBeUndefined();
  expect(quantityProblem(b, a)).toBeUndefined();
  // Without a first interval, the second stages still differ.
  const daily = side(
    "time: mean within days time: mean over days (interval: 1 day)"
  );
  const twoDaily = side(
    "time: mean within days time: mean over days (interval: 2 days)"
  );
  expect(quantityProblem(daily, twoDaily)).toBeTruthy();
  expect(quantityProblem(twoDaily, daily)).toBeTruthy();
});
