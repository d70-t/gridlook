import { createPinia, setActivePinia } from "pinia";
import { expect, it, vi } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import type { TSourceLevel } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import LevelSelector from "@/ui/overlays/controls/LevelSelector.vue";

vi.stubGlobal("localStorage", { getItem: () => null });

const source = { store: "https://example.test/data.zarr", dataset: "" };
const levels = ["0", "1"].map((path) => ({
  path,
  grid: source,
  time: source,
  datasources: {},
})) as TSourceLevel[];

async function render(varname: string, shown = levels) {
  setActivePinia(createPinia());
  useGlobeControlStore().varnameSelector = varname;
  return renderToString(createSSRApp(LevelSelector, { levels: shown }));
}

it("disables the level list for a variable outside the level groups", async () => {
  const html = await render("root_only");
  expect(html).toMatch(/<select[^>]*disabled/);
  expect(html).toContain("This variable has no levels.");
  expect(html).not.toContain("Pick the level from the zoom");
});

it("offers the levels of a variable in a level group", async () => {
  const html = await render("0/tas");
  expect(html).not.toMatch(/<select[^>]*disabled/);
  expect(html).not.toContain("This variable has no levels.");
  expect(html).toContain("Pick the level from the zoom");
});

it("disables the levels that lack the variable shown", async () => {
  const held = levels.map((level, index) => ({
    ...level,
    datasources: index === 0 ? { "0/foo": {} } : {},
  })) as TSourceLevel[];
  const html = await render("0/foo", held);
  expect(html).toMatch(/<option value="0"(?![^>]*disabled)/);
  expect(html).toMatch(/<option value="1"[^>]*disabled/);
});
