import { beforeEach, expect, it, vi } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

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
const { PLOT_STATUS, readSessionParam, useAnalysisStore } =
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
/** After the trailing link write (writeLinkSoon). */
const linkWritten = () => new Promise((resolve) => setTimeout(resolve, 200));

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

it("preserves temperature differences when undo restores a closed plot from another dataset", async () => {
  const analysis = store();
  const { convertResult } = await import("@/lib/analysis/displayUnits.ts");
  analysis.setActiveSource(source, ref, "A", {
    tas: { ...source, standardName: "air_temperature_anomaly" },
  });
  client.executeRun.mockResolvedValue(result(1));
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 4, lon: 5 },
    map,
    rect
  );
  const w = analysis.windows[0];
  w.result = {
    ...w.result!,
    query: w.committed!,
    units: "K",
    values: [1, 2, 3],
  };
  w.displayUnits = "degC";
  const before = convertResult(
    w.result,
    "degC",
    "air_temperature_anomaly"
  ).values;
  analysis.close(w.id, true);
  analysis.setActiveSource({ ...source, key: "replacement" }, ref, "B");
  analysis.undoClose();
  const restored = analysis.windows[0];
  expect(restored.snapshot).toBe(true);
  expect(convertResult(restored.result!, restored.displayUnits).values).toEqual(
    before
  );
});

