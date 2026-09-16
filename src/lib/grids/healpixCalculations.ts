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

// A face-local rectangle, normalized to [0, 1] across the whole face, that the
// texture covers. Lets the shader map a full-face UV onto a texture that only
// covers the (small) region a regional/sparse dataset actually has data for.
export type THealpixDataRect = {
  u: number;
  v: number;
  width: number;
  height: number;
};

export function buildHealpixRegionCoordinates(
  grid: Grid,
  faceIndex: number,
  rect: THealpixDataRect
) {
  using faceGrid = grid.replace({ level: 0, scheme: "nested" });
  // Sample the curved rectangle at 16 subdivisions per axis;
  // increase this if tighter framing than the camera's 5% margin is needed.
  const subdivisions = 16;
  const coordinates = new Float32Array((subdivisions + 1) ** 2 * 2);
  let offset = 0;
  for (let i = 0; i <= subdivisions; i++) {
    for (let j = 0; j <= subdivisions; j++) {
      using point = faceGrid.vertex(
        BigInt(faceIndex),
        rect.u + (rect.width * i) / subdivisions,
        rect.v + (rect.height * j) / subdivisions
      );
      coordinates[offset++] = point.lat;
      coordinates[offset++] = point.lon;
    }
  }
  return coordinates;
}

export function decodeHealpixFaceXY(pixel: number) {
  let x = 0;
  let y = 0;
  for (let bit = 1; pixel > 0; bit *= 2) {
    x += (pixel % 2) * bit;
    y += (Math.floor(pixel / 2) % 2) * bit;
    pixel = Math.floor(pixel / 4);
  }
  return { x, y };
}

export function getHealpixTextureIndex(pixel: number, nside: number) {
  const { x, y } = decodeHealpixFaceXY(pixel);
  return y * nside + x;
}

function buildDenseHealpixTexture(data: Float32Array, nside: number) {
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
    const value = data[pixel];
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
    width: nside,
    height: nside,
    dataRect: { u: 0, v: 0, width: 1, height: 1 } as THealpixDataRect,
    histogramSummary: buildHistogramSummary(dataValues, min, max),
  };
}

function getFaceCellBBox(cells: number[], faceOffset: number, faceEnd: number) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  for (const cell of cells) {
    if (cell < faceOffset || cell >= faceEnd) {
      continue;
    }
    const { x, y } = decodeHealpixFaceXY(cell - faceOffset);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return maxX < minX ? null : { minX, minY, maxX, maxY };
}

export function getHealpixFaceDataRect(
  faceIndex: number,
  nside: number,
  cells: number[]
): THealpixDataRect | null {
  const faceOffset = faceIndex * nside * nside;
  const bbox = getFaceCellBBox(cells, faceOffset, faceOffset + nside * nside);
  return bbox
    ? {
        u: bbox.minX / nside,
        v: bbox.minY / nside,
        width: (bbox.maxX - bbox.minX + 1) / nside,
        height: (bbox.maxY - bbox.minY + 1) / nside,
      }
    : null;
}

function fillFaceBBoxTexture(
  data: Float32Array,
  cells: number[],
  faceOffset: number,
  faceEnd: number,
  bbox: { minX: number; minY: number },
  width: number,
  height: number
) {
  const { minX, minY } = bbox;
  const dataValues = new Float32Array(width * height).fill(NaN);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    if (cell < faceOffset || cell >= faceEnd) {
      continue;
    }
    const { x, y } = decodeHealpixFaceXY(cell - faceOffset);
    const value = data[index];
    dataValues[(y - minY) * width + (x - minX)] = value;
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

// A regional/sparse dataset (a "cell" coordinate naming the actual pixels)
// typically covers only a tiny fraction of a face, especially at deep levels
// where nside² is far too large to allocate for the whole face. Size the
// texture to the bounding box of the cells actually present instead.
function buildSparseHealpixTexture(
  data: Float32Array,
  batchIndex: number,
  nside: number,
  cells: number[]
) {
  const faceOffset = batchIndex * nside * nside;
  const faceEnd = faceOffset + nside * nside;
  const dataRect = getHealpixFaceDataRect(batchIndex, nside, cells);
  if (!dataRect) {
    // None of the cells fall in this face.
    return {
      dataValues: new Float32Array(0),
      width: 0,
      height: 0,
      dataRect: { u: 0, v: 0, width: 0, height: 0 } as THealpixDataRect,
      histogramSummary: buildHistogramSummary(new Float32Array(0), NaN, NaN),
    };
  }
  const bbox = { minX: dataRect.u * nside, minY: dataRect.v * nside };
  const width = dataRect.width * nside;
  const height = dataRect.height * nside;
  const { dataValues, histogramSummary } = fillFaceBBoxTexture(
    data,
    cells,
    faceOffset,
    faceEnd,
    bbox,
    width,
    height
  );
  return {
    dataValues,
    width,
    height,
    dataRect,
    histogramSummary,
  };
}

export function buildHealpixTexture(
  data: Float32Array,
  batchIndex: number,
  nside: number,
  cells?: number[]
) {
  return cells
    ? buildSparseHealpixTexture(data, batchIndex, nside, cells)
    : buildDenseHealpixTexture(data, nside);
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
  // 12 scans avoid a full-grid map; index ranges if sparse scans become expensive.
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
