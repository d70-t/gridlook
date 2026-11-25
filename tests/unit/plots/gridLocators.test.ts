/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { REFINE_POINTS } from "@/lib/analysis/projectedGrid.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import type { TAnalysisQuery } from "@/lib/analysis/types.ts";
import {
  resolveVariableContext,
  type TVariableContext,
} from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

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

async function context(s: TStore) {
  return (await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      s as never,
      "",
      ZARR_FORMAT.V3,
      `g51-${Math.random()}`
    ),
    "v",
    new ByteLru(2 ** 20)
  )) as TVariableContext;
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

async function newStore() {
  const s: TStore = new Map();
  await zarr.create(zarr.root(s), { attributes: {} });
  return s;
}

/** A 12-column curvilinear ring with five appended copies of its start. */
async function halo(ghost?: number) {
  const [n, ny, nx] = [12, 8, 17];
  const s = await newStore();
  const [lats, lons, temps]: number[][] = [[], [], []];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const col = i % n;
      const missing = i === ghost && j === 3;
      lats.push(
        missing ? NaN : -35 + 10 * j + 0.2 * Math.sin((2 * Math.PI * col) / n)
      );
      lons.push(missing ? NaN : -165 + 30 * col + 0.2 * j);
      temps.push(col === 0 ? 120 : 0);
    }
  }
  await put(s, "time", [1], ["time"], [0], { units: "days since 2000-01-01" });
  await put(s, "lat", [ny, nx], ["y", "x"], lats, {
    standard_name: "latitude",
    units: "degrees_north",
  });
  await put(s, "lon", [ny, nx], ["y", "x"], lons, {
    standard_name: "longitude",
    units: "degrees_east",
  });
  await put(
    s,
    "area",
    [ny, nx],
    ["y", "x"],
    lats.map(() => 1),
    { standard_name: "cell_area", units: "m2" }
  );
  await put(s, "v", [1, ny, nx], ["time", "y", "x"], temps, {
    units: "K",
    coordinates: "lat lon",
    cell_measures: "area: area",
  });
  const c = await context(s);
  const out = await (
    await planAnalysis(
      c,
      query({ kind: "box", west: -180, east: 180, south: -85, north: 85 }),
      new ReadContext()
    )
  ).execute();
  return [out.region!.validCells[0], out.values[0]];
}

it("finds a one-sided halo whatever ghost coordinate is missing", async () => {
  expect(await halo()).toEqual([96, 10]);
  for (const ghost of [12, 13, 14, 15, 16]) {
    expect(await halo(ghost)).toEqual([96, 10]);
  }
});

async function geographic(rotated: boolean) {
  const s = await newStore();
  const [y, x] = rotated ? ["rlat", "rlon"] : ["lat", "lon"];
  const xs = [0, 90, 180, 270];
  await put(s, y, [2], [y], [0, 10], {
    standard_name: rotated ? "grid_latitude" : "latitude",
    units: rotated ? "degrees" : "degrees_north",
    bounds: "yb",
  });
  await put(s, "yb", [2, 2], [y, "nv"], [-5, 5, 5, 15]);
  await put(s, x, [4], [x], xs, {
    standard_name: rotated ? "grid_longitude" : "longitude",
    units: rotated ? "degrees" : "degrees_east",
    bounds: "xb",
  });
  await put(s, "xb", [4, 2], [x, "nv"], [-70, 30, 30, 120, 120, 205, 205, 290]);
  await put(s, "time", [1], ["time"], [0], { units: "days since 2000-01-01" });
  if (rotated) {
    await put(s, "pole", [], [], [], {
      grid_mapping_name: "rotated_latitude_longitude",
      grid_north_pole_latitude: 90,
      grid_north_pole_longitude: 180,
      north_pole_grid_longitude: 0,
    });
  }
  const vals = [10, 20, 30, 40];
  await put(s, "v", [1, 2, 4], ["time", y, x], [...vals, ...vals], {
    units: "K",
    ...(rotated ? { grid_mapping: "pole" } : {}),
  });
  return context(s);
}

it("locates an identity-rotated cyclic grid against its published sides", async () => {
  const plain = await geographic(false);
  const rotated = await geographic(true);
  for (const lon of [-65, -55, -40, 0, 95, 215, 280, 289, 295]) {
    const at = async (c: TVariableContext) =>
      (
        await (
          await planAnalysis(
            c,
            query({ kind: "point", lon, lat: 0 }),
            new ReadContext()
          )
        ).execute()
      ).values[0];
    expect(await at(rotated)).toBe(await at(plain));
  }
});

async function mercator(nx: number, ny: number) {
  const s = await newStore();
  const circumference = 2 * Math.PI * 6378137;
  for (const [dim, n, step] of [
    ["x", nx, circumference / 512],
    ["y", ny, circumference / 4096],
  ] as const) {
    const vals = Array.from({ length: n }, (_, i) => (i - n / 2 + 0.5) * step);
    await put(s, dim, [n], [dim], vals, {
      standard_name: `projection_${dim}_coordinate`,
      units: "m",
      bounds: `${dim}b`,
    });
    await put(
      s,
      `${dim}b`,
      [n, 2],
      [dim, "nv"],
      vals.flatMap((c) => [c - step / 2, c + step / 2])
    );
  }
  await put(s, "time", [1], ["time"], [0], { units: "days since 2000-01-01" });
  await put(s, "crs", [], [], [], {
    grid_mapping_name: "mercator",
    proj4: "+proj=merc +a=6378137 +b=6378137 +units=m +no_defs",
  });
  await zarr.create(zarr.root(s).resolve("v"), {
    shape: [1, ny, nx],
    chunkShape: [1, 16, 16],
    dimensionNames: ["time", "y", "x"],
    dtype: "float64",
    attributes: { grid_mapping: "crs", units: "K" },
  });
  return context(s);
}

it("refines projected cell areas only for areas, in bounded batches", async () => {
  const sizes = async (
    c: TVariableContext,
    geometry: Record<string, unknown>
  ) => {
    const F = Float64Array;
    const seen: number[] = [];
    try {
      globalThis.Float64Array = new Proxy(F, {
        construct(t, args, target) {
          if (new Error().stack?.includes("refinedAreas")) {
            seen.push(Number(args[0]));
          }
          return Reflect.construct(t, args, target);
        },
      }) as typeof Float64Array;
      const plan = await planAnalysis(
        c,
        query(geometry),
        new ReadContext(),
        undefined,
        true
      );
      return { seen, values: (await plan.execute()).values };
    } finally {
      globalThis.Float64Array = F;
    }
  };
  const small = await mercator(7, 9);
  expect(
    (await sizes(small, { kind: "point", lon: 0.01, lat: 0.01 })).seen
  ).toEqual([]);
  // 8,192 cells of 12 outline points each: inverted in reused batches.
  const wide = await mercator(128, 64);
  const box = await sizes(wide, {
    kind: "box",
    west: -60,
    east: 60,
    south: -1,
    north: 1,
  });
  expect(box.seen.length).toBeGreaterThan(0);
  expect(Math.max(...box.seen)).toBeLessThanOrEqual(REFINE_POINTS);
});
