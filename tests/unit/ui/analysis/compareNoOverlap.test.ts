import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";

vi.mock("@/store/store.ts", () => ({ useGlobeControlStore: () => ({}) }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
const { useAnalysisStore } = await import("@/store/analysisStore.ts");
const { default: ComparePanel } =
  await import("@/ui/analysis/ComparePanel.vue");

function plot(id: string, raw: number[]) {
  return {
    id,
    label: id.toUpperCase(),
    kind: "point-series",
    status: "done",
    snapshot: false,
    minimized: false,
    source: { key: "original|" + id },
    sourceRef: { ref: "example", versionStatus: "session" },
    result: {
      kind: "point-series",
      units: "K",
      query: {
        variable: "tas",
        geometry: { kind: "point", lat: 0, lon: 0 },
        source: { ref: "example", versionStatus: "session" },
        fixed: {},
      },
      time: {
        raw,
        calendar: "standard",
        units: "days since 2001-01-01",
        dimension: "time",
      },
      values: raw.map((v) => v + 1),
      dims: ["time"],
      shape: [raw.length],
      notes: [],
      grid: { conflicts: [] },
    },
    resultSummary: { label: id },
    rect: { x: 0, y: 0, w: 400, h: 300 },
  };
}

describe("Compare with no shared dates", () => {
  it("says which dates each plot has loaded", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useAnalysisStore().$patch({
      activeSource: {
        key: "original",
        store: "memory",
        dataset: "",
        format: 3,
      },
      windows: [plot("p4", [12, 13]), plot("p2", [2, 0, 1])],
      variableSources: { tas: {} },
      compare: { ids: ["p4", "p2"], reference: "p4", minimized: false },
    } as never);
    const html = await renderToString(
      createSSRApp({ render: () => h(ComparePanel) }).use(pinia)
    );
    const text = html.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");

    expect(text).toMatch(
      /No shared dates: P2 has 2001-01-01[^,]* – 2001-01-03[^,]*, the reference 2001-01-13/
    );
    expect(text).not.toContain("0 times");
  });
});
