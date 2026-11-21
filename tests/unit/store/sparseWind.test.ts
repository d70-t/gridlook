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

function sparseWind(id: string, dates: number[], latitude: number) {
  const analysis = useAnalysisStore(createPinia());
  configureWindWorker(Array.from({ length: 10000 }, (_, at) => at));
  const coords = (raw: number[]) => ({ ...summary.time, raw, chunk: 1 });
  const q = {
    version: 1 as const,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    geometry: { kind: "point" as const, lat: latitude, lon: 0 },
    fixed: {},
    source: ref,
    variable: "tas",
    time: { start: 0, stop: dates.length },
  };
  analysis.$patch({
    windows: [
      {
        id,
        kind: q.kind,
        source,
        sourceRef: ref,
        wind: true,
        windChoice: { u: "uas", v: "vas" },
        status: PLOT_STATUS.DONE,
        summary: { ...summary, time: coords(dates) },
        result: {
          kind: q.kind,
          query: q,
          time: coords(dates),
          values: dates.map(() => 1),
          shape: [dates.length],
          dims: ["time"],
        },
      },
    ],
  });
  return analysis;
}

function configureWindWorker(dense: number[]) {
  const coords = (raw: number[]) => ({ ...summary.time, raw, chunk: 1 });
  client.describeVariable.mockResolvedValue({
    ...summary,
    time: coords(dense),
  });
  client.executeRun.mockImplementation((id: string) => {
    const query = client.planRun.mock.calls.find(([run]) => run === id)![2];
    const raw = dense.slice(query.time.start, query.time.stop);
    return {
      ...result(0),
      query,
      time: coords(raw),
      values: raw,
      units: "m s-1",
      shape: [raw.length],
      dims: ["time"],
    };
  });
}

it.each([false, true])(
  "plans sparse wind dates without the dates in each gap; region=%s",
  async (region) => {
    const id = region ? "box" : "point";
    const a = sparseWind(id, [0, 100, 200], region ? 47 : 48);
    a.setComputeMode("auto");
    const w = a.windows[0];
    if (region) {
      w.kind = ANALYSIS_KINDS.REGION_SERIES;
      w.result!.kind = w.kind;
      w.result!.query.kind = w.kind;
      w.result!.query.geometry = {
        kind: "box",
        south: 0,
        north: 2,
        west: 0,
        east: 2,
      };
    }
    const reads: { name: string; start: number; stop: number }[] = [];
    client.planRun.mockImplementation(async (_id, _src, q) => {
      reads.push({ name: q.variable, start: q.time.start, stop: q.time.stop });
      return {
        ...modest,
        decodedBytes: (q.time.stop - q.time.start) * 2 ** 20,
      };
    });
    await a.loadWind(id);
    const dates = reads.reduce((n, r) => n + r.stop - r.start, 0);
    console.log("wind dates read", {
      region,
      reads,
      dates,
      status: w.companions?.wind?.status,
    });
    expect(w.companions?.wind?.status).toBe("ready");
    expect(dates).toBe(6);
  }
);
