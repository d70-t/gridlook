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

// eslint-disable-next-line max-lines-per-function
it("v20 review: a late partner for an old choice cannot overwrite the new one, and partners align by time", async () => {
  const analysis = store();
  const variableOf = new Map<string, string>();
  client.planRun.mockImplementation(
    async (runId: string, _source: unknown, query: { variable: string }) => {
      variableOf.set(runId, query.variable);
      return modest;
    }
  );
  const series = (tag: number, times = [0, 1, 2, 3]) => ({
    ...result(tag),
    values: times.map((t) => tag + t),
    dims: ["time"],
    shape: [times.length],
    time: {
      dimension: "time",
      raw: times,
      units: "days since 2000-01-01",
      calendar: "standard",
    },
  });
  const slowB = deferred<ReturnType<typeof series>>();
  client.executeRun.mockImplementation((runId: string) => {
    const variable = variableOf.get(runId);
    return variable === "B"
      ? slowB.promise
      : Promise.resolve(
          variable === "C"
            ? series(200, [3, 2, 1, 0]) // the same days, stored backwards
            : series(0)
        );
  });
  // A point of its own: results of other tests stay in the page cache.
  for (const at of [0, 1]) {
    void analysis.openWindow(
      ANALYSIS_KINDS.POINT_SERIES,
      { kind: "point", lat: 41, lon: 42 },
      map,
      { ...rect, x: at * 10 }
    );
  }
  await flush();
  await flush();
  const [one, two] = analysis.windows;
  // Both windows share the slow read of B.
  analysis.setPair(one.id, "B");
  analysis.setPair(two.id, "B");
  await flush();
  // One switches to C, which is fast.
  analysis.setPair(one.id, "C");
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const shownC = () => analysis.windows[0].companions?.pair;
  expect(shownC()?.choice).toBe("C");
  // C's values at the plot's own days, not by index: day 0 is 200.
  expect(shownC()?.results?.other.values).toEqual([200, 201, 202, 203]);
  // B finally completes: the window still shows C.
  slowB.resolve(series(100));
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  expect(shownC()?.choice).toBe("C");
  expect(shownC()?.results?.other.values).toEqual([200, 201, 202, 203]);
  expect(analysis.windows[1].companions?.pair?.results?.other.values).toEqual([
    100, 101, 102, 103,
  ]);
});

