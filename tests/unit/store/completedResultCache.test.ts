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
  shape: [4, 768],
  gridLabel: "HEALPix order 3",
  order: 3,
  conflicts: [],
  time: {
    dimension: "time",
    raw: [0, 1, 2, 3],
    units: "days since 2000-01-01",
    calendar: "standard",
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
const map = { variable: "tas", indices: { time: 2 } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((_resolve) => (resolve = _resolve));
  return { promise, resolve };
}

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

it("reuses the completed plot after an unrelated date was published mid-read", async () => {
  // Close starts lazy export cleanup. Load it before ending this isolated test.
  await import("@/lib/analysis/exportClient.ts");
  const analysis = store();
  const geo = { kind: "point" as const, lat: 21.25, lon: 33.25 };
  const q = {
    version: 1 as const,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    geometry: geo,
    variable: "tas",
    fixed: {},
    source: ref,
    time: {
      start: 0,
      stop: 4,
      runs: [
        [0, 1],
        [2, 4],
      ] as [number, number][],
    },
  };
  const value = {
    ...result(1),
    query: q,
    time: { ...summary.time, raw: [0, 2, 3] },
    shape: [3],
    values: [10, 12, 13],
  };
  const first = deferred<typeof value>();
  client.executeRun.mockImplementationOnce(() => first.promise);
  client.executeRun.mockResolvedValue(value);
  void analysis.openWindow(q.kind, geo, map, rect, q);
  await flush();
  expect(client.executeRun).toHaveBeenCalledTimes(1);
  analysis.livePublished(1, 1);
  first.resolve(value);
  for (let i = 0; i < 5; i++) {
    await flush();
  }
  expect(analysis.windows.at(-1)?.result?.values).toEqual(value.values);
  analysis.close(analysis.windows.at(-1)!.id, false);
  await analysis.openWindow(q.kind, geo, map, rect, q);
  expect(analysis.windows.at(-1)?.result?.values).toEqual(value.values);
  expect(client.executeRun).toHaveBeenCalledTimes(1);
});

it("charges a retained region boundary to the completed-result cache", async () => {
  const { resultBytes } = await import("@/store/analysisStore.ts");
  const n = 6001;
  const ring = Array.from({ length: n }, (_, i) => {
    const theta = (i / (n - 1)) * 2 * Math.PI;
    return [Math.cos(theta), Math.sin(theta)];
  });
  const shape = {
    kind: "shape",
    name: "coastal catchment",
    digest: "one-region",
    polygons: [[ring]],
  } as const;
  const result = {
    kind: ANALYSIS_KINDS.REGION_SERIES,
    query: { geometry: shape },
    values: [7],
  };
  expect(resultBytes(result as never)).toBeGreaterThanOrEqual(n * 2 * 8);
});

it("interim48: a profile's bounds and native observation coordinates are charged too", async () => {
  const { resultBytes } = await import("@/store/analysisStore.ts");
  const n = 4096;
  const column = Array.from({ length: n }, (_, k) => k + 0.5);
  const result = {
    kind: ANALYSIS_KINDS.PROFILE,
    query: { geometry: { kind: "point", lat: 0, lon: 0 } },
    values: column,
    vertical: {
      values: column,
      bounds: [...column, ...column],
      auxiliary: { name: "depth", native: column },
    },
  };
  expect(resultBytes(result as never)).toBeGreaterThanOrEqual(5 * n * 8);
});
