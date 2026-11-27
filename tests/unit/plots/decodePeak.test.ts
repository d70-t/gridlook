/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import {
  ReadContext,
  type TAnalysisArray,
} from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

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

// eslint-disable-next-line max-lines-per-function
async function check(n: number, ci: number) {
  const nlat = n,
    nlon = 9 * ci,
    s = new Map();
  await zarr.create(zarr.root(s), { attributes: {} });
  await write(
    s,
    "lat",
    Array.from({ length: nlat }, (_, i) => -60 + ((i + 0.5) * 120) / nlat),
    [nlat],
    ["lat"],
    { units: "degrees_north" }
  );
  await write(
    s,
    "lon",
    Array.from({ length: nlon }, (_, j) => -150 + ((j + 0.5) * 300) / nlon),
    [nlon],
    ["lon"],
    { units: "degrees_east" }
  );
  await write(s, "time", [0], [1], ["time"], {
    units: "days since 2001-01-01",
  });
  const m = await zarr.create(zarr.root(s).resolve("area"), {
    shape: [nlat, nlon],
    chunkShape: [nlat, ci],
    dtype: "float64",
    dimensionNames: ["lat", "lon"],
    attributes: { units: "m2" },
    fillValue: NaN,
  });
  await zarr.create(zarr.root(s).resolve("t"), {
    shape: [1, nlat, nlon],
    chunkShape: n < 20 ? [1, 4, 16] : [1, 128, 128],
    dtype: "float64",
    dimensionNames: ["time", "lat", "lon"],
    attributes: { cell_measures: "area: area" },
    fillValue: 4,
  });
  if (n < 20) {
    await zarr.set(m, null, {
      data: new Float64Array(nlat * nlon).fill(1),
      shape: [nlat, nlon],
      stride: [nlon, 1],
    });
  }
  const ds = zarrAnalysisDatasetFromStore(
      s as never,
      "",
      ZARR_FORMAT.V3,
      "decode-" + n
    ),
    ctx = await resolveVariableContext(ds, "t", new ByteLru(1e6));
  const q = {
    version: 1,
    kind: ANALYSIS_KINDS.REGION_SERIES,
    geometry: { kind: "box", south: -61, north: 61, west: -151, east: 151 },
    fixed: {},
    source: { ref: "x", versionStatus: "best-effort" },
    variable: "t",
  };
  const { array } = (
    ctx.grid as unknown as { areas: { array: TAnalysisArray } }
  ).areas;
  const source = array.unguarded ?? array,
    orig = source.readChunk.bind(source);
  let readCalls = 0,
    awaitingTarget = false;
  const raw: number[] = [],
    outputs: number[] = [];
  source.readChunk = async (coords, signal) => {
    readCalls++;
    if (n >= 20) {
      throw new Error("probe stopped before big allocation");
    }
    const ch = await orig(coords, signal);
    raw.push((ch.data as Float64Array).byteLength);
    awaitingTarget = true;
    return ch;
  };
  const old = globalThis.Float64Array;
  const watched = new Proxy(old, {
    construct(target, args, newTarget) {
      const dest = Reflect.construct(target, args, newTarget);
      if (awaitingTarget && args[0] === nlat * ci) {
        outputs.push(dest.byteLength);
        awaitingTarget = false;
      }
      return dest;
    },
  });
  globalThis.Float64Array = watched as typeof Float64Array;
  try {
    const preliminary = await planAnalysis(ctx, q as never, new ReadContext())
      .then((p) => p.estimate)
      .catch(String);
    const confirmed = await planAnalysis(
      ctx,
      q as never,
      new ReadContext(),
      undefined,
      true
    )
      .then(async (p) => (n < 20 ? (await p.execute()).values : p.estimate))
      .catch(String);
    return {
      preliminary,
      confirmed,
      readCalls,
      raw,
      outputs,
      retained: nlat * nlon * 8,
      input: nlat * ci * 8,
      peakLower: nlat * (nlon + ci) * 8,
    };
  } finally {
    globalThis.Float64Array = old;
  }
}
it("counts the current stored area chunk alongside all decoded output tiles during the last decode", async () => {
  const small = await check(16, 112),
    big = await check(1024, 7168);
  // Nine tiles decoded with their sources, the mean as stored.
  expect(small.confirmed).toEqual([4]);
  // Nine 56 MiB tiles and the last one's 56 MiB source: 560 MiB, refused
  // before any area chunk is read.
  expect(big.readCalls).toBe(0);
  expect(String(big.confirmed)).toMatch(/560 MiB of cell areas/);
});
