import { Grid, type IndexingScheme } from "healpix-geo";
import { describe, expect, it } from "vitest";

import { getHealpixVolumeSourceCells } from "@/lib/volume/healpixVolumeMapping.ts";
import type { THealpixVolumeGrid } from "@/lib/volume/healpixVolumeMapping.ts";

const TEST_GRID: THealpixVolumeGrid = {
  nside: 1,
  level: 0,
  scheme: "nested",
  semiMajorAxis: 6_370_997,
  flattening: 0,
  lonLatToHealpix(coordinates) {
    return BigUint64Array.from({ length: coordinates.length / 2 }, (_, index) =>
      BigInt(index)
    );
  },
};

describe("HEALPix volume mapping", () => {
  it.each<IndexingScheme>(["nested", "ring", "zuniq"])(
    "maps a level-20 %s cutout using full cell IDs from healpix-geo",
    (scheme) => {
      using grid = new Grid({ level: 20, scheme });
      const pixels = grid.lonLatToHealpix(
        new Float64Array([-90, -45, 90, -45, -90, 45, 90, 45])
      );
      const coordinates = new Float64Array([
        Number(pixels[3]),
        Number(pixels[0]),
      ]);
      expect(coordinates[0]).toBeGreaterThan(2 ** 32);
      expect(
        Array.from(getHealpixVolumeSourceCells(grid, 2, 2, 2, coordinates))
      ).toEqual([1, -1, -1, 0]);
    }
  );

  it("maps a reordered cell coordinate to its source-array index", () => {
    const globalCells = getHealpixVolumeSourceCells(TEST_GRID, 4, 2, 12);
    const reversedCoordinates = Float64Array.from(
      { length: 12 },
      (_, index) => 11 - index
    );
    const reorderedCells = getHealpixVolumeSourceCells(
      TEST_GRID,
      4,
      2,
      12,
      reversedCoordinates
    );

    expect(Array.from(reorderedCells)).toEqual(
      Array.from(globalCells, (cell) => 11 - cell)
    );
  });

  it("reuses the mapping for equivalent coordinate arrays", () => {
    const coordinates = Float64Array.from({ length: 12 }, (_, index) => index);
    getHealpixVolumeSourceCells(TEST_GRID, 4, 2, 12, coordinates);
    const progress: Array<[number, number]> = [];

    getHealpixVolumeSourceCells(
      TEST_GRID,
      4,
      2,
      12,
      coordinates.slice(),
      (completed, total) => progress.push([completed, total])
    );

    expect(progress).toEqual([[2, 2]]);
  });
});