async function comparisonRows() {
  const { default: Panel } = await import("@/ui/analysis/ComparePanel.vue");
  const { getActivePinia } = await import("pinia");
  const app = createSSRApp(Panel, { areaSize: { width: 900, height: 600 } });
  app.use(getActivePinia()!);
  const html = await renderToString(app);
  return (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []).map((row) =>
    row
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

it("keeps the comparison of absolute temperature snapshots independent of the new dataset", async () => {
  const analysis = store();
  const variables = {
    a: { ...source, standardName: "air_temperature" },
    b: { ...source, standardName: "air_temperature" },
  };
  analysis.setActiveSource(source, ref, "A", variables);
  client.executeRun.mockResolvedValue(result(1));
  for (const [variable, units, values] of [
    ["a", "K", [273.15, 274.15, 275.15]],
    ["b", "degC", [0, 1, 2]],
  ] as const) {
    await analysis.openWindow(
      ANALYSIS_KINDS.POINT_SERIES,
      { kind: "point", lat: 15, lon: 15 },
      { ...map, variable },
      rect
    );
    const w = analysis.windows[analysis.windows.length - 1];
    w.result = {
      ...w.result!,
      query: { ...w.committed!, variable },
      units,
      values: [...values],
      time: { ...summary.time, raw: [0, 1, 2] },
    };
  }
  const ids = analysis.windows.map((w) => w.id);
  analysis.compare = { ids, reference: ids[0] };
  const before = await comparisonRows();
  expect(before).toContain("P2 1.00 1.00 0 0");
  analysis.setActiveSource({ ...source, key: "other" }, ref, "B", {
    a: { ...source, standardName: "air_temperature_anomaly" },
    b: { ...source, standardName: "air_temperature_anomaly" },
  });
  expect(analysis.windows.every((w) => w.snapshot)).toBe(true);
  expect(await comparisonRows()).toEqual(before);
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

it("quotes mixed U and V chunk prices against their separate chunk counts", async () => {
  const id = "mixed-wind-prices";
  const dates = Array.from({ length: 8 }, (_, at) => 100 * at);
  const analysis = sparseWind(id, dates, 67);
  analysis.setComputeMode("ask");
  const raw = Array.from({ length: 10000 }, (_, at) => at);
  client.describeVariable.mockImplementation((_source, variable) => ({
    ...summary,
    time: { ...summary.time, raw, chunk: variable === "uas" ? 1 : 1000 },
  }));
  const price = (v: string) => (v === "uas" ? 192 : 80) * 2 ** 20;
  client.planRun.mockImplementation((_id, _source, query) => ({
    ...modest,
    chunks: 1,
    modest: false,
    decodedBytes: price(query.variable),
  }));
  const loading = analysis.loadWind(id);
  await flush();
  const quote = analysis.windows[0].companions?.wind;
  expect(quote?.status).toBe("confirm");
  analysis.approveCompanions(id, "wind");
  await loading;
  const variables = client.executeRun.mock.calls.map(
    ([id]) => client.planRun.mock.calls.find(([run]) => run === id)![2].variable
  );
  expect(variables.filter((v) => v === "uas")).toHaveLength(8);
  expect(variables.filter((v) => v === "vas")).toHaveLength(1);
  analysis.setWind(id, false);
  const spent = variables.reduce((sum, v) => sum + price(v), 0);
  expect(spent).toBeLessThanOrEqual(quote!.bytes!);
});

it("asks again when a component planned after the approval costs more (review of interim37)", async () => {
  const id = "late-dear-component";
  const dates = Array.from({ length: 8 }, (_, at) => 100 * at);
  const analysis = sparseWind(id, dates, 66);
  analysis.setComputeMode("ask");
  const raw = Array.from({ length: 10000 }, (_, at) => at);
  client.describeVariable.mockImplementation(() => ({
    ...summary,
    time: { ...summary.time, raw, chunk: 1 },
  }));
  // U's plans come at once, 8 MiB a date; V's later, at 252 MiB a date.
  const later: Array<() => void> = [];
  client.planRun.mockImplementation((_id, _source, query) => {
    const plan = {
      ...modest,
      chunks: 1,
      modest: false,
      decodedBytes: (query.variable === "uas" ? 8 : 252) * 2 ** 20,
    };
    return query.variable === "uas"
      ? plan
      : new Promise((resolve) => later.push(() => resolve(plan)));
  });
  const loading = analysis.loadWind(id);
  await flush();
  expect(analysis.windows[0].companions?.wind?.status).not.toBe("confirm");
  expect(client.executeRun).not.toHaveBeenCalled();
  later.splice(0).forEach((go) => go());
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  // Both components at their own prices: 8 × (8 + 252) MiB.
  const again = analysis.windows[0].companions?.wind;
  expect(again?.status).toBe("confirm");
  expect(again!.bytes!).toBe(8 * 260 * 2 ** 20);
  expect(client.executeRun).not.toHaveBeenCalled();
  analysis.setWind(id, false);
  await loading;
});

it("independent review of interim41: Automatic starts no cheap U piece before the dear V is priced", async () => {
  const id = "unpriced-component";
  const dates = Array.from({ length: 65 }, (_, at) => 100 * at);
  const analysis = sparseWind(id, dates, 69);
  analysis.setComputeMode("auto");
  const raw = Array.from({ length: 10000 }, (_, at) => at);
  client.describeVariable.mockImplementation(() => ({
    ...summary,
    time: { ...summary.time, raw, chunk: 1 },
  }));
  // U's plans come at once, 1 MiB a date; V's later, at 32 MiB a date.
  const later: Array<() => void> = [];
  client.planRun.mockImplementation((_id, _source, query) => {
    const plan = {
      ...modest,
      chunks: 1,
      modest: false,
      decodedBytes: (query.variable === "uas" ? 1 : 32) * 2 ** 20,
    };
    return query.variable === "uas"
      ? plan
      : new Promise((resolve) => later.push(() => resolve(plan)));
  });
  const loading = analysis.loadWind(id);
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  expect(client.executeRun).not.toHaveBeenCalled();
  later.splice(0).forEach((go) => go());
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  // 65 × 33 MiB is past Automatic's 2 GiB: asked, still nothing read.
  const wind = analysis.windows[0].companions?.wind;
  expect(wind?.status).toBe("confirm");
  expect(wind!.bytes!).toBe(65 * 33 * 2 ** 20);
  expect(client.executeRun).not.toHaveBeenCalled();
  analysis.setWind(id, false);
  await loading;
});

it("refreshes earlier sparse wind pieces republished while the last pieces run", async () => {
  const id = "wind-publication-between-pieces";
  const analysis = sparseWind(id, [0, 100], 68);
  analysis.setActiveSource(source, ref, "Example");
  const tail = deferred<void>();
  let corrected = false;
  client.executeRun.mockImplementation(async (runId: string) => {
    const query = client.planRun.mock.calls.find(([run]) => run === runId)![2];
    const date = query.time.start;
    const value = date === 0 ? (corrected ? 90 : 1) : 2;
    if (date === 100) {
      await tail.promise;
    }
    return {
      ...result(0),
      query,
      time: { ...summary.time, raw: [date] },
      values: [value],
      units: "m s-1",
      shape: [1],
      dims: ["time"],
    };
  });
  const loading = analysis.loadWind(id);
  await flush();
  expect(client.executeRun).toHaveBeenCalledTimes(4);
  corrected = true;
  analysis.livePublished(0, 0);
  tail.resolve();
  await loading;
  await analysis.loadWind(id);
  const retained = analysis.windows[0].companions?.wind?.results?.u.values;
  analysis.setWind(id, false);
  analysis.windows[0].wind = true;
  await analysis.loadWind(id);
  const fresh = analysis.windows[0].companions?.wind?.results?.u.values;
  expect(fresh).toEqual([90, 2]);
  expect(retained).toEqual(fresh);
});

it("applies the automatic wind cap even when each individual sparse read is modest", async () => {
  const id = "modest-wind-limit";
  const dates = Array.from({ length: 40 }, (_, k) => 100 * k);
  const analysis = sparseWind(id, dates, 47);
  analysis.setComputeMode("auto");
  const bytes = 32 * 2 ** 20;
  client.planRun.mockResolvedValue({
    ...modest,
    decodedBytes: bytes,
    workingBytes: bytes,
  });
  const pending = analysis.loadWind(id);
  await flush();
  const spent = bytes * client.executeRun.mock.calls.length;
  const status = analysis.windows[0].companions?.wind?.status;
  analysis.setWind(id, false);
  analysis.setComputeMode("ask");
  await pending;
  expect(spent).toBeLessThanOrEqual(2 * 2 ** 30);
  expect(status).toBe("confirm");
});

it("retains the publication that arrived while the wind components were being read", async () => {
  const id = "republished-wind";
  const analysis = sparseWind(id, [0, 1], 48);
  analysis.setActiveSource(source, ref, "Example");
  const pending = deferred<void>();
  let corrected = false;
  client.executeRun.mockImplementation(async (runId: string) => {
    const query = client.planRun.mock.calls.find(([run]) => run === runId)![2];
    const values = [corrected ? 90 : 1, 2];
    await pending.promise;
    return {
      ...result(0),
      query,
      values,
      time: { ...summary.time, raw: [0, 1] },
      units: "m s-1",
      shape: [2],
      dims: ["time"],
    };
  });
  const open = analysis.loadWind(id);
  await flush();
  expect(client.executeRun).toHaveBeenCalledTimes(2);
  corrected = true;
  analysis.livePublished(0, 0);
  pending.resolve();
  await open;
  await analysis.loadWind(id);
  const retained = analysis.windows[0].companions?.wind?.results?.u.values;
  analysis.setWind(id, false);
  analysis.windows[0].wind = true;
  await analysis.loadWind(id);
  const fresh = analysis.windows[0].companions?.wind?.results?.u.values;
  expect(fresh).toEqual([90, 2]);
  expect(retained).toEqual(fresh);
});

it("prices sparse wind by chunks when the first range fills its chunk", async () => {
  const id = "partly-filled-wind";
  const selected = [
    ...Array.from({ length: 16 }, (_, at) => at),
    ...Array.from({ length: 32 }, (_, at) => (at + 1) * 256),
  ];
  const analysis = sparseWind(id, selected, 49);
  analysis.setComputeMode("ask");
  client.describeVariable.mockResolvedValue({
    ...summary,
    time: {
      ...summary.time,
      raw: Array.from({ length: 10000 }, (_, at) => at),
      chunk: 16,
    },
  });
  const bytes = 128 * 2 ** 20;
  client.planRun.mockResolvedValue({
    ...modest,
    chunks: 1,
    decodedBytes: bytes,
    modest: false,
  });
  const loading = analysis.loadWind(id);
  await flush();
  const quoted = analysis.windows[0].companions?.wind;
  expect(quoted?.status).toBe("confirm");
  analysis.approveCompanions(id, "wind");
  await flush();
  const calls = client.executeRun.mock.calls.length;
  const allFitOneChunk = client.planRun.mock.calls.every(
    ([, , query]) =>
      Math.floor(query.time.start / 16) ===
      Math.floor((query.time.stop - 1) / 16)
  );
  analysis.setWind(id, false);
  await loading;
  expect(allFitOneChunk).toBe(true);
  expect(calls * bytes).toBeLessThanOrEqual(quoted!.bytes!);
});

it("starts no component reads after wind is disabled during its second description", async () => {
  const id = "disabled-wind-description";
  const analysis = sparseWind(id, [0, 1], 50);
  const waiting = deferred<typeof summary>();
  client.describeVariable.mockImplementation((_source, variable) =>
    variable === "vas" ? waiting.promise : Promise.resolve(summary)
  );
  const loading = analysis.loadWind(id);
  await flush();
  expect(
    client.describeVariable.mock.calls.some(
      ([, variable]) => variable === "vas"
    )
  ).toBe(true);
  analysis.setWind(id, false);
  waiting.resolve(summary);
  await loading;
  expect(client.executeRun).not.toHaveBeenCalled();
});

it("reads only the two matching chunks of each sparse wind component", async () => {
  const analysis = sparseWind("sparse-wind", [0, 9999], 0);
  await analysis.loadWind("sparse-wind");
  const reads = client.planRun.mock.calls.map(([, , query]) => [
    query.variable,
    query.time.start,
    query.time.stop,
  ]);
  expect(reads.sort()).toEqual([
    ["uas", 0, 1],
    ["uas", 9999, 10000],
    ["vas", 0, 1],
    ["vas", 9999, 10000],
  ]);
});

it("quotes the work that one approval starts across sparse wind chunks", async () => {
  const id = "sparse-wind-price";
  const dates = Array.from({ length: 8 }, (_, k) => 100 * k);
  const analysis = sparseWind(id, dates, 12);
  analysis.setComputeMode("ask");
  const bytes = 128 * 2 ** 20;
  client.planRun.mockResolvedValue({
    ...modest,
    modest: false,
    decodedBytes: bytes,
  });
  const done = analysis.loadWind(id);
  await flush();
  const quote = analysis.windows[0].companions?.wind;
  expect(quote?.status).toBe("confirm");
  expect(client.executeRun).not.toHaveBeenCalled();
  analysis.approveCompanions(id, "wind");
  await flush();
  const spent = bytes * client.executeRun.mock.calls.length;
  analysis.setWind(id, false);
  await done;
  expect(spent).toBeLessThanOrEqual(quote!.bytes!);
});

it("keeps the latest committed query: an out-of-order completion cannot relabel", async () => {
  const analysis = store();
  const first = deferred<ReturnType<typeof result>>();
  const second = deferred<ReturnType<typeof result>>();
  client.executeRun
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 1, lon: 2 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  expect(w.label).toBe("P1");
  expect(w.status).toBe(PLOT_STATUS.RUNNING);
  analysis.updateDraft(w.id, { geometry: { kind: "point", lat: 5, lon: 6 } });
  expect(analysis.windows[0].changed).toBe(true);
  void analysis.apply(w.id);
  await flush();
  second.resolve(result(2));
  await flush();
  first.resolve(result(1));
  await flush();
  expect(analysis.windows[0].result!.values).toEqual([2]);
  expect(client.cancelRun).toHaveBeenCalledTimes(1);
  // The link follows a burst of commits a moment later, once.
  await linkWritten();
  expect(readSessionParam().plots[0].query.geometry).toEqual({
    kind: "point",
    lat: 5,
    lon: 6,
  });
});

it("shares identical runs; closing one window keeps the other's request", async () => {
  const analysis = store();
  const run = deferred<ReturnType<typeof result>>();
  client.executeRun.mockReturnValue(run.promise);
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 11, lon: 12 },
    map,
    rect
  );
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 11, lon: 12 },
    map,
    rect
  );
  await flush();
  expect(client.executeRun).toHaveBeenCalledTimes(1);
  analysis.close(analysis.windows[0].id);
  expect(client.cancelRun).not.toHaveBeenCalled();
  run.resolve(result(7));
  await flush();
  expect(analysis.windows[0].result!.values).toEqual([7]);
});

