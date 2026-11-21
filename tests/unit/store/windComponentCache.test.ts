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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

it("review of interim43: a wholly cached component leaves its partner free to read", async () => {
  const id = "one-warm";
  const a = sparseWind(id, [0, 100, 200], 61);
  a.setComputeMode("ask");
  client.planRun.mockResolvedValue({ ...modest, decodedBytes: 2 ** 20 });
  await a.loadWind(id);
  expect(a.windows[0].companions?.wind?.status).toBe("ready");
  expect(client.executeRun.mock.calls.length).toBe(6);
  a.setWindChoice(id, { u: "uas", v: "vas_alt" });
  for (let i = 0; i < 20; i++) {
    await flush();
  }
  const plans = client.planRun.mock.calls.map(([, , q]) => q.variable);
  expect(plans.filter((v) => v === "vas_alt").length).toBeGreaterThan(0);
  expect(client.executeRun.mock.calls.length).toBeGreaterThan(6);
  expect(a.windows[0].companions?.wind?.status).toBe("ready");
  a.setWind(id, false);
});

it("review of interim43: Extend with barbs on quotes the components' new chunks", async () => {
  const id = "barbs-quote";
  // The plot shows dates 0, 100 and 200 of an axis that goes on to 300.
  const a = sparseWind(id, [0, 100, 200], 63);
  a.windows[0].summary = {
    ...a.windows[0].summary!,
    time: { ...summary.time, raw: [0, 100, 200, 300], chunk: 1 },
  } as never;
  a.setComputeMode("auto");
  client.planRun.mockResolvedValue({ ...modest, decodedBytes: 2 ** 20 });
  await a.loadWind(id);
  expect(a.windows[0].companions?.wind?.status).toBe("ready");
  const { overlayBytes } = await import("@/store/analysisStore.ts");
  // One more date: one more stored chunk of each component, 1 MiB each.
  expect(overlayBytes(a.windows[0], { start: 0, stop: 4 })).toBe(2 * 2 ** 20);
  // The dates shown cost nothing more; read again, all of them.
  expect(overlayBytes(a.windows[0], { start: 0, stop: 3 })).toBe(0);
  expect(overlayBytes(a.windows[0], { start: 0, stop: 4 }, true)).toBe(
    8 * 2 ** 20
  );
  a.setWind(id, false);
});

it("independent review of interim45: one dense run of wind chunks is priced a chunk at a time", async () => {
  const id = "barbs-dense";
  const chunk = 24;
  const shown = Array.from({ length: 792 }, (_, at) => at);
  const a = sparseWind(id, shown, 61);
  const coords = (raw: number[]) => ({ ...summary.time, raw, chunk });
  const dense = Array.from({ length: 1584 }, (_, at) => at);
  configureWindWorker(dense);
  client.describeVariable.mockResolvedValue({
    ...summary,
    time: coords(dense),
  });
  a.windows[0].summary = {
    ...a.windows[0].summary!,
    time: coords(dense),
  } as never;
  a.setComputeMode("auto");
  // A component's 33 stored chunks of 503,808 bytes, planned as one run.
  const perChunk = 503_808;
  client.planRun.mockResolvedValue({ ...modest, decodedBytes: 33 * perChunk });
  await a.loadWind(id);
  expect(a.windows[0].companions?.wind?.status).toBe("ready");
  const { overlayBytes } = await import("@/store/analysisStore.ts");
  // The next 792 dates: 33 new chunks of each component.
  expect(overlayBytes(a.windows[0], { start: 0, stop: 1584 })).toBe(
    2 * 33 * perChunk
  );
  a.setWind(id, false);
});