it("v20 review: a publication during a run reaches the next window and Apply", async () => {
  const analysis = store();
  const first = deferred<ReturnType<typeof result>>();
  let calls = 0;
  client.executeRun.mockImplementation(() => {
    calls++;
    return calls === 1 ? first.promise : Promise.resolve(result(85));
  });
  const point = { kind: "point" as const, lat: 51, lon: 52 };
  void analysis.openWindow(ANALYSIS_KINDS.POINT_SERIES, point, map, rect);
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  // The source publishes the steps while the first read runs.
  analysis.livePublished(0, 3);
  // A second window asks for the same plot: it does not join the old read.
  void analysis.openWindow(ANALYSIS_KINDS.POINT_SERIES, point, map, {
    ...rect,
    x: 20,
  });
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  first.resolve(result(1));
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const [one, two] = analysis.windows;
  expect(two.result?.values).toEqual([85]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  expect(one.result?.values).toEqual([85]);
  expect(calls).toBe(3);
  // Nothing published since: no further reads.
  for (let k = 0; k < 4; k++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(calls).toBe(3);
});

it("v20 review: a large companion is priced and waits for Read", async () => {
  const analysis = store();
  const variableOf = new Map<string, string>();
  client.planRun.mockImplementation(
    async (runId: string, _source: unknown, query: { variable: string }) => {
      variableOf.set(runId, query.variable);
      return query.variable === "huge"
        ? { ...modest, modest: false, chunks: 1024, decodedBytes: 4 * 2 ** 30 }
        : modest;
    }
  );
  const executed: string[] = [];
  client.executeRun.mockImplementation((runId: string) => {
    executed.push(variableOf.get(runId)!);
    return Promise.resolve({
      ...result(1),
      values: [1],
      dims: ["time"],
      shape: [1],
      time: { dimension: "time", raw: [0], units: "days since 2000-01-01" },
    });
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 61, lon: 62 },
    map,
    rect
  );
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const id = analysis.windows[0].id;
  analysis.setPair(id, "huge");
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  const pair = () => analysis.windows[0].companions?.pair;
  expect(pair()?.status).toBe("confirm");
  expect(pair()?.message).toMatch(/huge needs about 4\.0 GiB in 1,024 chunks/);
  expect(executed).not.toContain("huge");
  analysis.approveCompanions(id, "pair");
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(executed).toContain("huge");
  expect(pair()?.status).toBe("ready");
});

it("review #17: switching to Automatic leaves a companion over its cap waiting", async () => {
  const analysis = store();
  const variableOf = new Map<string, string>();
  client.planRun.mockImplementation(
    async (runId: string, _source: unknown, query: { variable: string }) => {
      variableOf.set(runId, query.variable);
      return query.variable === "vast"
        ? { ...modest, modest: false, chunks: 1024, decodedBytes: 4 * 2 ** 30 }
        : modest;
    }
  );
  const executed: string[] = [];
  client.executeRun.mockImplementation((runId: string) => {
    executed.push(variableOf.get(runId)!);
    return Promise.resolve({
      ...result(1),
      values: [1],
      dims: ["time"],
      shape: [1],
      time: { dimension: "time", raw: [0], units: "days since 2000-01-01" },
    });
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 63, lon: 64 },
    map,
    rect
  );
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const id = analysis.windows[0].id;
  analysis.setPair(id, "vast");
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  const pair = () => analysis.windows[0].companions?.pair;
  expect(pair()?.status).toBe("confirm");
  expect(pair()?.message).toMatch(/vast needs about 4\.0 GiB in 1,024 chunks/);
  expect(executed).not.toContain("vast");
  // Automatic starts plots up to 2 GiB unasked: 4 GiB still asks.
  analysis.setComputeMode("auto");
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(executed).not.toContain("vast");
  expect(pair()?.status).toBe("confirm");
  expect(pair()?.bytes).toBe(4 * 2 ** 30);
  analysis.setComputeMode("ask");
});

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

it("v24 review: a plot waiting for Compute across a publication is planned again", async () => {
  const analysis = store();
  let published = false;
  const plans: boolean[] = [];
  client.planRun.mockImplementation(async () => {
    plans.push(published);
    return { ...modest, modest: false };
  });
  client.executeRun.mockImplementation(async () =>
    seriesOf(published ? [1, 7, 71, 85] : [1, NaN, NaN, NaN])
  );
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 71, lon: 72 },
    map,
    rect
  );
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const id = analysis.windows[0].id;
  expect(analysis.windows[0].status).toBe(PLOT_STATUS.CONFIRM);
  published = true;
  analysis.livePublished(0, 3);
  await analysis.confirm(id);
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  // Priced before, planned again after the publication, then read.
  expect(plans).toEqual([false, true]);
  expect(analysis.windows[0].result?.values).toEqual([1, 7, 71, 85]);
});

it("v24 review: a partner read before a publication is read again with the plot", async () => {
  const analysis = store();
  const variableOf = new Map<string, string>();
  let published = false;
  client.planRun.mockImplementation(
    async (runId: string, _source: unknown, query: { variable: string }) => {
      variableOf.set(runId, query.variable);
      return modest;
    }
  );
  client.executeRun.mockImplementation(async (runId: string) =>
    variableOf.get(runId) === "partner"
      ? seriesOf(published ? [100, 200, 300, 400] : [100, 200, 300, NaN])
      : seriesOf([1, 2, 3, 4])
  );
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 73, lon: 74 },
    map,
    rect
  );
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const id = analysis.windows[0].id;
  analysis.setPair(id, "partner");
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  const other = () => analysis.windows[0].companions?.pair?.results?.other;
  expect(other()?.values).toEqual([100, 200, 300, NaN]);
  published = true;
  analysis.livePublished(3, 3);
  await analysis.apply(id);
  // PlotWindow reloads the partner when the plot's result changes; the
  // partner must not be kept from before the publication.
  await analysis.loadPair(id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(other()?.values).toEqual([100, 200, 300, 400]);
});

