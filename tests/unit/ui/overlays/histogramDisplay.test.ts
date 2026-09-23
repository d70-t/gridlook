import { expect, it, vi } from "vitest";

import { computeBinTooltip } from "@/ui/overlays/controls/colorbarUtils.ts";
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
