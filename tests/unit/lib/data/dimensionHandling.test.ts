import { describe, expect, it } from "vitest";
import type * as zarr from "zarrita";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";

const datavar = { shape: [10, 4, 180, 360] } as unknown as zarr.Array<
  zarr.DataType,
  zarr.AsyncReadable
>;

function build(
  presetStarts: Record<string, string>,
  presetMaxBounds: Record<string, string> = {}
) {
  return buildDimensionRangesAndIndices(
    datavar,
    ["time", "level", "lat", "lon"],
    presetStarts,
    {},
    presetMaxBounds,
    null,
    [2, 3],
    undefined
  ).indices;
}

describe("buildDimensionRangesAndIndices", () => {
  it("uses -1 as the latest available index", () => {
    expect(build({ time: "-1", level: "2" })).toEqual([9, 2, null, null]);
  });

  it("respects a preset max bound for -1", () => {
    expect(build({ time: "-1" }, { time: "5" })).toEqual([5, 0, null, null]);
  });
});

describe("negative dimension indices", () => {
  it("count back from the end and clamp to the bounds", () => {
    expect(build({ time: "-2" })).toEqual([8, 0, null, null]);
    expect(build({ time: "-100" })).toEqual([0, 0, null, null]);
  });
});
