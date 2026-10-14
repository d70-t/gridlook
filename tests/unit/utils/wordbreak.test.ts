import { afterEach, expect, it, vi } from "vitest";

import { vWordBreak } from "@/utils/wordbreak.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("inserts <wbr> as elements and keeps markup in the text inert", () => {
  vi.stubGlobal("document", {
    createElement: (tag: string) => ({ tag }),
  });
  let children: unknown[] = [];
  const el = {
    textContent: "<img/src='x'/onerror=alert(1)> sea_surface temp",
    replaceChildren: (...nodes: unknown[]) => {
      children = nodes;
    },
    set innerHTML(_: string) {
      throw new Error("dataset text must not be parsed as HTML");
    },
  } as unknown as HTMLElement;

  vWordBreak.mounted(el);

  const wbr = { tag: "wbr" };
  expect(children).toEqual([
    "<img/src='x'/onerror=alert(1)> ",
    wbr,
    "sea_",
    wbr,
    "surface ",
    wbr,
    "temp",
  ]);
});