// eslint-disable-next-line max-lines-per-function
it("asks before large time series and sections and explains unavailable operations", async () => {
  const analysis = store();
  client.planRun.mockResolvedValue({ ...modest, modest: false, chunks: 9000 });
  client.executeRun.mockResolvedValue(result(3));
  const series = analysis.openWindow(
    ANALYSIS_KINDS.REGION_SERIES,
    { kind: "box", west: 0, east: 10, south: 0, north: 10 },
    map,
    rect
  );
  await flush();
  expect(analysis.windows[0].status).toBe(PLOT_STATUS.CONFIRM);
  expect(client.executeRun).not.toHaveBeenCalled();
  await analysis.confirm(analysis.windows[0].id);
  await series;
  expect(analysis.windows[0].status).toBe(PLOT_STATUS.DONE);
  client.describeVariable.mockResolvedValue({
    ...summary,
    vertical: {
      dimension: "depth",
      label: "depth",
      values: [1, 2],
      physical: true,
      kind: "physical",
    },
    capabilities: {
      ...summary.capabilities,
      [ANALYSIS_KINDS.SECTION]: { available: true },
    },
  });
  const opening = analysis.openWindow(
    ANALYSIS_KINDS.SECTION,
    {
      kind: "polyline",
      vertices: [
        { lat: 0, lon: 0 },
        { lat: 1, lon: 1 },
      ],
    },
    map,
    rect
  );
  await flush();
  expect(analysis.windows[1].status).toBe(PLOT_STATUS.CONFIRM);
  expect(client.executeRun).toHaveBeenCalledTimes(1);
  // Compute runs the plan already made; it does not plan again.
  await analysis.confirm(analysis.windows[1].id);
  await opening;
  expect(client.planRun).toHaveBeenCalledTimes(2);
  expect(client.cancelRun).not.toHaveBeenCalled();
  expect(analysis.windows[1].status).toBe(PLOT_STATUS.DONE);
  client.describeVariable.mockResolvedValue(summary);
  await analysis.openWindow(
    ANALYSIS_KINDS.PROFILE,
    { kind: "point", lat: 0, lon: 0 },
    map,
    rect
  );
  expect(analysis.windows[2].status).toBe(PLOT_STATUS.UNAVAILABLE);
  expect(analysis.windows[2].message).toMatch(/vertical/);
});

it("shows parts as they arrive; pause, resume and stop keep what was read", async () => {
  const analysis = store();
  const run = deferred<ReturnType<typeof result>>();
  let push: (partial: unknown) => void = () => {};
  client.executeRun.mockImplementation((_id, _source, onPartial) => {
    push = onPartial;
    return run.promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 31, lon: 32 },
    map,
    rect
  );
  await flush();
  const id = analysis.windows[0].id;
  push({ ...result(1), partial: { done: 1, total: 4, readUntil: 1 } });
  expect(analysis.windows[0].result!.values).toEqual([1]);
  expect(analysis.windows[0].progress).toEqual({ done: 1, total: 4 });
  analysis.setPaused(id, true);
  expect(client.setRunPaused).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.anything(),
    true
  );
  expect(analysis.windows[0].paused).toBe(true);
  analysis.setPaused(id, false);
  push({ ...result(2), partial: { done: 2, total: 4, readUntil: 2 } });
  analysis.cancel(id);
  expect(analysis.windows[0].status).toBe(PLOT_STATUS.CANCELLED);
  expect(analysis.windows[0].result!.values).toEqual([2]);
  expect(analysis.windows[0].message).toMatch(
    /Stopped: 2 of 4 parts read; times from 2000-01-03 00:00:00 on/
  );
  expect(client.cancelRun).toHaveBeenCalled();
});

it("interim49: a Stop keeps the dates its run sends as it stops", async () => {
  const analysis = store();
  const run = deferred<ReturnType<typeof result>>();
  let push: (partial: unknown) => void = () => {};
  client.executeRun.mockImplementation((_id, _source, onPartial) => {
    push = onPartial;
    return run.promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 33, lon: 34 },
    map,
    rect
  );
  await flush();
  const id = analysis.windows[0].id;
  // Stopped before any update reached the page: none read yet.
  analysis.cancel(id);
  expect(analysis.windows[0].status).toBe(PLOT_STATUS.CANCELLED);
  // The run's last snapshot, flushed as it stops: three dates read.
  push({ ...result(3), partial: { done: 3, total: 7, readUntil: 3 } });
  expect(analysis.windows[0].result?.partial?.done).toBe(3);
  expect(analysis.windows[0].message).toMatch(/Stopped: 3 of 7 parts read/);
  run.resolve(result(9));
  await flush();
  // After it settles, nothing more is taken.
  push({ ...result(5), partial: { done: 5, total: 7, readUntil: 5 } });
  expect(analysis.windows[0].result?.partial?.done).toBe(3);
});

it("a dataset switch cancels pending work and keeps finished results as snapshots", async () => {
  const analysis = store();
  client.executeRun.mockReturnValue(new Promise(() => {}));
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 21, lon: 22 },
    map,
    rect
  );
  await flush();
  analysis.setActiveSource({ ...source, key: "other#2" }, ref, "Other");
  expect(analysis.windows[0].snapshot).toBe(true);
  expect(analysis.windows[0].status).toBe(PLOT_STATUS.CANCELLED);
  expect(client.cancelRun).toHaveBeenCalled();
  expect(client.releaseSource).toHaveBeenCalledWith(
    expect.objectContaining({
      key: `${source.key}|${source.store}|`,
      store: source.store,
    })
  );
});

it("identical cold windows share one plan and one execution", async () => {
  const analysis = store();
  const plan = deferred<typeof modest>();
  const run = deferred<ReturnType<typeof result>>();
  client.planRun.mockReturnValue(plan.promise);
  client.executeRun.mockReturnValue(run.promise);
  const geometry = { kind: "point" as const, lat: 31, lon: 7 };
  const a = analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    geometry,
    map,
    rect
  );
  const b = analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    geometry,
    map,
    rect
  );
  await flush();
  expect(client.planRun).toHaveBeenCalledTimes(1);
  expect(analysis.windows.map((w) => w.status)).toEqual([
    PLOT_STATUS.PLANNING,
    PLOT_STATUS.PLANNING,
  ]);
  plan.resolve(modest);
  await flush();
  run.resolve(result(9));
  await Promise.all([a, b]);
  expect(client.executeRun).toHaveBeenCalledTimes(1);
  expect(analysis.windows.map((w) => w.status)).toEqual([
    PLOT_STATUS.DONE,
    PLOT_STATUS.DONE,
  ]);
});

it("a peer's cancel leaves the survivor running; the last one stops the run", async () => {
  const analysis = store();
  const run = deferred<ReturnType<typeof result>>();
  client.executeRun.mockReturnValue(run.promise);
  const geometry = { kind: "point" as const, lat: 32, lon: 8 };
  const a = analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    geometry,
    map,
    rect
  );
  void analysis.openWindow(ANALYSIS_KINDS.POINT_SERIES, geometry, map, rect);
  await flush();
  const [first, second] = analysis.windows;
  analysis.cancel(second.id);
  expect(client.cancelRun).not.toHaveBeenCalled();
  run.resolve(result(4));
  await a;
  expect(analysis.windows[0].status).toBe(PLOT_STATUS.DONE);
  expect(first.id).toBe(analysis.windows[0].id);

  const slow = deferred<ReturnType<typeof result>>();
  client.executeRun.mockReturnValue(slow.promise);
  const other = { kind: "point" as const, lat: 33, lon: 9 };
  void analysis.openWindow(ANALYSIS_KINDS.POINT_SERIES, other, map, rect);
  void analysis.openWindow(ANALYSIS_KINDS.POINT_SERIES, other, map, rect);
  await flush();
  analysis.cancel(analysis.windows[2].id);
  analysis.cancel(analysis.windows[3].id);
  expect(client.cancelRun).toHaveBeenCalledTimes(1);
});

