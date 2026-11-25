import { describe, expect, it } from "vitest";

import { exportGroups } from "@/ui/analysis/exportMenu.ts";

describe("the Export menu", () => {
  it("groups every export by what the file holds", () => {
    const groups = exportGroups({ chartValues: true });
    expect(groups.map((g) => g.name)).toEqual([
      "Figure",
      "Values",
      "Selection and reproducibility",
    ]);
    expect(groups.map((g) => g.items.map((i) => i.format))).toEqual([
      ["png", "pdf", "svg"],
      ["chart-csv", "csv", "nc", "zarr"],
      ["geojson", "json", "py"],
    ]);
  });

  it("offers chart values as shown only when the chart can say what it draws", () => {
    const formats = exportGroups({ chartValues: false }).flatMap((g) =>
      g.items.map((i) => i.format)
    );
    expect(formats).not.toContain("chart-csv");
    // Still one computed-values CSV, whatever the view.
    expect(formats.filter((f) => f === "csv")).toHaveLength(1);
  });
});
