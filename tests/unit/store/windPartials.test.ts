/* eslint-disable max-lines-per-function -- one store fixture per case. */
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

function finiteDates(a: ReturnType<typeof sparseWind>) {
  const r = a.windows[0].companions?.wind?.results;
  return (
    r?.u.values.flatMap((x, i) =>
      Number.isFinite(x) && Number.isFinite(r.v.values[i]) ? [i] : []
    ) ?? []
  );
}
const pause = () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
};
it("64 dates: wholly warm U with 34 actual V values available", async () => {
  const id = "partials-warm",
    all = Array.from({ length: 64 }, (_, i) => i);
  const a = sparseWind(id, all, 30.6877);
  routePair(a, id);
  a.setComputeMode("auto");
  configureWindWorker(all);
  await a.loadWind(id);
  const plain = client.executeRun.getMockImplementation()!;
  const gate = pause();
  let didPublish = false;
  client.executeRun.mockImplementation(async (run, _src, onPart) => {
    const full = await plain(run);
    const q = full.query;
    if (q.variable === "vas_alt") {
      onPart?.({
        ...full,
        values: full.values.map((v: number, i: number) => (i < 34 ? v : NaN)),
        partial: { done: 34, total: 64, readUntil: 34 },
      });
      didPublish = true;
      await gate.wait;
    }
    return full;
  });
  a.windows[0].windChoice = { u: "uas", v: "vas_alt" };
  const pending = a.loadWind(id);
  await vi.waitFor(() => expect(didPublish).toBe(true));
  const held = finiteDates(a);
  gate.release();
  await pending;

  expect(held.length).toBe(34);
  expect(finiteDates(a).length).toBe(64);
});
it("old prefix while V extends", async () => {
  const id = "partials-extend",
    all = Array.from({ length: 64 }, (_, i) => i);
  const a = sparseWind(id, all.slice(0, 32), 30.6877);
  routePair(a, id);
  a.setComputeMode("auto");
  configureWindWorker(all);
  await a.loadWind(id);
  expect(finiteDates(a).length).toBe(32);
  const plain = client.executeRun.getMockImplementation()!;
  const gate = pause(),
    start = pause();
  let entered = false;
  client.executeRun.mockImplementation(async (run, _src, onPart) => {
    const full = await plain(run);
    if (full.query.variable === "vas") {
      entered = true;
      await start.wait;
      onPart?.({
        ...full,
        values: full.values.map((v: number, i: number) => (i < 15 ? v : NaN)),
        partial: { done: 15, total: 32, readUntil: 47 },
      });
      await gate.wait;
    }
    return full;
  });
  extendWindWindow(a, all);
  const pending = a.loadWind(id);
  await vi.waitFor(() => expect(entered).toBe(true));
  const before = finiteDates(a);
  start.release();
  await flush();
  const after = finiteDates(a);
  gate.release();
  await pending;

  expect(before.length).toBe(32);
  expect(after.length).toBe(47);
  expect(finiteDates(a).length).toBe(64);
});
it("sparse companion partials retain earlier complete pieces", async () => {
  const id = "partials-sparse",
    dates = [0, 1, 100, 101, 200, 201];
  const a = sparseWind(id, dates, 31);
  routePair(a, id);
  a.setComputeMode("auto");
  await a.loadWind(id);
  const plain = client.executeRun.getMockImplementation()!,
    gates = [pause(), pause(), pause()];
  let count = 0;
  client.executeRun.mockImplementation(async (run, _src, onPart) => {
    const full = await plain(run);
    if (full.query.variable === "vas_new") {
      const i = count++;
      onPart?.({
        ...full,
        partial: {
          done: full.values.length,
          total: full.values.length,
          readUntil: full.query.time.stop,
        },
      });
      await gates[i].wait;
    }
    return full;
  });
  a.windows[0].windChoice = { u: "uas", v: "vas_new" };
  const pending = a.loadWind(id);
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await vi.waitFor(() => expect(count).toBe(i + 1));
    seen.push(finiteDates(a));
    gates[i].release();
  }
  await pending;
  expect(finiteDates(a)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(seen[1]).toEqual([0, 1, 2, 3]);
});

