// Resume clicked twice while both run slots are busy takes one
// slot, not two (a file of its own: the run slots are module state).
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

// eslint-disable-next-line max-lines-per-function -- one sequence of slots.
it("two Resume clicks take one slot, released once; a Pause withdraws a waiting Resume", async () => {
  const analysis = store();
  const runs: ReturnType<typeof deferred<ReturnType<typeof result>>>[] = [];
  client.executeRun.mockImplementation(() => {
    const run = deferred<ReturnType<typeof result>>();
    runs.push(run);
    return run.promise;
  });
  const open = (lat: number) =>
    void analysis.openWindow(
      ANALYSIS_KINDS.POINT_SERIES,
      { kind: "point", lat, lon: 0 },
      map,
      rect
    );
  open(1);
  open(2);
  open(3);
  await flush();
  const [a] = analysis.windows.map((w) => w.id);
  analysis.setPaused(a, true);
  await flush();
  // The third took the first's slot; both slots busy (second and third).
  expect(client.executeRun).toHaveBeenCalledTimes(3);
  analysis.setPaused(a, false);
  analysis.setPaused(a, false);
  await flush();
  expect(analysis.windows[0].paused).toBe(true);
  // The third finishes: the first resumes with its one slot.
  runs[2].resolve(result(3));
  await flush();
  await flush();
  expect(analysis.windows[0].paused).toBe(false);
  // The first and second finish: both slots must be free again, so two new
  // plots read at once (with the double-counted slot only one could).
  // The second ends first, while the first still reads: its slot must
  // not go to the first's duplicate Resume.
  runs[1].resolve(result(2));
  await flush();
  await flush();
  runs[0].resolve(result(1));
  await flush();
  await flush();
  open(4);
  open(5);
  await flush();
  expect(client.executeRun).toHaveBeenCalledTimes(5);
  expect(analysis.windows[3].status).not.toBe(PLOT_STATUS.QUEUED);
  expect(analysis.windows[4].status).not.toBe(PLOT_STATUS.QUEUED);

  // Pause while a Resume waits: the slot, when it comes, is handed back.
  const d = analysis.windows[3].id;
  analysis.setPaused(d, true);
  open(6);
  await flush();
  expect(client.executeRun).toHaveBeenCalledTimes(6); // fifth and sixth busy
  analysis.setPaused(d, false); // waits for a slot
  analysis.setPaused(d, true); // ...and is withdrawn
  runs[4].resolve(result(5));
  await flush();
  await flush();
  expect(analysis.windows[3].paused).toBe(true);
  // The slot went back: a seventh reads at once.
  open(7);
  await flush();
  expect(client.executeRun).toHaveBeenCalledTimes(7);
  expect(analysis.windows[6].status).not.toBe(PLOT_STATUS.QUEUED);
});
