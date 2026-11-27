import { expect, it } from "vitest";

import { maximaYears, reshapedSpec } from "@/ui/analysis/seriesViews.ts";
import { TIME_VIEWS } from "@/ui/analysis/timeViews.ts";

const epoch = Date.UTC(2001, 0, 1);
const DAY = 86_400_000;
const day = (y: number, m = 0, d = 1) => (Date.UTC(y, m, d) - epoch) / DAY;
const label = (x: number) =>
  new Date(epoch + x * DAY).toISOString().slice(0, 10);

/** Daily cells over `years`, with `extra` rows ([start, end, value]) added. */
function daily(
  years: number[],
  value: (y: number, d: number) => number,
  extra: [number, number, number][] = []
) {
  const cells: [number, number, number][] = [];
  for (const y of years) {
    for (let d = day(y); d < day(y + 1); d++) {
      cells.push([d, d + 1, value(y, d - day(y))]);
    }
  }
  cells.push(...extra);
  cells.sort(
    (a, b) =>
      (Number.isFinite(a[0]) ? a[0] : a[2]) -
      (Number.isFinite(b[0]) ? b[0] : b[2])
  );
  return cells;
}

function context(
  cells: [number, number, number][],
  method: string,
  stamps?: number[]
) {
  const raw = stamps ?? cells.map(([a, b]) => (a + b) / 2);
  return {
    dates: raw.map(label),
    raw,
    bounds: cells.flatMap(([a, b]) => [a, b]),
    values: cells.map((c) => c[2]),
    timeUnits: "days since 2001-01-01",
    calendar: "standard",
    cellMethods: `time: ${method}`,
    units: "mm",
    window: 3,
    threshold: 0,
  };
}

const chart = (ctx: ReturnType<typeof context>) =>
  reshapedSpec(
    TIME_VIEWS.RETURN,
    {
      mode: "time",
      x: ctx.raw,
      y: ctx.values,
      xTitle: "Date",
      xLabel: String,
      yTitle: "Rain",
      readout: () => [],
    },
    ctx as never
  )!;

it("review of interim45: a one-minute mean is not a daily mean in a daily fit", () => {
  const years = [2001, 2002, 2003, 2004, 2005, 2006];
  const base = daily(years, (y, d) => (d === 100 ? y - 1999 : 1));
  const plain = chart(context(base, "mean"));
  // A one-minute mean of 1,000 inside a day whose mean is 4.
  const t = day(2003, 3, 11) + 0.5;
  const withMinute = daily(years, (y, d) => (d === 100 ? y - 1999 : 1), [
    [t, t + 1 / 1440, 1000],
  ]);
  const mixed = chart(context(withMinute, "mean"));
  expect(mixed.points?.y).toEqual(plain.points?.y);
  expect(mixed.y).toEqual(plain.y);
  expect(Math.max(...(mixed.points?.y ?? [0]))).toBeLessThan(10);
  // And a zero-length row likewise.
  const zero = chart(
    context(
      daily(years, (y, d) => (d === 100 ? y - 1999 : 1), [[t, t, 1000]]),
      "mean"
    )
  );
  expect(zero.y).toEqual(plain.y);
});

it("independent review of interim45: an extreme of unknown support is not fitted, and its year is said withheld", () => {
  const years = [2001, 2002, 2003, 2004, 2005, 2006];
  const cells = daily(years, (y, d) => (d === 100 ? 10 * (y - 2000) : 1));
  const stamps = cells.map(([a, b]) => (a + b) / 2);
  // A 999 mm row in 2003, its bounds missing.
  const at = day(2003, 5, 1) + 0.25;
  cells.push([Number.NaN, Number.NaN, 999]);
  stamps.push(at);
  const order = stamps.map((_, k) => k).sort((a, b) => stamps[a] - stamps[b]);
  const ctx = context(
    order.map((k) => cells[k]),
    "maximum",
    order.map((k) => stamps[k])
  );
  const fit = chart(ctx);
  expect(fit.points?.y).not.toContain(999);
  // 2003 may hold it: withheld, and said.
  expect([...maximaYears(ctx as never).years].sort()).toEqual([
    "2001",
    "2002",
    "2004",
    "2005",
    "2006",
  ]);
  expect(fit.readout(0).join(" ")).toMatch(
    /2003 withheld: a value of unknown time support/
  );
});

it("independent review of interim45: a distant two-year maximum leaves the earlier years fitted", () => {
  const years = [2001, 2002, 2003, 2004, 2005, 2006];
  const cells = daily(years, (y, d) => (d === 100 ? 10 * (y - 2000) : 1), [
    [day(2008), day(2010), 3],
  ]);
  expect(
    [...maximaYears(context(cells, "maximum") as never).years].sort()
  ).toEqual(years.map(String));
  // A two-year maximum over 2005–06 larger than theirs withholds those two.
  const over = daily(years, (y, d) => (d === 100 ? 10 * (y - 2000) : 1), [
    [day(2005), day(2007), 500],
  ]);
  expect(
    [...maximaYears(context(over, "maximum") as never).years].sort()
  ).toEqual(["2001", "2002", "2003", "2004"]);
});

