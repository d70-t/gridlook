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

beforeEach(() => {
  setActivePinia(createPinia());
  Object.values(client).forEach((fn) => fn.mockReset());
  client.describeVariable.mockResolvedValue(summary);
  client.planRun.mockResolvedValue(modest);
  page.hash = "#https://example.org/data.zarr";
});

it("review of interim43: a new sparse date inside the old span is read when the plot extends", async () => {
  const analysis = useAnalysisStore(createPinia());
  // The plot every 100 days, the partner daily in chunks of 8.
  const old = 512;
  const every = (n: number) => Array.from({ length: n }, (_, i) => 3 * i);
  const daily = Array.from({ length: 1600 }, (_, at) => at);
  const coords = (raw: number[], chunk: number) => ({
    ...summary.time,
    raw,
    chunk,
  });
  const plot = (n: number) => {
    const query = {
      version: 1 as const,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      geometry: { kind: "point" as const, lat: 0, lon: 0 },
      fixed: {},
      source: ref,
      variable: "tas",
      time: { start: 0, stop: n },
    };
    return {
      kind: query.kind,
      query,
      time: coords(every(n), 1),
      values: every(n),
      shape: [n],
      dims: ["time"],
    };
  };
  analysis.$patch({
    windows: [
      {
        id: "sparse-pair",
        kind: ANALYSIS_KINDS.POINT_SERIES,
        source,
        sourceRef: ref,
        pairWith: "hus",
        status: PLOT_STATUS.DONE,
        summary: { ...summary, time: coords(every(old + 1), 1) },
        result: plot(old),
      },
    ],
  });
  client.describeVariable.mockResolvedValue({
    ...summary,
    variable: "hus",
    time: coords(daily, 1),
  });
  client.executeRun.mockImplementation((id: string) => {
    const query = client.planRun.mock.calls.find(([run]) => run === id)![2];
    const raw = daily.slice(query.time.start, query.time.stop);
    return {
      ...result(0),
      query,
      time: coords(raw, 1),
      values: raw,
      shape: [raw.length],
      dims: ["time"],
    };
  });
  await analysis.loadPair("sparse-pair");
  const reads = () =>
    client.planRun.mock.calls
      .filter(([, , query]) => query.variable === "hus")
      .map(([, , query]) => query.time.stop - query.time.start);
  const first = reads().length;
  expect(first).toBe(old);
  // Eight runs of the modest estimate for eight dates: Extend's price
  // adds this much per new date for the partner.
  expect(analysis.windows[0].companions?.pair?.perDate).toBe(
    modest.decodedBytes
  );
  analysis.windows[0].result = plot(old + 1) as never;
  const apply = Array.prototype.forEach;
  const tally = new Map<unknown[], number>();
  const spy = vi.spyOn(Array.prototype, "forEach").mockImplementation(function (
    this: { start?: number }[],
    callback,
    ...args
  ) {
    if (
      this.length === old &&
      this[0]?.start === 0 &&
      this.at(-1)?.start === 3 * (old - 1)
    ) {
      tally.set(this, (tally.get(this) ?? 0) + 1);
    }
    return apply.call(this, callback, ...args);
  });
  try {
    await analysis.loadPair("sparse-pair");
  } finally {
    spy.mockRestore();
  }
  const passes = Math.max(...tally.values());
  console.log("sparse partner Extend", {
    old,
    now: old + 1,
    newReads: reads().length - first,
    passes,
    comparisons: passes * old,
  });
  expect(reads().length - first).toBe(1);
  expect(passes).toBeLessThanOrEqual(1);
});
