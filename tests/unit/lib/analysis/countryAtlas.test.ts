import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  countryName,
  getCountryList,
  getCountryRings,
  isCountryId,
} from "@/lib/analysis/countryAtlas.ts";
import { prepareCountry } from "@/lib/analysis/countryRegion.ts";

const resolve = createRequire(import.meta.url).resolve;
const signedArea = (ring: number[][]) =>
  ring
    .slice(1)
    .reduce((area, [x, y], i) => area + ring[i][0] * y - x * ring[i][1], 0);

describe("versioned country boundaries", () => {
  for (const resolution of ["110m", "50m", "10m"] as const) {
    it(`offers every usable territory at ${resolution}, with unique stable IDs`, async () => {
      const path = resolve(`world-atlas/countries-${resolution}.json`);
      const atlas = JSON.parse(readFileSync(path, "utf8"));
      const expected: string[] = atlas.objects.countries.geometries
        .map((g: { properties: { name: string } }) => g.properties.name)
        // The pinned 10m file contains only two distinct points for Vatican.
        .filter((name: string) => resolution !== "10m" || name !== "Vatican");
      const list = await getCountryList(resolution);
      expect(list.map((c) => c.name)).toEqual(
        expected.sort((a: string, b: string) => a.localeCompare(b, "en"))
      );
      expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
      expect(countryName("036", resolution)).toBe("Australia");
      expect(countryName("ne-kosovo", resolution)).toBe("Kosovo");
      for (const { id, name } of list) {
        const polygons = await getCountryRings(id, resolution);
        expect(() => prepareCountry(polygons), name).not.toThrow();
      }
    });
  }

  it("validates small islands against the selected atlas scale before loading it", async () => {
    expect(isCountryId("798", "50m")).toBe(false);
    expect(countryName("798", "10m")).toBe("Tuvalu");
    await expect(getCountryRings("798", "50m")).rejects.toThrow("unavailable");
    expect(await getCountryRings("798", "10m")).not.toHaveLength(0);
  });

  it("returns closed rings with the South African enclave wound opposite the mainland", async () => {
    const polygons = await getCountryRings("710", "110m");
    const mainland = polygons.find((polygon) => polygon.length > 1)!;
    for (const ring of mainland) {
      expect(ring.at(-1)).toEqual(ring[0]);
    }
    expect(signedArea(mainland[0])).toBeGreaterThan(0);
    expect(signedArea(mainland[1])).toBeLessThan(0);
  });

  it("splits Fiji at the antimeridian and keeps components on both sides", async () => {
    const polygons = await getCountryRings("242", "50m");
    const rings = polygons.flat();
    expect(rings.some((ring) => ring.every(([x]) => x < 0))).toBe(true);
    expect(rings.some((ring) => ring.every(([x]) => x > 0))).toBe(true);
    for (const ring of rings) {
      expect(
        ring.every(([x], i) => i === 0 || Math.abs(x - ring[i - 1][0]) <= 180)
      ).toBe(true);
    }
  });
});
