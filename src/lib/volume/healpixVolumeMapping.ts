import { healpixNestedPixelIndex } from "@/lib/data/healpix.ts";

type TPixelLookupCache = {
  nside: number;
  width: number;
  height: number;
  sourceCellCount: number;
  cellCoordinates?: Int32Array;
  sourceCells: Int32Array;
};

let pixelLookupCache: TPixelLookupCache | undefined;

function equalCoordinates(first?: Int32Array, second?: Int32Array) {
  if (first === second) {
    return true;
  }
  if (!first || !second || first.length !== second.length) {
    return false;
  }
  for (let index = 0; index < first.length; index++) {
    if (first[index] !== second[index]) {
      return false;
    }
  }
  return true;
}

function makeCellLookup(nside: number, cellCoordinates?: Int32Array) {
  if (!cellCoordinates) {
    return undefined;
  }
  let isIdentity = true;
  for (let index = 0; index < cellCoordinates.length; index++) {
    if (cellCoordinates[index] !== index) {
      isIdentity = false;
      break;
    }
  }
  if (isIdentity) {
    return undefined;
  }
  const lookup = new Int32Array(12 * nside * nside);
  lookup.fill(-1);
  for (let index = 0; index < cellCoordinates.length; index++) {
    const cell = cellCoordinates[index];
    if (cell >= 0 && cell < lookup.length) {
      lookup[cell] = index;
    }
  }
  return lookup;
}

function cacheMatches(
  cache: TPixelLookupCache,
  nside: number,
  width: number,
  height: number,
  sourceCellCount: number,
  cellCoordinates?: Int32Array
) {
  return (
    cache.nside === nside &&
    cache.width === width &&
    cache.height === height &&
    cache.sourceCellCount === sourceCellCount &&
    equalCoordinates(cache.cellCoordinates, cellCoordinates)
  );
}

export function getHealpixVolumeSourceCells(
  nside: number,
  width: number,
  height: number,
  sourceCellCount: number,
  cellCoordinates?: Int32Array,
  onProgress?: (completed: number, total: number) => void
) {
  if (
    pixelLookupCache &&
    cacheMatches(
      pixelLookupCache,
      nside,
      width,
      height,
      sourceCellCount,
      cellCoordinates
    )
  ) {
    onProgress?.(height, height);
    return pixelLookupCache.sourceCells;
  }

  const cellLookup = makeCellLookup(nside, cellCoordinates);
  const sourceCells = new Int32Array(width * height);
  sourceCells.fill(-1);
  const progressInterval = Math.max(1, Math.floor(height / 100));
  for (let y = 0; y < height; y++) {
    const latitude = ((y + 0.5) / height) * 180 - 90;
    for (let x = 0; x < width; x++) {
      const longitude = ((x + 0.5) / width) * 360 - 180;
      const pixel = healpixNestedPixelIndex(nside, latitude, longitude);
      const sourceCell = cellLookup ? cellLookup[pixel] : pixel;
      if (sourceCell >= 0 && sourceCell < sourceCellCount) {
        sourceCells[y * width + x] = sourceCell;
      }
    }
    if ((y + 1) % progressInterval === 0 || y + 1 === height) {
      onProgress?.(y + 1, height);
    }
  }

  pixelLookupCache = {
    nside,
    width,
    height,
    sourceCellCount,
    cellCoordinates,
    sourceCells,
  };
  return sourceCells;
}