// eslint-disable-next-line max-lines-per-function
it("v24 review: Read approves one priced stage, never the field read after it", async () => {
  const analysis = store();
  const variableOf = new Map<string, string>();
  const located = new Set<string>();
  client.planRun.mockImplementation(
    async (
      runId: string,
      _source: unknown,
      query: { variable: string },
      geometryConfirmed?: boolean
    ) => {
      variableOf.set(runId, query.variable);
      if (query.variable !== "native") {
        return modest;
      }
      if (!geometryConfirmed) {
        return {
          ...modest,
          modest: false,
          needsConfirmation: true,
          decodedBytes: 2 ** 20,
          chunks: 0,
        };
      }
      located.add(runId);
      return {
        ...modest,
        modest: false,
        chunks: 2000,
        decodedBytes: 8 * 2 ** 30,
      };
    }
  );
  const executed: string[] = [];
  client.executeRun.mockImplementation(async (runId: string) => {
    executed.push(variableOf.get(runId)!);
    return seriesOf([1]);
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 75, lon: 76 },
    map,
    rect
  );
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const id = analysis.windows[0].id;
  analysis.setPair(id, "native");
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  const pair = () => analysis.windows[0].companions?.pair;
  expect(pair()?.status).toBe("confirm");
  expect(pair()?.stage).toBe("geometry");
  // Read: cells are located, and the 8 GiB field read is asked for next.
  analysis.approveCompanions(id, "pair");
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(located.size).toBe(1);
  expect(executed).not.toContain("native");
  expect(pair()?.status).toBe("confirm");
  expect(pair()?.stage).toBe("field");
  expect(pair()?.message).toMatch(/8\.0 GiB in 2,000 chunks/);
  analysis.approveCompanions(id, "pair");
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(executed).toContain("native");
  expect(pair()?.status).toBe("ready");
});

// eslint-disable-next-line max-lines-per-function
it("v24 review: Read for ensemble members shows what all of them need together", async () => {
  client.describeVariable.mockResolvedValue({
    ...summary,
    dims: ["time", "member", "cell"],
    shape: [4, 5, 768],
    others: [{ dimension: "member", size: 5, ensemble: true }],
  });
  const analysis = store();
  const member = new Map<string, number>();
  client.planRun.mockImplementation(
    async (
      runId: string,
      _source: unknown,
      query: { fixed: Record<string, number> }
    ) => {
      member.set(runId, query.fixed.member ?? 0);
      // The plot's own member is small; each other is a priced read.
      return query.fixed.member
        ? { ...modest, modest: false, chunks: 6, decodedBytes: 48 * 2 ** 20 }
        : modest;
    }
  );
  const executed: number[] = [];
  client.executeRun.mockImplementation(async (runId: string) => {
    executed.push(member.get(runId)!);
    return seriesOf([member.get(runId)!]);
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 77, lon: 78 },
    map,
    rect
  );
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const id = analysis.windows[0].id;
  analysis.setMembers(id, "plume");
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const members = () => analysis.windows[0].companions?.members;
  expect(members()?.status).toBe("confirm");
  expect(members()?.message).toMatch(
    /the other 4 members need about 192 MiB in 24 chunks/
  );
  expect(executed).toEqual([0]);
  analysis.approveCompanions(id, "members");
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect([...executed].sort()).toEqual([0, 1, 2, 3, 4]);
  expect(members()?.status).toBe("ready");
});

