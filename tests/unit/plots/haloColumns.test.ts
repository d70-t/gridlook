/* eslint-disable max-lines-per-function -- each case builds its fixture inline. */
/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { dropFrameDuplicates } from "@/lib/analysis/nativeGrid.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

/** Eight rows of six 60° cells, `halo` copied columns each side. */
function haloRows(halo: number) {
  const physical = [30, 90, 150, 210, 270, 330];
  const row = [
    ...physical.slice(physical.length - halo),
    ...physical,
    ...physical.slice(0, halo),
  ];
  const nx = row.length;
  const lat = new Float64Array(8 * nx);
  const lon = new Float64Array(8 * nx);
  for (let j = 0; j < 8; j++) {
    row.forEach((x, i) => {
      lat[j * nx + i] = -35 + 10 * j;
      lon[j * nx + i] = x;
    });
  }
  return { lat, lon, shape: [8, nx], nx };
}

describe("review of interim43: halo columns", () => {
  it("keeps the six physical cells of each row for zero to three halo columns", () => {
    for (const halo of [0, 1, 2, 3]) {
      const { lat, lon, shape, nx } = haloRows(halo);
      expect(dropFrameDuplicates(lat, lon, shape), `${halo}`).toBe(
        8 * 2 * halo
      );
      // The inner ones are kept, the copies at the sides dropped.
      for (let i = 0; i < nx; i++) {
        expect(Number.isFinite(lat[i]), `${halo}: ${i}`).toBe(
          i >= halo && i < halo + 6
        );
      }
    }
  });
});

describe("review of interim43: cells with the same corners", () => {
  // Two rings over the same five corners: the centre inserted into the
  // right edge of the first and the left edge of the second.
  const corners: Record<string, [number, number][]> = {
    a: [
      [-2, -2],
      [2, -2],
      [0, 0],
      [2, 2],
      [-2, 2],
    ],
    b: [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
      [0, 0],
    ],
  };
  const ring = (cell: [number, number][]) =>
    cell.map(([x, y]) => `${x},${y}`).join(" ");
  /** The same ring from any corner, in either direction. */
  const sameRing = (p: [number, number][], q: [number, number][]) => {
    const n = p.length;
    for (let shift = 0; shift < n; shift++) {
      for (const step of [1, -1]) {
        const turned = p.map((_, k) => q[(((shift + step * k) % n) + n) % n]);
        if (ring(turned) === ring(p)) {
          return true;
        }
      }
    }
    return false;
  };

  it("keeps two distinct rings at one centre, in either order", () => {
    for (const order of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      const lat = new Float64Array([0, 0]);
      const lon = new Float64Array([0, 0]);
      const dropped = dropFrameDuplicates(lat, lon, [1, 2], (x, y) =>
        sameRing(corners[order[x]], corners[order[y]])
      );
      expect(dropped).toBe(0);
    }
  });

  it("drops an exact copy relabelled from another corner", () => {
    const relabelled = [...corners.a.slice(2), ...corners.a.slice(0, 2)];
    const cells = [corners.a, relabelled];
    const lat = new Float64Array([0, 0]);
    const lon = new Float64Array([0, 0]);
    expect(
      dropFrameDuplicates(lat, lon, [1, 2], (x, y) =>
        sameRing(cells[x], cells[y])
      )
    ).toBe(1);
  });

  it("compares cells near a pole by their outlines", () => {
    // Sectors at ±180° on 89.9999995° N, the second repeated as a halo.
    const lat = new Float64Array([89.9999995, 89.9999995, 89.9999995]);
    const lon = new Float64Array([180, -180, -180]);
    const outline = ["east", "west", "west"];
    expect(
      dropFrameDuplicates(lat, lon, [1, 3], (x, y) => outline[x] === outline[y])
    ).toBe(1);
    expect(Number.isFinite(lat[0])).toBe(true);
    // Without outlines, centres at a pole say nothing: none dropped.
    const bare = new Float64Array([89.9999995, 89.9999995]);
    expect(
      dropFrameDuplicates(bare, new Float64Array([180, -180]), [1, 2])
    ).toBe(0);
  });
});

