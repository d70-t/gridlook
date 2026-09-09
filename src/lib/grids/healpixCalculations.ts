import type { Grid } from "healpix-geo";

import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import { buildHistogramSummary } from "@/utils/histogram.ts";

export const HEALPIX_NUMCHUNKS = 12;

function distanceSquared(
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number
): number {
  return (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1) + (z2 - z1) * (z2 - z1);
}

function generateHealpixIndices(positionValues: Float32Array, steps: number) {
  const indices = [];
  for (let i = 0; i < steps - 1; ++i) {
    for (let j = 0; j < steps - 1; ++j) {
      const a = i * steps + (j + 1);
      const b = i * steps + j;
      const c = (i + 1) * steps + j;
      const d = (i + 1) * steps + (j + 1);
      const dac2 = distanceSquared(
        positionValues[3 * a + 0],
        positionValues[3 * a + 1],
        positionValues[3 * a + 2],
        positionValues[3 * c + 0],
        positionValues[3 * c + 1],
        positionValues[3 * c + 2]
      );
      const dbd2 = distanceSquared(
        positionValues[3 * b + 0],
        positionValues[3 * b + 1],
        positionValues[3 * b + 2],
        positionValues[3 * d + 0],
        positionValues[3 * d + 1],
        positionValues[3 * d + 2]
      );
      if (dac2 < dbd2) {
        indices.push(a, c, d);
        indices.push(b, c, a);
      } else {
        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }
  }
  return indices;
}

export function buildHealpixGeometry(
  grid: Grid,
  ipix: bigint,
  steps: number,
  helper: ProjectionHelper
) {
  const vertexCount = steps * steps;
  const positionValues = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const latLonValues = new Float32Array(vertexCount * 2);
  let vertexIndex = 0;

  const coords = grid.vertices(BigInt(ipix), steps);
  for (let index = 0; index < Math.floor(coords.length / 2); ++index) {
    const indexLon = 2 * index;
    const indexLat = 2 * index + 1;
    const lat = coords[indexLat];
    const lon = coords[indexLon];

    const u = Math.floor(index / steps) / (steps - 1);
    const v = (index % steps) / (steps - 1);

    const positionOffset = vertexIndex * 3;
    helper.projectLatLonToArrays(
      lat,
      lon,
      positionValues,
      positionOffset,
      latLonValues,
      vertexIndex * 2
    );

    const uvIndex = vertexIndex * 2;
    uv[uvIndex] = u;
    uv[uvIndex + 1] = v;

    vertexIndex++;
  }

  const indices = generateHealpixIndices(positionValues, steps);
  return {
    positionValues,
    uv,
    latLonValues,
    indices: new Uint32Array(indices),
  };
}

export function buildHealpixTexture(
  data: Float32Array,
  batchIndex: number,
  nside: number,
  cellIndex?: Map<number, number>
) {
  const dataValues = new Float32Array(nside * nside);
  // Interleave each axis separately: O(nside) lookup storage instead of O(nside²).
  const spread = new Uint32Array(nside);
  for (let index = 1; index < nside; index++) {
    spread[index] = spread[index >> 1] * 4 + (index & 1);
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < dataValues.length; index++) {
    const pixel = spread[index % nside] + spread[Math.floor(index / nside)] * 2;
    const cell = batchIndex * dataValues.length + pixel;
    const inputIndex = cellIndex ? cellIndex.get(cell) : pixel;
    const value = inputIndex === undefined ? NaN : data[inputIndex];
    dataValues[index] = value;
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  if (min === Number.POSITIVE_INFINITY) {
    min = max = NaN;
  }
  return {
    dataValues,
    histogramSummary: buildHistogramSummary(dataValues, min, max),
  };
}

export function getHealpixTextureIndex(pixel: number, nside: number) {
  let x = 0;
  let y = 0;
  for (let bit = 1; pixel > 0; bit *= 2) {
    x += (pixel % 2) * bit;
    y += (Math.floor(pixel / 2) % 2) * bit;
    pixel = Math.floor(pixel / 4);
  }
  return y * nside + x;
}

export function getHealpixFaceRange(
  faceIndex: number,
  nside: number,
  cells?: number[]
) {
  const pixelStart = faceIndex * nside * nside;
  const pixelEnd = pixelStart + nside * nside;
  if (!cells) {
    return { start: pixelStart, end: pixelEnd, cells };
  }
  // ponytail: 12 scans avoid a full-grid map; index ranges if sparse scans become expensive.
  let start = cells.length;
  let end = 0;
  for (let index = 0; index < cells.length; index++) {
    if (cells[index] >= pixelStart && cells[index] < pixelEnd) {
      start = Math.min(start, index);
      end = index + 1;
    }
  }
  return { start: Math.min(start, end), end, cells: cells.slice(start, end) };
}
