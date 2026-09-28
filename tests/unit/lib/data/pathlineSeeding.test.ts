import { Grid } from "healpix-geo";
import proj4 from "proj4";
import { expect, it } from "vitest";

import {
  createPathlineGrid,
  PATHLINE_GRID,
  type TPathlineGrid,
} from "@/lib/data/pathlineField.ts";
import { pathlineGeographic } from "@/lib/data/pathlineIntegration.ts";
import { pathlinePositionAt } from "@/lib/data/pathlineTrajectories.ts";
import {
  pathlineWorkerGrid,
  runPathlineWorkerTask,
} from "@/lib/data/pathlineWorkerTask.ts";

const crs = "+proj=lcc +lat_1=56 +lat_0=56 +lon_0=10 +datum=WGS84 +units=m";
const regionalGrids: TPathlineGrid[] = [
  {
    kind: PATHLINE_GRID.REGULAR,
    x: new Float32Array([10, 9, 8]),
    y: new Float32Array([56, 55, 54]),
  },
  {
    kind: PATHLINE_GRID.PROJECTED,
    x: new Float32Array([-10000, 0, 10000]),
    y: new Float32Array([-10000, 0, 10000]),
    crs,
  },
  {
    kind: PATHLINE_GRID.POINTS,
    // Irregular footprint: native points, not the surrounding latitude/lon box.
    latitudes: new Float32Array([54, 55, 56, 55]),
    longitudes: new Float32Array([9, 10, 9, 8]),
  },
];

async function regionalSeeds(grid: TPathlineGrid) {
  const native = createPathlineGrid(grid);
  const u = new Float32Array(native.length);
  u[0] = NaN;
  const fields = [0, 30, 60].map(() => ({
    u,
    v: new Float32Array(native.length),
    gridRelative: false,
  }));
  const data = await runPathlineWorkerTask({
    grid: structuredClone(pathlineWorkerGrid(grid)),
    times: [0, 30, 60],
    fields,
    config: {
      particleCount: 64,
      randomSeed: 42,
      sampleSeconds: 30,
      maxStepSeconds: 30,
      maxStepMetres: 1000,
      errorToleranceMetres: 50,
    },
    start: 0,
    end: 64,
  });
  return Array.from(data.counts, (count, particle) => {
    expect(count).toBe(3);
    const point = pathlineGeographic(pathlinePositionAt(data, particle, 30)!);
    return point;
  });
}

it.each(regionalGrids)(
  "seeds regional $kind workers inside native coverage and rejects masked velocities",
  async (grid) => {
    const seeds = await regionalSeeds(grid);
    for (const { latitude, longitude } of seeds) {
      if (grid.kind === PATHLINE_GRID.REGULAR) {
        expect(latitude).toBeGreaterThanOrEqual(54);
        expect(latitude).toBeLessThanOrEqual(56);
        expect(longitude).toBeGreaterThanOrEqual(8);
        expect(longitude).toBeLessThanOrEqual(10);
        expect(latitude < 55 || longitude < 9).toBe(true);
      } else if (grid.kind === PATHLINE_GRID.PROJECTED) {
        const [x, y] = proj4(crs, "EPSG:4326").inverse([longitude, latitude]);
        expect(Math.abs(x)).toBeLessThanOrEqual(10000);
        expect(Math.abs(y)).toBeLessThanOrEqual(10000);
        expect(x > 0 || y > 0).toBe(true);
      } else if (grid.kind === PATHLINE_GRID.POINTS) {
        const matches = Array.from(
          grid.latitudes,
          (lat, i) =>
            i > 0 &&
            Math.abs(lat - latitude) < 1e-5 &&
            Math.abs(grid.longitudes[i] - longitude) < 1e-5
        );
        expect(matches.some(Boolean)).toBe(true);
      }
    }
  }
);

it.each(["nested", "ring", "zuniq"] as const)(
  "seeds only selected regional %s HEALPix cells with valid velocity",
  async (scheme) => {
    using hp = new Grid({ level: 8, scheme });
    const cells = Array.from(
      hp.lonLatToHealpix(new Float64Array([9, 54, 10, 55, 9, 56, 8, 55])),
      Number
    );
    const seeds = await regionalSeeds({
      kind: PATHLINE_GRID.HEALPIX,
      grid: hp,
      cells,
    });
    for (const { latitude, longitude } of seeds) {
      const [cell] = hp.lonLatToHealpix(
        new Float64Array([longitude, latitude])
      );
      expect(cells.slice(1)).toContain(Number(cell));
    }
  }
);
