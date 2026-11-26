/* eslint-disable max-lines-per-function -- fixtures with CF and Zarr attribute names. */
import { createPinia, setActivePinia } from "pinia";
import { expect, it, vi } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
vi.mock("@/store/store.ts", () => ({ useGlobeControlStore: () => ({}) }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
const { useAnalysisStore } = await import("@/store/analysisStore.ts");
const { default: ComparePanel } =
  await import("@/ui/analysis/ComparePanel.vue");
async function display(
  units: string[],
  variables: string[],
  names: string[],
  values: number[][],
  stored = false
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const a = useAnalysisStore();
  const seed = variables.map((variable, i) => ({
    id: "w" + i,
    label: "Series" + i,
    kind: "point-series",
    status: "done",
    snapshot: false,
    minimized: false,
    source: { key: "original|w" + i },
    sourceRef: { ref: "example", versionStatus: "session" },
    result: {
      kind: "point-series",
      units: units[i],
      query: {
        variable,
        geometry: { kind: "point", lat: 0, lon: 0 },
        source: { ref: "example", versionStatus: "session" },
        fixed: {},
      },
      time: {
        raw: [0, 1, 2],
        calendar: "standard",
        units: "days since 2001-01-01",
        dimension: "time",
      },
      values: values[i],
      dims: ["time"],
      shape: [3],
      notes: [],
      grid: { conflicts: [] },
    },
    resultSummary: { standardName: names[i], label: "Series" + i },
    rect: { x: 0, y: 0, w: 400, h: 300 },
  }));
  a.$patch({
    activeSource: { key: "original", store: "memory", dataset: "", format: 3 },
    windows: seed,
    variableSources: Object.fromEntries(
      variables.map((v, i) => [v, { standardName: names[i] }])
    ),
    compare: { ids: ["w0", "w1"], reference: "w0", minimized: false },
  } as never);
  if (stored) {
    a.setActiveSource(
      { key: "next", store: "memory-next", dataset: "", format: 3 } as never,
      undefined,
      "next",
      Object.fromEntries(
        variables.map((v) => [
          v,
          {
            store: "memory-next",
            dataset: "",
            standardName: "sea_water_temperature_anomaly",
          },
        ])
      )
    );
  }
  const html = await renderToString(
    createSSRApp({ render: () => h(ComparePanel) }).use(pinia)
  );
  const table =
    html.match(/<table class="compare-stats"[\s\S]*?<\/table>/)?.[0] ?? "";
  return {
    scores: Array.from(
      table.matchAll(/<td\b[^>]*>([^<]*)<\/td>/g),
      (m) => m[1]
    ),
    unitLine: html.includes("converted from mm/s"),
    html,
  };
}
it("does not compare ocean velocity in mm/s as an atmospheric carbon mass flux", async () => {
  const result = await display(
    ["kg m-2 s-1", "mm/s"],
    ["fg", "uo"],
    [
      "surface_upward_mass_flux_of_carbon_dioxide_expressed_as_carbon",
      "eastward_sea_water_velocity",
    ],
    [
      [1, 2, 3],
      [1, 2, 3],
    ]
  );

  expect(result.scores).toHaveLength(0);
});
it("compares equivalent ocean currents", async () => {
  const result = await display(
    ["m/s", "mm/s"],
    ["uo_A", "uo_B"],
    ["eastward_sea_water_velocity", "eastward_sea_water_velocity"],
    [
      [1, 2, 3],
      [1000, 2000, 3000],
    ]
  );

  expect(result.scores).toEqual(["1.00", "1.00", "0", "0"]);
});

it("preserves an absolute temperature's meaning when a different dataset opens", async () => {
  const names = ["sea_water_temperature", "sea_water_temperature"];
  const units = ["K", "degC"],
    fields = ["t1", "t2"],
    data = [
      [280, 281, 282],
      [6.85, 7.85, 8.85],
    ];
  const open = await display(units, fields, names, data, false);
  const snapshot = await display(units, fields, names, data, true);

  expect(open.scores[3]).toBe("0");
  expect(snapshot.scores[3]).toBe(open.scores[3]);
});
