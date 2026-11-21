/* eslint-disable camelcase -- CF attribute names. */
import { expect, it, vi } from "vitest";

import { correspondingIndex } from "@/ui/analysis/plotLayout.ts";

vi.mock("@/store/store.ts", () => ({ useGlobeControlStore: () => ({}) }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
const { sameLevel } = await import("@/store/analysisStore.ts");

it("matches a height up against a depth down by sign (review of interim37)", () => {
  const map = { values: [100], units: "m", positive: "up" };
  const plot = { values: [-100, 100], units: "m", positive: "down" };
  expect(correspondingIndex(map, 0, plot, "level")).toBe(0);
  // Same direction: the same number.
  expect(
    correspondingIndex({ ...map, positive: "down" }, 0, plot, "level")
  ).toBe(1);
});

it("takes 500 hPa and 50,000 Pa as one wind level (review of interim37)", () => {
  const at = (value: number, units: string) =>
    ({ fixedLevel: { dimension: "plev", index: 0, value, units } }) as never;
  expect(sameLevel(at(50000, "Pa"), at(500, "hPa"))).toBe(true);
  expect(sameLevel(at(85000, "Pa"), at(500, "hPa"))).toBe(false);
});

it("unpacks the map's time coordinate before matching (review of interim37)", async () => {
  const { mapCoordinateOf } = await import("@/ui/analysis/plotLayout.ts");
  const units = "days since 2001-01-01";
  const globe = {
    varinfo: {
      dimRanges: [{ name: "time" }],
      dimInfo: [{ values: [0, 1, 2], attrs: { scale_factor: 2, units } }],
    },
  } as never;
  const map = mapCoordinateOf(globe, "time")!;
  expect(Array.from(map.values as number[])).toEqual([0, 2, 4]);
  const plot = { values: [0, 2, 4], units, calendar: "standard" };
  expect(correspondingIndex(map, 2, plot, "time")).toBe(2);
});
