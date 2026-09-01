import { describe, expect, it } from "vitest";

import { getHealpixVolumeSourceCells } from "@/lib/volume/healpixVolumeMapping.ts";

describe("HEALPix volume mapping", () => {
  it("maps a reordered cell coordinate to its source-array index", () => {
    const globalCells = getHealpixVolumeSourceCells(1, 4, 2, 12);
    const reversedCoordinates = Int32Array.from(
      { length: 12 },
      (_, index) => 11 - index
    );
    const reorderedCells = getHealpixVolumeSourceCells(
      1,
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
    const coordinates = Int32Array.from({ length: 12 }, (_, index) => index);
    getHealpixVolumeSourceCells(1, 4, 2, 12, coordinates);
    const progress: Array<[number, number]> = [];

    getHealpixVolumeSourceCells(
      1,
      4,
      2,
      12,
      coordinates.slice(),
      (completed, total) => progress.push([completed, total])
    );

    expect(progress).toEqual([[2, 2]]);
  });
});
