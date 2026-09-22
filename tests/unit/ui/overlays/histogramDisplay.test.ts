import { renderToString } from "@vue/server-renderer";
import { expect, it, vi } from "vitest";
import { createSSRApp } from "vue";

import { computeBinTooltip } from "@/ui/overlays/controls/colorbarUtils.ts";
import DistributionPlot from "@/ui/overlays/controls/DistributionPlot.vue";
import {
  buildHistogramSummary,
  mergeHistogramSummaries,
  rebinHistogramSummary,
} from "@/utils/histogram.ts";

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: vi.fn(),
  onBeforeUnmount: vi.fn(),
  useSSRContext: () => ({}),
}));

it.each([0, -12, 42])(
  "centers constant data (%s) and preserves its count",
  (value) => {
    const summary = buildHistogramSummary(
      [value, value, NaN, Infinity],
      value,
      value
    );
    const merged = mergeHistogramSummaries([summary, summary], value, value);
    const bins = rebinHistogramSummary(merged, 50, value, value);
    expect(bins[25]).toBe(4);
    expect(bins.reduce((total, count) => total + count, 0)).toBe(4);
    expect(computeBinTooltip(25, bins, value, value)).toMatchObject({
      frequency: "100.00%",
      beyond: undefined,
    });
    expect(computeBinTooltip(25, bins, value, value).range).not.toContain("<");

    const wider = rebinHistogramSummary(summary, 10, value - 2, value + 8);
    expect(wider[2]).toBe(2);
  }
);

it.each([
  [NaN, NaN],
  [Infinity, -Infinity],
  [NaN, Infinity, -Infinity],
])(
  "explicitly reports a distribution without finite values: %j",
  async (...values) => {
    const summary = buildHistogramSummary(values, 0, 0);
    const bins = rebinHistogramSummary(summary, 50, 0, 0);
    expect(bins.every((count) => count === 0)).toBe(true);
    const html = await renderToString(
      createSSRApp(DistributionPlot, {
        fullHistogram: bins,
        dataBoundsLow: 0,
        dataBoundsHigh: 0,
      })
    );
    expect(html).toContain("No values to display.");
    expect(html).toContain("NaN, ±Infinity, missing values and string data");
    expect(html).not.toContain("Constant value:");
  }
);
