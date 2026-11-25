import { describe, expect, it } from "vitest";

import { introduceTab, viewTabs } from "@/ui/analysis/viewTabs.ts";

describe("view tabs", () => {
  it("put the figures the data allow between Chart and Data", () => {
    expect(viewTabs({}).map((t) => t.label)).toEqual(["Chart", "Data"]);
    expect(viewTabs({ figure: "rose" }).map((t) => t.label)).toEqual([
      "Chart",
      "Wind rose",
      "Data",
    ]);
    expect(
      viewTabs({ figure: "rose", current: true, scatter: "T–S" }).map((t) => [
        t.label,
        t.icon,
      ])
    ).toEqual([
      ["Chart", "chart"],
      ["Current rose", "rose"],
      ["T–S", "ts"],
      ["Data", "data"],
    ]);
    expect(viewTabs({ figure: "hodograph" })[1].icon).toBe("hodograph");
  });

  it("introduce a new figure tab once per plot", () => {
    expect(introduceTab("P1", "rose")).toBe(true);
    expect(introduceTab("P1", "rose")).toBe(false);
    expect(introduceTab("P2", "rose")).toBe(true);
    expect(introduceTab("P1", "chart")).toBe(false);
  });
});
