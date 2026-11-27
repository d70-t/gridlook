/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { beforeEach, expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import {
  zarrAnalysisDatasetFromStore,
  type TAnalysisDataset,
} from "@/lib/analysis/sourceAdapter.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

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

beforeEach(() => {
  setActivePinia(createPinia());
  Object.values(client).forEach((fn) => fn.mockReset());
  client.describeVariable.mockResolvedValue(summary);
  client.planRun.mockResolvedValue(modest);
  page.hash = "#https://example.org/data.zarr";
});

type TStore = Map<string, Uint8Array>;
const C = (shape: number[]) =>
  shape.map((_, d) => shape.slice(d + 1).reduce((a, n) => a * n, 1));

async function write(
  store: TStore,
  path: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {}
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride: C(shape),
  } as never);
}

/** Two latitudes and two longitudes, one date, with bounds. */
async function grid(units: string) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", [-1, 1], [2], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(store, "lat_bnds", [-2, 0, 0, 2], [2, 2], ["lat", "nv"]);
  await write(store, "lon", [0, 1], [2], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
  });
  await write(store, "lon_bnds", [-0.5, 0.5, 0.5, 1.5], [2, 2], ["lon", "nv"]);
  await write(store, "time", [0, 1, 2], [3], ["time"], {
    units,
  });
  return store;
}

it.each([false, true])(
  "pairs the components on the displayed physical date (V's origin a day earlier: %s)",
  // eslint-disable-next-line max-lines-per-function
  async (shifted) => {
    const uUnits = "days since 2000-01-01";
    const vUnits = shifted ? "days since 1999-12-31" : uUnits;
    const u = await grid(uUnits);
    const v = await grid(vUnits);
    const all = [1, 1, 1, 1];
    const uTarget = [6, 0, NaN, NaN];
    const vTarget = [NaN, 0, 8, NaN];
    const writeField = (s: TStore, name: string, rows: number[][]) =>
      write(s, name, rows.flat(), [3, 2, 2], ["time", "lat", "lon"], {
        units: "m s-1",
        standard_name:
          name === "uo"
            ? "eastward_sea_water_velocity"
            : "northward_sea_water_velocity",
      });
    await writeField(u, "uo", [all, uTarget, all]);
    await writeField(
      v,
      "vo",
      shifted ? [all, all, vTarget] : [all, vTarget, all]
    );
    const byVar = new Map<
      string,
      Awaited<ReturnType<typeof resolveVariableContext>>
    >();
    for (const [name, s] of [
      ["uo", u],
      ["vo", v],
    ] as const) {
      const dataset: TAnalysisDataset = zarrAnalysisDatasetFromStore(
        s as never,
        "",
        ZARR_FORMAT.V3,
        `day-case-${shifted}-${name}`
      );
      byVar.set(
        name,
        await resolveVariableContext(dataset, name, new ByteLru(2 ** 20))
      );
    }
    const a = useAnalysisStore(createPinia());
    const id = `origins-${shifted}`;
    a.setActiveSource(source, ref, "catalog", {
      uo: { store: "U", dataset: "", units: "m s-1" },
      vo: { store: "V", dataset: "", units: "m s-1" },
    } as never);
    const coords = (raw: number[], units: string) => ({
      ...summary.time,
      raw,
      units,
      chunk: 1,
    });
    const plotQ = {
      version: 1,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      geometry: { kind: "box", west: -1, east: 2, south: -2, north: 2 },
      fixed: {},
      source: ref,
      variable: "temperature",
      time: { start: 0, stop: 1 },
    };
    a.$patch({
      windows: [
        {
          id,
          kind: plotQ.kind,
          source,
          sourceRef: ref,
          wind: true,
          windChoice: { u: "uo", v: "vo" },
          status: PLOT_STATUS.DONE,
          summary: { ...summary, time: coords([1], uUnits) },
          result: {
            kind: plotQ.kind,
            query: plotQ,
            time: coords([1], uUnits),
            values: [1],
            shape: [1],
            dims: ["time"],
          },
        },
      ],
    } as never);
    client.describeVariable.mockImplementation(
      async (_: unknown, name: string) => ({
        ...summary,
        variable: name,
        time: coords([0, 1, 2], name === "uo" ? uUnits : vUnits),
      })
    );
    const plans = new Map<string, Awaited<ReturnType<typeof planAnalysis>>>();
    client.planRun.mockImplementation(
      async (
        runId: string,
        _source: unknown,
        q: { variable: string; jointWith?: string }
      ) => {
        const plan = await planAnalysis(
          byVar.get(q.variable)!,
          q as never,
          new ReadContext(),
          undefined,
          false,
          q.jointWith ? byVar.get(q.jointWith) : undefined
        );
        plans.set(runId, plan);
        return plan.estimate;
      }
    );
    client.executeRun.mockImplementation((runId: string) =>
      plans.get(runId)!.execute()
    );
    await a.loadWind(id);
    const wind = a.windows[0].companions?.wind;
    expect(wind?.status).toBe("ready");
    expect([wind?.results?.u?.values[0], wind?.results?.v?.values[0]]).toEqual([
      0, 0,
    ]);
  }
);
