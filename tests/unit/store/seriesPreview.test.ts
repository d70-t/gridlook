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
const { AnalysisRunError } = await import("@/lib/analysis/analysisClient.ts");
const { decodeSession } = await import("@/lib/analysis/sessionLink.ts");
const { pendingChanges } = await import("@/ui/analysis/plotLayout.ts");
const { exceedsApproval, isStalePlan } =
  await import("@/store/analysisStore.ts");

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

it("v28: an expensive series shows the dates around the map's date at once", async () => {
  const analysis = store();
  const times: TTime[] = [];
  pricedByDates(times);
  const w = await opened(analysis);
  // Priced in full (100 MiB, Compute), then its first chunks: 16 MiB.
  expect(times[0]).toEqual({ start: 0, stop: 100 });
  expect(times[1]).toEqual({ start: 50, stop: 60 });
  expect(w.status).toBe(PLOT_STATUS.DONE);
  expect(w.result?.values).toHaveLength(10);
  expect(w.preview?.intent.time).toEqual({ start: 0, stop: 100 });
  expect(w.preview?.fullBytes).toBe(100 * 2 ** 20);
  // The first dates are not an unapplied edit; Discard keeps the request.
  expect(pendingChanges(w)).toEqual([]);
  analysis.discardDraft(w.id);
  expect(analysis.windows[0].draft.time).toEqual({ start: 0, stop: 100 });
  // A shared link keeps the request as asked, not its first dates.
  analysis.writeLink();
  const value = /plots=([^&:]+)/.exec(page.hash)![1];
  expect(decodeSession(decodeURIComponent(value)).plots[0].query.time).toEqual({
    start: 0,
    stop: 100,
  });
});