// eslint-disable-next-line max-lines-per-function
it("review of interim30: 99 modest members are priced together before any is read", async () => {
  client.describeVariable.mockResolvedValue({
    ...summary,
    dims: ["time", "member", "cell"],
    shape: [4, 100, 768],
    others: [{ dimension: "member", size: 100, ensemble: true }],
  });
  const analysis = store();
  analysis.setComputeMode("ask");
  const member = new Map<string, number>();
  client.planRun.mockImplementation(
    async (
      runId: string,
      _source: unknown,
      query: { fixed: Record<string, number> }
    ) => {
      member.set(runId, query.fixed.member ?? 0);
      return modest;
    }
  );
  const executed: number[] = [];
  client.executeRun.mockImplementation(async (runId: string) => {
    executed.push(member.get(runId)!);
    // Each member decodes 48 MiB: modest alone, 4.6 GiB for 99.
    return {
      ...seriesOf([member.get(runId)!]),
      counters: { decodedBytes: 48 * 2 ** 20 },
    };
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 79, lon: 80 },
    map,
    rect
  );
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const id = analysis.windows[0].id;
  analysis.setMembers(id, "plume");
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const members = () => analysis.windows[0].companions?.members;
  expect(members()?.status).toBe("confirm");
  expect(members()?.message).toMatch(/99 members need about 4\.6 GiB together/);
  expect(executed).toEqual([0]);
  analysis.approveCompanions(id, "members");
  for (let k = 0; k < 12; k++) {
    await flush();
  }
  expect(executed).toHaveLength(100);
  expect(members()?.status).toBe("ready");
});
// eslint-disable-next-line max-lines-per-function
it("lets a members load waiting for Read go when its window closes (review of interim33)", async () => {
  client.describeVariable.mockResolvedValue({
    ...summary,
    dims: ["time", "member", "cell"],
    shape: [4, 100, 768],
    others: [{ dimension: "member", size: 100, ensemble: true }],
  });
  const analysis = store();
  analysis.setComputeMode("ask");
  const member = new Map<string, number>();
  client.planRun.mockImplementation(
    async (
      runId: string,
      _source: unknown,
      query: { fixed: Record<string, number> }
    ) => {
      member.set(runId, query.fixed.member ?? 0);
      return modest;
    }
  );
  const executed: number[] = [];
  client.executeRun.mockImplementation(async (runId: string) => {
    executed.push(member.get(runId)!);
    // Each member decodes 48 MiB: modest alone, 4.6 GiB for 99.
    return {
      ...seriesOf([member.get(runId)!]),
      counters: { decodedBytes: 48 * 2 ** 20 },
    };
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 77, lon: 82 },
    map,
    rect
  );
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const id = analysis.windows[0].id;
  analysis.setMembers(id, "plume");
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(analysis.windows[0].companions?.members?.status).toBe("confirm");
  // The waiting load, asked again, joins nothing new; Close lets it go.
  let settled = false;
  void analysis.loadMembers(id).then(() => (settled = true));
  analysis.close(id);
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  expect(executed).toEqual([0]);
  expect(settled).toBe(true);
});

// eslint-disable-next-line max-lines-per-function
it("prices the other members from the plan when the first was read from cache", async () => {
  client.describeVariable.mockResolvedValue({
    ...summary,
    dims: ["time", "member", "cell"],
    shape: [4, 100, 768],
    others: [{ dimension: "member", size: 100, ensemble: true }],
  });
  const analysis = store();
  analysis.setComputeMode("ask");
  const member = new Map<string, number>();
  client.planRun.mockImplementation(
    async (
      runId: string,
      _source: unknown,
      query: { fixed: Record<string, number> }
    ) => {
      member.set(runId, query.fixed.member ?? 0);
      return { ...modest, decodedBytes: 48 * 2 ** 20 };
    }
  );
  const executed: number[] = [];
  client.executeRun.mockImplementation(async (runId: string) => {
    executed.push(member.get(runId)!);
    // The first member's chunks were cached: it decoded nothing now.
    return {
      ...seriesOf([member.get(runId)!]),
      counters: { decodedBytes: member.get(runId) === 0 ? 0 : 48 * 2 ** 20 },
    };
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 78, lon: 81 },
    map,
    rect
  );
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const id = analysis.windows[0].id;
  analysis.setMembers(id, "plume");
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const members = () => analysis.windows[0].companions?.members;
  expect(members()?.status).toBe("confirm");
  expect(members()?.message).toMatch(/99 members need about 4\.6 GiB together/);
  expect(executed).toEqual([0]);
  analysis.approveCompanions(id, "members");
  for (let k = 0; k < 12; k++) {
    await flush();
  }
  expect(executed).toHaveLength(100);
  expect(members()?.status).toBe("ready");
});

