import { expect, it } from "vitest";

import { areasOnlyBytes } from "@/lib/analysis/nativeGrid.ts";

it("budgets the corner pass at its live buffers (review of interim37)", () => {
  const cells = 1_800_000;
  const corners = 16;
  const array = {
    key: "b",
    shape: [cells, corners],
    chunks: [65_536, corners],
    dtype: "float64",
    attrs: {},
    dimensionNames: ["cell", "nv"],
    fillValue: null,
    readChunk: () => Promise.reject(new Error("not read")),
  };
  const bytes = areasOnlyBytes(cells, cells * corners, [array, array]);
  // A float32 latitude offset and two float64 longitude buffers per corner.
  expect(bytes / 2 ** 20).toBeGreaterThanOrEqual(549.32);
});
