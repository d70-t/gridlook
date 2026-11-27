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
  await zarr.set(a as never, null, {
    shape,
    stride: shape.map((_, i) => shape.slice(i + 1).reduce((x, y) => x * y, 1)),
    data: Float64Array.from(values),
  } as never);
}

/**
 * A 12-column curvilinear ring, 8 rows, with its first five columns
 * repeated after the last: 96 cells of unit area, 120 K in column 0 and
 * 0 K elsewhere (a 10 K mean). `missing` masks the field's values (not the
 * coordinates) in the repeated columns or in the originals.
 */
async function areaMean(missing?: "copies" | "originals") {
  const [n, ny, nx] = [12, 8, 17];
  const s: TStore = new Map();
  await zarr.create(zarr.root(s), { attributes: {} });
  const [lats, lons, temps]: number[][] = [[], [], []];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const col = i % n;
      lats.push(-35 + 10 * j + 0.2 * Math.sin((2 * Math.PI * col) / n));
      lons.push(-165 + 30 * col + 0.2 * j);
      const masked =
        (missing === "copies" && i >= n) || (missing === "originals" && i < 5);
      temps.push(masked ? NaN : col === 0 ? 120 : 0);
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
  await put(s, "area", [ny, nx], ["y", "x"], Array(ny * nx).fill(1), {
    standard_name: "cell_area",
    units: "m2",
  });
  await put(s, "v", [1, ny, nx], ["time", "y", "x"], temps, {
    units: "K",
    coordinates: "lat lon",
    cell_measures: "area: area",
  });
  const c = (await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      s as never,
      "",
      ZARR_FORMAT.V3,
      `copies-${missing}`
    ),
    "v",
    new ByteLru(2 ** 20)
  )) as TVariableContext;
  const query = {
    kind: "region-series",
    version: 1,
    variable: "v",
    fixed: {},
    time: { start: 0, stop: 1 },
    geometry: { kind: "box", west: -180, east: 180, south: -85, north: 85 },
    source: { ref: "local", versionStatus: "best-effort" },
  } as TAnalysisQuery;
  const out = await (await planAnalysis(c, query, new ReadContext())).execute();
  return [out.values[0], out.region!.validCells[0]];
}

it("takes a repeated cell's value from whichever copy has it", async () => {
  for (const missing of [undefined, "copies", "originals"] as const) {
    const [mean, cells] = await areaMean(missing);
    expect(mean, `${missing}`).toBeCloseTo(10);
    expect(cells, `${missing}`).toBe(96);
  }
});
