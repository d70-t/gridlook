// 24 Nov: keys beside a narrow colour bar were cut ("map s…", "hidden on
// m…"); they now take two lines where one does not fit.
import { expect, it } from "vitest";

import { keyLines } from "@/ui/analysis/colourBar.ts";

// 5 px a character, as a stand-in for the canvas' measure.
const context = { measureText: (text: string) => ({ width: text.length * 5 }) };

it("a key that fits stays on one line", () => {
  expect(keyLines(context as never, "missing", 43)).toEqual(["missing"]);
});

it("a longer key wraps at a space instead of being cut", () => {
  expect(keyLines(context as never, "map scale", 43)).toEqual(["map", "scale"]);
  expect(keyLines(context as never, "hidden on map", 43)).toEqual([
    "hidden",
    "on map",
  ]);
});

it("a single word is left whole", () => {
  expect(keyLines(context as never, "unsampled", 20)).toEqual(["unsampled"]);
});
