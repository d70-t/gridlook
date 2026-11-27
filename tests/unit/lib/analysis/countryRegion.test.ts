import { Grid } from "healpix-geo";
import { describe, expect, it } from "vitest";

import { getCountryRings } from "@/lib/analysis/countryAtlas.ts";
import {
  countryContains,
  prepareCountry,
} from "@/lib/analysis/countryRegion.ts";
import { idRangesContain } from "@/lib/analysis/healpixIds.ts";
import { coverHealpixRegion } from "@/lib/analysis/regionCover.ts";

const box = (west: number, south: number, east: number, north: number) => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];
const region = prepareCountry([
  [box(169, -18, -165, 24), box(175, -5, -170, 6)],
  [box(-21, 29, -7, 40)],
  [box(177, -2, -176, 2)],
]);

describe("country membership", () => {
  it("keeps separate islands and holes and accepts either longitude convention", () => {
    expect(countryContains(region, 10, 189)).toBe(true);
    expect(countryContains(region, 10, -171)).toBe(true);
    expect(countryContains(region, 4, -174)).toBe(false);
    expect(countryContains(region, 0, 180)).toBe(true);
    expect(countryContains(region, 36, -16)).toBe(true);
    expect(countryContains(region, 5, 0)).toBe(false);
    expect(countryContains(region, Number.NaN, 0)).toBe(false);
  });

  it("preserves a polar cap", () => {
    const cap = prepareCountry([
      [[-180, -120, -60, 0, 60, 120, 180].map((lon) => [lon, -72])],
    ]);
    for (const lon of [-180, -110, -25, 0, 130, 180, 260]) {
      expect(countryContains(cap, -85, lon)).toBe(true);
      expect(countryContains(cap, -65, lon)).toBe(false);
    }
  });
});

describe("country cover", () => {
  it("computes the same HEALPix mask as exhaustive centre membership", async () => {
    const level = 5;
    const grid = new Grid({ level, scheme: "nested" });
    try {
      const cover = await coverHealpixRegion(grid, {
        kind: "country",
        country: region,
      });
      const ids = new BigUint64Array(12 * 4 ** level).map((_, i) => BigInt(i));
      const coords = grid.healpixToLonLat(ids);
      const expected: bigint[] = [];
      const actual: bigint[] = [];
      for (let i = 0; i < ids.length; i++) {
        const lon = coords[2 * i],
          lat = coords[2 * i + 1];
        const outer = lon >= 169 && lon < 195 && lat >= -18 && lat < 24;
        const hole = lon >= 175 && lon < 190 && lat >= -5 && lat < 6;
        const island = lon >= 339 && lon < 353 && lat >= 29 && lat < 40;
        const insideHole = lon >= 177 && lon < 184 && lat >= -2 && lat < 2;
        if ((outer && !hole) || island || insideHole) {
          expected.push(ids[i]);
        }
        if (idRangesContain(cover.ranges, ids[i])) {
          actual.push(ids[i]);
        }
      }
      expect(actual).toEqual(expected);
      expect(cover.testedCells).toBeLessThan(ids.length / 5);
    } finally {
      grid.free();
    }
  });
});

describe("real country boundaries", () => {
  it("includes Antarctica across all longitudes and excludes its surrounding ocean", async () => {
    const antarctica = prepareCountry(await getCountryRings("010", "110m"));
    for (const lon of [-180, -130, -30, 0, 30, 130, 180]) {
      expect(countryContains(antarctica, -85, lon), String(lon)).toBe(true);
      expect(countryContains(antarctica, -55, lon)).toBe(false);
    }
  });

  it("excludes Lesotho from South Africa", async () => {
    const southAfrica = prepareCountry(await getCountryRings("710", "110m"));
    expect(countryContains(southAfrica, -29.4, 28.3)).toBe(false);
    expect(countryContains(southAfrica, -30.5, 23.5)).toBe(true);
  });
});