it("interim47 dense wind extension dispatches only the new dates advertised by its quote", async () => {
  const id = "dense-wind-extend";
  const dense = Array.from({ length: 65 }, (_, k) => k);
  const a = sparseWind(id, dense.slice(0, 64), 53);
  const w = a.windows[0];
  const coords = (raw: number[]) => ({ ...summary.time, raw, chunk: 1 });
  configureWindWorker(dense);
  w.summary = { ...w.summary!, time: coords(dense) } as never;
  a.setComputeMode("auto");
  const MiB = 2 ** 20;
  client.planRun.mockImplementation(async (_id, _source, q) => ({
    ...modest,
    decodedBytes: (q.time.stop - q.time.start) * MiB,
  }));
  await a.loadWind(id);
  expect(w.companions?.wind?.status).toBe("ready");
  const { overlayBytes } = await import("@/store/analysisStore.ts");
  const added = { start: 0, stop: 65 };
  const quote = overlayBytes(w, added);
  expect(quote).toBe(2 * MiB);
  w.result = {
    ...w.result!,
    query: { ...w.result!.query, time: added },
    shape: [65],
    values: dense,
    time: coords(dense),
  };
  const start = client.executeRun.mock.calls.length;
  await a.loadWind(id);
  const work = client.executeRun.mock.calls
    .slice(start)
    .map(([id]) => client.planRun.mock.calls.find(([run]) => run === id)![2]);
  expect(w.companions?.wind?.status).toBe("ready");
  console.log("Dense wind Extend", {
    quoteMiB: quote! / MiB,
    scheduled: work.map((q) => [q.variable, q.time.start, q.time.stop]),
  });
  expect(work.reduce((n, q) => n + (q.time.stop - q.time.start) * MiB, 0)).toBe(
    quote
  );
});

function routePair(a: ReturnType<typeof sparseWind>, name: string) {
  const route = { store: "https://example.org/" + name + ".zarr", dataset: "" };
  a.setActiveSource(source, ref, "regional catalogue", {
    uas: route,
    vas: route,
  });
}

function extendWindWindow(a: ReturnType<typeof sparseWind>, raw: number[]) {
  const w = a.windows[0];
  const time = { ...summary.time, raw, chunk: 1 };
  w.summary = { ...w.summary!, time } as never;
  w.result = {
    ...w.result!,
    query: { ...w.result!.query, time: { start: 0, stop: raw.length } },
    time,
    shape: [raw.length],
    values: raw.map(() => 1),
  };
}

it("interim48 rereads the wind prefix when the selected component's catalogue route changes", async () => {
  const id = "route48";
  const dates = [0, 1, 2, 3];
  const a = sparseWind(id, dates, 11);
  a.setComputeMode("auto");
  routePair(a, "first-wind");
  client.describeVariable.mockResolvedValue({
    ...summary,
    time: { ...summary.time, raw: [...dates, 4], chunk: 1 },
  });
  client.executeRun.mockImplementation((run: string) => {
    const [, src, q] = client.planRun.mock.calls.find(([key]) => key === run)!;
    const raw = [...dates, 4].slice(q.time.start, q.time.stop);
    const tag = src.store.endsWith("/second-wind.zarr") ? 20 : 10;
    return {
      ...result(0),
      query: q,
      time: { ...summary.time, raw },
      units: "m s-1",
      values: raw.map((t) => t + tag),
      shape: [raw.length],
      dims: ["time"],
    };
  });
  await a.loadWind(id);
  expect(a.windows[0].companions?.wind?.results?.u.values).toEqual([
    10, 11, 12, 13,
  ]);
  routePair(a, "second-wind");
  extendWindWindow(a, [...dates, 4]);
  await a.loadWind(id);
  expect(a.windows[0].companions?.wind?.status).toBe("ready");
  expect(a.windows[0].companions?.wind?.results?.u.values).toEqual([
    20, 21, 22, 23, 24,
  ]);
});

