import { expect, it } from "vitest";

import { latitudeWeightAt } from "@/lib/grids/analysisGrid.ts";

it("weighs narrow cells at the pole by their area (review of interim37)", () => {
  const bounds = [89.9999998, 89.9999999, 89.9999999, 90];
  const [a, b] = [latitudeWeightAt(bounds, 0), latitudeWeightAt(bounds, 1)];
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(0);
  // Areas grow linearly in distance from the pole: 3: 1, to 1e-6.
  expect(a / b).toBeCloseTo(3, 4);
  // Ordinary cells unchanged: the whole sphere is 2.
  expect(latitudeWeightAt([-90, 90], 0)).toBeCloseTo(2, 12);
});
