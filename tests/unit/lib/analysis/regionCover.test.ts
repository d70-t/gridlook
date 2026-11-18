import * as healpixGeo from "healpix-geo";
import { describe, expect, it } from "vitest";

import { childRange, idRangesContain } from "@/lib/analysis/healpixIds.ts";
import {
  coverHealpixRegion,
  REGION_KINDS,
  type TRegion,
} from "@/lib/analysis/regionCover.ts";
import {
  polygonContains,
  preparePolygon,
  samplePolyline,
  type TBox,
} from "@/lib/analysis/sphere.ts";

const ORDER = 7; // 196,608 cells: brute force stays fast

// Independent reference: every cell centre, tested with plain formulas.
const grid = new healpixGeo.Grid({ scheme: "nested", level: ORDER });
const ALL = new BigUint64Array(12 * 4 ** ORDER).map((_, at) => BigInt(at));
const CENTRES = grid.healpixToLonLat(ALL);

function bruteForce(test: (lat: number, lon: number) => boolean) {
  const inside = new Set<bigint>();
  for (let at = 0; at < ALL.length; at++) {
    if (test(CENTRES[2 * at + 1], CENTRES[2 * at])) {
      inside.add(ALL[at]);
    }
  }
  return inside;
}

function boxReference(box: TBox) {
  return (lat: number, lon: number) => {
    if (lat < box.south || lat > box.north) {
      return false;
    }
    // healpix-geo returns longitudes in [0, 360)
    const east = box.east <= box.west ? box.east + 360 : box.east;
    let l = ((lon + 180) % 360) - 180;
    l = l < box.west ? l + 360 : l;
    return l >= box.west && l <= east;
  };
}

async function expectExactCover(region: TRegion, reference: Set<bigint>) {
  const cover = await coverHealpixRegion(grid, region);
  expect(cover.cellCount).toBe(BigInt(reference.size));
  for (const id of reference) {
    expect(idRangesContain(cover.ranges, id)).toBe(true);
  }
  return cover;
}

// eslint-disable-next-line max-lines-per-function
describe("conservative HEALPix region cover", () => {
  it("matches brute force for a box across the antimeridian", async () => {
    const box = { west: 170, east: -160, south: -20, north: 15 };
    await expectExactCover(
      { kind: REGION_KINDS.BOX, box },
      bruteForce(boxReference(box))
    );
  });

  it("matches brute force for a polar box and a seam-straddling box", async () => {
    const polar = { west: -180, east: 180, south: 75, north: 90 };
    await expectExactCover(
      { kind: REGION_KINDS.BOX, box: polar },
      bruteForce(boxReference(polar))
    );
    const seam = { west: -1, east: 1, south: 41.5, north: 42 }; // equatorial/polar face seam
    await expectExactCover(
      { kind: REGION_KINDS.BOX, box: seam },
      bruteForce(boxReference(seam))
    );
  });

  it("matches brute force for a polygon around the pole and a thin polygon", async () => {
    const ring = [0, 60, 120, 180, 240, 300].map((lon) => ({ lat: 70, lon }));
    const polar = preparePolygon(ring);
    await expectExactCover(
      { kind: REGION_KINDS.POLYGON, polygon: polar },
      bruteForce((lat, lon) => polygonContains(polar, lat, lon))
    );
    const thin = preparePolygon([
      { lat: -10, lon: 30 },
      { lat: 25, lon: 31.2 },
      { lat: 25, lon: 31.5 },
      { lat: -10, lon: 30.4 },
    ]);
    const cover = await expectExactCover(
      { kind: REGION_KINDS.POLYGON, polygon: thin },
      bruteForce((lat, lon) => polygonContains(thin, lat, lon))
    );
    // Pruning means far fewer tests than cells.
    expect(cover.testedCells).toBeLessThan(ALL.length / 10);
  });

  it("nested child ranges are exactly the cells whose centres fall in the parent", () => {
    const parent = new healpixGeo.Grid({ scheme: "nested", level: 3 });
    const [start, end] = childRange(100n, 3, ORDER);
    const parents = parent.lonLatToHealpix(CENTRES);
    let inParent = 0;
    for (let at = 0; at < ALL.length; at++) {
      if (parents[at] === 100n) {
        inParent++;
        expect(ALL[at] >= start && ALL[at] < end).toBe(true);
      }
    }
    expect(inParent).toBe(Number(end - start));
    parent.free();
  });

  it("reports zero cells for a region between centres", async () => {
    const tiny = { west: 10.0, east: 10.0001, south: 20.0, north: 20.0001 };
    const reference = bruteForce(boxReference(tiny));
    expect(reference.size).toBe(0);
    const cover = await coverHealpixRegion(grid, {
      kind: REGION_KINDS.BOX,
      box: tiny,
    });
    expect(cover.cellCount).toBe(0n);
  });
});

describe("polygon validation and path sampling", () => {
  it("rejects self-intersections and oversized polygons", () => {
    expect(() =>
      preparePolygon([
        { lat: 0, lon: 0 },
        { lat: 10, lon: 10 },
        { lat: 0, lon: 10 },
        { lat: 10, lon: 0 },
      ])
    ).toThrow(/cross/);
    expect(() =>
      preparePolygon([0, 90, 180, 270].map((lon) => ({ lat: 0, lon })))
    ).toThrow(/hemisphere/);
  });

  it("keeps exact cumulative distances at vertices", () => {
    const samples = samplePolyline(
      [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 1 },
        { lat: 1, lon: 1 },
      ],
      10_000,
      1000
    );
    const quarter = (2 * Math.PI * 6_371_008.8) / 360;
    expect(samples[0].distance).toBe(0);
    expect(samples.at(-1)!.distance).toBeCloseTo(2 * quarter, 3);
    const vertex = samples.find(
      (sample) => sample.lat === 0 && sample.lon === 1
    )!;
    expect(vertex.distance).toBeCloseTo(quarter, 3);
  });
});
