/* eslint-disable camelcase, max-lines-per-function -- CF fixtures per case. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import type { TAnalysisQuery } from "@/lib/analysis/types.ts";
import {
  resolveVariableContext,
  type TVariableContext,
} from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;
type TLayout = "ordinary" | "padded" | "ten-shards";

async function put(
  s: TStore,
  name: string,
  shape: number[],
  dims: string[],
  values: number[],
  attrs: Record<string, unknown> = {}
) {
  const a = await zarr.create(zarr.root(s).resolve(name), {
    shape,
    chunkShape: shape,
    dimensionNames: dims,
    dtype: "float64",
    fillValue: NaN,
    attributes: attrs,
  });
  if (shape.length) {
    await zarr.set(a as never, null, {
      shape,
      stride: shape.map((_, i) =>
        shape.slice(i + 1).reduce((x, y) => x * y, 1)
      ),
      data: Float64Array.from(values),
    } as never);
  }
}

function query(geometry: Record<string, unknown>): TAnalysisQuery {
  return {
    kind: geometry.kind === "point" ? "point-series" : "region-series",
    version: 1,
    variable: "v",
    fixed: {},
    time: { start: 0, stop: 1 },
    geometry,
    source: { ref: "local", versionStatus: "best-effort" },
  } as TAnalysisQuery;
}

/** Restores the longitude sides `xb` in the given stored layout. */
function relayout(s: TStore, layout: TLayout, bounds: number[]) {
  const key = "/xb/zarr.json";
  const meta = JSON.parse(new TextDecoder().decode(s.get(key)));
  const n = bounds.length / 2;
  if (layout === "padded") {
    // One chunk of 8 MiB holding 64 bytes of sides.
    const pad = 2 ** 18;
    meta.chunk_grid.configuration.chunk_shape = [n, pad];
    const data = new Float64Array(n * pad);
    for (let i = 0; i < n; i++) {
      data.set(bounds.slice(i * 2, (i + 1) * 2), i * pad);
    }
    s.set("/xb/c/0/0", new Uint8Array(data.buffer));
  }
  if (layout === "ten-shards") {
    // A shard per row, each with an 8 MiB index in front of 16 bytes.
    const entries = 2 ** 19;
    meta.chunk_grid.configuration.chunk_shape = [1, 2 * entries];
    meta.codecs = [
      {
        name: "sharding_indexed",
        configuration: {
          chunk_shape: [1, 2],
          codecs: [{ name: "bytes", configuration: { endian: "little" } }],
          index_codecs: [
            { name: "bytes", configuration: { endian: "little" } },
          ],
          index_location: "end",
        },
      },
    ];
    for (let i = 0; i < n; i++) {
      const shard = new Uint8Array(16 + entries * 16).fill(255, 16);
      shard.set(
        new Uint8Array(Float64Array.from(bounds.slice(2 * i, 2 * i + 2)).buffer)
      );
      const index = new BigUint64Array(shard.buffer, 16);
      [index[0], index[1]] = [0n, 16n];
      s.set(`/xb/c/${i}/0`, shard);
    }
  }
  s.set(key, new TextEncoder().encode(JSON.stringify(meta)));
}

