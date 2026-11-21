import { beforeEach, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  describeVariable: vi.fn(),
  planRun: vi.fn(),
  executeRun: vi.fn(),
  cancelRun: vi.fn(),
  releaseSource: vi.fn(),
  setRunPaused: vi.fn(),
  sourcePublished: vi.fn(),
}));

vi.mock("@/lib/analysis/analysisClient.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/analysis/analysisClient.ts")
  >()),
  ...client,
}));

vi.mock("@/store/store.ts", () => ({
  useGlobeControlStore: () => ({
    varnameSelector: "tas",
    varinfo: { dimRanges: [{ name: "time" }] },
    dimSlidersValues: [3],
  }),
}));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});
const page = {
  hash: "#https://example.org/data.zarr",
  pathname: "/",
  search: "",
};
vi.stubGlobal("location", page);
vi.stubGlobal("history", {
  replaceState: (_: unknown, __: string, url: string) => {
    page.hash = url.slice(url.indexOf("#"));
  },
});

const { createPinia, setActivePinia } = await import("pinia");
const { useAnalysisStore } = await import("@/store/analysisStore.ts");
const { ANALYSIS_KINDS } = await import("@/lib/analysis/types.ts");

const summary = {
  variable: "tas",
  dims: ["time", "cell"],
  shape: [100, 768],
  gridLabel: "HEALPix order 3",
  order: 3,
  conflicts: [],
  time: {
    dimension: "time",
    raw: Array.from({ length: 100 }, (_, t) => t),
    units: "days since 2000-01-01",
    calendar: "standard",
    chunk: 10,
  },
  others: [],
  capabilities: {
    [ANALYSIS_KINDS.POINT_SERIES]: { available: true },
    [ANALYSIS_KINDS.REGION_SERIES]: { available: true },
    [ANALYSIS_KINDS.PROFILE]: {
      available: false,
      reason: "The variable has no vertical dimension.",
    },
    [ANALYSIS_KINDS.SECTION]: {
      available: false,
      reason: "The variable has no vertical dimension.",
    },
  },
  decoding: "",
  overviews: [],
};

const modest = {
  chunks: 1,
  decodedBytes: 8,
  workingBytes: 8,
  outputValues: 4,
  modest: true,
  notes: [],
};
const source = {
  key: "src#1",
  store: "https://example.org/data.zarr",
  dataset: "",
  format: 3 as const,
};
const ref = {
  ref: "https://example.org/data.zarr",
  versionStatus: "best-effort" as const,
};
const rect = { x: 0, y: 0, w: 400, h: 300 };
const map = { variable: "tas", indices: { time: 55 } };

function result(tag: number) {
  return {
    kind: ANALYSIS_KINDS.POINT_SERIES,
    values: [tag],
    notes: [],
    counters: {},
    grid: { conflicts: [] },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  setActivePinia(createPinia());
  Object.values(client).forEach((fn) => fn.mockReset());
  client.describeVariable.mockResolvedValue(summary);
  client.planRun.mockResolvedValue(modest);
  page.hash = "#https://example.org/data.zarr";
});

function store() {
  const analysis = useAnalysisStore();
  analysis.setActiveSource(source, ref, "Example");
  return analysis;
}

it("v31: Apply leaves a crossed polygon pending and keeps the last plot", async () => {
  const analysis = store();
  client.executeRun.mockResolvedValue(result(1));
  const square = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 10 },
    { lat: 10, lon: 10 },
    { lat: 10, lon: 0 },
  ];
  void analysis.openWindow(
    ANALYSIS_KINDS.REGION_SERIES,
    { kind: "polygon", vertices: square },
    map,
    rect
  );
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  const w = analysis.windows[0];
  const before = w.committed;
  expect(before?.geometry.kind).toBe("polygon");
  const runs = client.planRun.mock.calls.length;
  // Swap two corners: a bow tie.
  analysis.updateDraft(w.id, {
    geometry: {
      kind: "polygon",
      vertices: [square[0], square[2], square[1], square[3]],
    },
  });
  await analysis.apply(w.id);
  expect(analysis.windows[0].committed).toBe(before);
  expect(client.planRun.mock.calls.length).toBe(runs);
});

it("v27 review: a restored plot that cannot run here stays in the link", async () => {
  const analysis = store();
  const { decodeSession } = await import("@/lib/analysis/sessionLink.ts");
  const restored = {
    version: 1,
    kind: ANALYSIS_KINDS.PROFILE,
    variable: "tas",
    geometry: { kind: "point" as const, lat: 3, lon: 4 },
    fixed: {},
  };
  await analysis.openWindow(
    ANALYSIS_KINDS.PROFILE,
    restored.geometry,
    map,
    rect,
    restored as never
  );
  // The variable has no levels here: unavailable, the request kept.
  expect(analysis.windows[0].message).toMatch(/vertical/);
  analysis.urlRestored = true;
  analysis.writeLink();
  const value = /plots=([^&:]+)/.exec(page.hash)?.[1];
  expect(value).toBeDefined();
  expect(
    decodeSession(decodeURIComponent(value!)).plots[0].query.geometry
  ).toEqual(restored.geometry);
});
