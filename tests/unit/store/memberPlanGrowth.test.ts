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
const { useAnalysisStore, PLOT_STATUS } =
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

const seriesOf = (values: number[]) => ({
  ...result(values[0]),
  values,
  dims: ["time"],
  shape: [values.length],
  time: {
    dimension: "time",
    raw: values.map((_, t) => t),
    units: "days since 2000-01-01",
  },
});

// eslint-disable-next-line max-lines-per-function -- one store sequence.
it("review of interim43: Automatic asks again when queued member plans grow past its cap", async () => {
  const analysis = store();
  analysis.setComputeMode("auto");
  client.describeVariable.mockResolvedValue({
    ...summary,
    dims: ["time", "member", "cell"],
    shape: [4, 100, 768],
    others: [{ dimension: "member", size: 100, ensemble: true }],
  });
  const gate = deferred<void>();
  let expensive = false;
  const plans = new Map();
  const dispatch: number[] = [];
  client.planRun.mockImplementation(async (id, _, q) => {
    const m = q.fixed.member ?? 0;
    // An unrelated point (at −44°) is a few bytes.
    const mib = q.geometry?.lat === -44 ? 2 ** -20 : expensive ? 48 : 15;
    plans.set(id, { m, mib });
    return { ...modest, decodedBytes: mib * 2 ** 20 };
  });
  client.executeRun.mockImplementation(async (id) => {
    const { m, mib } = plans.get(id);
    if (m !== 0) {
      dispatch.push(mib);
      if (!expensive) {
        await gate.promise;
      }
    }
    return { ...seriesOf([m]), counters: { decodedBytes: mib * 2 ** 20 } };
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: -34, lon: 10 },
    map,
    rect
  );
  for (let i = 0; i < 5; i++) {
    await flush();
  }
  const [w] = analysis.windows;
  analysis.setMembers(w.id, "plume");
  for (let i = 0; i < 6; i++) {
    await flush();
  }
  const planned = plans.size;
  const before = dispatch.length;
  expensive = true;
  analysis.livePublished(0, 0);
  gate.resolve();
  for (let i = 0; i < 16; i++) {
    await flush();
  }
  const total = dispatch.reduce((a, b) => a + b, 0);
  expect(planned).toBe(100);
  expect(total).toBeLessThan(2048);
  expect(dispatch.length).toBeLessThan(99);
  expect(w.companions?.members?.status).toBe("confirm");
  void before;
  const unrelated = analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: -44, lon: 15 },
    map,
    rect
  );
  for (let i = 0; i < 16; i++) {
    await flush();
  }
  await unrelated;
  expect(analysis.windows[1].status).toBe(PLOT_STATUS.DONE);
  expect(w.companions?.members?.status).toBe("confirm");
});

