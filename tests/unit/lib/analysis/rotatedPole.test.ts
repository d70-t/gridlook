/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { describe, expect, it } from "vitest";

import {
  rotatedPoleOf,
  rotatedToTrue,
  trueCoordinates,
} from "@/lib/analysis/rotatedPole.ts";

// The EURO-CORDEX rotated pole.
const CORDEX = { lat: 39.25, lon: -162, gridLon: 0 };

describe("rotated pole to true coordinates (v27 review §4)", () => {
  it("puts the rotated origin 90° from the pole, the true pole at grid longitude 0", () => {
    const toTrue = rotatedToTrue(CORDEX);
    const origin = toTrue(0, 0);
    expect(origin.lat).toBeCloseTo(50.75, 9);
    expect(origin.lon).toBeCloseTo(18, 9);
    // North along the rotated meridian 0 by the pole's latitude: the pole.
    expect(toTrue(39.25, 0).lat).toBeCloseTo(90, 9);
    // Rotated longitude grows eastward.
    expect(toTrue(0, 1).lon).toBeGreaterThan(18);
  });

  it("is the identity for a pole at the true north pole (longitude 180)", () => {
    const toTrue = rotatedToTrue({ lat: 90, lon: 180, gridLon: 0 });
    const p = toTrue(-33.5, 151.2);
    expect(p.lat).toBeCloseTo(-33.5, 9);
    expect(p.lon).toBeCloseTo(151.2, 9);
  });

  it("turns the grid by north_pole_grid_longitude", () => {
    const turned = rotatedToTrue({ ...CORDEX, gridLon: 30 });
    const plain = rotatedToTrue(CORDEX);
    expect(turned(5, 40).lat).toBeCloseTo(plain(5, 10).lat, 9);
    expect(turned(5, 40).lon).toBeCloseTo(plain(5, 10).lon, 9);
  });

  it("reads the pole from a rotated_latitude_longitude grid mapping only", () => {
    expect(
      rotatedPoleOf({
        grid_mapping_name: "rotated_latitude_longitude",
        grid_north_pole_latitude: 39.25,
        grid_north_pole_longitude: -162,
      })
    ).toEqual(CORDEX);
    expect(rotatedPoleOf({ grid_mapping_name: "latitude_longitude" })).toBe(
      undefined
    );
  });
});

describe("review #14: rotated grids are not materialized when described", () => {
  it("a 10,000 × 10,000 grid allocates nothing until read; a small one reads true coordinates", async () => {
    const axis = (n: number) => Float64Array.from({ length: n }, (_, k) => k);
    const before = process.memoryUsage().arrayBuffers;
    const started = performance.now();
    const huge = trueCoordinates(
      {
        lat: { dim: "rlat", key: "rlat", values: axis(10_000) },
        lon: { dim: "rlon", key: "rlon", values: axis(10_000) },
      },
      CORDEX
    );
    expect(huge.lat.shape).toEqual([10_000, 10_000]);
    // 1.6 GB would have been held here, and taken seconds to fill.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(2 ** 26);
    expect(performance.now() - started).toBeLessThan(500);

    const small = trueCoordinates(
      {
        lat: { dim: "rlat", key: "a", values: [0, 39.25] },
        lon: { dim: "rlon", key: "b", values: [0, 1] },
      },
      CORDEX
    );
    const lat = await small.lat.readChunk([0, 0]);
    const lon = await small.lon.readChunk([0, 0]);
    expect(lat.data[0]).toBeCloseTo(50.75, 9);
    expect(lon.data[0]).toBeCloseTo(18, 9);
    expect(lat.data[2]).toBeCloseTo(90, 9);
    // One computation for both, kept.
    expect(await small.lat.readChunk([0, 0])).toBe(lat);
  });
});

it("reads rotated axes again after a failed read (review of interim33)", async () => {
  let calls = 0;
  const coordinates = trueCoordinates(
    {
      lat: {
        dim: "rlat",
        key: "retry-lat",
        length: 2,
        values: async () => {
          calls++;
          if (calls === 1) {
            throw new Error("HTTP 503");
          }
          return [0, 39.25];
        },
      },
      lon: { dim: "rlon", key: "retry-lon", values: [0, 1] },
    },
    CORDEX
  );
  await expect(coordinates.lat.readChunk([0, 0])).rejects.toThrow(/503/);
  const lat = await coordinates.lat.readChunk([0, 0]);
  expect(lat.data[0]).toBeCloseTo(50.75, 9);
  expect(calls).toBe(2);
});
