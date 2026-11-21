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

it("updates an existing continued series in place as more rows arrive", async () => {
  const analysis = store();
  let push!: (partial: unknown) => void;
  const start = deferred<ReturnType<typeof result>>();
  const next = deferred<ReturnType<typeof result>>();
  client.executeRun
    .mockImplementationOnce((_id, _source, onPartial) => {
      push = onPartial;
      return start.promise;
    })
    .mockImplementationOnce((_id, _source, onPartial) => {
      push = onPartial;
      return next.promise;
    });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 34.5, lon: 46.5 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  push({
    ...result(1),
    values: [1, 2, NaN, NaN],
    partial: { done: 1, total: 2, readUntil: 2 },
  });
  analysis.cancel(w.id);
  analysis.continueRead(w.id);
  await flush();
  const tail = [3, NaN];
  push({
    ...result(1),
    values: tail,
    partial: { done: 1, total: 3, readUntil: 3 },
  });
  const first = w.result?.values;
  tail[1] = 4;
  push({
    ...result(1),
    values: tail,
    partial: { done: 2, total: 3, readUntil: 4 },
  });
  const second = w.result?.values;
  next.resolve({ ...result(1), values: tail });
  start.resolve(result(0));
  await flush();
  expect(second).toEqual([1, 2, 3, 4]);
  expect(second).toBe(first);
});

it("review of interim26: Continue never joins another place's dates", async () => {
  const analysis = store();
  // Point A reads two of four dates, then stops.
  let push: (partial: unknown) => void = () => {};
  const a = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    push = onPartial;
    return a.promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 61.25, lon: 71.5 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  const asked = { ...w.committed!.time! };
  push({
    ...result(1),
    values: [1, 2, Number.NaN, Number.NaN],
    partial: { done: 2, total: 4, readUntil: 2 },
  });
  analysis.cancel(w.id);
  // Point B, same dates, applied and stopped before its first values.
  const b = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce(() => b.promise);
  analysis.updateDraft(w.id, {
    geometry: { kind: "point", lat: 62.25, lon: 72.5 },
  });
  void analysis.apply(w.id);
  await flush();
  analysis.cancel(w.id);
  // Continue reads B from its start; A's 1 and 2 are not B's.
  client.planRun.mockClear();
  client.executeRun.mockResolvedValueOnce({
    ...result(30),
    values: [10, 20, 30, 40],
  });
  analysis.continueRead(w.id);
  for (
    let k = 0;
    k < 20 && analysis.windows[0].status !== PLOT_STATUS.DONE;
    k++
  ) {
    await flush();
  }
  const planned = client.planRun.mock.calls.at(-1)?.[2];
  expect(planned?.geometry).toEqual({ kind: "point", lat: 62.25, lon: 72.5 });
  expect(planned?.time).toEqual(asked);
  expect(analysis.windows[0].result!.values).toEqual([10, 20, 30, 40]);
});

it("asks for the price of a replacement query when Continue has only the old point's partial", async () => {
  const analysis = store();
  analysis.setComputeMode("ask");
  let publish!: (partial: unknown) => void;
  const first = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    publish = onPartial;
    return first.promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 30, lon: 40 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  publish({
    ...result(1),
    values: [1, 2, Number.NaN, Number.NaN],
    partial: { done: 2, total: 4, readUntil: 2 },
  });
  analysis.cancel(w.id);
  const bytes = 8 * 2 ** 30;
  client.planRun.mockResolvedValue({
    ...modest,
    modest: false,
    decodedBytes: bytes,
  });
  client.executeRun.mockResolvedValue({ ...result(9), values: [9, 8, 7, 6] });
  analysis.updateDraft(w.id, { geometry: { kind: "point", lat: 31, lon: 41 } });
  void analysis.apply(w.id);
  await flush();
  expect(w.status).toBe(PLOT_STATUS.CONFIRM);
  expect(w.estimate?.decodedBytes).toBe(bytes);
  analysis.cancel(w.id);
  analysis.continueRead(w.id);
  await flush();
  expect(client.executeRun).toHaveBeenCalledTimes(1);
  expect(w.status).toBe(PLOT_STATUS.CONFIRM);
});