describe("review of interim43: two rings over one centre through the reducer", () => {
  /** Two curvilinear cells at (0°, 0°) with the given outlines, values 0, 100. */
  async function pair(first: [number, number][], second: [number, number][]) {
    const store = new Map<string, Uint8Array>();
    await zarr.create(zarr.root(store), { attributes: {} });
    const put = async (
      path: string,
      data: number[],
      shape: number[],
      dims: string[],
      attrs: Record<string, unknown> = {}
    ) => {
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
        stride: shape.map((_, d) =>
          shape.slice(d + 1).reduce((a, n) => a * n, 1)
        ),
      } as never);
    };
    const n = first.length;
    await put("time", [0], [1], ["time"], { units: "days since 2000-01-01" });
    await put("lat", [0, 0], [1, 2], ["y", "x"], {
      standard_name: "latitude",
      units: "degrees_north",
      bounds: "lat_b",
    });
    await put("lon", [0, 0], [1, 2], ["y", "x"], {
      standard_name: "longitude",
      units: "degrees_east",
      bounds: "lon_b",
    });
    const cells = [first, second];
    await put(
      "lat_b",
      cells.flat().map(([, y]) => y),
      [1, 2, n],
      ["y", "x", "nv"]
    );
    await put(
      "lon_b",
      cells.flat().map(([x]) => x),
      [1, 2, n],
      ["y", "x", "nv"]
    );
    await put("v", [0, 100], [1, 1, 2], ["time", "y", "x"], {
      coordinates: "lat lon",
    });
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `rings-${Math.random()}`
    );
    const context = await resolveVariableContext(
      dataset,
      "v",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    const planned = await planAnalysis(
      context,
      {
        version: 1,
        kind: ANALYSIS_KINDS.REGION_SERIES,
        geometry: { kind: "box", west: -10, east: 10, south: -10, north: 10 },
        fixed: {},
        source: { ref: "x", versionStatus: "best-effort" },
        variable: "v",
        time: { start: 0, stop: 1 },
      },
      new ReadContext(),
      undefined,
      true
    );
    return planned.execute();
  }
  // The centre inserted into the right edge of one ring, the left edge of
  // the other: two distinct simple outlines of equal area.
  const a: [number, number][] = [
    [-2, -2],
    [2, -2],
    [0, 0],
    [2, 2],
    [-2, 2],
  ];
  const b: [number, number][] = [
    [-2, -2],
    [2, -2],
    [2, 2],
    [-2, 2],
    [0, 0],
  ];

  it("counts each once whichever is stored first", async () => {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      const result = await pair(x, y);
      expect(result.values[0]).toBeCloseTo(50, 9);
      expect(result.region!.validCells[0]).toBe(2);
    }
  });

  it("counts an exact copy relabelled from another corner once", async () => {
    const relabelled = [...a.slice(2), ...a.slice(0, 2)];
    const result = await pair(a, relabelled);
    expect(result.region!.validCells[0]).toBe(1);
  });
});

describe("independent review of interim45: halo columns in the transposed order", () => {
  it("drops the same copies whichever dimension runs along the rows", () => {
    for (const halo of [1, 2, 3]) {
      const { lat, lon, nx } = haloRows(halo);
      // [i, j]: the same cells, the longitude dimension first.
      const tLat = new Float64Array(lat.length);
      const tLon = new Float64Array(lon.length);
      for (let j = 0; j < 8; j++) {
        for (let i = 0; i < nx; i++) {
          tLat[i * 8 + j] = lat[j * nx + i];
          tLon[i * 8 + j] = lon[j * nx + i];
        }
      }
      expect(dropFrameDuplicates(tLat, tLon, [nx, 8]), `${halo}`).toBe(
        8 * 2 * halo
      );
      expect(dropFrameDuplicates(lat, lon, [8, nx]), `${halo}`).toBe(
        8 * 2 * halo
      );
      // The same cells kept: 48 either way.
      for (let j = 0; j < 8; j++) {
        for (let i = 0; i < nx; i++) {
          expect(Number.isFinite(tLat[i * 8 + j])).toBe(
            Number.isFinite(lat[j * nx + i])
          );
        }
      }
    }
  });

  it("keeps distinct cells sharing a centre when their published outlines differ", () => {
    // Two rows of polar sectors around one centre: same centre, outlines apart.
    const lat = new Float64Array(12).fill(90);
    const lon = Float64Array.from({ length: 12 }, (_, k) => 30 * k);
    const sector = (at: number) => Math.floor(at / 2) + 6 * (at % 2);
    expect(
      dropFrameDuplicates(lat, lon, [6, 2], (a, b) => sector(a) === sector(b))
    ).toBe(0);
    expect(
      dropFrameDuplicates(lat, lon, [2, 6], (a, b) => a % 6 === b % 6 && false)
    ).toBe(0);
  });
});

describe("review of interim45: polar caps whose centres name other longitudes", () => {
  it("drops a copy of a cap stored at another longitude, keeps distinct sectors", () => {
    // Two rows of three: row 0 at 60° S, row 1 the north cap three times —
    // the first and last the same cap (one outline), the middle another.
    const lat = Float64Array.from([-60, -60, -60, 90, 90, 90]);
    const lon = Float64Array.from([0, 120, 240, 0, 45, 90]);
    const outline = [0, 1, 2, 3, 4, 3];
    const dropped = dropFrameDuplicates(
      lat,
      lon,
      [2, 3],
      (a, b) => outline[a] === outline[b]
    );
    expect(dropped).toBe(1);
    expect([...lat].map(Number.isFinite)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});