it("interim48 keeps the wind prefix across a publication outside all displayed and requested dates", async () => {
  const id = "outside48";
  const full = Array.from({ length: 65 }, (_, date) => date);
  const a = sparseWind(id, full.slice(0, 64), 12);
  routePair(a, "outside48");
  a.setComputeMode("auto");
  configureWindWorker(full);
  const w = a.windows[0];
  w.summary = {
    ...w.summary!,
    time: { ...summary.time, raw: full, chunk: 1 },
  } as never;
  const MiB = 2 ** 20;
  client.planRun.mockImplementation(async (_id, _src, q) => ({
    ...modest,
    decodedBytes: (q.time.stop - q.time.start) * MiB,
  }));
  await a.loadWind(id);
  a.livePublished(100, 100);
  expect(w.companions?.wind?.stale).toBeFalsy();
  const { overlayBytes } = await import("@/store/analysisStore.ts");
  const quote = overlayBytes(w, { start: 0, stop: 65 });
  expect(quote).toBe(2 * MiB);
  const before = client.executeRun.mock.calls.length;
  extendWindWindow(a, full);
  await a.loadWind(id);
  expect(w.companions?.wind?.status).toBe("ready");
  const work = client.executeRun.mock.calls
    .slice(before)
    .map(([id]) => client.planRun.mock.calls.find(([run]) => run === id)![2]);
  expect(work.reduce((n, q) => n + (q.time.stop - q.time.start) * MiB, 0)).toBe(
    quote
  );
});

it("interim48 releases a closed window's wind prefix when another window finishes the shared read", async () => {
  const dates = Array.from({ length: 128 }, (_, i) => i);
  const closedId = "closed-wind48";
  const liveId = "live-wind48";
  const a = sparseWind(closedId, dates, 71);
  const b = sparseWind(liveId, dates, 71);
  configureWindWorker(dates);
  const exec = client.executeRun.getMockImplementation()!;
  let resume!: () => void;
  const pause = new Promise<void>((resolve) => {
    resume = resolve;
  });
  client.executeRun.mockImplementation(async (run: string) => {
    await pause;
    return exec(run);
  });
  const oldRead = a.loadWind(closedId);
  const liveRead = b.loadWind(liveId);
  await vi.waitFor(() => expect(client.executeRun).toHaveBeenCalledTimes(2));
  a.close(closedId);
  expect(a.windows).toHaveLength(0);
  let hasPrefix: ((key: unknown) => boolean) | undefined;
  const set = Map.prototype.set;
  const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown
  ) {
    if (
      typeof key === "string" &&
      typeof value === "object" &&
      value &&
      "epoch" in value &&
      "results" in value
    ) {
      hasPrefix = this.has.bind(this);
    }
    return set.call(this, key, value);
  });
  try {
    resume();
    await Promise.all([oldRead, liveRead]);
  } finally {
    spy.mockRestore();
  }
  expect(b.windows[0].companions?.wind?.status).toBe("ready");
  expect(hasPrefix?.(liveId + ":wind")).toBe(true);
  expect(hasPrefix?.(closedId + ":wind")).toBe(false);
});

it("interim49: turning Barbs off lets the components read go", async () => {
  const id = "barbs-off49";
  const dates = [0, 1, 2, 3];
  const a = sparseWind(id, dates, 13);
  routePair(a, "barbs-off49");
  a.setComputeMode("auto");
  configureWindWorker([...dates, 4]);
  await a.loadWind(id);
  expect(a.windows[0].companions?.wind?.status).toBe("ready");
  a.setWind(id, false);
  // On again over more dates: nothing kept to grow, all of them read.
  extendWindWindow(a, [...dates, 4]);
  const before = client.executeRun.mock.calls.length;
  a.windows[0].wind = true;
  await a.loadWind(id);
  const read = client.executeRun.mock.calls
    .slice(before)
    .map(([run]) => client.planRun.mock.calls.find(([key]) => key === run)![2])
    .reduce((n, q) => n + (q.time.stop - q.time.start), 0);
  expect(read).toBe(2 * 5);
});

it("interim49: a geometry is serialized once however many members compare it", async () => {
  const { geometryDigest } = await import("@/store/analysisStore.ts");
  const ring = Array.from({ length: 6001 }, (_, k) => ({
    lat: k / 100,
    lon: 0,
  }));
  const geometry = { kind: "polygon", rings: [ring] } as never;
  const stringify = vi.spyOn(JSON, "stringify");
  for (let k = 0; k < 58; k++) {
    geometryDigest(geometry);
  }
  expect(stringify).toHaveBeenCalledTimes(1);
  stringify.mockRestore();
});

