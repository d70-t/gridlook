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
const { PLOT_STATUS, useAnalysisStore } =
  await import("@/store/analysisStore.ts");
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

function result(tag: number) {
  return {
    kind: ANALYSIS_KINDS.POINT_SERIES,
    values: [tag],
    notes: [],
    counters: {},
    grid: { conflicts: [] },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  Object.values(client).forEach((fn) => fn.mockReset());
  client.describeVariable.mockResolvedValue(summary);
  client.planRun.mockResolvedValue(modest);
  page.hash = "#https://example.org/data.zarr";
});

// eslint-disable-next-line max-lines-per-function
it("review of interim43: a cached scatter partner keeps the price of the read that made it", async () => {
  const analysis = useAnalysisStore(createPinia());
  const every = (n: number) => Array.from({ length: n }, (_, at) => 100 * at);
  const daily = Array.from({ length: 1600 }, (_, at) => at);
  const coords = (raw: number[], chunk: number) => ({
    ...summary.time,
    raw,
    chunk,
  });
  const query = {
    version: 1 as const,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    geometry: { kind: "point" as const, lat: 1, lon: 1 },
    fixed: {},
    source: ref,
    variable: "tas",
    time: { start: 0, stop: 8 },
  };
  analysis.$patch({
    windows: [
      {
        id: "cached-pair",
        kind: ANALYSIS_KINDS.POINT_SERIES,
        source,
        sourceRef: ref,
        pairWith: "hus",
        status: PLOT_STATUS.DONE,
        summary: { ...summary, time: coords(every(8), 1) },
        result: {
          kind: query.kind,
          query,
          time: coords(every(8), 1),
          values: every(8),
          shape: [8],
          dims: ["time"],
        },
      },
    ],
  });
  client.describeVariable.mockResolvedValue({
    ...summary,
    variable: "hus",
    time: coords(daily, 8),
  });
  // Each partner read decodes 4 MiB, as its plan says.
  client.planRun.mockResolvedValue({ ...modest, decodedBytes: 4 * 2 ** 20 });
  client.executeRun.mockImplementation((id: string) => {
    const asked = client.planRun.mock.calls.find(([run]) => run === id)![2];
    const raw = daily.slice(asked.time.start, asked.time.stop);
    return {
      ...result(0),
      counters: { decodedBytes: 0 },
      query: asked,
      time: coords(raw, 8),
      values: raw,
      shape: [raw.length],
      dims: ["time"],
    };
  });
  await analysis.loadPair("cached-pair");
  const cold = analysis.windows[0].companions?.pair?.perDate;
  expect(cold).toBe(4 * 2 ** 20);
  const reads = client.executeRun.mock.calls.length;
  analysis.setPair("cached-pair", undefined);
  analysis.setPair("cached-pair", "hus");
  for (let k = 0; k < 6; k++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // Read from the cache, quoted the same.
  expect(client.executeRun.mock.calls.length).toBe(reads);
  expect(analysis.windows[0].companions?.pair?.perDate).toBe(cold);
  const { withPartnerBytes } = await import("@/lib/analysis/preview.ts");
  const own = {
    dates: 8,
    total: 16,
    nextDates: 8,
    nextBytes: 8 * 2 ** 20,
    allBytes: 8 * 2 ** 20,
  } as never;
  const before = withPartnerBytes(own, cold, false).facts.nextBytes;
  const after = withPartnerBytes(
    own,
    analysis.windows[0].companions?.pair?.perDate,
    false
  ).facts.nextBytes;
  expect([before, after]).toEqual([40 * 2 ** 20, 40 * 2 ** 20]);
});
