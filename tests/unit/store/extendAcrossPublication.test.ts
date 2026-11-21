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
const { rowIndices } = await import("@/lib/analysis/timeRows.ts");

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

type TRuns = TTime & { runs?: [number, number][] };

// eslint-disable-next-line max-lines-per-function -- one store sequence, step by step.
it("review of interim41: an Extend read across a publication of its new dates is read again", async () => {
  const analysis = store();
  const queries = new Map<string, TTime>();
  client.planRun.mockImplementation(
    async (runId: string, _source: unknown, query: { time: TTime }) => {
      queries.set(runId, query.time);
      const dates = query.time.stop - query.time.start;
      return {
        ...modest,
        chunks: dates,
        decodedBytes: dates * 2 ** 20,
        modest: dates <= 16,
      };
    }
  );
  // Date d holds d; once republished, date 62 holds 1062.
  let republished = false;
  const read = ({ start, stop }: TTime) => ({
    ...result(start),
    values: Array.from({ length: stop - start }, (_, t) =>
      republished && start + t === 62 ? 1062 : start + t
    ),
    time: {
      ...summary.time,
      raw: Array.from({ length: stop - start }, (_, i) => start + i),
    },
    dims: ["time"],
    shape: [stop - start],
  });
  client.executeRun.mockImplementation(async (runId: string) =>
    read(queries.get(runId)!)
  );
  const w = await opened(analysis);
  expect(w.committed?.time).toEqual({ start: 50, stop: 60 });
  // The later dates are read before date 62 is republished.
  let finish!: () => void;
  client.executeRun.mockImplementationOnce(
    (runId: string) =>
      new Promise((resolve) => {
        const held = read(queries.get(runId)!);
        finish = () => resolve(held);
      })
  );
  analysis.extendDates(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  republished = true;
  analysis.livePublished(62, 62);
  finish();
  for (let k = 0; k < 12; k++) {
    await flush();
  }
  const done = analysis.windows[0];
  expect(done.status).toBe(PLOT_STATUS.DONE);
  expect(done.committed?.time).toEqual({ start: 50, stop: 70 });
  expect(done.result?.values[12]).toBe(1062);
  await analysis.commit(w.id, { ...done.committed! });
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  expect(analysis.windows[0].result?.values[12]).toBe(1062);
});

it("review of interim41: Automatic asks before a stale-plan retry above its ceiling", async () => {
  const analysis = store();
  analysis.setComputeMode("auto");
  let plans = 0;
  const sizes = [1920, 2304];
  const actual: number[] = [];
  client.planRun.mockImplementation(async () => ({
    ...modest,
    modest: false,
    decodedBytes: sizes[plans++] * 2 ** 20,
  }));
  client.executeRun.mockImplementation(async () => {
    actual.push(sizes[plans - 1]);
    if (actual.length === 1) {
      throw new Error("published new data since this plot was planned");
    }
    return result(1);
  });
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 64, lon: 4 },
    { ...map, indices: { time: 2 } },
    rect
  );
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(actual).toEqual([1920]);
  expect(analysis.windows[0].status).toBe(PLOT_STATUS.CONFIRM);
});

it("review of interim41: Ask first asks again when an Extend's plan costs far more than quoted", async () => {
  const a = store();
  a.setComputeMode("ask");
  const plans: TTime[] = [];
  pricedByDates(plans);
  const w = await opened(a);
  expect(w.committed?.time).toEqual({ start: 50, stop: 60 });
  expect(w.preview?.perGroup).toBe(10 * 2 ** 20);
  let count = 0;
  client.planRun.mockImplementation(async () => ({
    ...modest,
    modest: false,
    decodedBytes: 8 * 2 ** 30,
  }));
  client.executeRun.mockImplementation(async () => {
    count++;
    return seriesOf({ start: 60, stop: 70 });
  });
  a.extendDates(w.id);
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  expect(count).toBe(0);
  expect(a.windows[0].status).toBe(PLOT_STATUS.CONFIRM);
});

// eslint-disable-next-line max-lines-per-function -- one store sequence, step by step.
it("review of interim41: Continue after narrowing the selection keeps only the selected dates", async () => {
  client.describeVariable.mockResolvedValue({
    ...summary,
    shape: [4, 768],
    time: { ...summary.time, raw: [0, 200, 1, 2] },
  });
  const analysis = store();
  let publish!: (partial: unknown) => void;
  let hold!: (value: unknown) => void;
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    publish = onPartial;
    return new Promise((resolve) => (hold = resolve));
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 33, lon: 43 },
    { ...map, indices: { time: 2 } },
    rect
  );
  await flush();
  const w = analysis.windows[0];
  publish({
    ...result(1),
    values: [1, 2, NaN, NaN],
    partial: { done: 2, total: 4, readUntil: 2 },
  });
  analysis.cancel(w.id);
  void hold;
  client.executeRun.mockImplementationOnce(() => new Promise(() => {}));
  analysis.updateDraft(w.id, {
    time: {
      start: 0,
      stop: 4,
      runs: [
        [0, 1],
        [2, 4],
      ],
    },
  });
  void analysis.apply(w.id);
  await flush();
  analysis.cancel(w.id);
  // Stored date d holds d + 1; a read returns only its selected rows.
  const reads = new Map<string, TRuns>();
  client.planRun.mockImplementation(async (id, _source, query) => {
    reads.set(id, query.time);
    return modest;
  });
  client.executeRun.mockImplementation(async (id) => ({
    ...result(0),
    values: rowIndices(reads.get(id)!).map((d) => d + 1),
  }));
  analysis.continueRead(w.id);
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  expect(w.result?.query.time).toEqual({
    start: 0,
    stop: 4,
    runs: [
      [0, 1],
      [2, 4],
    ],
  });
  expect(w.result?.values).toEqual([1, 3, 4]);
});