// eslint-disable-next-line max-lines-per-function -- one store sequence.
it("independent review of interim45: members grow by the new dates only", async () => {
  const analysis = store();
  analysis.setComputeMode("auto");
  client.describeVariable.mockResolvedValue({
    ...summary,
    dims: ["time", "member", "cell"],
    shape: [8, 4, 768],
    time: { ...summary.time, raw: [0, 1, 2, 3, 4, 5, 6, 7] },
    others: [{ dimension: "member", size: 4, ensemble: true }],
  });
  const asked = new Map<string, { m: number; start: number; stop: number }>();
  client.planRun.mockImplementation(async (id, _, q) => {
    asked.set(id, {
      m: q.fixed.member ?? 0,
      start: q.time.start,
      stop: q.time.stop,
    });
    return modest;
  });
  client.executeRun.mockImplementation(async (id) => {
    const { m, start, stop } = asked.get(id)!;
    const values = Array.from(
      { length: stop - start },
      (_, t) => 10 * m + start + t
    );
    return {
      ...seriesOf(values),
      query: { ...plans0, fixed: { member: m }, time: { start, stop } },
      time: {
        dimension: "time",
        raw: values.map((_, t) => start + t),
        units: "days since 2000-01-01",
      },
    };
  });
  const plans0 = {
    version: 1 as const,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    geometry: { kind: "point" as const, lat: -30, lon: 10 },
    variable: "tas",
    fixed: {},
    source: {
      ref: "https://example.org/data.zarr",
      versionStatus: "best-effort" as const,
    },
  };
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: -30, lon: 10 },
    map,
    rect,
    { ...plans0, time: { start: 0, stop: 4 } }
  );
  for (let i = 0; i < 6; i++) {
    await flush();
  }
  const [w] = analysis.windows;
  analysis.setMembers(w.id, "plume");
  for (let i = 0; i < 8; i++) {
    await flush();
  }
  expect(w.companions?.members?.status).toBe("ready");
  // The plot extended to eight dates; the members follow it.
  const before = asked.size;
  const longer = {
    ...plans0,
    fixed: { member: 0 },
    time: { start: 0, stop: 8 },
  };
  w.result = {
    ...seriesOf([0, 1, 2, 3, 4, 5, 6, 7]),
    query: longer,
  } as never;
  await analysis.loadMembers(w.id);
  const reads = [...asked.values()].slice(before).filter((r) => r.m !== 0);
  expect(reads.map((r) => [r.m, r.start, r.stop])).toEqual([
    [1, 4, 8],
    [2, 4, 8],
    [3, 4, 8],
  ]);
  const members = w.companions?.members?.results as Record<
    string,
    { values: number[] }
  >;
  expect(members[2].values).toEqual([20, 21, 22, 23, 24, 25, 26, 27]);
});

it.each(["moved point", "republished prefix"] as const)(
  "interim47 refreshes earlier ensemble values when a larger query has a %s",
  // eslint-disable-next-line max-lines-per-function -- one store session checks values before and after the change.
  async (change) => {
    const analysis = store();
    analysis.setComputeMode("auto");
    client.describeVariable.mockResolvedValue({
      ...summary,
      dims: ["time", "member", "cell"],
      shape: [8, 2, 768],
      time: { ...summary.time, raw: [0, 1, 2, 3, 4, 5, 6, 7] },
      others: [{ dimension: "member", size: 2, ensemble: true }],
    });
    const firstLat = change === "moved point" ? 10 : 30;
    const initial = {
      version: 1 as const,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      geometry: { kind: "point" as const, lat: firstLat, lon: 0 },
      variable: "tas",
      fixed: { member: 0 },
      source: ref,
      time: { start: 0, stop: 4 },
    };
    const plans = new Map<string, typeof initial>();
    let correction = 0;
    client.planRun.mockImplementation(async (id, _, q) => {
      plans.set(id, q);
      return modest;
    });
    client.executeRun.mockImplementation(async (id) => {
      const q = plans.get(id)!;
      const raw = Array.from(
        { length: q.time.stop - q.time.start },
        (_, r) => q.time.start + r
      );
      const values = raw.map(
        (t) =>
          q.geometry.lat * 10 + q.fixed.member + t + (t < 4 ? correction : 0)
      );
      return { ...seriesOf(values), query: q, time: { ...summary.time, raw } };
    });
    await analysis.openWindow(
      initial.kind,
      initial.geometry,
      map,
      rect,
      initial
    );
    const [w] = analysis.windows;
    w.members = "plume";
    await analysis.loadMembers(w.id);
    expect(w.companions?.members?.results?.[1].values[0]).toBe(
      10 * firstLat + 1
    );
    if (change === "republished prefix") {
      correction = 1000;
      analysis.livePublished(0, 3);
      expect(w.companions?.members?.stale).toBe(true);
    }
    const next = {
      ...initial,
      geometry: {
        ...initial.geometry,
        lat: firstLat + (change === "moved point" ? 10 : 0),
      },
      time: { start: 0, stop: 8 },
    };
    await analysis.commit(w.id, next);
    await analysis.loadMembers(w.id);
    const expected = w.result!.values.map((v) => v + 1);
    expect(w.companions?.members?.status).toBe("ready");
    expect(w.companions?.members?.results?.[1].values).toEqual(expected);
  }
);