it("cancelling while planning stops the plan; nothing executes afterwards", async () => {
  const analysis = store();
  const plan = deferred<typeof modest>();
  client.planRun.mockReturnValue(plan.promise);
  const opening = analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 34, lon: 10 },
    map,
    rect
  );
  await flush();
  analysis.cancel(analysis.windows[0].id);
  expect(client.cancelRun).toHaveBeenCalledTimes(1);
  plan.resolve(modest);
  await opening;
  await flush();
  expect(client.executeRun).not.toHaveBeenCalled();
  expect(analysis.windows[0].status).toBe(PLOT_STATUS.CANCELLED);
});

it("pause state is shared by every window on the run", async () => {
  const analysis = store();
  const run = deferred<ReturnType<typeof result>>();
  client.executeRun.mockReturnValue(run.promise);
  const geometry = { kind: "point" as const, lat: 35, lon: 11 };
  void analysis.openWindow(ANALYSIS_KINDS.POINT_SERIES, geometry, map, rect);
  void analysis.openWindow(ANALYSIS_KINDS.POINT_SERIES, geometry, map, rect);
  await flush();
  analysis.setPaused(analysis.windows[0].id, true);
  expect(analysis.windows.map((w) => w.paused)).toEqual([true, true]);
  expect(client.setRunPaused).toHaveBeenCalledTimes(1);
  run.resolve(result(5));
  await flush();
});

it("a remount keeps the binding; a new dataset releases every source it opened", async () => {
  const analysis = store();
  const sources = { name: "A" };
  const first = analysis.bindDatasources(sources);
  expect(first).toBeTypeOf("number");
  // The layer remounts while the viewer detects a variable: nothing changes.
  expect(analysis.bindDatasources(sources)).toBeUndefined();
  const menuSource = analysis.sourceFor("tas")!;
  await analysis.describe(menuSource, "tas");
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 36, lon: 12 },
    map,
    rect
  );
  const changed = analysis.bindDatasources({ name: "A, reloaded" });
  expect(changed).toBe(first! + 1);
  analysis.setActiveSource({ ...source, key: `src#${changed}` }, ref, "A");
  expect(client.releaseSource).toHaveBeenCalledWith(
    expect.objectContaining({ key: menuSource.key })
  );
  expect(analysis.windows[0].snapshot).toBe(true);
});

it("a stopped window keeps its values while a sharing window reads on", async () => {
  const analysis = store();
  const run = deferred<ReturnType<typeof result>>();
  let push: (partial: unknown) => void = () => {};
  client.executeRun.mockImplementation((_id, _source, onPartial) => {
    push = onPartial;
    return run.promise;
  });
  const geometry = { kind: "point" as const, lat: 37, lon: 13 };
  void analysis.openWindow(ANALYSIS_KINDS.POINT_SERIES, geometry, map, rect);
  void analysis.openWindow(ANALYSIS_KINDS.POINT_SERIES, geometry, map, rect);
  await flush();
  // The assembler patches one array in place for both subscribers.
  const values = [1, Number.NaN, Number.NaN, Number.NaN];
  push({ ...result(1), values, partial: { done: 1, total: 4, readUntil: 1 } });
  analysis.cancel(analysis.windows[0].id);
  values[1] = 22;
  push({ ...result(1), values, partial: { done: 2, total: 4, readUntil: 2 } });
  expect(analysis.windows[0].result!.values.slice(0, 2)).toEqual([
    1,
    Number.NaN,
  ]);
  expect(analysis.windows[1].result!.values[1]).toBe(22);
  run.resolve(result(9));
  await flush();
});

it("Discard restores the source and summary with the variable; late descriptions lose", async () => {
  const analysis = store();
  analysis.setActiveSource(source, ref, "Example", {
    tas: { store: "https://a.example/a.zarr", dataset: "" },
    wind: { store: "https://b.example/b.zarr", dataset: "" },
  });
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 38, lon: 14 },
    map,
    rect
  );
  const w = analysis.windows[0];
  expect(w.source.store).toBe("https://a.example/a.zarr");
  client.describeVariable.mockResolvedValue({ ...summary, variable: "wind" });
  await analysis.useMapSettings(w.id, { variable: "wind", indices: {} });
  expect(analysis.windows[0].source.store).toBe("https://b.example/b.zarr");
  analysis.discardDraft(w.id);
  expect(analysis.windows[0].draft.variable).toBe("tas");
  expect(analysis.windows[0].source.store).toBe("https://a.example/a.zarr");
  analysis.updateDraft(w.id, { geometry: { kind: "point", lat: 39, lon: 14 } });
  await analysis.apply(w.id);
  const planned = client.planRun.mock.calls.at(-1)!;
  expect(planned[1].store).toBe("https://a.example/a.zarr");
  expect(planned[2].variable).toBe("tas");

  // A slow description for an abandoned variable does not rebind later.
  const slow = deferred<typeof summary>();
  client.describeVariable.mockReturnValueOnce(slow.promise);
  const pending = analysis.useMapSettings(w.id, {
    variable: "wind",
    indices: {},
  });
  analysis.discardDraft(w.id);
  slow.resolve({ ...summary, variable: "wind" });
  await pending;
  expect(analysis.windows[0].source.store).toBe("https://a.example/a.zarr");
});

it("changing only the display threshold does not recompute", async () => {
  const analysis = store();
  client.describeVariable.mockResolvedValue(summary);
  client.executeRun.mockResolvedValue({
    ...result(3),
    kind: ANALYSIS_KINDS.REGION_SERIES,
  });
  await analysis.openWindow(
    ANALYSIS_KINDS.REGION_SERIES,
    { kind: "box", west: 1, east: 9, south: 1, north: 9 },
    map,
    rect
  );
  const runs = client.executeRun.mock.calls.length;
  const w = analysis.windows[0];
  analysis.updateDraft(w.id, { minCoverage: 0.7 });
  await analysis.apply(w.id);
  expect(client.executeRun.mock.calls.length).toBe(runs);
  expect(analysis.windows[0].result!.query.minCoverage).toBe(0.7);
});

it("Follow map time changes only the time; an unapplied location edit stays pending", async () => {
  const analysis = store();
  client.executeRun.mockResolvedValue(result(1));
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 1, lon: 2 },
    map,
    rect
  );
  const w = analysis.windows[0];
  analysis.updateDraft(w.id, { geometry: { kind: "point", lat: 40, lon: 50 } });
  const later = deferred<ReturnType<typeof result>>();
  client.executeRun.mockReturnValueOnce(later.promise);
  void analysis.followTime(w.id, 3);
  await flush();
  const query = client.planRun.mock.calls.at(-1)![2];
  expect(query.geometry).toEqual({ kind: "point", lat: 1, lon: 2 });
  expect(query.time).toEqual({ start: 3, stop: 4 });
  const shown = analysis.windows[0];
  expect(shown.draft.geometry).toEqual({ kind: "point", lat: 40, lon: 50 });
  expect(shown.changed).toBe(true);
  later.resolve(result(4));
  await flush();
  expect(analysis.windows[0].result!.values).toEqual([4]);
});