// eslint-disable-next-line max-lines-per-function
it("review of interim37: members of a plot with no price of its own are priced from their plans", async () => {
  client.describeVariable.mockResolvedValue({
    ...summary,
    dims: ["time", "member", "cell"],
    shape: [4, 100, 768],
    others: [{ dimension: "member", size: 100, ensemble: true }],
  });
  const analysis = store();
  analysis.setComputeMode("ask");
  const member = new Map<string, number>();
  client.planRun.mockImplementation(
    async (
      runId: string,
      _source: unknown,
      query: { fixed: Record<string, number> }
    ) => {
      member.set(runId, query.fixed.member ?? 0);
      return { ...modest, decodedBytes: 48 * 2 ** 20 };
    }
  );
  const executed: number[] = [];
  client.executeRun.mockImplementation(async (runId: string) => {
    executed.push(member.get(runId)!);
    return { ...seriesOf([member.get(runId)!]), counters: { decodedBytes: 0 } };
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 78, lon: 81 },
    map,
    rect
  );
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const w = analysis.windows[0];
  // As a duplicate showing a finished cached result: no plan, no decode.
  w.estimate = undefined;
  analysis.setMembers(w.id, "plume");
  for (let k = 0; k < 8; k++) {
    await flush();
  }
  const members = () => analysis.windows[0].companions?.members;
  expect(members()?.status).toBe("confirm");
  expect(members()?.message).toMatch(/99 members need .*4\.6 GiB/);
  expect(executed).toEqual([0]);
  analysis.approveCompanions(w.id, "members");
  for (let k = 0; k < 12; k++) {
    await flush();
  }
  expect(executed).toHaveLength(100);
  expect(members()?.status).toBe("ready");
});

it("v24 review: a partner stored backwards is planned at the plot's own dates", async () => {
  client.describeVariable.mockImplementation(
    async (_source: unknown, variable: string) =>
      variable === "partner"
        ? { ...summary, time: { ...summary.time, raw: [3, 2, 1, 0] } }
        : summary
  );
  const analysis = store();
  const planned = new Map<string, { start: number; stop: number }>();
  client.planRun.mockImplementation(
    async (
      _runId: string,
      _source: unknown,
      query: { variable: string; time: { start: number; stop: number } }
    ) => {
      planned.set(query.variable, query.time);
      return modest;
    }
  );
  client.executeRun.mockResolvedValue(seriesOf([1, 2, 3, 4]));
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 79, lon: 80 },
    map,
    rect
  );
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  const id = analysis.windows[0].id;
  // The first two days only.
  analysis.updateDraft(id, { time: { start: 0, stop: 2 } });
  await analysis.apply(id);
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  expect(planned.get("tas")).toEqual({ start: 0, stop: 2 });
  analysis.setPair(id, "partner");
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  // The same days, at the other end of the partner's axis.
  expect(planned.get("partner")).toEqual({ start: 2, stop: 4 });
});

it("v24 review: a distribution's cells count in the result cache", async () => {
  const { resultBytes } = await import("@/store/analysisStore.ts");
  const n = 100_000;
  const cells = Array.from({ length: n }, () => 0);
  const distribution = {
    ...result(1),
    field: { lat: cells, lon: cells, values: cells },
    histogram: {
      edges: [0, 1],
      validFraction: 1,
      validCells: n,
      selectedCells: n,
      mean: 0,
      weighting: "",
    },
  };
  // Three numbers per cell, 8 bytes each: 2.4 MB at least.
  expect(resultBytes(distribution as never)).toBeGreaterThanOrEqual(24 * n);
});

