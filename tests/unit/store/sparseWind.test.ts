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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

function routePair(a: ReturnType<typeof sparseWind>, name: string) {
  const route = { store: "https://example.org/" + name + ".zarr", dataset: "" };
  a.setActiveSource(source, ref, "regional catalogue", {
    uas: route,
    vas: route,
  });
}

function pairedDates(a: ReturnType<typeof sparseWind>) {
  const r = a.windows[0].companions?.wind?.results;
  return (
    r?.u.values.flatMap((x, i) =>
      Number.isFinite(x) && Number.isFinite(r.v.values[i]) ? [i] : []
    ) ?? []
  );
}

it("starts no later piece of a shared sparse wind once both windows stop", async () => {
  const id = "stop";
  const a = sparseWind(id, [0, 1, 100, 101, 200, 201, 300, 301], 51);
  routePair(a, id);
  a.setComputeMode("auto");
  a.windows.push({ ...a.windows[0], id: "stop-other" });
  const run = client.executeRun.getMockImplementation()!;
  const gates = [gate(), gate(), gate(), gate()];
  const started = new Map<number, number>();
  client.executeRun.mockImplementation(async (key: string) => {
    const r = await run(key);
    const at = r.query.time.start;
    started.set(at, (started.get(at) ?? 0) + 1);
    await gates[Math.floor(at / 100)].wait;
    return r;
  });
  const pending = [a.loadWind(id), a.loadWind("stop-other")];
  await vi.waitFor(() => expect(started.get(0)).toBe(2));
  await flush();
  a.setWind(id, false);
  gates[0].release();
  await vi.waitFor(() => expect(started.get(100)).toBe(2));
  await flush();
  a.setWind("stop-other", false);
  gates.forEach((g) => g.release());
  await Promise.all(pending);
  expect(a.windows.every((w) => !w.companions?.wind)).toBe(true);
  expect([started.get(200), started.get(300)]).toEqual([undefined, undefined]);
});

it("shows cached sparse wind pieces while the next piece is read", async () => {
  const id = "warm";
  const dates = [0, 1, 100, 101, 200, 201];
  const a = sparseWind(id, dates, 52);
  routePair(a, id);
  a.setComputeMode("auto");
  await a.loadWind(id);
  const seed = sparseWind("warm-seed", dates.slice(0, 4), 52);
  routePair(seed, id);
  seed.setComputeMode("auto");
  seed.windows[0].windChoice = { u: "uas", v: "vas_alt" };
  await seed.loadWind("warm-seed");
  const plain = client.executeRun.getMockImplementation()!;
  const [hold, entered] = [gate(), gate()];
  client.executeRun.mockImplementation(async (key: string) => {
    const r = await plain(key);
    if (r.query.variable === "vas_alt" && r.query.time.start === 200) {
      entered.release();
      await hold.wait;
    }
    return r;
  });
  a.windows[0].windChoice = { u: "uas", v: "vas_alt" };
  const pending = a.loadWind(id);
  await entered.wait;
  await flush();
  expect(pairedDates(a)).toEqual([0, 1, 2, 3]);
  hold.release();
  await pending;
  expect(pairedDates(a)).toEqual([0, 1, 2, 3, 4, 5]);
});
