/**
 * Tilted Mercator projection speed, against a per-vertex rotation helper.
 * Skipped unless GRIDLOOK_BENCH=1:
 *
 *   GRIDLOOK_BENCH=1 npx vitest run tests/benchmark/mercatorProjection.test.ts
 *
 * Paired, warmed passes alternate the two; the medians are written to
 * stdout and compared.
 */
import * as d3 from "d3-geo";
import { describe, expect, it } from "vitest";

import {
  MERCATOR_LAT_LIMIT,
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

const PASSES = 9;

describe.skipIf(process.env.GRIDLOOK_BENCH !== "1")("Mercator", () => {
  it("projects a tilted map no slower than a rotation per vertex", () => {
    const helper = new ProjectionHelper(PROJECTION_TYPES.MERCATOR, {
      lat: 35,
      lon: 20,
    });
    const projection = helper.getD3Projection()!;
    const perVertex = (lat: number, lon: number) => {
      const rotation = d3.geoRotation(projection.rotate());
      const [rLon, rLat] = rotation([lon, lat]);
      const safe = rotation.invert([
        rLon,
        Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, rLat)),
      ])!;
      return projection(safe);
    };
    const points = Array.from({ length: 400_000 }, (_, k) => [
      ((k * 37) % 180) - 90,
      ((k * 101) % 360) - 180,
    ]);
    const time = (f: (lat: number, lon: number) => unknown) => {
      const t0 = performance.now();
      for (const [lat, lon] of points) {
        f(lat, lon);
      }
      return performance.now() - t0;
    };
    const current = (lat: number, lon: number) => helper.project(lat, lon, 1);
    time(perVertex);
    time(current);
    const before: number[] = [];
    const now: number[] = [];
    for (let pass = 0; pass < PASSES; pass++) {
      before.push(time(perVertex));
      now.push(time(current));
    }
    const median = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    process.stdout.write(
      `Mercator 400k: per vertex ${median(before).toFixed(1)} ms, cached ${median(now).toFixed(1)} ms\n`
    );
    expect(median(now)).toBeLessThanOrEqual(median(before) * 1.05);
  });
});