it("v24 review: a plot still restoring keeps its place in the link", async () => {
  const { sessionOf } = await import("@/store/analysisStore.ts");
  const analysis = store();
  // The description of the second plot does not answer yet.
  let answer!: (summary: unknown) => void;
  client.describeVariable
    .mockResolvedValueOnce(summary)
    .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  const query = (lat: number) => ({
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    variable: "tas",
    geometry: { kind: "point", lat, lon: 0 },
    fixed: {},
  });
  for (const lat of [10, 20]) {
    void analysis.openWindow(
      ANALYSIS_KINDS.POINT_SERIES,
      { kind: "point", lat, lon: 0 },
      map,
      rect,
      query(lat) as never
    );
  }
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  const { session, leftOut } = sessionOf(analysis.windows);
  expect(
    session.plots.map((p) => (p.query.geometry as { lat: number }).lat)
  ).toEqual([10, 20]);
  expect(leftOut).toEqual([]);
  answer(summary);
});

// eslint-disable-next-line max-lines-per-function
it("v24 review: a large session file opens through this tab's storage, once", async () => {
  const { readSessionParam } = await import("@/store/analysisStore.ts");
  const { encodeSession } = await import("@/lib/analysis/sessionLink.ts");
  const kept = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => kept.set(key, value),
    removeItem: (key: string) => kept.delete(key),
  });
  const value = encodeSession({
    plots: [
      {
        query: {
          version: 1,
          kind: ANALYSIS_KINDS.POINT_SERIES,
          variable: "tas",
          geometry: { kind: "point", lat: 1, lon: 2 },
          fixed: {},
        } as never,
      },
    ],
  });
  const hand = (id: string, resource: string) =>
    kept.set(
      "gridlook-pending-session",
      JSON.stringify({ id, resource, value })
    );
  hand("a1", "https://example.org/data.zarr");
  page.hash = "#https://example.org/data.zarr::session=a1";
  expect(readSessionParam().plots).toHaveLength(1);
  // The id has done its work: the address no longer names it.
  expect(page.hash).toBe("#https://example.org/data.zarr");
  // Taken once: a reload later opens the address's own plots (none here).
  expect(readSessionParam().plots).toHaveLength(0);
  const other = encodeSession({
    plots: [
      {
        query: {
          version: 1,
          kind: ANALYSIS_KINDS.POINT_SERIES,
          variable: "tas",
          geometry: { kind: "point", lat: 7, lon: 8 },
          fixed: {},
        } as never,
      },
    ],
  });
  for (const hash of [
    "#https://example.org/other.zarr::session=a1",
    `#https://example.org/data.zarr::session=a1::plots=${other}`,
    "#https://example.org/data.zarr::session=b2",
  ]) {
    hand("a1", "https://example.org/data.zarr");
    page.hash = hash;
    const opened = readSessionParam().plots;
    expect(
      opened.every((p) => (p.query.geometry as { lat: number }).lat === 7)
    ).toBe(true);
    expect(kept.has("gridlook-pending-session")).toBe(false);
  }
  page.hash = "#https://example.org/data.zarr";
  vi.unstubAllGlobals();
});

it("a partner replaced while it is described is never read (review of interim8)", async () => {
  const analysis = store();
  const variableOf = new Map<string, string>();
  client.planRun.mockImplementation(
    async (runId: string, _source: unknown, query: { variable: string }) => {
      variableOf.set(runId, query.variable);
      return modest;
    }
  );
  const planned: string[] = [];
  client.executeRun.mockImplementation((runId: string) => {
    planned.push(variableOf.get(runId)!);
    return Promise.resolve(seriesOf([1]));
  });
  void analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 81, lon: 82 },
    map,
    rect
  );
  for (let k = 0; k < 4; k++) {
    await flush();
  }
  // The first choice's description is slow; the second is chosen meanwhile.
  const slow = deferred<typeof summary>();
  client.describeVariable.mockImplementation(
    (_source: unknown, variable: string) =>
      variable === "first" ? slow.promise : Promise.resolve(summary)
  );
  const id = analysis.windows[0].id;
  analysis.setPair(id, "first");
  await flush();
  analysis.setPair(id, "second");
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  slow.resolve(summary);
  for (let k = 0; k < 6; k++) {
    await flush();
  }
  expect(planned).toContain("second");
  expect(planned).not.toContain("first");
  expect(analysis.windows[0].companions?.pair?.choice).toBe("second");
});
