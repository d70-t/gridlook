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

it("v29: a description is kept when its window closes and dropped with the source", async () => {
  const analysis = store();
  client.executeRun.mockResolvedValue(result(1));
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 1, lon: 2 },
    map,
    rect
  );
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  const key = analysis.windows[0].source.key;
  expect(analysis.summaryOf(key, "tas")?.variable).toBe("tas");
  analysis.close(analysis.windows[0].id);
  expect(analysis.windows).toHaveLength(0);
  expect(analysis.summaryOf(key, "tas")?.variable).toBe("tas");
  // Another variable described (an unapplied draft) is its own record.
  client.describeVariable.mockResolvedValueOnce({
    ...summary,
    variable: "landcover",
  });
  await analysis.describe(source, "landcover");
  expect(analysis.summaryOf(source.key, "landcover")?.variable).toBe(
    "landcover"
  );
  expect(analysis.summaryOf(key, "tas")?.variable).toBe("tas");
  // A new source generation describes its variables anew.
  analysis.bindDatasources({});
  expect(analysis.summaryOf(key, "tas")).toBeUndefined();
});