it("share an extended date preview and restore its eight rows", async () => {
  const { sessionOf } = await import("@/store/analysisStore.ts");
  const { encodeSession, decodeSession } =
    await import("@/lib/analysis/sessionLink.ts");
  const { selectionOf, rowCount } = await import("@/lib/analysis/timeRows.ts");
  const traces = [];
  for (const sparse of [false, true]) {
    const raw = Array.from({ length: 32 }, (_, i) =>
      sparse ? (i % 2 === 0 ? i / 2 : 500 + (i - 1) / 2) : i
    );
    const whole = selectionOf(raw, 0, 15, 0, raw.length);
    const seen = selectionOf(raw, 0, 7, 0, raw.length);
    const id = "partials-link-" + sparse,
      a = sparseWind(id, raw, 12),
      w = a.windows[0];
    w.summary = {
      ...w.summary!,
      time: { ...summary.time, raw, chunk: 1 },
    } as never;
    const base = w.result!.query;
    const q = { ...base, time: whole };
    w.committed = { ...base, time: seen };
    w.preview = { intent: q } as never;
    w.rect = { x: 0, y: 0, w: 800, h: 500 };
    const restored = decodeSession(encodeSession(sessionOf([w]).session))
      .plots[0];
    w.preview = undefined;
    w.committed = { ...restored.query, source: ref };
    w.anchor = 0;
    w.shownRange = restored.view?.shownRange as typeof w.shownRange;
    const commit = vi.spyOn(a, "commit").mockImplementation(async () => {});
    expect(
      a.startPreview(id, {
        estimate: {
          chunks: 16,
          decodedBytes: 64 * 2 ** 20,
          outputValues: 16,
          workingBytes: 64 * 2 ** 20,
          modest: false,
          notes: [],
        },
      })
    ).toBe(true);
    const range = commit.mock.calls[0][1].time;
    traces.push({
      sparse,
      sharedShown: restored.view?.shownRange,
      sharedFullRows: rowCount(restored.query.time!),
      originalRows: rowCount(seen),
      reopenedRows: rowCount(range!),
      reopenedRange: range,
    });
    commit.mockRestore();
  }

  expect(traces.map((r) => r.reopenedRows)).toEqual([8, 8]);
});

it("does not advertise zero additional wind bytes while waiting for approval", async () => {
  const id = "partials-wind-confirm",
    all = Array.from({ length: 32 }, (_, i) => i);
  const a = sparseWind(id, all.slice(0, 16), 23);
  routePair(a, id);
  a.setComputeMode("ask");
  configureWindWorker(all);
  const w = a.windows[0];
  w.summary = {
    ...w.summary!,
    time: { ...summary.time, raw: all, chunk: 1 },
  } as never;
  client.planRun.mockImplementation((_id, _src, q) => ({
    ...modest,
    modest: false,
    decodedBytes: (q.time.stop - q.time.start) * 8 * 2 ** 20,
  }));
  const { overlayBytes } = await import("@/store/analysisStore.ts");
  const { withOverlayBytes } = await import("@/lib/analysis/preview.ts");
  const pending = a.loadWind(id);
  await vi.waitFor(() => expect(w.companions?.wind?.status).toBe("confirm"));
  // Waiting for approval, unpriced: the quote says so rather than adding 0.
  const pendingPrice = overlayBytes(w, { start: 0, stop: 32 });
  const own = { nextBytes: 128 * 2 ** 20, allBytes: 128 * 2 ** 20 } as never;
  const price = (v: number | undefined) =>
    withOverlayBytes(own, { next: v, all: v }, 0)?.facts.nextBytes;
  expect(pendingPrice).toBeUndefined();
  expect(price(pendingPrice)).toBeUndefined();
  a.approveCompanions(id, "wind");
  await pending;
  expect(overlayBytes(w, { start: 0, stop: 32 })).toBeGreaterThan(0);
});

/** A point series of `dates`, its values the dates themselves. */
const series = (dates: number[]) =>
  ({
    values: [...dates],
    time: {
      dimension: "time",
      raw: [...dates],
      units: "hours since 2000-01-01",
      calendar: "standard",
    },
    kind: "point-series",
    units: "m s-1",
    shape: [dates.length],
    dims: ["time"],
    query: { variable: "v" },
    notes: [],
    counters: {},
  }) as never;