it("Discard restores a custom band width and bin count", async () => {
  const analysis = store();
  client.executeRun.mockResolvedValue(result(1));
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 1, lon: 2 },
    map,
    rect
  );
  const w = analysis.windows[0];
  w.committed = { ...w.committed!, binDegrees: 2, valueBins: 10 };
  analysis.updateDraft(w.id, { binDegrees: 5, valueBins: 50 });
  analysis.discardDraft(w.id);
  expect(analysis.windows[0].draft.binDegrees).toBe(2);
  expect(analysis.windows[0].draft.valueBins).toBe(10);
  expect(analysis.windows[0].changed).toBe(false);
});

it("names the displayed selection until its replacement arrives", async () => {
  const { humanStatus } = await import("@/ui/analysis/plotLayout.ts");
  const analysis = store();
  client.executeRun.mockResolvedValue(result(1));
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 1, lon: 2 },
    map,
    rect
  );
  const w = analysis.windows[0];
  const next = deferred<ReturnType<typeof result>>();
  client.executeRun.mockReturnValueOnce(next.promise);
  analysis.updateDraft(w.id, { geometry: { kind: "point", lat: 9, lon: 9 } });
  void analysis.apply(w.id);
  await flush();
  const running = analysis.windows[0];
  // The chart and its caption still describe the old point.
  expect(running.result!.query.geometry).toEqual({
    kind: "point",
    lat: 1,
    lon: 2,
  });
  expect(humanStatus(running)).toMatch(/^Updating selection: Reading/);
  next.resolve(result(2));
  await flush();
  expect(analysis.windows[0].result!.query.geometry).toEqual({
    kind: "point",
    lat: 9,
    lon: 9,
  });
  expect(humanStatus(analysis.windows[0])).toBe("Ready");
});

it("re-estimates a shorter range without starting the original multi-GiB series", async () => {
  const analysis = store();
  client.planRun.mockResolvedValueOnce({
    ...modest,
    chunks: 128,
    decodedBytes: 5 * 2 ** 30,
    modest: false,
  });
  client.executeRun.mockResolvedValue(result(1));
  const opening = analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 12, lon: -95 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  expect(w.status).toBe(PLOT_STATUS.CONFIRM);
  expect(w.estimate?.decodedBytes).toBe(5 * 2 ** 30);
  expect(client.executeRun).not.toHaveBeenCalled();
  analysis.updateDraft(w.id, { time: { start: 1, stop: 3 } });
  await analysis.apply(w.id);
  await opening;
  expect(client.cancelRun).toHaveBeenCalledTimes(1);
  expect(client.executeRun).toHaveBeenCalledTimes(1);
  expect(client.planRun.mock.calls[1][2].time).toEqual({ start: 1, stop: 3 });
  expect(w.estimate).toEqual(modest);
  expect(w.status).toBe(PLOT_STATUS.DONE);
});

it("asks again for an expensive field after permission to locate native cells", async () => {
  const analysis = store();
  client.planRun
    .mockResolvedValueOnce({
      ...modest,
      modest: false,
      needsConfirmation: true,
      geometryReads: 120,
    })
    .mockResolvedValueOnce({
      ...modest,
      modest: false,
      decodedBytes: 4 * 2 ** 30,
    });
  client.executeRun.mockResolvedValue(result(1));
  const opening = analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 11, lon: -96 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  expect(w.estimate?.needsConfirmation).toBe(true);
  await analysis.confirm(w.id);
  await flush();
  expect(w.status).toBe(PLOT_STATUS.CONFIRM);
  expect(client.planRun.mock.calls[1][3]).toBe(true);
  expect(w.estimate?.decodedBytes).toBe(4 * 2 ** 30);
  expect(client.executeRun).not.toHaveBeenCalled();
  await analysis.confirm(w.id);
  await opening;
  expect(client.executeRun).toHaveBeenCalledTimes(1);
});

it("retries failed opening metadata with the original map settings and preserves escaped URL state", async () => {
  const analysis = store();
  const selected = { variable: "tas", indices: { time: 2, member: 3 } };
  page.hash += "::label=a%26b%2Bc%3A%3Ad";
  client.describeVariable
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({
      ...summary,
      capabilities: {
        ...summary.capabilities,
        [ANALYSIS_KINDS.PROFILE]: { available: true },
      },
      others: [{ dimension: "member", size: 6 }],
    });
  client.executeRun.mockResolvedValue(result(1));
  await analysis.openWindow(
    ANALYSIS_KINDS.PROFILE,
    { kind: "point", lat: 33, lon: -97 },
    selected,
    rect
  );
  const w = analysis.windows[0];
  expect(w.status).toBe(PLOT_STATUS.ERROR);
  selected.indices = { time: 1, member: 0 };
  await analysis.retry(w.id);
  expect(w.status).toBe(PLOT_STATUS.DONE);
  expect(w.committed?.fixed).toEqual({ member: 3 });
  expect(w.committed?.time).toEqual({ start: 2, stop: 3 });
  expect(
    new URLSearchParams(page.hash.split("::").slice(1).join("&")).get("label")
  ).toBe("a&b+c::d");
});

async function renderWindow(
  plot: ReturnType<typeof useAnalysisStore>["windows"][number]
) {
  const [
    { createSSRApp },
    { renderToString },
    { getActivePinia },
    { default: PlotWindow },
  ] = await Promise.all([
    import("vue"),
    import("vue/server-renderer"),
    import("pinia"),
    import("@/ui/analysis/PlotWindow.vue"),
  ]);
  const app = createSSRApp(PlotWindow, {
    plot,
    areaSize: { width: 900, height: 700 },
  });
  return renderToString(app.use(getActivePinia()!));
}

it("independent review of interim41: says when a scatter partner was read across a publication", async () => {
  const analysis = store();
  client.executeRun.mockResolvedValue({
    ...result(1),
    values: [1, 2, 3, 4],
    time: summary.time,
  });
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 61, lon: -97 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  expect(w.status).toBe(PLOT_STATUS.DONE);
  const { queryKey } = await import("@/store/analysisStore.ts");
  analysis.patchWindow(w.id, {
    pairWith: "sal",
    companions: {
      pair: {
        status: "ready",
        stale: true,
        key: queryKey(w.source!, w.result!.query),
      },
    },
  } as never);
  const html = await renderWindow(w);
  expect(html).toContain(
    "The source published new data while the scatter was read"
  );
  expect(html).toContain("Read again");
});

it("renders the same read-through date on Chart and Data without starting a second run", async () => {
  const analysis = store();
  const run = deferred<ReturnType<typeof result>>();
  client.executeRun.mockReturnValue(run.promise);
  const opening = analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 59, lon: -97 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  client.executeRun.mock.calls[0][2]({
    ...result(1),
    values: [3, NaN, NaN, NaN],
    time: summary.time,
    partial: { done: 1, total: 4, readUntil: 1 },
  });
  analysis.setPaused(w.id, true);
  const chart = await renderWindow(w);
  const facts = [
    ">Paused</strong> 1 of 4 dates (25 %)",
    "through 2000-01-01 00:00",
    "to 2000-01-01",
    "After part 1 of 4",
  ];
  for (const fact of facts) {
    expect(chart).toContain(fact);
  }
  expect(chart).toContain("<canvas");
  analysis.patchWindow(w.id, { showTable: true });
  const table = await renderWindow(w);
  for (const fact of facts) {
    expect(table).toContain(fact);
  }
  expect(table).toContain("<table");
  expect(table).toContain(
    "CSV includes all requested rows and marks unread rows"
  );
  expect(client.executeRun).toHaveBeenCalledTimes(1);
  run.resolve(result(1));
  await opening;
});

function stubExportWorker() {
  let acknowledge!: () => void;
  const terminate = vi.fn();
  class TestWorker {
    terminate = terminate;
    onmessage!: (event: { data: { id: number; bytes: Uint8Array } }) => void;
    postMessage({ id }: { id: number }) {
      acknowledge = () =>
        this.onmessage({ data: { id, bytes: Uint8Array.of(7) } });
    }
  }
  vi.stubGlobal("Worker", TestWorker);
  return { terminate, acknowledge: () => acknowledge() };
}