it("releases the continued prefix when its completed window closes without Undo", async () => {
  const analysis = store();
  let publish!: (partial: unknown) => void;
  const first = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    publish = onPartial;
    return first.promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 72, lon: 42 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  publish({
    ...result(1),
    values: [1, 2, Number.NaN, Number.NaN],
    partial: { done: 2, total: 4, readUntil: 2 },
  });
  analysis.cancel(w.id);
  client.executeRun.mockResolvedValue({ ...result(1), values: [3, 4] });

  // Observe only strong Maps that retain this plot's stopped result.
  const maps: Map<unknown, unknown>[] = [];
  const set = Map.prototype.set;
  try {
    Map.prototype.set = function (key, value) {
      if (key === w.id && value?.partial?.readUntil === 2) {
        maps.push(this);
      }
      return set.call(this, key, value);
    };
    analysis.continueRead(w.id);
  } finally {
    Map.prototype.set = set;
  }
  await flush();
  expect(w.status).toBe(PLOT_STATUS.DONE);
  expect(w.result?.values).toEqual([1, 2, 3, 4]);
  analysis.close(w.id, false);
  expect(analysis.windows).toHaveLength(0);
  expect(maps.some((map) => map.has(w.id))).toBe(false);
});

it("keeps the new price prompt when Continue must replace a republished prefix", async () => {
  const analysis = store();
  let publish!: (partial: unknown) => void;
  const first = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    publish = onPartial;
    return first.promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 71, lon: 41 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  publish({
    ...result(1),
    values: [1, 2, Number.NaN, Number.NaN],
    partial: { done: 2, total: 4, readUntil: 2 },
  });
  analysis.cancel(w.id);
  analysis.livePublished(0, 1);
  const decodedBytes = 8 * 2 ** 30;
  client.planRun.mockResolvedValue({
    ...modest,
    modest: false,
    needsConfirmation: true,
    decodedBytes,
  });
  client.executeRun.mockResolvedValue({
    ...result(1),
    values: [10, 20, 30, 40],
  });
  analysis.continueRead(w.id);
  await flush();
  expect(client.executeRun).toHaveBeenCalledTimes(1);
  expect(w.status).toBe(PLOT_STATUS.CONFIRM);
  expect(w.estimate?.decodedBytes).toBe(decodedBytes);
});

it("refreshes a stopped prefix if the live source republishes its dates before Continue", async () => {
  const analysis = store();
  let publish!: (partial: unknown) => void;
  const first = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    publish = onPartial;
    return first.promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 32, lon: 42 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  const full = w.committed!.time!;
  publish({
    ...result(1),
    values: [1, 2, Number.NaN, Number.NaN],
    partial: { done: 2, total: 4, readUntil: 2 },
  });
  analysis.cancel(w.id);
  analysis.livePublished(0, 1);
  const updated = [10, 20, 30, 40];
  const reads = new Map<string, { start: number; stop: number }>();
  client.planRun.mockImplementation(async (id, _source, query) => {
    reads.set(id, query.time);
    return modest;
  });
  client.executeRun.mockImplementation(async (id) => {
    const { start, stop } = reads.get(id)!;
    return { ...result(0), values: updated.slice(start, stop) };
  });
  analysis.continueRead(w.id);
  await flush();
  expect(w.status).toBe(PLOT_STATUS.DONE);
  expect(w.result?.values).toEqual(updated.slice(full.start, full.stop));
});

