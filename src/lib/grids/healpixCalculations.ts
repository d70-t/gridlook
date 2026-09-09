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
  mortonIndices: BigUint64Array,
  cellIndex?: Map<number, number>
) {
  const dataValues = new Float32Array(mortonIndices.length);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < dataValues.length; index++) {
    const cell = batchIndex * dataValues.length + Number(mortonIndices[index]);
    const inputIndex = cellIndex ? cellIndex.get(cell) : cell;
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
