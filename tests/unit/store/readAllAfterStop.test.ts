/** Its own module state: other store tests keep shared runs in flight. */
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

type TTime = { start: number; stop: number };
const seriesOf = (time: TTime) => ({
  ...result(time.start),
  values: Array.from({ length: time.stop - time.start }, (_, t) => t),
  dims: ["time"],
  shape: [time.stop - time.start],
});

/** Plans priced by dates: 1 MiB per date, Compute past 16 dates. */
function pricedByDates(times: TTime[]) {
  const queries = new Map<string, TTime>();
  client.planRun.mockImplementation(
    async (runId: string, _source: unknown, query: { time: TTime }) => {
      queries.set(runId, query.time);
      times.push(query.time);
      const dates = query.time.stop - query.time.start;
      return {
        ...modest,
        chunks: dates,
        decodedBytes: dates * 2 ** 20,
        outputValues: dates,
        modest: dates <= 16,
      };
    }
  );
  client.executeRun.mockImplementation(async (runId: string) =>
    seriesOf(queries.get(runId)!)
  );
}

// Each test its own point: results are cached across the module.
let nextPoint = 0;

async function opened(analysis: ReturnType<typeof store>) {
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 10 + ++nextPoint, lon: 20 },
    map,
    rect
  );
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  return analysis.windows[0];
}

it("review of interim43: Read all after Stop asks for a replan past its quote", async () => {
  const a = store();
  a.setComputeMode("ask");
  const times: TTime[] = [];
  pricedByDates(times);
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    onPartial({
      ...seriesOf({ start: 50, stop: 60 }),
      values: [50, ...Array(9).fill(NaN)],
      partial: { done: 1, total: 10, readUntil: 51 },
    });
    return new Promise(() => {});
  });
  const w = await opened(a);
  expect(w.preview?.fullBytes).toBe(100 * 2 ** 20);
  a.cancel(w.id);
  expect(w.status).toBe(PLOT_STATUS.CANCELLED);
  const calls = client.executeRun.mock.calls.length;
  client.planRun.mockResolvedValue({
    ...modest,
    modest: false,
    decodedBytes: 8 * 2 ** 30,
  });
  client.executeRun.mockResolvedValue(seriesOf({ start: 0, stop: 100 }));
  a.readAll(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(client.executeRun.mock.calls.length).toBe(calls);
  expect(w.status).toBe(PLOT_STATUS.CONFIRM);
});
