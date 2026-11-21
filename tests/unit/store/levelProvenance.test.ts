import { expect, it, vi } from "vitest";

vi.mock("@/store/store.ts", () => ({ useGlobeControlStore: () => ({}) }));
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
});

const { levelText } = await import("@/store/analysisStore.ts");
const { resultProvenance } = await import("@/lib/analysis/analysisExport.ts");

const source = {
  key: "k",
  store: "https://example.org/multi.zarr",
  dataset: "",
  format: 3 as const,
  level: { index: 0, count: 2, label: "0", paths: ["0", "1"] },
};

it("a variable in group 1 is level 2 of 2", () => {
  expect(levelText(source, "1/tas")).toBe("2 of 2: 1");
  expect(levelText(source, "0/tas")).toBe("1 of 2: 0");
  // A plain name: the level plots read.
  expect(levelText(source, "tas")).toBe("1 of 2: 0");
  expect(levelText({ ...source, level: undefined }, "tas")).toBeUndefined();
});

it("an exported level label keeps no access parameters", () => {
  const provenance = resultProvenance({
    kind: "point-series",
    query: {
      version: 1,
      kind: "point-series",
      source: {
        ref: "https://example.org/multi.zarr?token=SECRET",
        versionStatus: "best-effort",
        level: "1 of 2: https://example.org/l0.zarr?X-Amz-Signature=SECRET",
      },
      variable: "tas",
      geometry: { kind: "point", lat: 0, lon: 0 },
      fixed: {},
    },
    values: [1],
    notes: [],
    counters: {},
    grid: { conflicts: [] },
  } as never);
  const text = JSON.stringify(provenance);
  expect(text).not.toMatch(/SECRET/);
  expect(provenance.source.level).toBe("1 of 2: https://example.org/l0.zarr");
});

it("names nested groups' levels and each variable's own store (review of interim37)", () => {
  expect(levelText(source, "1/physics/tas")).toBe("2 of 2: 1");
  // A level of several stores, no paths: the variable's store.
  const stores = {
    ...source,
    store: "https://example.org/temperature.zarr",
    level: {
      index: 0,
      count: 2,
      label: "https://example.org/salinity.zarr",
      paths: [undefined, undefined],
    },
  };
  expect(levelText(stores, "thetao")).toBe(
    "1 of 2: https://example.org/temperature.zarr"
  );
});