/** Two latitude bands of longitude cells, ordinary or identity-rotated. */
async function grid(
  rotated: boolean,
  xs: number[],
  bounds: number[],
  values: number[],
  layout: TLayout = "ordinary"
) {
  const s: TStore = new Map();
  await zarr.create(zarr.root(s), { attributes: {} });
  const [y, x] = rotated ? ["rlat", "rlon"] : ["lat", "lon"];
  await put(s, y, [2], [y], [0, 10], {
    standard_name: rotated ? "grid_latitude" : "latitude",
    units: rotated ? "degrees" : "degrees_north",
    bounds: "yb",
  });
  await put(s, "yb", [2, 2], [y, "nv"], [-5, 5, 5, 15]);
  await put(s, x, [xs.length], [x], xs, {
    standard_name: rotated ? "grid_longitude" : "longitude",
    units: rotated ? "degrees" : "degrees_east",
    bounds: "xb",
  });
  await put(s, "xb", [xs.length, 2], [x, "nv"], bounds);
  await put(s, "time", [1], ["time"], [0], { units: "days since 2000-01-01" });
  if (rotated) {
    await put(s, "pole", [], [], [], {
      grid_mapping_name: "rotated_latitude_longitude",
      grid_north_pole_latitude: 90,
      grid_north_pole_longitude: 180,
      north_pole_grid_longitude: 0,
    });
  }
  await put(s, "v", [1, 2, xs.length], ["time", y, x], [...values, ...values], {
    units: "K",
    ...(rotated ? { grid_mapping: "pole" } : {}),
  });
  relayout(s, layout, bounds);
  let fetched = 0;
  const store = {
    get: async (key: string) => {
      const b = s.get(key);
      fetched += key.startsWith("/xb/c/") ? (b?.length ?? 0) : 0;
      return b;
    },
    getRange: async (
      key: string,
      r: { suffixLength?: number; offset?: number; length?: number }
    ) => {
      const b = s.get(key);
      const view =
        b &&
        (r.suffixLength === undefined
          ? b.subarray(r.offset!, r.offset! + r.length!)
          : b.subarray(-r.suffixLength));
      fetched += key.startsWith("/xb/c/") ? (view?.length ?? 0) : 0;
      return view;
    },
  };
  const c = (await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `sides-${Math.random()}`
    ),
    "v",
    new ByteLru(2 ** 20)
  )) as TVariableContext;
  return { c, fetched: () => fetched };
}

it("prices a rotated locator's stored sides before reading them", async () => {
  const x = Array.from({ length: 10 }, (_, i) => -162 + 36 * i);
  const sides = x.flatMap((a) => [a - 18, a + 18]);
  const values = x.map(() => 10);
  const sharded = await grid(true, x, sides, values, "ten-shards");
  const plan = await planAnalysis(
    sharded.c,
    query({ kind: "point", lon: 0, lat: 0 }),
    new ReadContext()
  );
  // Ten 8 MiB indexes: asked about first, nothing fetched.
  expect(plan.estimate.needsConfirmation).toBe(true);
  expect(plan.estimate.decodedBytes).toBeGreaterThanOrEqual(80 * 2 ** 20);
  expect(sharded.fetched()).toBe(0);
  expect((await plan.execute()).values).toEqual([10]);
  const padded = await grid(true, x, sides, values, "padded");
  const quote = (
    await planAnalysis(
      padded.c,
      query({ kind: "point", lon: 0, lat: 0 }),
      new ReadContext()
    )
  ).estimate;
  expect(quote.decodedBytes).toBeGreaterThanOrEqual(8 * 2 ** 20);
});

it.each([
  ["a whole turn", [0], [-180, 180], [27]],
  ["a cell past half a turn", [0, 100], [-200, 50, 50, 160], [10, 40]],
  ["its sides from the other end", [0, 100], [160, 50, 50, 160], [10, 40]],
])(
  "locates and weighs a rotated grid like its ordinary one: %s",
  async (_, xs, bounds, values) => {
    const answers = [];
    for (const rotated of [false, true]) {
      const { c } = await grid(rotated, xs, bounds, values);
      const run = async (q: TAnalysisQuery) =>
        (await (await planAnalysis(c, q, new ReadContext())).execute()).values;
      const points = [];
      for (const lon of [-159, -70, 0, 60, 130, 170]) {
        points.push((await run(query({ kind: "point", lon, lat: 0 })))[0]);
      }
      const box = { kind: "box", west: -180, east: 180, south: -85, north: 85 };
      answers.push({ points, mean: (await run(query(box)))[0] });
    }
    expect(answers[1].points).toEqual(answers[0].points);
    expect(answers[1].mean).toBeCloseTo(answers[0].mean);
    expect(answers[0].points.every(Number.isFinite)).toBe(true);
  }
);