it("catches up Follow on remount and cancels exports on Close only", async () => {
  const analysis = store();
  client.describeVariable.mockResolvedValue({
    ...summary,
    capabilities: {
      ...summary.capabilities,
      [ANALYSIS_KINDS.PROFILE]: { available: true },
    },
  });
  client.executeRun.mockResolvedValue({
    ...result(1),
    kind: ANALYSIS_KINDS.PROFILE,
  });
  await analysis.openWindow(
    ANALYSIS_KINDS.PROFILE,
    { kind: "point", lat: 60, lon: -97 },
    map,
    rect
  );
  const w = analysis.windows[0];
  analysis.patchWindow(w.id, { followMapTime: true });
  const followTime = vi.spyOn(analysis, "followTime");
  const { writeScientificFile } =
    await import("@/lib/analysis/exportClient.ts");
  const originalWorker = globalThis.Worker;
  const { terminate, acknowledge } = stubExportWorker();
  try {
    const exporting = writeScientificFile("zarr", w.result!, w.id);
    analysis.setMinimized(w.id, true);
    analysis.setMinimized(w.id, false);
    await renderWindow(w);
    expect(followTime).toHaveBeenCalledWith(w.id, 3);
    expect(terminate).not.toHaveBeenCalled();
    acknowledge();
    await expect(exporting).resolves.toEqual({
      bytes: Uint8Array.of(7),
      background: true,
    });
    const closing = writeScientificFile("nc", w.result!, w.id);
    analysis.close(w.id);
    await expect(closing).rejects.toMatchObject({ name: "AbortError" });
    expect(terminate).toHaveBeenCalled();
  } finally {
    vi.stubGlobal("Worker", originalWorker);
  }
});

it("a live publication recomputes the plots whose dates it touches", async () => {
  const analysis = store();
  client.executeRun
    .mockResolvedValueOnce(result(1))
    .mockResolvedValue(result(2));
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 41, lon: 42 },
    map,
    rect
  );
  const [w] = analysis.windows;
  const { start, stop } = w.committed!.time!;
  expect(w.result!.values).toEqual([1]);
  // Steps after the plot's range: the shown result stands.
  analysis.livePublished(stop + 5, stop + 9);
  expect(client.sourcePublished).toHaveBeenLastCalledWith(
    source,
    stop + 5,
    stop + 9
  );
  const runs = client.executeRun.mock.calls.length;
  await analysis.commit(w.id, w.committed!);
  expect(client.executeRun.mock.calls.length).toBe(runs);
  // A step inside it: the same query is read afresh.
  analysis.livePublished(stop - 1, stop - 1);
  await analysis.commit(w.id, w.committed!);
  expect(client.executeRun.mock.calls.length).toBe(runs + 1);
  expect(analysis.windows[0].result!.values).toEqual([2]);
  expect(start).toBeLessThan(stop);
});

it("a closed window owns no downloads; minimized and restored ones do", async () => {
  const analysis = store();
  client.executeRun.mockResolvedValue(result(5));
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 51, lon: 52 },
    map,
    rect
  );
  const { id } = analysis.windows[0];
  analysis.setMinimized(id, true);
  expect(analysis.ownsDownloads(id)).toBe(true);
  analysis.close(id, true);
  expect(analysis.ownsDownloads(id)).toBe(false);
  analysis.undoClose();
  expect(analysis.ownsDownloads(id)).toBe(true);
});

it("review #19: Undo after a dataset switch brings the plot back as a snapshot, out of the link", async () => {
  const analysis = store();
  client.executeRun.mockResolvedValue(result(7));
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 53, lon: 54 },
    map,
    rect
  );
  const { id } = analysis.windows[0];
  analysis.close(id, true);
  analysis.setActiveSource({ ...source, key: "other#3" }, ref, "Other");
  analysis.undoClose();
  expect(analysis.windows[0].snapshot).toBe(true);
  await linkWritten();
  expect(readSessionParam()?.plots ?? []).toHaveLength(0);
  // On the same dataset, Undo restores a live plot as before.
  analysis.setActiveSource(source, ref, "Example");
  client.executeRun.mockResolvedValue(result(8));
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 55, lon: 56 },
    map,
    rect
  );
  const live = analysis.windows[1].id;
  analysis.close(live, true);
  analysis.undoClose();
  expect(analysis.windows.find((w) => w.id === live)?.snapshot).toBe(false);
});

it("review of interim30: a page opened with plots waits for them before any write", () => {
  const incoming = "#https://example.org/data.zarr::plots=INCOMING";
  page.hash = incoming;
  setActivePinia(createPinia());
  const analysis = useAnalysisStore();
  expect(analysis.restorePending).toBe(true);
  // Share opened before the grid is known: the address stays.
  analysis.writeLink();
  expect(page.hash).toBe(incoming);
});

it("review #21: while a link's plots wait to be restored, nothing rewrites the address", async () => {
  const analysis = store();
  const incoming = "#https://example.org/data.zarr::plots=INCOMING";
  page.hash = incoming;
  analysis.restorePending = true;
  // Share opened early: it writes the (still empty) session.
  analysis.writeLink();
  analysis.writeLinkSoon();
  await linkWritten();
  expect(page.hash).toBe(incoming);
  analysis.restorePending = false;
  analysis.writeLink();
  expect(page.hash).not.toBe(incoming);
});

it("writes the session to the link and says what it holds", async () => {
  const analysis = store();
  client.executeRun.mockResolvedValue(result(1));
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 1, lon: 2 },
    map,
    rect,
    undefined,
    undefined,
    { timeView: "running", timeWindow: 6 }
  );
  await flush();
  const w = analysis.windows[0];
  analysis.writeLink();
  expect(analysis.link).toMatchObject({ plots: 1, edited: 0, tooLong: false });
  expect(readSessionParam().plots[0].view).toEqual({
    timeView: "running",
    timeWindow: 6,
    minimized: false,
    showTable: false,
  });
  expect(location.hash.startsWith("#https://example.org/data.zarr::")).toBe(
    true
  );
  analysis.updateDraft(w.id, { geometry: { kind: "point", lat: 5, lon: 6 } });
  analysis.writeLink();
  expect(analysis.link.edited).toBe(1);
  // Shared as shown: the unapplied edit is not in the link.
  expect(readSessionParam().plots[0].query.geometry).toMatchObject({ lat: 1 });
  w.snapshot = true;
  analysis.writeLink();
  expect(analysis.link.plots).toBe(0);
  expect(analysis.link.leftOut).toEqual(["P1 (from another dataset)"]);
});

/** The next plan: a large read of this many decoded bytes. */
function plansRead(bytes: number) {
  client.planRun.mockResolvedValue({
    ...modest,
    modest: false,
    decodedBytes: bytes,
  });
}

it("computes large reads by itself in Automatic, up to its cap, and asks in Ask first", async () => {
  const analysis = store();
  const box = { kind: "box" as const, west: 0, east: 10, south: 0, north: 10 };
  client.executeRun.mockResolvedValue(result(3));
  // Automatic: a 100 MiB read starts without Compute.
  analysis.setComputeMode("auto");
  plansRead(100 * 2 ** 20);
  const first = analysis.openWindow(
    ANALYSIS_KINDS.REGION_SERIES,
    box,
    map,
    rect
  );
  await flush();
  await first;
  expect(analysis.windows[0].status).toBe(PLOT_STATUS.DONE);
  // Above the cap it still asks.
  plansRead(3 * 2 ** 30);
  void analysis.openWindow(
    ANALYSIS_KINDS.REGION_SERIES,
    { ...box, east: 20 },
    map,
    rect
  );
  await flush();
  expect(analysis.windows[1].status).toBe(PLOT_STATUS.CONFIRM);
  // Ask first: a 100 MiB read waits for Compute again.
  analysis.setComputeMode("ask");
  plansRead(100 * 2 ** 20);
  void analysis.openWindow(
    ANALYSIS_KINDS.REGION_SERIES,
    { ...box, east: 30 },
    map,
    rect
  );
  await flush();
  expect(analysis.windows[2].status).toBe(PLOT_STATUS.CONFIRM);
  // Switching to Automatic starts what waits under the cap.
  analysis.setComputeMode("auto");
  await flush();
  expect(analysis.windows[2].status).toBe(PLOT_STATUS.DONE);
  expect(analysis.windows[1].status).toBe(PLOT_STATUS.CONFIRM);
  analysis.setComputeMode("ask");
});

