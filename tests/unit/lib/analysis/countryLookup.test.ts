import { describe, expect, it } from "vitest";

import {
  countryAt,
  getCountryList,
  getCountryRings,
} from "@/lib/analysis/countryAtlas.ts";
import {
  countryContains,
  prepareCountry,
} from "@/lib/analysis/countryRegion.ts";

const maskOf = async (id: string, resolution: "110m" | "50m" | "10m") =>
  prepareCountry(await getCountryRings(id, resolution));

describe("fine Maldives boundary", () => {
  it("covers its islands only, in the mask and the map picker", async () => {
    const maldives = await maskOf("462", "10m");
    let inside = 0;
    for (let lat = -87.5; lat < 90; lat += 5) {
      for (let lon = -177.5; lon < 180; lon += 5) {
        inside += Number(countryContains(maldives, lat, lon));
      }
    }
    expect(inside).toBeLessThan(3);
    expect(countryContains(maldives, 4.175, 73.509)).toBe(true); // Malé
    expect(countryContains(maldives, 26.07, 50.54)).toBe(false); // Bahrain
    expect(countryContains(maldives, 0, -150)).toBe(false); // open Pacific
    expect((await countryAt(26.07, 50.54, "10m"))?.id).toBe("048");
    expect((await countryAt(4.175, 73.509, "10m"))?.id).toBe("462");
    expect(await countryAt(0, -150, "10m")).toBeUndefined();
  });

  it("exports only small rings for it", async () => {
    for (const polygon of await getCountryRings("462", "10m")) {
      const lons = polygon[0].map(([lon]) => lon);
      expect(Math.max(...lons) - Math.min(...lons)).toBeLessThan(2);
    }
  });
});

describe("a map pick and its plot agree", () => {
  // On the 49th parallel the coarse boundary's straight segments and great
  // circles put this point in different countries.
  for (const resolution of ["110m", "50m", "10m"] as const) {
    it(`at the US–Canada border at ${resolution}`, async () => {
      const picked = await countryAt(49.006479, -98.939789, resolution);
      expect(picked).toBeDefined();
      const canada = await maskOf("124", resolution);
      const usa = await maskOf("840", resolution);
      const inCanada = countryContains(canada, 49.006479, -98.939789);
      expect(inCanada).not.toBe(countryContains(usa, 49.006479, -98.939789));
      expect(picked!.id).toBe(inCanada ? "124" : "840");
    });
  }
});

describe("map picks over the whole globe", () => {
  for (const resolution of ["110m", "50m", "10m"] as const) {
    it(`match a scan of every prepared country at ${resolution}`, async () => {
      const regions: [string, ReturnType<typeof prepareCountry>][] = [];
      for (const { id } of await getCountryList(resolution)) {
        regions.push([id, await maskOf(id, resolution)]);
      }
      let land = 0;
      for (let lat = -89; lat < 90; lat += 3) {
        for (let lon = -179; lon < 180; lon += 3) {
          const scan = regions.find(([, r]) => countryContains(r, lat, lon));
          const picked = await countryAt(lat, lon, resolution);
          expect(picked?.id, `${lat}, ${lon}`).toBe(scan?.[0]);
          land += Number(Boolean(scan));
        }
      }
      expect(land).toBeGreaterThan(1500);
    }, 60000);
  }
});

describe("exported country rings", () => {
  const area = (ring: number[][]) =>
    ring
      .slice(1)
      .reduce((sum, [x, y], at) => sum + ring[at][0] * y - x * ring[at][1], 0);
  for (const resolution of ["110m", "50m", "10m"] as const) {
    it(`have area and RFC 7946 winding at ${resolution}`, async () => {
      for (const { id, name } of await getCountryList(resolution)) {
        for (const [exterior, ...holes] of await getCountryRings(
          id,
          resolution
        )) {
          expect(area(exterior), name).toBeGreaterThan(0);
          for (const hole of holes) {
            expect(area(hole), `${name} hole`).toBeLessThan(0);
          }
        }
      }
    }, 60000);
  }
});
