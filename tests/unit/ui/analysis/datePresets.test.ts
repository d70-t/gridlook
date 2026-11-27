import { describe, expect, it } from "vitest";

import {
  bytesPerGroup,
  datePresets,
  rangeCost,
} from "@/ui/analysis/datePresets.ts";

const MiB = 2 ** 20;

describe("Dates in Settings (v26 review)", () => {
  // Five years of daily values, 365-day calendar, 73 days per stored chunk.
  const raw = Array.from({ length: 5 * 365 }, (_, day) => day);

  it("prices a range by its stored time chunks", () => {
    expect(rangeCost({ start: 0, stop: 73 }, 73, 4 * MiB)).toBe("≈ 4.0 MiB");
    // One date past a chunk boundary reads the next chunk too.
    expect(rangeCost({ start: 0, stop: 74 }, 73, 4 * MiB)).toBe("≈ 8.0 MiB");
    expect(rangeCost({ start: 0, stop: 74 }, 73)).toBe("");
  });

  it("takes the price per chunk from the preview, the estimate or the last read", () => {
    expect(bytesPerGroup({ previewPerGroup: 3 })).toBe(3);
    expect(
      bytesPerGroup({
        chunk: 73,
        committed: { start: 0, stop: 730 },
        estimateBytes: 40 * MiB,
      })
    ).toBe(4 * MiB);
    expect(
      bytesPerGroup({
        chunk: 73,
        committed: { start: 0, stop: 146 },
        decodedBytes: 8 * MiB,
      })
    ).toBe(4 * MiB);
    expect(bytesPerGroup({ chunk: 73 })).toBeUndefined();
  });

  it("offers the map's date, the last year and everything, each priced", () => {
    const presets = datePresets({
      raw,
      units: "days since 2000-01-01",
      calendar: "noleap",
      chunk: 73,
      perGroup: 4 * MiB,
      anchor: 400,
    });
    expect(presets.map((p) => p.id)).toEqual(["map", "year", "all"]);
    // Four chunks fit the 16 MiB first-dates budget, around date 400.
    const map = presets[0];
    expect(map.range.start % 73).toBe(0);
    expect(map.range.start <= 400 && 400 < map.range.stop).toBe(true);
    expect(map.cost).toBe("≈ 16 MiB");
    // The last 365 days of a 365-day calendar.
    expect(presets[1].range).toEqual({ start: 4 * 365, stop: 5 * 365 });
    expect(presets[2]).toMatchObject({
      label: "All 1,825 dates",
      cost: "≈ 100 MiB",
    });
  });
});

describe("Dates presets without metadata", () => {
  it("leaves out a year it cannot measure and a map date it does not know", () => {
    const presets = datePresets({ raw: [0, 1, 2], chunk: 1 });
    expect(presets.map((p) => p.id)).toEqual(["all"]);
    expect(presets[0].cost).toBe("");
  });
});
