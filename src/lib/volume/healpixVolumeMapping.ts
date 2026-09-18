import type { Grid } from "healpix-geo";

export type THealpixVolumeGrid = Pick<
  Grid,
  | "nside"
  | "level"
  | "scheme"
  | "semiMajorAxis"
  | "flattening"
  | "lonLatToHealpix"
>;

type TPixelLookupCache = {
  gridKey: string;
  width: number;
  height: number;
  sourceCellCount: number;
  cellCoordinates?: Float64Array;
  sourceCells: Int32Array;
};

let pixelLookupCache: TPixelLookupCache | undefined;

function equalCoordinates(first?: Float64Array, second?: Float64Array) {
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

function makeCellLookup(cellCoordinates?: Float64Array) {
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
  const lookup = new Map<number, number>();
  for (let index = 0; index < cellCoordinates.length; index++) {
    lookup.set(cellCoordinates[index], index);
  }
  return lookup;
}

function cacheMatches(
  cache: TPixelLookupCache,
  gridKey: string,
  width: number,
  height: number,
  sourceCellCount: number,
  cellCoordinates?: Float64Array
) {
  return (
    cache.gridKey === gridKey &&
    cache.width === width &&
    cache.height === height &&
    cache.sourceCellCount === sourceCellCount &&
    equalCoordinates(cache.cellCoordinates, cellCoordinates)
  );
}

// eslint-disable-next-line max-lines-per-function
export function getHealpixVolumeSourceCells(
  grid: THealpixVolumeGrid,
  width: number,
  height: number,
  sourceCellCount: number,
  cellCoordinates?: Float64Array,
  onProgress?: (completed: number, total: number) => void
) {
  const gridKey = `${grid.scheme}:${grid.level}:${grid.semiMajorAxis}:${grid.flattening}`;
  if (
    pixelLookupCache &&
    cacheMatches(
      pixelLookupCache,
      gridKey,
      width,
      height,
      sourceCellCount,
      cellCoordinates
    )
  ) {
    onProgress?.(height, height);
    return pixelLookupCache.sourceCells;
  }

  const cellLookup = makeCellLookup(cellCoordinates);
  const sourceCells = new Int32Array(width * height);
  sourceCells.fill(-1);
  const batchRows = 32;
  const coordinates = new Float64Array(width * Math.min(batchRows, height) * 2);
  for (let startY = 0; startY < height; startY += batchRows) {
    const endY = Math.min(startY + batchRows, height);
    let coordinateOffset = 0;
    for (let y = startY; y < endY; y++) {
      const latitude = ((y + 0.5) / height) * 180 - 90;
      for (let x = 0; x < width; x++) {
        coordinates[coordinateOffset++] = ((x + 0.5) / width) * 360 - 180;
        coordinates[coordinateOffset++] = latitude;
      }
    }
    const pixels = grid.lonLatToHealpix(
      coordinates.subarray(0, coordinateOffset)
    );
    const targetOffset = startY * width;
    for (let index = 0; index < pixels.length; index++) {
      const pixel = Number(pixels[index]);
      const sourceCell = cellLookup ? (cellLookup.get(pixel) ?? -1) : pixel;
      if (sourceCell >= 0 && sourceCell < sourceCellCount) {
        sourceCells[targetOffset + index] = sourceCell;
      }
    }
    onProgress?.(endY, height);
  }

  pixelLookupCache = {
    gridKey,
    width,
    height,
    sourceCellCount,
    cellCoordinates,
    sourceCells,
  };
  return sourceCells;
}
