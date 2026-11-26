import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  axisCells,
  rasterize,
  timeCells,
} from "@/ui/analysis/heatmapRaster.ts";

// GRIDLOOK_BENCH=1 npx vitest run tests/benchmark/heatmapRaster.test.ts
// Time bounds that overlap: accumulations since a fixed start ([0, i]) and
// running means ([i - k, i + k]), each as one redraw of a streaming heatmap
// (only the first half read).
function render(bounds: (i: number) => [number, number], n: number) {
  const raw = Array.from({ length: n }, (_, i) => i + 1);
  const rows = timeCells(
    raw,
    raw.flatMap((_, i) => bounds(i))
  );
  const lo = Math.min(...rows.lo);
  const hi = Math.max(...rows.hi);
  const started = performance.now();
  const raster = rasterize({
    values: raw,
    rows,
    columns: axisCells([0]),
    unreadFrom: n / 2,
    timePixels: 800,
    axisPixels: 1,
    timeToPixel: (t) => ((t - lo) / (hi - lo)) * 800,
    axisToPixel: (v) => v + 0.5,
  });
  return {
    ms: Math.round((performance.now() - started) * 10) / 10,
    lookupEntries: raster.lookupEntries,
    drawnAtTimes: Boolean(rows.overlapping),
  };
}

describe.skipIf(process.env.GRIDLOOK_BENCH !== "1")("heatmap raster", () => {
  it("bounds the work for overlapping time bounds", () => {
    const n = 6000;
    const records = [
      { bounds: "adjacent [i, i + 1]", ...render((i) => [i, i + 1], n) },
      { bounds: "cumulative [0, i + 1]", ...render((i) => [0, i + 1], n) },
      {
        bounds: "running mean [i − 15, i + 15]",
        ...render((i) => [i - 15, i + 15], n),
      },
    ];
    for (const record of records) {
      expect(record.lookupEntries).toBeLessThan(4 * (n + 800));
    }
    const out = process.env.GRIDLOOK_BENCH_OUT;
    if (out) {
      writeFileSync(out, JSON.stringify({ node: process.version, records }));
    }
    console.table(records);
  });
});