it("keeps Continue values aligned when the replacement interval ends earlier", async () => {
  const analysis = store();
  let publish!: (partial: unknown) => void;
  const first = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    publish = onPartial;
    return first.promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 33, lon: 43 },
    map,
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
  const second = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce(() => second.promise);
  analysis.updateDraft(w.id, { time: { start: 0, stop: 3 } });
  void analysis.apply(w.id);
  await flush();
  analysis.cancel(w.id);
  const values = [1, 2, 3, 4];
  const reads = new Map<string, { start: number; stop: number }>();
  client.planRun.mockImplementation(async (id, _source, query) => {
    reads.set(id, query.time);
    return modest;
  });
  client.executeRun.mockImplementation(async (id) => {
    const { start, stop } = reads.get(id)!;
    return { ...result(0), values: values.slice(start, stop) };
  });
  analysis.continueRead(w.id);
  await flush();
  expect(w.result?.query.time).toEqual({ start: 0, stop: 3 });
  expect(w.result?.values).toEqual([1, 2, 3]);
});

it("remembers republished dates across more partial updates before Stop and Continue", async () => {
  const analysis = store();
  let report!: (partial: unknown) => void;
  const first = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    report = onPartial;
    return first.promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 41, lon: 51 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  const partial = (values: number[], until: number) => ({
    ...result(0),
    values,
    partial: { done: until, total: 4, readUntil: until },
  });
  report(partial([1, 2, NaN, NaN], 2));
  analysis.livePublished(0, 1);
  report(partial([1, 2, 3, NaN], 3));
  analysis.cancel(w.id);

  const updated = [10, 20, 3, 40];
  const ranges = new Map<string, { start: number; stop: number }>();
  client.planRun.mockImplementation(async (id, _source, query) => {
    ranges.set(id, query.time);
    return modest;
  });
  client.executeRun.mockImplementation(async (id) => {
    const { start, stop } = ranges.get(id)!;
    return { ...result(0), values: updated.slice(start, stop) };
  });
  analysis.continueRead(w.id);
  await flush();
  expect(w.status).toBe(PLOT_STATUS.DONE);
  expect(w.result?.values).toEqual(updated);
});

it("prices a newly extended date range after its full-read prompt was cancelled", async () => {
  const analysis = store();
  analysis.setComputeMode("ask");
  let report!: (partial: unknown) => void;
  const first = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    report = onPartial;
    return first.promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 42, lon: 52 },
    map,
    rect,
    {
      version: 1,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      variable: "tas",
      geometry: { kind: "point", lat: 42, lon: 52 },
      fixed: {},
      time: { start: 0, stop: 2 },
    }
  );
  await flush();
  const w = analysis.windows[0];
  expect(w.committed?.time).toEqual({ start: 0, stop: 2 });
  report({
    ...result(1),
    values: [1, NaN],
    partial: { done: 1, total: 2, readUntil: 1 },
  });
  analysis.cancel(w.id);
  const eightGiB = 8 * 2 ** 30;
  client.planRun.mockResolvedValue({
    ...modest,
    decodedBytes: eightGiB,
    modest: false,
  });
  analysis.updateDraft(w.id, { time: { start: 0, stop: 4 } });
  void analysis.apply(w.id);
  await flush();
  expect(w.status).toBe(PLOT_STATUS.CONFIRM);
  analysis.cancel(w.id);
  client.executeRun.mockResolvedValue({ ...result(2), values: [2, 3, 4] });
  analysis.continueRead(w.id);
  await flush();
  expect(client.executeRun).toHaveBeenCalledTimes(1);
  expect(w.status).toBe(PLOT_STATUS.CONFIRM);
});

