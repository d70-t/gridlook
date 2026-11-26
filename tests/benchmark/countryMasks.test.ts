import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getCountryRings } from "@/lib/analysis/countryAtlas.ts";
import { prepareCountry } from "@/lib/analysis/countryRegion.ts";
import {
  queryRegionSelection,
  regionSelection,
} from "@/lib/analysis/operations.ts";
import {
  COUNTRY_RESOLUTIONS,
  emptyCounters,
  type TCountryGeometry,
} from "@/lib/analysis/types.ts";
import type { TVariableContext } from "@/lib/analysis/variableContext.ts";

// GRIDLOOK_BENCH=1 npx vitest run tests/benchmark/countryMasks.test.ts
// Each uncached mask is measured on the same 0.25° grid. No data array is
// involved. Atlas assets are already loaded locally before measurements.
function axis(start: number, n: number, longitude: boolean) {
  const values = Float64Array.from(
    { length: n },
    (_, i) => start + (i + 0.5) / 4
  );
  const bounds = Float64Array.from(
    { length: n * 2 },
    (_, i) => start + (Math.floor(i / 2) + (i % 2)) / 4
  );
  return { values, bounds, longitude, periodic: longitude };
}

const grid = {
  kind: "rectilinear",
  regionKey: "bench-0.25",
  latAxis: 0,
  lonAxis: 1,
  lat: axis(-90, 720, false),
  lon: axis(-180, 1440, true),
} as const;
const context = { grid, dims: ["lat", "lon"] } as unknown as TVariableContext;
const runs = () => [[], []];
const median = (times: number[]) =>
  times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)];

async function measure(geometry: TCountryGeometry) {
  const outlineMs: number[] = [],
    maskMs: number[] = [];
  let selected = 0;
  for (let i = 0; i < 4; i++) {
    const start = performance.now();
    const country = prepareCountry(
      await getCountryRings(geometry.id, geometry.resolution)
    );
    const prepared = performance.now();
    const result = await regionSelection(
      context,
      { kind: "country", country },
      runs(),
      emptyCounters()
    );
    const done = performance.now();
    selected = result.storedCells;
    if (i > 0) {
      outlineMs.push(prepared - start);
      maskMs.push(done - prepared);
    }
  }
  expect(selected).toBeGreaterThan(0);
  const initial = await queryRegionSelection(
    context,
    geometry,
    runs(),
    emptyCounters()
  );
  const start = performance.now();
  for (let i = 0; i < 200; i++) {
    const hit = await queryRegionSelection(
      context,
      geometry,
      runs(),
      emptyCounters()
    );
    if (hit.points !== initial.points) {
      throw Error("Mask was not cached.");
    }
  }
  const cachedMs = (performance.now() - start) / 200;
  return {
    selected,
    outlineMs: +median(outlineMs).toFixed(2),
    maskMs: +median(maskMs).toFixed(2),
    cachedMs: +cachedMs.toFixed(3),
  };
}

describe.skipIf(process.env.GRIDLOOK_BENCH !== "1")(
  "country boundaries on a 0.25° global grid",
  () => {
    it("reports median outline preparation and centre-mask time in ms", async () => {
      const rows = [];
      for (const resolution of Object.values(COUNTRY_RESOLUTIONS)) {
        await getCountryRings("276", resolution);
        for (const [country, id] of [
          ["Germany", "276"],
          ["Canada", "124"],
        ]) {
          rows.push({
            country,
            resolution,
            ...(await measure({ kind: "country", id, resolution })),
          });
        }
      }
      const output = process.env.GRIDLOOK_COUNTRY_BENCH_OUT;
      if (output) {
        writeFileSync(output, JSON.stringify(rows, null, 2) + "\n");
      }
      console.table(rows);
    }, 90_000);
  }
);
