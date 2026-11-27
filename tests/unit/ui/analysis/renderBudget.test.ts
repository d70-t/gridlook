/**
 * Drawing work is bounded by the screen, whatever the data: cases (a
 * constant reference, near-identical floats, 200,000 pairs, four
 * 31,411-day comparisons) finish quickly with a bounded number of marks.
 */
import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";

import { extent, thinLine, thinScatter } from "@/ui/analysis/chartBudget.ts";
import {
  onTaylor,
  pairSeries,
  taylorReach,
  taylorRings,
  taylorStats,
} from "@/ui/analysis/compare.ts";
import CompareCharts from "@/ui/analysis/CompareCharts.vue";
import { niceTicks } from "@/ui/analysis/heatmapRaster.ts";
import { drawScatter } from "@/ui/analysis/scatterFigure.ts";

/** A canvas context that counts marks (arcs) and ignores the rest. */
function countingContext() {
  const counts = { arcs: 0 };
  const context = new Proxy(
    {},
    {
      get: (_, key) =>
        key === "arc"
          ? () => counts.arcs++
          : key === "measureText"
            ? () => ({ width: 10 })
            : () => undefined,
      set: () => true,
    }
  );
  return { context: context as CanvasRenderingContext2D, counts };
}
const colours = { fg: "#000", muted: "#666", grid: "#ccc", line: "#06c" };

describe("Taylor diagram", () => {
  it("leaves out a constant reference instead of looping without end", () => {
    const stats = taylorStats([1, 1, 1], [0, 1, 2])!;
    expect(onTaylor(stats)).toBe(false);
    // Bias and the RMS difference stay defined.
    expect(stats.bias).toBe(0);
    expect(stats.crmsd).toBeCloseTo(Math.sqrt(2 / 3));
    expect(taylorReach([stats.stdTest / stats.stdRef])).toBe(1.5);
  });

  it("draws a bounded number of rings for any spread ratio", () => {
    for (const ratio of [0.5, 1, 7, 1000, 1e12]) {
      const reach = taylorReach([ratio]);
      const rings = taylorRings(reach);
      expect(rings.length).toBeLessThanOrEqual(9);
      expect(rings).toContain(1);
      expect(Math.max(...rings)).toBeLessThanOrEqual(reach);
    }
  });
});