it("v28: Extend date range adds dates; Read all reads them all at the price shown", async () => {
  const analysis = store();
  const times: TTime[] = [];
  pricedByDates(times);
  const w = await opened(analysis);
  analysis.extendDates(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  // As many again, later first: 20 dates cost Compute, which was chosen.
  expect(analysis.windows[0].committed?.time).toEqual({ start: 50, stop: 70 });
  expect(analysis.windows[0].preview).toBeDefined();
  analysis.readAll(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const done = analysis.windows[0];
  expect(done.status).toBe(PLOT_STATUS.DONE);
  expect(done.result?.values).toHaveLength(100);
  expect(done.preview).toBeUndefined();
  expect(done.autoConfirm).toBeUndefined();
  // Only the dates not shown: the earlier ones in steps beside the plot, latest
  // first, then after. Earlier steps are read from their end.
  expect(times.slice(-6)).toEqual([
    { start: 40, stop: 50, fromEnd: true },
    { start: 30, stop: 40, fromEnd: true },
    { start: 20, stop: 30, fromEnd: true },
    { start: 10, stop: 20, fromEnd: true },
    { start: 0, stop: 10, fromEnd: true },
    { start: 70, stop: 100 },
  ]);
  expect(client.executeRun).toHaveBeenCalledTimes(8);
  // In date order: the earlier steps (each counts from 0 in this mock),
  // the 20 kept, the later piece.
  expect(done.result?.values.slice(0, 12)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1,
  ]);
  expect(done.result?.values.slice(48, 52)).toEqual([8, 9, 0, 1]);
  expect(done.result?.values.slice(68, 72)).toEqual([8, 9, 0, 1]);
  expect(done.committed?.time).toEqual({ start: 0, stop: 100 });
});

it("v28: a request too big to hold opens on the dates that fit and says why", async () => {
  const analysis = store();
  client.planRun.mockImplementation(
    async (_runId: string, _source: unknown, query: { time: TTime }) => {
      if (query.time.stop - query.time.start > 40) {
        throw new AnalysisRunError(
          "The result would hold 9,000,000 values; plots keep at most 4,000,000.",
          "input"
        );
      }
      return modest;
    }
  );
  client.executeRun.mockResolvedValue(seriesOf({ start: 0, stop: 1 }));
  const w = await opened(analysis);
  expect(w.status).toBe(PLOT_STATUS.DONE);
  expect(w.preview?.tooMany).toBe(9_000_000);
  // 90,000 values a date: one date, the map's.
  expect(w.committed?.time).toEqual({ start: 55, stop: 56 });
  analysis.readAll(w.id);
  expect(analysis.windows[0].committed?.time).toEqual({ start: 55, stop: 56 });
});

it("v28: other refusals still fail, and an explicit edit ends the preview", async () => {
  const analysis = store();
  client.planRun.mockRejectedValue(
    new AnalysisRunError("The variable has no time dimension.", "input")
  );
  const w = await opened(analysis);
  expect(w.status).toBe(PLOT_STATUS.ERROR);
  const times: TTime[] = [];
  pricedByDates(times);
  await analysis.retry(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(analysis.windows[0].preview).toBeDefined();
  void analysis.commit(w.id, {
    ...analysis.windows[0].committed!,
    time: { start: 0, stop: 8 },
  });
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  expect(analysis.windows[0].preview).toBeUndefined();
  expect(analysis.windows[0].result?.values).toHaveLength(8);
});

it("v28: a plan made stale by live data is planned again without asking", async () => {
  const analysis = store();
  let reads = 0;
  client.executeRun.mockImplementation(async () => {
    if (reads++ === 0) {
      throw new Error(
        "The source published new data since this plot was planned; plan it again."
      );
    }
    return seriesOf({ start: 0, stop: 4 });
  });
  const w = await opened(analysis);
  expect(w.status).toBe(PLOT_STATUS.DONE);
  expect(w.message).toBeUndefined();
  expect(client.planRun).toHaveBeenCalledTimes(2);
  expect(isStalePlan(new Error("plan it again"))).toBe(false);
  // Asked again only past the agreed price, or once a plan stops being modest.
  const big = { ...modest, modest: false, decodedBytes: 130 };
  expect(exceedsApproval(big, 100)).toBe(true);
  expect(exceedsApproval({ ...big, decodedBytes: 120 }, 100)).toBe(false);
  expect(exceedsApproval(big, undefined)).toBe(true);
  expect(exceedsApproval(modest, undefined)).toBe(false);
});

it("Extend reads only the new dates and keeps those shown (review of interim8)", async () => {
  const analysis = store();
  const times: TTime[] = [];
  pricedByDates(times);
  const w = await opened(analysis);
  analysis.extendDates(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  // Planned and read: only 60–70, joined after the 10 shown.
  expect(times.at(-1)).toEqual({ start: 60, stop: 70 });
  const done = analysis.windows[0];
  expect(done.committed?.time).toEqual({ start: 50, stop: 70 });
  expect(done.result?.values).toHaveLength(20);
  expect(done.result?.query.time).toEqual({ start: 50, stop: 70 });
});

it("an extended plot is as old as its kept dates: a publication reads again", async () => {
  const analysis = store();
  const times: TTime[] = [];
  pricedByDates(times);
  const w = await opened(analysis);
  // Date 52, already shown, is published again before Extend.
  analysis.livePublished(52, 53);
  analysis.extendDates(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  // Its kept dates are not joined to new ones: the whole range is read again.
  expect(times).not.toContainEqual({ start: 60, stop: 70 });
  expect(times.at(-1)).toEqual({ start: 50, stop: 70 });
});

it("a stopped Extend keeps the dates read and says exactly those", async () => {
  const analysis = store();
  const times: TTime[] = [];
  pricedByDates(times);
  const w = await opened(analysis);
  // The next read sends four of its ten dates, then waits.
  client.executeRun.mockImplementationOnce(
    async (
      _runId: string,
      _source: unknown,
      onPartial?: (r: unknown) => void
    ) => {
      onPartial?.({
        ...seriesOf({ start: 60, stop: 70 }),
        values: [0, 1, 2, 3, ...Array(6).fill(Number.NaN)],
        partial: { done: 4, total: 10, readUntil: 64 },
      });
      return new Promise(() => {});
    }
  );
  analysis.extendDates(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(analysis.windows[0].result?.values).toHaveLength(20);
  analysis.cancel(w.id);
  const stopped = analysis.windows[0];
  expect(stopped.status).toBe(PLOT_STATUS.DONE);
  // 10 shown + 4 read: the range and the result say 14, not 20.
  expect(stopped.committed?.time).toEqual({ start: 50, stop: 64 });
  expect(stopped.result?.values).toHaveLength(14);
  expect(stopped.result?.partial).toBeUndefined();
  expect(stopped.message).toMatch(/4 more dates added/);
  // Extend again reads on to the 70 asked and priced, no further.
  analysis.extendDates(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(times.at(-1)).toEqual({ start: 64, stop: 70 });
  expect(analysis.windows[0].committed?.time).toEqual({ start: 50, stop: 70 });
});

it("a failed Extend keeps the plot and its dates; Extend tries again", async () => {
  const analysis = store();
  const times: TTime[] = [];
  pricedByDates(times);
  const w = await opened(analysis);
  client.executeRun.mockRejectedValueOnce(new Error("storage said 503"));
  analysis.extendDates(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const kept = analysis.windows[0];
  expect(kept.status).toBe(PLOT_STATUS.DONE);
  expect(kept.committed?.time).toEqual({ start: 50, stop: 60 });
  expect(kept.result?.values).toHaveLength(10);
  expect(kept.message).toMatch(/could not be read.*503.*no dates added/i);
});

// eslint-disable-next-line max-lines-per-function
it("Extend earlier reads in steps beside the plot; a stop keeps what was read beside it (reviews of interim10 and interim30)", async () => {
  const analysis = store();
  const times: TTime[] = [];
  pricedByDates(times);
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 10 + ++nextPoint, lon: 20 },
    { variable: "tas", indices: { time: 95 } },
    rect
  );
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const id = analysis.windows[0].id;
  expect(analysis.windows[0].committed?.time).toEqual({ start: 90, stop: 100 });
  analysis.extendDates(id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(analysis.windows[0].committed?.time).toEqual({ start: 80, stop: 100 });
  // Twenty earlier dates: 70–80 first, then 60–70, which stops part way.
  const normal = client.executeRun.getMockImplementation()!;
  client.executeRun.mockImplementationOnce(normal);
  client.executeRun.mockImplementationOnce(
    async (
      _runId: string,
      _source: unknown,
      onPartial?: (r: unknown) => void
    ) => {
      // Read from its end: 67–69, beside the plot, are in.
      onPartial?.({
        ...seriesOf({ start: 60, stop: 70 }),
        values: [...Array(7).fill(Number.NaN), 7, 8, 9],
        partial: { done: 3, total: 10, readUntil: 70, readFrom: 67 },
      });
      return new Promise(() => {});
    }
  );
  analysis.extendDates(id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const reading = analysis.windows[0];
  expect(times.slice(-2)).toEqual([
    { start: 70, stop: 80, fromEnd: true },
    { start: 60, stop: 70, fromEnd: true },
  ]);
  // While 60–70 comes in, the plot shows the 30 dates beside each other.
  expect(reading.committed?.time).toEqual({ start: 70, stop: 100 });
  expect(reading.result?.values).toHaveLength(30);
  analysis.cancel(id);
  const stopped = analysis.windows[0];
  expect(stopped.status).toBe(PLOT_STATUS.DONE);
  // The whole step 70–80 and the three dates read of 60–70.
  expect(stopped.committed?.time).toEqual({ start: 67, stop: 100 });
  expect(stopped.result?.values).toHaveLength(33);
  expect(stopped.result?.values.slice(0, 3)).toEqual([7, 8, 9]);
  expect(stopped.message).toMatch(/13 more dates added/);
  // Extend again reads the rest of the step that stopped, to the 60 asked.
  analysis.extendDates(id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(times.at(-1)).toEqual({ start: 60, stop: 67, fromEnd: true });
  expect(analysis.windows[0].committed?.time).toEqual({ start: 60, stop: 100 });
  expect(analysis.windows[0].result?.values).toHaveLength(40);
});

it("a paused later Extend's result names the range its rows are of", async () => {
  const analysis = store();
  const times: TTime[] = [];
  pricedByDates(times);
  const w = await opened(analysis);
  client.executeRun.mockImplementationOnce(
    async (
      _runId: string,
      _source: unknown,
      onPartial?: (r: unknown) => void
    ) => {
      onPartial?.({
        ...seriesOf({ start: 60, stop: 70 }),
        values: [0, 1, 2, 3, ...Array(6).fill(Number.NaN)],
        partial: { done: 4, total: 10, readUntil: 64 },
      });
      return new Promise(() => {});
    }
  );
  analysis.extendDates(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const reading = analysis.windows[0].result!;
  // 20 rows, read until 64: the query is 50–70, not the 50–60 shown before.
  expect(reading.values).toHaveLength(20);
  expect(reading.query.time).toEqual({ start: 50, stop: 70 });
  expect(reading.partial?.readUntil).toBe(64);
});

it("a first preview that fails part way keeps its dates and retries the rest (review of interim10)", async () => {
  const analysis = store();
  const times: TTime[] = [];
  pricedByDates(times);
  const normal = client.executeRun.getMockImplementation()!;
  client.executeRun.mockImplementationOnce(
    async (
      _runId: string,
      _source: unknown,
      onPartial?: (r: unknown) => void
    ) => {
      onPartial?.({
        ...seriesOf({ start: 50, stop: 60 }),
        values: [0, 1, 2, 3, ...Array(6).fill(Number.NaN)],
        partial: { done: 4, total: 10, readUntil: 54 },
      });
      await flush();
      throw new Error("storage said 503");
    }
  );
  const w = await opened(analysis);
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const failed = analysis.windows[0];
  expect(failed.status).toBe(PLOT_STATUS.ERROR);
  expect(failed.result?.partial?.readUntil).toBe(54);
  expect(failed.message).toMatch(/503; 4 of 10 dates read are kept/);
  client.executeRun.mockImplementation(normal);
  analysis.continueRead(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(times.at(-1)).toEqual({ start: 54, stop: 60 });
  const done = analysis.windows[0];
  expect(done.status).toBe(PLOT_STATUS.DONE);
  expect(done.result?.values.slice(0, 6)).toEqual([0, 1, 2, 3, 0, 1]);
});

it("a Hovmöller over its own limit opens its first dates; unpriced Extend asks (review of interim10)", async () => {
  const analysis = store();
  const planned: TTime[] = [];
  client.planRun.mockImplementation(
    async (_runId: string, _source: unknown, query: { time: TTime }) => {
      planned.push(query.time);
      if (query.time.stop - query.time.start > 40) {
        throw new AnalysisRunError(
          "180 columns × 100 times is more than 2,000 values. Choose a bin width or a shorter time range.",
          "input"
        );
      }
      return { ...modest, modest: false, decodedBytes: 68 * 2 ** 20 };
    }
  );
  client.executeRun.mockImplementation(async () =>
    seriesOf({ start: 55, stop: 56 })
  );
  const w = await opened(analysis);
  // A first figure, not an error; the plot's own limit is kept.
  expect(w.status).not.toBe(PLOT_STATUS.ERROR);
  expect(w.preview?.limit).toBe(2_000);
  expect(w.preview?.tooMany).toBe(18_000);
  // The first dates' plan is not modest: under Ask it waits to be read.
  const first = analysis.windows[0];
  expect(first.status).toBe(PLOT_STATUS.CONFIRM);
});

it("a request over the chunk limit opens with All off (review of interim10)", async () => {
  const analysis = store();
  // Even the dates not shown are more than one plan may read.
  client.planRun.mockImplementation(
    async (_runId: string, _source: unknown, query: { time: TTime }) => {
      if (query.time.stop - query.time.start > 40) {
        throw new AnalysisRunError(
          "This request touches 400,001 stored chunks; at most 200,000 are read for one plot.",
          "input"
        );
      }
      return modest;
    }
  );
  client.executeRun.mockResolvedValue(seriesOf({ start: 50, stop: 60 }));
  const w = await opened(analysis);
  expect(w.preview?.refused).toMatch(/400,001 stored chunks/);
  const before = { ...analysis.windows[0].committed!.time! };
  analysis.readAll(w.id);
  expect(analysis.windows[0].committed?.time).toEqual(before);
});

it("a refused request's first dates fill the preview budget at its stated chunk size", async () => {
  const analysis = store();
  client.planRun.mockImplementation(
    async (_runId: string, _source: unknown, query: { time: TTime }) => {
      if (query.time.stop - query.time.start > 40) {
        throw new AnalysisRunError(
          "This request needs about 9000 MiB of working memory (100 stored chunks of about 0.5 MiB each); plots use at most 1024 MiB.",
          "input"
        );
      }
      return modest;
    }
  );
  client.executeRun.mockResolvedValue(seriesOf({ start: 40, stop: 70 }));
  const w = await opened(analysis);
  // 50 MiB over 10 stored time chunks: 5 MiB each, three in 16 MiB.
  expect(w.preview?.perGroup).toBe(5 * 2 ** 20);
  const time = analysis.windows[0].committed!.time!;
  expect(time.stop - time.start).toBe(30);
});

it("a scatter partner reads only the new dates when the plot extends (review of interim10)", async () => {
  const analysis = store();
  const times: TTime[] = [];
  const variables: string[] = [];
  const queries = new Map<string, { time: TTime; variable: string }>();
  client.planRun.mockImplementation(
    async (
      runId: string,
      _source: unknown,
      query: { time: TTime; variable: string }
    ) => {
      queries.set(runId, query);
      times.push(query.time);
      variables.push(query.variable);
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
    seriesOf(queries.get(runId)!.time)
  );
  const w = await opened(analysis);
  analysis.setPair(w.id, "hus");
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const read = () => times.filter((_, at) => variables[at] === "hus");
  expect(read()).toEqual([{ start: 50, stop: 60 }]);
  analysis.extendDates(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  void analysis.loadPair(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  // 50–60 kept, 60–70 read: not 50–70 again.
  expect(read()).toEqual([
    { start: 50, stop: 60 },
    { start: 60, stop: 70 },
  ]);
  expect(
    analysis.windows[0].companions?.pair?.results?.other.values
  ).toHaveLength(20);
});

it("performance review of interim30: a finished Extend is reused as the request it answers", async () => {
  const analysis = store();
  const times: TTime[] = [];
  pricedByDates(times);
  const w = await opened(analysis);
  const point = analysis.windows[0].committed!.geometry;
  analysis.extendDates(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(analysis.windows[0].committed?.time).toEqual({ start: 50, stop: 70 });
  // The same request in another plot: nothing is read again.
  void analysis.openWindow(ANALYSIS_KINDS.POINT_SERIES, point, map, rect);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const other = analysis.windows[1];
  const executed = client.executeRun.mock.calls.length;
  analysis.updateDraft(other.id, { time: { start: 50, stop: 70 } });
  void analysis.apply(other.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(analysis.windows[1].status).toBe(PLOT_STATUS.DONE);
  expect(analysis.windows[1].result?.values).toHaveLength(20);
  expect(client.executeRun.mock.calls.length).toBe(executed);
});

it("performance review of interim30: a request without a range shows its first dates, as with every date named", async () => {
  const analysis = store();
  const times: (TTime | undefined)[] = [];
  const queries = new Map<string, TTime>();
  client.planRun.mockImplementation(
    async (runId: string, _source: unknown, query: { time?: TTime }) => {
      // No range: every date (100 MiB, Compute).
      const time = query.time ?? { start: 0, stop: 100 };
      queries.set(runId, time);
      times.push(query.time);
      const dates = time.stop - time.start;
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
  const w = await opened(analysis);
  const intent = { ...w.preview!.intent };
  delete intent.time;
  // As a link restores it, with its optional range left out.
  void analysis.commit(w.id, intent);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const done = analysis.windows[0];
  expect(done.status).toBe(PLOT_STATUS.DONE);
  expect(done.result?.values).toHaveLength(10);
  expect(done.preview?.intent.time).toEqual({ start: 0, stop: 100 });
});

it("performance review of interim30: All reads what is left of a refused request when that fits", async () => {
  const analysis = store();
  const times: TTime[] = [];
  // 200,001 chunks for 100 dates: the 90 not shown touch 180,001.
  client.planRun.mockImplementation(
    async (_runId: string, _source: unknown, query: { time: TTime }) => {
      times.push(query.time);
      if (query.time.stop - query.time.start === 100) {
        throw new AnalysisRunError(
          "This request touches 200,001 stored chunks; at most 200,000 are read for one plot.",
          "input"
        );
      }
      return modest;
    }
  );
  client.executeRun.mockImplementation(async () =>
    seriesOf(times[times.length - 1])
  );
  const w = await opened(analysis);
  expect(w.preview?.refused).toMatch(/200,001 stored chunks/);
  const asked = times.length;
  analysis.readAll(w.id);
  for (let k = 0; k < 16; k++) {
    await flush();
  }
  // The dates on either side, not the whole request again.
  expect(times.slice(asked).every((t) => t.stop - t.start < 100)).toBe(true);
  expect(times.length).toBeGreaterThan(asked);
});

// eslint-disable-next-line max-lines-per-function
it("reads an extended plot again when a live source republished its kept dates meanwhile", async () => {
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
  // Date d holds d; once republished, date 52 holds 1052.
  let republished = false;
  const valuesOf = ({ start, stop }: TTime) =>
    Array.from({ length: stop - start }, (_, t) =>
      republished && start + t === 52 ? 1052 : start + t
    );
  const read = (time: TTime) => ({
    ...result(time.start),
    values: valuesOf(time),
    dims: ["time"],
    shape: [time.stop - time.start],
  });
  client.executeRun.mockImplementation(async (runId: string) =>
    read(queries.get(runId)!)
  );
  const w = await opened(analysis);
  expect(w.result?.values[2]).toBe(52);
  // The later dates are read; date 52, shown already, is republished.
  let finish!: () => void;
  client.executeRun.mockImplementationOnce(
    (runId: string) =>
      new Promise(
        (resolve) => (finish = () => resolve(read(queries.get(runId)!)))
      )
  );
  analysis.extendDates(w.id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  republished = true;
  analysis.livePublished(52, 52);
  finish();
  for (let k = 0; k < 12; k++) {
    await flush();
  }
  const done = analysis.windows[0];
  expect(done.status).toBe(PLOT_STATUS.DONE);
  expect(done.committed?.time).toEqual({ start: 50, stop: 70 });
  expect(done.result?.values[2]).toBe(1052);
  expect(done.result?.values).toEqual(valuesOf({ start: 50, stop: 70 }));
});

// eslint-disable-next-line max-lines-per-function
it("keeps an earlier step's dates read when a live source publishes dates it does not hold", async () => {
  const analysis = store();
  pricedByDates([]);
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 10 + ++nextPoint, lon: 20 },
    { variable: "tas", indices: { time: 95 } },
    rect
  );
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const id = analysis.windows[0].id;
  analysis.extendDates(id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const normal = client.executeRun.getMockImplementation()!;
  client.executeRun.mockImplementationOnce(normal);
  client.executeRun.mockImplementationOnce(
    async (
      _runId: string,
      _source: unknown,
      onPartial?: (r: unknown) => void
    ) => {
      onPartial?.({
        ...seriesOf({ start: 60, stop: 70 }),
        values: [...Array(7).fill(Number.NaN), 7, 8, 9],
        partial: { done: 3, total: 10, readUntil: 70, readFrom: 67 },
      });
      return new Promise(() => {});
    }
  );
  analysis.extendDates(id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  // Date 5, far from every date read, is published; then Stop.
  analysis.livePublished(5, 5);
  analysis.cancel(id);
  const stopped = analysis.windows[0];
  expect(stopped.committed?.time).toEqual({ start: 67, stop: 100 });
  expect(stopped.result?.values).toHaveLength(33);
  expect(stopped.message).toMatch(/13 more dates added/);

  // Date 65, among those just read, is published: they are not kept.
  analysis.extendDates(id);
  client.executeRun.mockImplementationOnce(
    async (
      _runId: string,
      _source: unknown,
      onPartial?: (r: unknown) => void
    ) => {
      onPartial?.({
        ...seriesOf({ start: 60, stop: 67 }),
        values: [...Array(4).fill(Number.NaN), 4, 5, 6],
        partial: { done: 3, total: 7, readUntil: 67, readFrom: 64 },
      });
      return new Promise(() => {});
    }
  );
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  analysis.livePublished(65, 65);
  analysis.cancel(id);
  expect(analysis.windows[0].committed?.time).toEqual({ start: 67, stop: 100 });
});

// eslint-disable-next-line max-lines-per-function -- one store sequence, step by step.
it("review of interim41: a preview and All of a request in slices read only its own dates", async () => {
  const { rowCount, rowIndices } = await import("@/lib/analysis/timeRows.ts");
  const analysis = store();
  const asked: TTime[] = [];
  const queries = new Map<string, TTime>();
  // 1 MiB a selected date (not a stored index between slices).
  client.planRun.mockImplementation(
    async (runId: string, _source: unknown, query: { time: TTime }) => {
      queries.set(runId, query.time);
      asked.push(query.time);
      const dates = rowCount(query.time);
      return {
        ...modest,
        chunks: dates,
        decodedBytes: dates * 2 ** 20,
        outputValues: dates,
        modest: dates <= 16,
      };
    }
  );
  client.executeRun.mockImplementation(async (runId: string) => {
    const time = queries.get(runId)!;
    const ids = rowIndices(time);
    return {
      ...result(time.start),
      query: { time },
      values: ids,
      dims: ["time"],
      shape: [ids.length],
      time: { ...summary.time, raw: ids },
    };
  });
  // 0–9 and 90–99: the map's date (55) lies in the gap. Opened as asked
  // (a link, a session): priced in full, then its first dates.
  const sliced = {
    start: 0,
    stop: 100,
    runs: [
      [0, 10],
      [90, 100],
    ] as [number, number][],
  };
  const geometry = { kind: "point" as const, lat: 10 + ++nextPoint, lon: 20 };
  void analysis.openWindow(ANALYSIS_KINDS.POINT_SERIES, geometry, map, rect, {
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    geometry,
    variable: "tas",
    fixed: {},
    time: sliced,
  } as never);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const w = analysis.windows[0];
  const inside = (time: TTime) =>
    rowIndices(time).every((at) => at < 10 || at >= 90);
  expect(asked.length).toBeGreaterThan(1);
  expect(asked.every(inside)).toBe(true);
  const shown = analysis.windows[0].result!.values;
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.every((at) => at < 10 || at >= 90)).toBe(true);
  analysis.readAll(w.id);
  for (let k = 0; k < 12; k++) {
    await flush();
  }
  const done = analysis.windows[0];
  expect(asked.filter((t) => !inside(t))).toEqual([]);
  expect(done.result?.values).toEqual([
    ...Array.from({ length: 10 }, (_, k) => k),
    ...Array.from({ length: 10 }, (_, k) => 90 + k),
  ]);
  expect(done.committed?.time).toEqual(sliced);
});

// eslint-disable-next-line max-lines-per-function -- one preview and its streamed extension share the counter.
it("interim47 streams a forward Extend without traversing the kept value column on every part", async () => {
  const a = store();
  a.setComputeMode("ask");
  const times: TTime[] = [];
  pricedByDates(times);
  const w = await opened(a);
  expect(w.status).toBe(PLOT_STATUS.DONE);
  const prefixRows = w.result!.values.length;
  // Count reads of the frozen column itself; unaffected by CPU speed and garbage collection.
  let visits = 0;
  const instrument = (values: number[]) =>
    new Proxy(values, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          visits++;
        }
        return Reflect.get(target, key, receiver);
      },
    });
  let parts = 0;
  client.executeRun.mockImplementation(async (id, _source, onPartial) => {
    const prefix = w.extending!.kept;
    prefix.values = instrument(prefix.values);
    const q = client.planRun.mock.calls.find(([run]) => run === id)![2];
    const time = q.time;
    const rows = time.stop - time.start;
    const values = new Array<number>(rows).fill(Number.NaN);
    for (let row = 0; row < rows; row++) {
      values[row] = time.start + row;
      onPartial?.({
        ...seriesOf(time),
        query: q,
        values,
        partial: {
          done: row + 1,
          total: rows,
          readUntil: time.start + row + 1,
        },
      });
      parts++;
    }
    return { ...seriesOf(time), query: q, values };
  });
  a.extendDates(w.id);
  for (let i = 0; i < 8; i++) {
    await flush();
  }
  expect(w.status).toBe(PLOT_STATUS.DONE);
  expect(parts).toBeGreaterThan(3);
  console.log("Forward Extend", {
    prefixRows,
    publications: parts,
    keptValueReads: visits,
  });
  expect(visits).toBeLessThanOrEqual(2 * prefixRows);
});
