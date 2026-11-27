import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

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
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((product, n) => product * n, 1)
  );
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride,
  } as never);
}

/** A 1° regular grid of `lats` × `lons` cells around the equator. */
// eslint-disable-next-line max-lines-per-function
async function spreadOf(
  field: (t: number, i: number, j: number) => number,
  lats: number,
  lons: number
) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  const centres = (n: number) =>
    Array.from({ length: n }, (_, k) => k - (n - 1) / 2);
  const edges = (n: number) => centres(n).flatMap((c) => [c - 0.5, c + 0.5]);
  await write(store, "lat", centres(lats), [lats], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(store, "lat_bnds", edges(lats), [lats, 2], ["lat", "nv"]);
  await write(store, "lon", centres(lons), [lons], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
  });
  await write(store, "lon_bnds", edges(lons), [lons, 2], ["lon", "nv"]);
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  const data: number[] = [];
  for (let t = 0; t < 2; t++) {
    for (let i = 0; i < lats; i++) {
      for (let j = 0; j < lons; j++) {
        data.push(field(t, i, j));
      }
    }
  }
  await write(store, "x", data, [2, lats, lons], ["time", "lat", "lon"]);
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `spread-${Math.random()}`
  );
  const context = await resolveVariableContext(
    dataset,
    "x",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  const result = await (
    await planAnalysis(
      context,
      {
        version: 1,
        kind: ANALYSIS_KINDS.REGION_SERIES,
        source: { ref: "memory", versionStatus: "session" },
        variable: "x",
        fixed: {},
        geometry: { kind: "box", west: -10, east: 10, south: -10, north: 10 },
        time: { start: 0, stop: 2 },
      },
      new ReadContext()
    )
  ).execute();
  return { std: result.region!.spread!.std, mean: result.values };
}

describe("regional spread about the mean", () => {
  it("rows of [1e8, 1e8+1, 1e8+2]: √(2/3), not 1.41", async () => {
    const { std } = await spreadOf((_, __, j) => 1e8 + j, 3, 3);
    for (const s of std) {
      expect(s).toBeCloseTo(Math.sqrt(2 / 3), 9);
    }
  });

  it("two cells at 1e8 and 1e8 + 1: 0.5; a constant field: exactly 0", async () => {
    expect((await spreadOf((_, __, j) => 1e8 + j, 1, 2)).std[0]).toBeCloseTo(
      0.5,
      9
    );
    expect((await spreadOf(() => 7, 3, 3)).std).toEqual([0, 0]);
  });

  it("adding 1e12 to every value leaves the spread unchanged", async () => {
    const field = (t: number, i: number, j: number) => (i * 7 + j * 3 + t) % 6;
    const plain = await spreadOf(field, 4, 5);
    const shifted = await spreadOf((t, i, j) => 1e12 + field(t, i, j), 4, 5);
    shifted.std.forEach((s, t) => expect(s).toBeCloseTo(plain.std[t], 3));
  });
});
