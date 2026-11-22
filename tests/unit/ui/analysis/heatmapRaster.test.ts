/* eslint-disable max-lines-per-function -- one describe block of raster checks. */
import { describe, expect, it } from "vitest";

import {
  axisCells,
  extent,
  meanOf,
  moreExtreme,
  mostExtreme,
  niceTicks,
  PIXEL,
  rasterize,
  timeCells,
} from "@/ui/analysis/heatmapRaster.ts";

/** Time on x over `pixels` pixels spanning the cells' extent. */
function layout(
  raw: number[],
  cols: number[],
  values: number[],
  pixels: number,
  unreadFrom?: number
) {
  const rows = timeCells(raw);
  const columns = axisCells(cols);
  const lo = Math.min(...rows.lo);
  const hi = Math.max(...rows.hi);
  return {
    rows,
    raster: rasterize({
      values,
      rows,
      columns,
      unreadFrom,
      timePixels: pixels,
      axisPixels: cols.length,
      timeToPixel: (t) => ((t - lo) / (hi - lo)) * pixels,
      axisToPixel: (v) => v - Math.min(...columns.lo),
    }),
    pixelOf: (t: number) => Math.floor(((t - lo) / (hi - lo)) * pixels),
  };
}

describe("heatmap pixels", () => {
  it("skips a missing date during pixel reduction and keeps neighbouring values", () => {
    const rows = timeCells([0, NaN, 2]);
    expect(extent(rows)).toEqual({ low: -0.5, high: 2.5 });
    const raster = rasterize({
      values: [12, 300, 42],
      rows,
      columns: axisCells([0]),
      timePixels: 2,
      axisPixels: 1,
      timeToPixel: (t) => ((t + 0.5) * 2) / 3,
      axisToPixel: (v) => v + 0.5,
    });
    expect([raster.value(0, 0), raster.value(1, 0)]).toEqual([12, 42]);
  });

  it("shows a long gap between instantaneous samples as unsampled time", () => {
    // Jan 1–2 and Feb 15–16 (days since Jan 1).
    const { rows, raster, pixelOf } = layout(
      [0, 1, 45, 46],
      [0],
      [1, 2, 3, 4],
      470
    );
    expect(rows.gaps).toBe(true);
    expect(raster.state(pixelOf(20), 0)).toBe(PIXEL.GAP);
    expect(raster.state(pixelOf(0), 0)).toBe(PIXEL.VALUE);
    expect(raster.value(pixelOf(45.2), 0)).toBe(3);
  });

  it("keeps a one-step extreme when many steps share a pixel", () => {
    const n = 18_200;
    const values = Array.from({ length: n }, (_, t) =>
      t === 9_001 ? 40 : 10 + Math.sin(t / 50)
    );
    const raw = Array.from({ length: n }, (_, t) => t);
    const { raster, pixelOf } = layout(raw, [0], values, 200);
    expect(raster.reducedRows).toBeGreaterThan(50);
    expect(raster.value(pixelOf(9_001), 0)).toBe(40);
  });

  it("keeps an extreme when irregular times share a pixel (fewer cells than pixels)", () => {
    const { raster, pixelOf } = layout(
      [0, 1, 2, 1000],
      [0],
      [99, 0, 0, 0],
      100
    );
    expect(raster.value(pixelOf(0), 0)).toBe(99);
    expect(raster.reducedRows).toBeGreaterThanOrEqual(3);
  });

  it("shades by the rows read, also when dates descend", () => {
    // Dates [3, 2, 1, 0]: the first two rows (3 and 2) were read.
    const { raster, pixelOf } = layout(
      [3, 2, 1, 0],
      [0],
      [30, 20, 10, 0],
      400,
      2
    );
    expect(raster.state(pixelOf(3.2), 0)).toBe(PIXEL.VALUE);
    expect(raster.state(pixelOf(2.2), 0)).toBe(PIXEL.VALUE);
    expect(raster.state(pixelOf(1.2), 0)).toBe(PIXEL.UNREAD);
    expect(raster.state(pixelOf(0.2), 0)).toBe(PIXEL.UNREAD);
  });

  it("bounds the work by cells plus pixels", () => {
    const rows = timeCells(Array.from({ length: 20 }, (_, t) => t));
    const columns = axisCells(Array.from({ length: 20_000 }, (_, c) => c));
    const values = Array.from({ length: 20 * 20_000 }, (_, at) => at % 7);
    const started = performance.now();
    const raster = rasterize({
      values,
      rows,
      columns,
      timePixels: 400,
      axisPixels: 240,
      timeToPixel: (t) => ((t + 0.5) / 20) * 400,
      axisToPixel: (c) => ((c + 0.5) / 20_000) * 240,
    });
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 400; x++) {
        raster.value(x, y);
      }
    }
    expect(raster.reducedColumns).toBeGreaterThan(50);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("axis ticks terminate on near-equal ends (v7 review P0)", () => {
  it("gives bounded, strictly increasing ticks", () => {
    for (const [low, high] of [
      [45, 45 + 2 ** -47],
      [2 ** 52 + 2, 2 ** 52 + 4],
      [0, Number.MIN_VALUE],
      [-Number.MAX_VALUE, Number.MAX_VALUE],
      [1, 1],
    ]) {
      const started = performance.now();
      const ticks = niceTicks(low, high, 4);
      expect(performance.now() - started).toBeLessThan(50);
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks.length).toBeLessThanOrEqual(7);
      for (let at = 1; at < ticks.length; at++) {
        expect(ticks[at]).toBeGreaterThan(ticks[at - 1]);
      }
    }
  });
});

describe("raster memory follows cells and pixels (v8 review)", () => {
  it("3 dates × 20,000 samples on a 940 × 1,632 canvas", () => {
    const rows = timeCells([0, 1, 2]);
    const columns = axisCells(Array.from({ length: 20_000 }, (_, c) => c));
    const values = Array.from({ length: 3 * 20_000 }, (_, at) => at % 11);
    values[1 * 20_000 + 7_777] = 500;
    const raster = rasterize({
      values,
      rows,
      columns,
      timePixels: 940,
      axisPixels: 1632,
      // A fractional boundary between dates puts two in one pixel.
      timeToPixel: (t) => ((t + 0.5) / 3) * 940,
      axisToPixel: (c) => ((c + 0.5) / 20_000) * 1632,
    });
    // Never pixels × columns (940 × 20,000): bounded by about twice the
    // source plus the image.
    // (about 108,000 here, against 18.8 million before).
    expect(raster.intermediateValues).toBeLessThan(200_000);
    // The one-sample peak survives both reductions.
    const peakColumn = Math.floor(((7_777 + 0.5) / 20_000) * 1632);
    const peakRow = Math.floor((1.5 / 3) * 940);
    expect(raster.value(peakRow, peakColumn)).toBe(500);
  });
});

describe("curtain pixel columns keep extremes (v9 review)", () => {
  it("a narrow peak keeps one pixel; the wide cell beside it paints its own width", async () => {
    const { columnMembers } = await import("@/ui/analysis/heatmapRaster.ts");
    // Positions [0, 0.01, 0.02, 1000] m: edges at midpoints, ends clamped.
    const edges = [0, 0.005, 0.015, 500.01, 1000];
    const W = 740;
    const columns = columnMembers(edges, (d) => (d / 1000) * W, W);
    const at = (x: number) =>
      Array.from(
        columns.items.subarray(columns.start[x], columns.start[x + 1])
      );
    // Column 0 holds the three near samples, peak included.
    expect(at(0)).toEqual([0, 1, 2]);
    // Every other column up to 500 m holds only the wide third sample.
    for (let x = 1; x < 369; x++) {
      expect(at(x)).toEqual([2]);
    }
    expect(at(W - 1)).toEqual([3]);
    const values = [1, 99, 0, 0];
    const peakColumns = Array.from({ length: W }, (_, x) =>
      at(x).some((s) => values[s] === 99)
    ).filter(Boolean).length;
    expect(peakColumns).toBe(1);
  });
});

describe("overlapping time intervals (v9 review)", () => {
  it("5,000 coinciding intervals over 940 pixels are one group, not 4.7 million entries", () => {
    const n = 5000;
    const raw = Array.from({ length: n }, (_, t) => t);
    const bounds = raw.flatMap(() => [0, n]);
    const rows = timeCells(raw, bounds);
    const columns = axisCells([0]);
    const values = raw.map((t) => (t === 4321 ? 1e6 : t % 3));
    const raster = rasterize({
      values,
      rows,
      columns,
      timePixels: 940,
      axisPixels: 10,
      timeToPixel: (t) => (t / n) * 940,
      axisToPixel: (c) => ((c + 0.5) / 1) * 10,
    });
    expect(raster.lookupEntries).toBeLessThanOrEqual(n + 10);
    expect(raster.value(400, 5)).toBe(1e6);
  });

  it("places samples stored out of date order on their own dates, also while reading", () => {
    // Days 0, 3, 1, 2 in storage order; each value names its day.
    const raw = [0, 3, 1, 2];
    const rows = timeCells(raw);
    expect(Array.from(rows.lo)).toEqual([-0.5, 2.5, 0.5, 1.5]);
    expect(Array.from(rows.hi)).toEqual([0.5, 3.5, 1.5, 2.5]);
    expect(extent(rows)).toEqual({ low: -0.5, high: 3.5 });
    const full = layout(raw, [0], [100, 103, 101, 102], 4);
    expect(
      [0, 1, 2, 3].map((d) => full.raster.value(full.pixelOf(d), 0))
    ).toEqual([100, 101, 102, 103]);
    // Only the first two stored rows (days 0 and 3) are read so far.
    const partial = layout(raw, [0], [100, 103, NaN, NaN], 4, 2);
    expect(partial.raster.value(partial.pixelOf(3), 0)).toBe(103);
    expect(partial.raster.value(partial.pixelOf(0), 0)).toBe(100);
    expect(partial.raster.state(partial.pixelOf(2), 0)).toBe(PIXEL.UNREAD);
  });

  it("draws overlapping (cumulative) time bounds at their times with bounded work", () => {
    // 6,000 accumulations since day 0, each labelled at its end, day i + 1.
    const n = 6000;
    const raw = Array.from({ length: n }, (_, i) => i + 1);
    const bounds = raw.flatMap((t) => [0, t]);
    const rows = timeCells(raw, bounds);
    expect(rows.overlapping).toBe(true);
    const lo = Math.min(...rows.lo);
    const hi = Math.max(...rows.hi);
    const raster = rasterize({
      values: raw.map((t) => t * 10),
      rows,
      columns: axisCells([0]),
      timePixels: 800,
      axisPixels: 1,
      timeToPixel: (t) => ((t - lo) / (hi - lo)) * 800,
      axisToPixel: (v) => v + 0.5,
    });
    expect(raster.lookupEntries).toBeLessThan(4 * (n + 800));
    // The last pixel holds the last steps, not the extreme of all of them.
    expect(raster.value(799, 0)).toBeGreaterThan(59000);
    expect(raster.value(0, 0)).toBeLessThan(1000);
    // Adjacent declared bounds are used as declared.
    expect(timeCells([1, 2], [0, 1, 1, 2]).overlapping).toBeUndefined();
  });

  it("keeps a thin peak among zeros in one curtain pixel (farthest from the mean)", () => {
    // Values [0, 0, 99, 0, 0] as palette codes; their mean is code 51.
    const codes = [0, 0, 255, 0, 0];
    const centre = codes.reduce((a, b) => a + b, 0) / codes.length;
    let held = -3;
    for (const code of codes) {
      held = moreExtreme(code, held, centre) ? code : held;
    }
    expect(held).toBe(255);
    // An exact tie goes to the larger value, whatever the order.
    expect(moreExtreme(200, 56, 128)).toBe(true);
    expect(moreExtreme(56, 200, 128)).toBe(false);
  });
});

it("finds the cell a pixel is painted with across both axes (review of interim33)", async () => {
  const { coveringCells, mostExtreme } =
    await import("@/ui/analysis/heatmapRaster.ts");
  // 1,601 distances (0–1,600 km) on 656 pixels; two dates on 350.
  const n = 1601;
  const lo = Float64Array.from({ length: n }, (_, k) => k - 0.5);
  const hi = Float64Array.from({ length: n }, (_, k) => k + 0.5);
  const toPixel = (km: number) => ((km + 0.5) / n) * 656;
  const values = new Float64Array(2 * n);
  values[800] = 100;
  values[n + 800] = 100;
  // The pixel of 798 km also holds 800 km: it is painted 100, from there.
  const pixel = Math.floor(toPixel(798));
  const places = coveringCells({ lo, hi }, toPixel, pixel);
  expect(places).toContain(800);
  const painted = mostExtreme(values, n, [0], places, 100 / n);
  expect(painted).toMatchObject({ column: 800, value: 100 });
  // A pixel of one cell names none.
  expect(mostExtreme(values, n, [0], [5], 0)).toBeUndefined();
});

it("paints and reads out the same cell when two are equally extreme (review of interim37)", () => {
  // [[50, 0], [100, 50]] K reduced to one pixel: 0 and 100 tie about 50.
  for (const values of [
    [50, 0, 100, 50],
    [50, 100, 0, 50],
    [5, 0, 10, 5],
  ]) {
    const raster = rasterize({
      values,
      rows: axisCells([0, 1]),
      columns: axisCells([0, 1]),
      timePixels: 1,
      axisPixels: 1,
      timeToPixel: (t) => (t + 0.5) / 2,
      axisToPixel: (v) => (v + 0.5) / 2,
    });
    const hover = mostExtreme(values, 2, [0, 1], [0, 1], meanOf(values));
    expect(raster.value(0, 0)).toBe(Math.max(...values));
    expect(hover?.value).toBe(raster.value(0, 0));
  }
});

it("names the cell each pixel shows, for hovering to read (review of interim37)", () => {
  // 2,000 dates × 2,000 places in one pixel: four million cells.
  const n = 2000;
  const values = new Float64Array(n * n);
  values[1234 * n + 567] = 100;
  values[42 * n + 1999] = -60;
  const raster = rasterize({
    values,
    rows: axisCells(Array.from({ length: n }, (_, i) => i)),
    columns: axisCells(Array.from({ length: n }, (_, j) => j)),
    timePixels: 1,
    axisPixels: 1,
    timeToPixel: (t) => (t + 0.5) / n,
    axisToPixel: (v) => (v + 0.5) / n,
  });
  const started = performance.now();
  let won;
  for (let k = 0; k < 10; k++) {
    won = raster.winner(0, 0);
  }
  // A lookup per pixel, not a scan of every bin: timed only on a quiet
  // benchmark run (GRIDLOOK_TIMING=1), as a busy host does not fail correct
  // code.
  if (process.env.GRIDLOOK_TIMING === "1") {
    expect(performance.now() - started).toBeLessThan(5);
  }
  expect(won).toEqual({ row: 1234, column: 567, rows: n, columns: n });
  expect(values[won!.row * n + won!.column]).toBe(raster.value(0, 0));
  // One cell to a pixel: itself.
  const plain = rasterize({
    values: [5, 0, 10, 5],
    rows: axisCells([0, 1]),
    columns: axisCells([0, 1]),
    timePixels: 2,
    axisPixels: 2,
    timeToPixel: (t) => t + 0.5,
    axisToPixel: (v) => v + 0.5,
  });
  expect(plain.winner(1, 0)).toEqual({
    row: 1,
    column: 0,
    rows: 1,
    columns: 1,
  });
});

it("finds the row under the pointer as a full scan would, by search (review of interim37)", async () => {
  const { rowUnder, timeCells: cellsOf } =
    await import("@/ui/analysis/heatmapRaster.ts");
  void cellsOf;
  // Dates out of order, uneven, some cells overlapping.
  const n = 2000;
  const raw = Array.from({ length: n }, (_, i) => ((i * 7919) % n) * 1.5);
  const lo = Float64Array.from(raw, (v, i) => v - (i % 5 === 0 ? 2 : 0.7));
  const hi = Float64Array.from(raw, (v) => v + 0.7);
  const rows = { lo, hi };
  const scan = (t: number, tol: number, readUntil: number) => {
    let best = -1;
    for (let at = 0; at < readUntil; at++) {
      const inside =
        t >= Math.min(lo[at], hi[at]) - tol &&
        t <= Math.max(lo[at], hi[at]) + tol;
      if (
        inside &&
        (best < 0 || Math.abs(raw[at] - t) < Math.abs(raw[best] - t))
      ) {
        best = at;
      }
    }
    return best;
  };
  for (const readUntil of [n, 1200]) {
    for (let k = 0; k < 400; k++) {
      const t = -3 + k * 7.53;
      expect(rowUnder(raw, rows, readUntil, t, 0.05)).toBe(
        scan(t, 0.05, readUntil)
      );
    }
  }
  // 200,000 dates: a move is a search, not a pass.
  const big = Array.from({ length: 200_000 }, (_, i) => i);
  const bigRows = {
    lo: Float64Array.from(big, (v) => v - 0.5),
    hi: Float64Array.from(big, (v) => v + 0.5),
  };
  rowUnder(big, bigRows, big.length, 10, 0.01);
  const started = performance.now();
  for (let k = 0; k < 1000; k++) {
    rowUnder(big, bigRows, big.length, k * 199.7, 0.01);
  }
  expect(performance.now() - started).toBeLessThan(50);
});

it("review of interim45: one broad interval does not widen every pointer search", async () => {
  const { rowUnder } = await import("@/ui/analysis/heatmapRaster.ts");
  const n = 200_000;
  const raw = Array.from({ length: n }, (_, i) => i);
  const lo = Float64Array.from(raw, (v) => v - 0.5);
  const hi = Float64Array.from(raw, (v) => v + 0.5);
  // One cell over the whole axis, dated at its middle.
  lo[n / 2] = -1;
  hi[n / 2] = n;
  let reads = 0;
  const counted = (array: Float64Array) =>
    new Proxy(array, {
      get: (target, key) => {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads++;
        }
        return Reflect.get(target, key);
      },
    });
  const rows = { lo: counted(lo), hi: counted(hi) };
  rowUnder(raw, rows, n, 10, 0.01);
  reads = 0;
  const found = [10.2, 77_000.1, 199_998.9].map((t) =>
    rowUnder(raw, rows, n, t, 0.01)
  );
  // The narrow cells are the nearer dates; the broad one also holds them.
  expect(found).toEqual([10, 77_000, 199_999]);
  expect(reads).toBeLessThan(1_000);
  // Between narrow cells only the broad one holds the time.
  hi[11] = 11.2;
  lo[12] = 11.8;
  rowUnder(raw, rows, n - 1, 0, 0);
  expect(rowUnder(raw, rows, n - 1, 11.5, 0)).toBe(n / 2);
});

it("review of interim45: a pixel over reduced rows and columns holds their product", async () => {
  const { axisCells, cellsPerPixel, rasterize, timeCells } =
    await import("@/ui/analysis/heatmapRaster.ts");
  // Eight dates and three depths on 4 × 1 pixels: 2 rows and 3 columns a pixel.
  const raster = rasterize({
    values: Array.from({ length: 24 }, (_, k) => k),
    rows: timeCells([0, 1, 2, 3, 4, 5, 6, 7]),
    columns: axisCells([0, 1, 2]),
    timePixels: 4,
    axisPixels: 1,
    timeToPixel: (t) => (t + 0.5) / 2,
    axisToPixel: (v) => (v + 0.5) / 3,
  });
  expect([raster.reducedRows, raster.reducedColumns]).toEqual([2, 3]);
  expect(cellsPerPixel(raster)).toBe(6);
});
