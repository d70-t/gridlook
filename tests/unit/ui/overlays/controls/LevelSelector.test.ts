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

async function render(varname: string) {
  setActivePinia(createPinia());
  useGlobeControlStore().varnameSelector = varname;
  return renderToString(createSSRApp(LevelSelector, { levels }));
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