describe("ticks and extents", () => {
  it("finishes on spans below the floating-point spacing", () => {
    for (const [low, high] of [
      [45, 45 + 2 ** -47],
      [1, 1 + Number.EPSILON],
      [1e15, 1e15 + 0.25],
      [-1e308, 1e308],
    ]) {
      const ticks = niceTicks(low, high, 5);
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks.length).toBeLessThanOrEqual(8);
    }
  });

  it("takes the extent of 200,000 values without spreading them", () => {
    const xs = Float64Array.from({ length: 200_000 }, (_, i) => i);
    expect(extent(xs, [NaN, -3])).toEqual({ low: -3, high: 199_999 });
    expect(extent([NaN], [])).toBeUndefined();
  });

  it("thins a scatter to its pixels and a line to its columns, peaks kept", () => {
    const n = 200_000;
    const xs = Array.from({ length: n }, (_, i) => i % 1000);
    const ys = Array.from({ length: n }, (_, i) => (i * 7919) % 1000);
    const kept = thinScatter(
      xs,
      ys,
      (x) => x / 2,
      (y) => y / 2
    );
    expect(kept.length).toBeLessThanOrEqual((500 / 1.5 + 1) ** 2);
    const line = Array.from({ length: n }, (_, x) => ({
      x,
      y: x === 123_457 ? 99 : 0,
    }));
    const thin = thinLine(line, (x) => (x / n) * 600);
    expect(thin.length).toBeLessThanOrEqual(600 * 4 + 4);
    expect(thin.some((p) => p.y === 99)).toBe(true);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("scatter and Compare charts at supported sizes", () => {
  it("draws a canvas scatter of near-identical floats and of 200,000 pairs", () => {
    const near = countingContext();
    const started = performance.now();
    drawScatter(
      near.context,
      600,
      400,
      {
        x: [45, 45 + 2 ** -47],
        y: [1, 1 + Number.EPSILON],
        xTitle: "x",
        yTitle: "y",
        title: "t",
        joined: false,
      },
      colours
    );
    const big = countingContext();
    const n = 200_000;
    drawScatter(
      big.context,
      600,
      400,
      {
        x: Array.from({ length: n }, (_, i) => Math.sin(i)),
        y: Array.from({ length: n }, (_, i) => Math.cos(i * 1.3)),
        xTitle: "x",
        yTitle: "y",
        title: "t",
        joined: false,
      },
      colours
    );
    expect(big.counts.arcs).toBeLessThan(110_000);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("renders bias and scatter of four 31,411-day comparisons with bounded marks", async () => {
    const n = 31_411;
    const day = (i: number) =>
      new Date(Date.UTC(1940, 0, 1) + i * 86_400_000)
        .toISOString()
        .slice(0, 10);
    const dates = Array.from({ length: n }, (_, i) => day(i));
    const reference = { dates, values: dates.map((_, i) => Math.sin(i / 50)) };
    const rows = [0, 1, 2, 3].map((k) => {
      const pair = pairSeries(reference, {
        dates,
        values: dates.map((_, i) => Math.sin(i / 50) + k * 0.1 + Math.cos(i)),
      });
      return {
        label: `P${k + 2}`,
        colour: "#000",
        pair,
        stats: taylorStats(pair.reference, pair.other)!,
      };
    });
    for (const view of ["bias", "scatter", "qq", "parallel"] as const) {
      const html = await renderToString(
        createSSRApp({
          render: () =>
            h(CompareCharts, { view, rows, referenceLabel: "P1", units: "K" }),
        })
      );
      const circles = html.split("<circle").length - 1;
      expect(circles, view).toBeLessThan(40_000);
      expect(html).not.toContain("NaN");
    }
  });

  it("parallel coordinates break the line at an undefined score", async () => {
    const pair = pairSeries(
      { dates: ["2000-01-01", "2000-01-02", "2000-01-03"], values: [1, 1, 1] },
      { dates: ["2000-01-01", "2000-01-02", "2000-01-03"], values: [0, 1, 2] }
    );
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(CompareCharts, {
            view: "parallel",
            rows: [
              {
                label: "P2",
                colour: "#000",
                pair,
                stats: taylorStats(pair.reference, pair.other)!,
              },
            ],
            referenceLabel: "P1",
          }),
      })
    );
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    // Every score is undefined against a constant reference (0 / 0 or x / 0):
    // none is drawn, rather than at the "best" end of its axis.
    expect(html.split("<circle").length - 1).toBe(0);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("bias over time", () => {
  const hours = Array.from(
    { length: 12 },
    (_, i) => `2000-01-01 ${String(i).padStart(2, "0")}:00:00`
  );
  const render = async (pair: ReturnType<typeof pairSeries>) =>
    renderToString(
      createSSRApp({
        render: () =>
          h(CompareCharts, {
            view: "bias",
            rows: [
              {
                label: "P2",
                colour: "#000",
                pair,
                stats: taylorStats(pair.reference, pair.other)!,
              },
            ],
            referenceLabel: "P1",
            units: "K",
          }),
      })
    );

  it("breaks its line at dates known to be missing", async () => {
    const pair = pairSeries(
      { dates: hours, values: hours.map(() => 280) },
      {
        dates: hours,
        values: hours.map((_, i) => (i >= 2 && i <= 9 ? NaN : 281)),
      }
    );
    expect(pair.keys).toHaveLength(4);
    const html = await render(pair);
    // The line: the one path of four points' moves and lines.
    const paths = [...html.matchAll(/ d="(M[^"]*)"/g)].map((m) => m[1]);
    const line = paths.find((d) => (d.match(/[ML]/g) ?? []).length === 4);
    expect(line?.match(/M/g)).toHaveLength(2);
    expect(html).not.toContain("NaN");
  });

  it("labels the dates of a long comparison without overflowing the stack", async () => {
    const n = 130_000;
    const dates = Array.from({ length: n }, (_, i) =>
      new Date(Date.UTC(2000, 0, 1) + i * 3_600_000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ")
    );
    const pair = pairSeries(
      { dates, values: dates.map(() => 1) },
      { dates, values: dates.map(() => 2) }
    );
    await expect(render(pair)).resolves.toContain("<svg");
  });
});
