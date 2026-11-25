import { expect, it } from "vitest";

import { followRequest } from "@/ui/analysis/followMap.ts";

it("interim49: turning Follow back on after a Stop reads again where the map is", () => {
  const stopped = {
    following: true,
    complete: false,
    mapTime: 40,
    shownTime: 40,
  };
  expect(followRequest({ ...stopped, byLevel: false })).toEqual({ time: 40 });
  expect(followRequest({ ...stopped, byLevel: true, mapLevel: 22 })).toEqual({
    level: 22,
    again: true,
  });
  // Finished there already: nothing to read; elsewhere: the map's date.
  const done = { ...stopped, complete: true, byLevel: false };
  expect(followRequest(done)).toBeUndefined();
  expect(followRequest({ ...done, mapTime: 41 })).toEqual({ time: 41 });
  expect(followRequest({ ...done, following: false })).toBeUndefined();
});