it("independent review of interim45: a 500,000-year cell is checked against the candidate years only", () => {
  // Three rows: two 360-day years and one cell over 500,000 years.
  const ctx = {
    dates: ["0001-06-15", "0002-06-15", "0003-06-15"],
    raw: [165, 525, 885],
    bounds: [0, 360, 360, 720, 0, 360 * 500_000],
    values: [1, 2, 3],
    timeUnits: "days since 0001-01-01",
    calendar: "360_day",
    cellMethods: "time: maximum",
    units: "mm",
    window: 3,
    threshold: 0,
  };
  const began = performance.now();
  maximaYears(ctx as never);
  expect(performance.now() - began).toBeLessThan(100);
});

it("independent review of interim45: a mean over 23 h 59 min 59 s fills no hour of a diurnal cycle", async () => {
  const { diurnalCycle } = await import("@/ui/analysis/timeViews.ts");
  const { periodDates } = await import("@/ui/analysis/seriesViews.ts");
  const { timeLabels } = await import("@/lib/analysis/calendar.ts");
  const units = "seconds since 2001-01-01";
  // Four days: a mean of 10 over all but the last second, then 0 over it.
  const rows: [number, number, number][] = [];
  for (let d = 0; d < 4; d++) {
    rows.push(
      [d * 86400, d * 86400 + 86399, 10],
      [d * 86400 + 86399, (d + 1) * 86400, 0]
    );
  }
  const raw = rows.map(([a, b]) => (a + b) / 2);
  const ctx = {
    raw,
    dates: timeLabels({ raw, calendar: "standard", units }),
    values: rows.map((r) => r[2]),
    calendar: "standard",
    timeUnits: units,
    cellMethods: "time: mean",
    bounds: rows.flatMap((r) => [r[0], r[1]]),
  };
  const cycle = diurnalCycle(periodDates(ctx as never), ctx.values);
  // No hour from the long means; hour 23 from the last seconds alone.
  expect(cycle.mean.slice(0, 23).every(Number.isNaN)).toBe(true);
  expect(cycle.mean[23]).toBe(0);
  expect(cycle.leftOut).toBe(4);
});

it("independent review of interim45: a month's climatology weighs known lengths and leaves the unknown out, as the ensemble does", async () => {
  const { annualCycle } = await import("@/ui/analysis/timeViews.ts");
  const { periodDates } = await import("@/ui/analysis/seriesViews.ts");
  const { timeLabels } = await import("@/lib/analysis/calendar.ts");
  const { meanDurations, memberStats } =
    await import("@/ui/analysis/members.ts");
  const units = "days since 2001-01-01";
  // January means 0, 20 and 100 over 1 day, 9 days and an unknown length.
  const bounds = [0, 1, 1, 10, Number.NaN, Number.NaN];
  const raw = [0.5, 5.5, 20];
  const values = [0, 20, 100];
  const ctx = {
    raw,
    dates: timeLabels({ raw, calendar: "standard", units }),
    values,
    calendar: "standard",
    timeUnits: units,
    cellMethods: "time: mean",
    bounds,
  };
  const cycle = annualCycle(periodDates(ctx as never), values);
  expect(cycle.mean[0]).toBe(18);
  expect(cycle.unknownLeft).toBe(1);
  const durations = meanDurations({
    cellMethods: "time: mean",
    time: { dimension: "time", raw, bounds },
  });
  expect(memberStats([values], 3, durations).means).toEqual([18]);
  // Every length unknown: a sample mean, and called one.
  const none = meanDurations({
    cellMethods: "time: mean",
    time: {
      dimension: "time",
      raw: [1, 2],
      bounds: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
    },
  });
  const sample = memberStats([[100, 200]], 2, none);
  expect(sample.means).toEqual([150]);
  expect(sample.sample).toBe(true);
});

it("reviews of interim45: a member's fill row overlaps nothing", async () => {
  const { meanDurations, memberStats } =
    await import("@/ui/analysis/members.ts");
  // [0, 10] with 10, and [9.5, 11] with no member's value.
  const durations = meanDurations({
    cellMethods: "time: mean",
    time: { dimension: "time", raw: [5, 10.25], bounds: [0, 10, 9.5, 11] },
  });
  const stats = memberStats([[10, Number.NaN]], 2, durations);
  expect(stats.withheld).toBe(false);
  expect(stats.means).toEqual([10]);
  // Both observed: they overlap, no one period mean.
  expect(memberStats([[10, 20]], 2, durations).withheld).toBe(true);
});