it("continues a stopped series from where it stopped, keeping the dates read", async () => {
  const analysis = store();
  const first = deferred<ReturnType<typeof result>>();
  let push: (partial: unknown) => void = () => {};
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    push = onPartial;
    return first.promise;
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 31, lon: 32 },
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
  expect(analysis.windows[0].status).toBe(PLOT_STATUS.CANCELLED);
  // Continue reads only the dates after the stop, without a second ask.
  client.planRun.mockClear();
  client.executeRun.mockResolvedValueOnce({ ...result(3), values: [3, 4] });
  analysis.continueRead(w.id);
  await flush();
  await flush();
  expect(client.planRun.mock.calls[0][2].time).toEqual({
    start: 2,
    stop: asked.stop,
  });
  const after = analysis.windows[0];
  expect(after.status).toBe(PLOT_STATUS.DONE);
  expect(after.result!.values).toEqual([1, 2, 3, 4]);
  expect(after.result!.partial).toBeUndefined();
  // The request is still the whole range (Settings, the link).
  expect(after.committed!.time).toEqual(asked);
});

it("reuses a completed discontiguous result when the same plot reopens", async () => {
  const analysis = store();
  const geo = { kind: "point" as const, lat: 31.1, lon: 32.1 };
  const read = async (time: {
    start: number;
    stop: number;
    runs?: [number, number][];
  }) => {
    const q = {
      version: 1 as const,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      geometry: geo,
      variable: "tas",
      fixed: {},
      time,
      source: ref,
    };
    const dates = time.runs ? [0, 2, 3] : [0, 1, 2];
    client.executeRun.mockResolvedValue({
      ...result(1),
      query: q,
      shape: [3],
      values: dates,
      time: { ...summary.time, raw: dates },
    });
    for (let i = 0; i < 2; i++) {
      await analysis.openWindow(q.kind, geo, map, rect, q);
      await flush();
      const w = analysis.windows.at(-1)!;
      expect(w.result?.values).toEqual(dates);
      analysis.close(w.id, false);
    }
  };
  await read({ start: 0, stop: 3 });
  expect(client.executeRun).toHaveBeenCalledTimes(1);
  client.executeRun.mockClear();
  await read({
    start: 0,
    stop: 4,
    runs: [
      [0, 1],
      [2, 4],
    ],
  });
  expect(client.executeRun).toHaveBeenCalledTimes(1);
});

it("ignores a publication inside an excluded date gap during the active read", async () => {
  const analysis = store();
  const geo = { kind: "point" as const, lat: 31.2, lon: 32.2 };
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
  expect(client.executeRun).toHaveBeenCalledTimes(1);
});

it("continues a request in two stored slices with the slice not read yet", async () => {
  // 25 Nov: Jan 1 and Jan 2–3 of a file storing Jan 4 between them.
  const analysis = store();
  client.executeRun.mockResolvedValueOnce(result(0));
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 31, lon: 32 },
    map,
    rect
  );
  await flush();
  await flush();
  const w = analysis.windows[0];
  const sliced = {
    start: 0,
    stop: 4,
    runs: [
      [0, 1],
      [2, 4],
    ] as [number, number][],
  };
  const first = deferred<ReturnType<typeof result>>();
  let push: (partial: unknown) => void = () => {};
  client.executeRun.mockImplementationOnce((_id, _source, onPartial) => {
    push = onPartial;
    return first.promise;
  });
  analysis.updateDraft(w.id, { time: sliced });
  void analysis.apply(w.id);
  await flush();
  await flush();
  // Stopped after the first slice: one of three rows read.
  push({
    ...result(1),
    values: [1, Number.NaN, Number.NaN],
    partial: { done: 1, total: 2, readUntil: 1 },
  });
  analysis.cancel(w.id);
  client.planRun.mockClear();
  client.executeRun.mockResolvedValueOnce({ ...result(3), values: [3, 4] });
  analysis.continueRead(w.id);
  await flush();
  await flush();
  // Only the second slice is read; Jan 4 (index 1) never.
  expect(client.planRun.mock.calls[0][2].time).toEqual({ start: 2, stop: 4 });
  const after = analysis.windows[0];
  expect(after.status).toBe(PLOT_STATUS.DONE);
  expect(after.result!.values).toEqual([1, 3, 4]);
  expect(after.committed!.time).toEqual(sliced);
  expect(after.result!.query.time).toEqual(sliced);
});

it("writes the link once for a burst of commits (a restored session)", async () => {
  const analysis = store();
  client.executeRun.mockResolvedValue(result(1));
  const writes = vi.spyOn(history, "replaceState");
  for (let k = 0; k < 6; k++) {
    void analysis.openWindow(
      ANALYSIS_KINDS.POINT_SERIES,
      { kind: "point", lat: k, lon: k },
      map,
      rect
    );
  }
  await flush();
  writes.mockClear();
  await linkWritten();
  expect(writes).toHaveBeenCalledTimes(1);
  expect(readSessionParam().plots).toHaveLength(6);
  writes.mockRestore();
});

it("a paused plot gives its slot to the next one, and waits for one to resume", async () => {
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
  // Two slots: the third waits.
  expect(client.executeRun).toHaveBeenCalledTimes(2);
  expect(analysis.windows[2].status).toBe(PLOT_STATUS.QUEUED);
  const [a, b] = analysis.windows.map((w) => w.id);
  analysis.setPaused(a, true);
  await flush();
  // Pausing the first lets the third read.
  expect(client.executeRun).toHaveBeenCalledTimes(3);
  analysis.setPaused(b, true);
  analysis.setPaused(a, false);
  await flush();
  // A slot was free (b paused): the first reads again at once.
  expect(analysis.windows[0].paused).toBe(false);
  analysis.setPaused(b, false);
  await flush();
  // Both slots taken (first and third): the second stays paused...
  expect(analysis.windows[1].paused).toBe(true);
  runs[2].resolve(result(3));
  await flush();
  await flush();
  // ...until the third is done.
  expect(analysis.windows[2].status).toBe(PLOT_STATUS.DONE);
  expect(analysis.windows[1].paused).toBe(false);
  expect(client.setRunPaused).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.anything(),
    false
  );
});