// eslint-disable-next-line max-lines-per-function
it("keeps a refreshed whole read out of the cache under its continuation's dates", async () => {
  const analysis = store();
  let report!: (partial: unknown) => void;
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    report = onPartial;
    return deferred<ReturnType<typeof result>>().promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 43, lon: 53 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  report({
    ...result(0),
    values: [1, 2, NaN, NaN],
    partial: { done: 2, total: 4, readUntil: 2 },
  });
  analysis.cancel(w.id);

  // Continue reads [2, 4); the source republishes all four dates meanwhile (its
  // values change everywhere), so the whole request is read once more, from one
  // publication.
  const updated = [10, 20, 30, 40];
  const ranges = new Map<string, { start: number; stop: number }>();
  client.planRun.mockImplementation(async (id, _source, query) => {
    ranges.set(id, query.time);
    return modest;
  });
  const suffix = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce(() => suffix.promise);
  client.executeRun.mockImplementation(async (id) => {
    const { start, stop } = ranges.get(id)!;
    return { ...result(0), values: updated.slice(start, stop) };
  });
  analysis.continueRead(w.id);
  await flush();
  analysis.livePublished(0, 3);
  suffix.resolve({ ...result(0), values: [3, 4] });
  for (let i = 0; i < 4; i++) {
    await flush();
  }
  expect(w.status).toBe(PLOT_STATUS.DONE);
  expect(w.result?.values).toEqual(updated);

  // The dates [2, 4) asked on their own are those dates, not all four.
  const calls = client.executeRun.mock.calls.length;
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 43, lon: 53 },
    map,
    rect,
    {
      version: 1,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      variable: "tas",
      geometry: { kind: "point", lat: 43, lon: 53 },
      fixed: {},
      time: { start: 2, stop: 4 },
    }
  );
  for (let i = 0; i < 3; i++) {
    await flush();
  }
  const suffixOnly = analysis.windows[1];
  expect(suffixOnly.status).toBe(PLOT_STATUS.DONE);
  expect(suffixOnly.result?.values).toEqual([30, 40]);
  expect(client.executeRun.mock.calls.length).toBe(calls + 1);
});

it("prices a much larger replacement read after a live publication during execution", async () => {
  const analysis = store();
  analysis.setComputeMode("ask");
  const request = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce(() => request.promise);
  const opening = analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 11, lon: 21 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  expect(client.executeRun).toHaveBeenCalledTimes(1);
  analysis.livePublished(0, 0);
  const cost = 8 * 2 ** 30;
  client.planRun.mockResolvedValue({
    ...modest,
    modest: false,
    decodedBytes: cost,
  });
  client.executeRun.mockResolvedValue({ ...result(20), values: [20, 2, 3, 4] });
  request.resolve({ ...result(1), values: [1, 2, 3, 4] });
  await opening;
  await flush();
  await flush();
  const count = client.executeRun.mock.calls.length;
  const status = w.status;
  analysis.cancel(w.id);
  expect(count).toBe(1);
  expect(status).toBe(PLOT_STATUS.CONFIRM);
});

it("rereads a corrected time step even after 256 later publications outside the plot", async () => {
  const analysis = store();
  const geometry = { kind: "point" as const, lat: 12, lon: 23 };
  const request = deferred<ReturnType<typeof result> & { query: unknown }>();
  client.executeRun.mockImplementationOnce(() => request.promise);
  const open = analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    geometry,
    map,
    rect,
    {
      version: 1,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      variable: "tas",
      geometry,
      fixed: {},
      time: { start: 0, stop: 2 },
    }
  );
  await flush();
  const window = analysis.windows[0];
  const query = window.committed!;
  analysis.livePublished(0, 0);
  for (let update = 0; update < 256; update++) {
    analysis.livePublished(3, 3);
  }
  client.executeRun.mockResolvedValue({
    ...result(10),
    query,
    values: [10, 2],
  });
  request.resolve({ ...result(1), query, values: [1, 2] });
  await open;
  await flush();
  await flush();
  expect(window.status).toBe(PLOT_STATUS.DONE);
  expect(window.result?.values).toEqual([10, 2]);
});