it("publishes a sparse extension's partials in time linear in its rows", async () => {
  const { grownSegments, joinInOrder } =
    await import("@/store/analysisStore.ts");
  // 512 kept three-hour groups, 512 new ones, each new one partial first.
  const all = Array.from({ length: 1024 }, (_, i) => ({
    start: 6 * i,
    stop: 6 * i + 3,
    chunk: 1,
  }));
  const old = all.slice(0, 512);
  const before = series(
    old.flatMap((o) => [o.start, o.start + 1, o.start + 2])
  );
  const started = performance.now();
  let published = 0;
  const parts = await grownSegments(
    before,
    old,
    all,
    async (piece, publish) => {
      publish?.({
        ...(series([piece.start, NaN, NaN]) as object),
        partial: { done: 1, total: 3 },
      } as never);
      return series([piece.start, piece.start + 1, piece.start + 2]);
    },
    () => published++
  );
  expect(joinInOrder(parts).values).toEqual(
    all.flatMap((o) => [o.start, o.start + 1, o.start + 2])
  );
  expect(published).toBe(513);
  expect(performance.now() - started).toBeLessThan(250);
});

it.each([false, true])(
  "publishes a long sparse extension without joining it once a piece; backward=%s",
  async (backward) => {
    const { grownSegments, joinInOrder } =
      await import("@/store/analysisStore.ts");
    // 4,096 kept three-hour groups and 4,096 new ones.
    const all = Array.from({ length: 8192 }, (_, i) => ({
      start: 6 * i,
      stop: 6 * i + 3,
      chunk: 1,
    }));
    const old = backward ? all.slice(4096) : all.slice(0, 4096);
    const dates = (o: { start: number }) => [o.start, o.start + 1, o.start + 2];
    let shown = 0;
    // Values copied by slicing while it is read: the kept rows are sliced
    // only for what is shown.
    let sliced = 0;
    const slice = Array.prototype.slice;
    Array.prototype.slice = function (this: unknown[], ...args) {
      const out = slice.apply(this, args as never) as unknown[];
      sliced += out.length;
      return out;
    };
    const parts = await grownSegments(
      series(old.flatMap(dates)),
      old,
      all,
      async (piece, publish) => {
        publish?.({
          ...(series([piece.start, NaN, NaN]) as object),
          partial: { done: 1, total: 3 },
        } as never);
        return series(dates(piece));
      },
      (partial) => (shown += partial.values.length)
    ).finally(() => (Array.prototype.slice = slice));
    expect(joinInOrder(parts).values).toEqual(all.flatMap(dates));
    // Once a piece, every partial would carry 100 million rows in all.
    expect(shown).toBeLessThan(4_000_000);
    expect(sliced).toBeLessThan(4_000_000);
  }
);

it("shows a burst's last pairs on a long series after the worker goes quiet", async () => {
  const n = 4097;
  const dates = Array.from({ length: n }, (_, i) => i);
  const id = "burst";
  const a = sparseWind(id, dates, 31);
  routePair(a, id);
  a.setComputeMode("auto");
  configureWindWorker(dates);
  await a.loadWind(id);
  const plain = client.executeRun.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let burst!: () => void;
  const sent = new Promise<void>((resolve) => (burst = resolve));
  client.executeRun.mockImplementation(async (run: string, _src, onPart) => {
    const full = await plain(run);
    if (full.query.variable === "other_v") {
      const values = Array(n).fill(NaN);
      // Eight dates at once, then nothing until the read ends.
      for (let j = 0; j < 8; j++) {
        values[j] = 10 + j;
        onPart?.({
          ...full,
          values: values.slice(),
          partial: { done: j + 1, total: n, readUntil: j },
        });
      }
      burst();
      await gate;
    }
    return full;
  });
  a.windows[0].windChoice = { u: "uas", v: "other_v" };
  const pending = a.loadWind(id);
  await sent;
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(finiteDates(a)).toHaveLength(8);
  release();
  await pending;
  expect(finiteDates(a)).toHaveLength(n);
});