it("Cancel on the large-read card reads nothing and says what is shown", async () => {
  const analysis = store();
  client.planRun.mockResolvedValue({ ...modest, modest: false, chunks: 9000 });
  // Ask first (an earlier test may have left Automatic on).
  analysis.setComputeMode("ask");
  const runs = client.executeRun.mock.calls.length;
  void analysis.openWindow(
    ANALYSIS_KINDS.REGION_SERIES,
    { kind: "box", west: 21, east: 27, south: 3, north: 9 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  expect(w.status).toBe(PLOT_STATUS.CONFIRM);
  analysis.cancel(w.id);
  await flush();
  expect(client.executeRun.mock.calls.length).toBe(runs);
  expect(analysis.windows[0].status).toBe(PLOT_STATUS.CANCELLED);
  expect(analysis.windows[0].message).toBe("Not computed: nothing was read.");
});

it("Compare opens with the finished series, or empty to collect places", () => {
  const analysis = store();
  analysis.openCompare();
  expect(analysis.compare).toEqual({ ids: [], reference: "", collect: true });
});

it("Compare opened from a found chart remembers its view", () => {
  const analysis = store();
  analysis.openCompare("qq");
  expect(analysis.compare?.view).toBe("qq");
});

it("Apply after editing nothing keeps a traced box as it was", async () => {
  const analysis = store();
  const edge = (a: number[], b: number[]) =>
    Array.from({ length: 5 }, (_, k) => [
      a[0] + ((b[0] - a[0]) * k) / 5,
      a[1] + ((b[1] - a[1]) * k) / 5,
    ]);
  const ring = [
    ...edge([-30, 23], [-11, 23]),
    ...edge([-11, 23], [-11, 13]),
    ...edge([-11, 13], [-30, 13]),
    ...edge([-30, 13], [-30, 23]),
    [-30, 23],
  ];
  const traced = {
    kind: "shape" as const,
    name: "as drawn",
    polygons: [[ring]],
    digest: "traced",
    drawn: true as const,
    poles: { north: false, south: false },
  };
  void analysis.openWindow(ANALYSIS_KINDS.REGION_SERIES, traced, map, rect);
  await flush();
  const id = analysis.windows[0].id;
  const runs = client.executeRun.mock.calls.length;
  analysis.startShapeEdit(id);
  // Edited as traced, not as a polygon of corners.
  expect(analysis.windows[0].draft.geometry).toEqual(traced);
  analysis.endShapeEdit(true);
  await flush();
  expect(analysis.windows[0].draft.geometry).toEqual(traced);
  expect(client.executeRun.mock.calls.length).toBe(runs);
});

// eslint-disable-next-line max-lines-per-function
it("turns on a found chart's switch as its plot opens (no note telling what to do)", async () => {
  const analysis = store();
  client.executeRun.mockResolvedValue(result(1));
  analysis.variableSources = { ...analysis.variableSources, so: source };
  analysis.nextTurnOn = { turnOn: { timeView: "anomaly" }, at: Date.now() };
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 3, lon: 4 },
    map,
    rect
  );
  await flush();
  expect(analysis.windows[0].timeView).toBe("anomaly");
  expect(analysis.windows[0]).not.toHaveProperty("tip");
  // Taken once: the next plot opens plain.
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 5, lon: 6 },
    map,
    rect
  );
  await flush();
  expect(analysis.windows[1].timeView).toBeUndefined();
  // T–S: the salinity the caller resolved from metadata is the partner, never
  // one found by a name's substring.
  analysis.variableSources = {
    ...analysis.variableSources,
    ["salinometer_voltage"]: source,
  };
  analysis.nextTurnOn = {
    turnOn: { pair: { variable: "so" } },
    at: Date.now(),
  };
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 7, lon: 8 },
    map,
    rect
  );
  await flush();
  expect(analysis.windows[2]).toMatchObject({
    pairWith: "so",
    figure: "scatter",
  });
  // Unresolved ("salinity" alone): the scatter opens, no partner guessed.
  analysis.nextTurnOn = { turnOn: { pair: "salinity" }, at: Date.now() };
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 9, lon: 10 },
    map,
    rect
  );
  await flush();
  expect(analysis.windows[3].pairWith).toBeUndefined();
  expect(analysis.windows[3].figure).toBe("scatter");
});

it("compares daily means using the three shared intervals", async () => {
  const pinia = createPinia();
  const analysis = useAnalysisStore(pinia);
  const raw = [1, 2, 3, 4];
  analysis.$patch({
    windows: [0, 1].map((offset) => {
      const variable = offset ? "forward" : "backward";
      return {
        id: variable,
        label: variable,
        datasetName: "daily",
        kind: ANALYSIS_KINDS.POINT_SERIES,
        result: {
          kind: ANALYSIS_KINDS.POINT_SERIES,
          query: { variable },
          units: "K",
          cellMethods: "time: mean",
          time: {
            ...summary.time,
            raw,
            bounds: raw.flatMap((day) => [day - 1 + offset, day + offset]),
          },
          values: raw.map((day) => 10 * (day + offset)),
          dims: ["time"],
          shape: [raw.length],
        },
      };
    }),
  });
  analysis.openCompare();
  const { default: ComparePanel } =
    await import("@/ui/analysis/ComparePanel.vue");
  const app = createSSRApp(ComparePanel, {
    areaSize: { width: 900, height: 700 },
  });
  const html = await renderToString(app.use(pinia));
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const stats = html.match(
    /<table class="compare-stats"[^>]*>([\s\S]*?)<\/table>/
  )?.[1];
  const cells = Array.from(stats?.matchAll(/<td\b[^>]*>([^<]*)<\/td>/g) ?? []);

  // [1,2], [2,3] and [3,4] have matching means of 20, 30 and 40 K.
  expect({
    paired: Number(text.match(/\b(\d+) (?:times|dates)\b/)?.[1]),
    bias: Number(cells.at(-1)?.[1]),
  }).toEqual({ paired: 3, bias: 0 });
});

it("review of interim30 (#4): the catalog level read reaches the run, Method and provenance", async () => {
  const analysis = useAnalysisStore();
  // A two-level index whose levels name the variable in different stores:
  // plots read the first level's store, and say so.
  const level = { index: 0, count: 2, label: "https://example.org/l0.zarr" };
  analysis.setActiveSource({ ...source, level }, ref, "Example", {
    tas: { store: "https://example.org/l0.zarr", dataset: "" },
  });
  client.executeRun.mockResolvedValue(result(1));
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 1, lon: 2 },
    map,
    rect
  );
  await flush();
  const w = analysis.windows[0];
  expect(w.source.store).toBe("https://example.org/l0.zarr");
  expect(w.source.level).toEqual(level);
  expect(w.committed!.source.level).toBe("1 of 2: https://example.org/l0.zarr");
});

it("refuses a chosen wind pair whose units are no speed, as a found pair is", async () => {
  const id = "chosen-kelvin";
  const analysis = sparseWind(id, [0, 1, 2], 14);
  analysis.variableSources = {
    uas: { store: "s", dataset: "", units: "K" },
    vas: { store: "s", dataset: "", units: "K" },
  };
  await analysis.loadWind(id);
  const wind = analysis.windows[0].companions?.wind;
  expect(wind?.status).toBe("failed");
  expect(wind?.message).toMatch(/not a speed/);
  expect(client.executeRun).not.toHaveBeenCalled();
});

it("quotes unequal contiguous runs of sparse wind at their own lengths", async () => {
  const id = "unequal-wind";
  const dates = [0, ...Array.from({ length: 15 }, (_, k) => 100 + k)];
  const analysis = sparseWind(id, dates, 45);
  analysis.setComputeMode("ask");
  const chunk = 128 * 2 ** 20;
  const prices = new Map<string, number>();
  client.planRun.mockImplementation((run, _source, query) => {
    const chunks = query.time.stop - query.time.start;
    prices.set(run, chunks * chunk);
    return { ...modest, chunks, decodedBytes: chunks * chunk, modest: false };
  });
  const pending = analysis.loadWind(id);
  await flush();
  const quote = analysis.windows[0].companions?.wind;
  expect(quote?.status).toBe("confirm");
  expect(client.executeRun).not.toHaveBeenCalled();
  analysis.approveCompanions(id, "wind");
  await flush();
  const spent = client.executeRun.mock.calls.reduce(
    (total, [run]) => total + prices.get(run)!,
    0
  );
  analysis.setWind(id, false);
  await pending;
  expect(spent).toBeLessThanOrEqual(quote!.bytes!);
});

it("applies the Automatic cap to the full sparse wind selection", async () => {
  const id = "auto-wind-limit";
  const dates = Array.from({ length: 9 }, (_, k) => 100 * k);
  const analysis = sparseWind(id, dates, 46);
  analysis.setComputeMode("auto");
  const bytes = 256 * 2 ** 20;
  client.planRun.mockResolvedValue({
    ...modest,
    modest: false,
    decodedBytes: bytes,
  });
  const pending = analysis.loadWind(id);
  await flush();
  const state = analysis.windows[0].companions?.wind;
  const spent = bytes * client.executeRun.mock.calls.length;
  analysis.setWind(id, false);
  analysis.setComputeMode("ask");
  await pending;
  expect(spent).toBeLessThanOrEqual(2 * 2 ** 30);
  expect(state?.status).toBe("confirm");
});