// eslint-disable-next-line max-lines-per-function
it("keeps a republished prefix through a continuation after the journal rolls over", async () => {
  const analysis = store();
  client.describeVariable.mockResolvedValue({
    ...summary,
    shape: [5, 768],
    time: { ...summary.time, raw: [0, 1, 2, 3, 4] },
  });
  let report!: (partial: unknown) => void;
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    report = onPartial;
    return deferred<ReturnType<typeof result>>().promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 51, lon: 54 },
    map,
    rect,
    {
      version: 1,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      variable: "tas",
      geometry: { kind: "point", lat: 51, lon: 54 },
      fixed: {},
      time: { start: 0, stop: 4 },
    }
  );
  await flush();
  const w = analysis.windows[0];
  report({
    ...result(0),
    values: [1, 2, NaN, NaN],
    partial: { done: 2, total: 4, readUntil: 2 },
  });
  analysis.cancel(w.id);

  // Continue reads [2, 4); the source republishes [0, 1] meanwhile, so the
  // whole request is read once more, from one publication.
  const updated = [10, 20, 3, 4];
  const ranges = new Map<string, { start: number; stop: number }>();
  client.planRun.mockImplementation(async (id, _source, query) => {
    ranges.set(id, query.time);
    return modest;
  });
  const suffix = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce(() => suffix.promise);
  client.executeRun.mockImplementation(async (id) => {
    const { start, stop } = ranges.get(id)!;
    return { ...result(0), values: updated.slice(start, stop) };
  });
  analysis.continueRead(w.id);
  await flush();
  analysis.livePublished(0, 1);
  for (let update = 0; update < 256; update++) {
    analysis.livePublished(4, 4);
  }
  suffix.resolve({ ...result(0), values: [3, 4] });
  for (let i = 0; i < 4; i++) {
    await flush();
  }
  expect(w.status).toBe(PLOT_STATUS.DONE);
  expect(w.result?.values).toEqual(updated);
});

it("maintainability review of interim41: a refresh queued before a source switch plans the old source once", async () => {
  const analysis = store();
  const request = deferred<ReturnType<typeof result>>();
  client.executeRun.mockImplementationOnce(() => request.promise);
  const opening = analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 11, lon: 21 },
    map,
    rect
  );
  await flush();
  const plans = () =>
    client.planRun.mock.calls.filter((call) =>
      (call[1] as { key: string }).key.startsWith(`${source.key}|`)
    ).length;
  // A publication of a date the run reads, while it reads.
  analysis.livePublished(0, 0);
  request.resolve({ ...result(1), values: [1, 2, 3, 4] });
  await opening;
  // The refresh is queued; the user switches to B before it runs.
  const before = plans();
  analysis.setActiveSource(
    { ...source, key: "src#2", store: "https://example.org/b.zarr" },
    { ...ref, ref: "https://example.org/b.zarr" },
    "B"
  );
  await flush();
  await flush();
  expect(analysis.windows[0]?.snapshot).toBe(true);
  expect(plans() - before).toBe(0);
  expect(plans()).toBe(1);
});

it("interim49: Continue after a section stopped part way reads it again whole", async () => {
  const analysis = store();
  let push!: (partial: unknown) => void;
  const start = deferred<ReturnType<typeof result>>();
  const again = deferred<unknown>();
  client.executeRun
    .mockImplementationOnce((_id, _source, onPartial) => {
      push = onPartial;
      return start.promise;
    })
    .mockImplementationOnce((_id, _source, onPartial) => {
      push = onPartial;
      return again.promise;
    });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 34.5, lon: 46.5 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  const asked = w.committed!.time!;
  // A curtain of 5 samples × 2 levels, 1 of 2 chunks in.
  push({
    ...result(1),
    values: [1, NaN, 2, NaN, 3, NaN, 4, NaN, 5, NaN],
    shape: [5, 2],
    partial: { done: 1, total: 2, readUntil: asked.start, chunks: true },
  });
  analysis.cancel(w.id);
  analysis.continueRead(w.id);
  await flush();
  // Not joined: the window waits for the whole request read again.
  expect(w.result).toBeUndefined();
  expect(client.executeRun).toHaveBeenCalledTimes(2);
  expect(w.committed!.time).toEqual(asked);
  const whole = {
    ...result(1),
    values: [1, 6, 2, 7, 3, 8, 4, 9, 5, 10],
    shape: [5, 2],
  };
  again.resolve(whole);
  start.resolve(result(0));
  await flush();
  expect(w.result?.shape).toEqual([5, 2]);
  expect(w.result?.values).toEqual(whole.values);
});