it("interim49: co-chunked members cost nothing more within the chunk cache, one pass past it", async () => {
  const { otherMemberReads } = await import("@/store/analysisStore.ts");
  const together = { size: 4, chunk: 4 };
  expect(otherMemberReads(together, 15 * 2 ** 20)).toBe(0);
  expect(otherMemberReads(together, 65 * 2 ** 20)).toBe(1);
  expect(otherMemberReads({ size: 4, chunk: 1 }, 65 * 2 ** 20)).toBe(3);
});

it("interim49: the barbs' progress averages both components from zero", async () => {
  const id = "barb-progress49";
  const dates = [0, 1, 2, 3];
  const a = sparseWind(id, dates, 17);
  routePair(a, "barb-progress49");
  a.setComputeMode("auto");
  configureWindWorker(dates);
  const plain = client.executeRun.getMockImplementation()!;
  const seen: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  client.executeRun.mockImplementation(
    async (run: string, _src: unknown, onPartial?: (r: unknown) => void) => {
      const whole = await plain(run);
      if (first) {
        first = false;
        // One component half read, the other not started yet.
        onPartial?.({ ...whole, partial: { done: 1, total: 2, readUntil: 2 } });
        seen.push(a.windows[0].companions?.wind?.progress?.done ?? -1);
        await held;
      }
      return whole;
    }
  );
  const loading = a.loadWind(id);
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  release();
  await loading;
  expect(seen[0]).toBe(250);
  expect(a.windows[0].companions?.wind?.status).toBe("ready");
});

it("interim50: barbs pair as soon as one component is whole and the other part read", async () => {
  const id = "barb-early50";
  const dates = [0, 1, 2, 3];
  const a = sparseWind(id, dates, 17);
  routePair(a, "barb-early50");
  a.setComputeMode("auto");
  configureWindWorker(dates);
  const plain = client.executeRun.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  let midway: unknown;
  client.executeRun.mockImplementation(
    async (run: string, _src: unknown, onPartial?: (r: unknown) => void) => {
      const whole = await plain(run);
      if (++calls === 2) {
        // The first component is whole; this one has its first half.
        await new Promise((resolve) => setTimeout(resolve, 0));
        onPartial?.({ ...whole, partial: { done: 1, total: 2, readUntil: 2 } });
        midway = a.windows[0].companions?.wind?.results;
        await held;
      }
      return whole;
    }
  );
  const loading = a.loadWind(id);
  await vi.waitFor(() => expect(calls).toBe(2));
  await vi.waitFor(() => expect(midway).toBeDefined());
  release();
  await loading;
  expect(a.windows[0].companions?.wind?.status).toBe("ready");
});

it("interim50: Extend prices the plot's own component once", async () => {
  const id = "barbs-own";
  const a = sparseWind(id, [0, 100, 200], 63);
  a.windows[0].summary = {
    ...a.windows[0].summary!,
    time: { ...summary.time, raw: [0, 100, 200, 300], chunk: 1 },
  } as never;
  a.setComputeMode("auto");
  client.planRun.mockResolvedValue({ ...modest, decodedBytes: 2 ** 20 });
  await a.loadWind(id);
  const { overlayBytes, queryKey } = await import("@/store/analysisStore.ts");
  const w = a.windows[0];
  expect(overlayBytes(w, { start: 0, stop: 4 })).toBe(2 * 2 ** 20);
  // The plot shows U itself: its new chunk is in the plot's own price.
  const query = { ...w.result!.query, variable: "uas" };
  w.result = { ...w.result!, query };
  w.companions!.wind!.key = queryKey(
    w.committedBinding?.source ?? w.source,
    query
  );
  expect(overlayBytes(w, { start: 0, stop: 4 })).toBe(2 ** 20);
  a.setWind(id, false);
});
