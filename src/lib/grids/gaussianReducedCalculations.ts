import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

// One entry per latitude row, sorted north to south.
export type TGaussianReducedGrid = {
  rowLatitudes: Float64Array;
  rowFirstLongitudes: Float64Array;
  rowPointCounts: Uint32Array;
  // Data index of each row's first point.
  rowOffsets: Uint32Array;
};

export type TGaussianReducedMesh = {
  positionValues: Float32Array;
  latLonValues: Float32Array;
  uvValues: Float32Array;
  indices: Uint32Array;
};

function assertEvenlySpacedRow(
  longitudes: ArrayLike<number>,
  offset: number,
  count: number
) {
  const spacing = 360 / count;
  for (let k = 1; k < count; k++) {
    const error = ProjectionHelper.normalizeLongitude(
      longitudes[offset + k] - longitudes[offset] - k * spacing
    );
    if (Math.abs(error) > spacing / 4) {
      throw new Error(
        "Gaussian reduced rows must be evenly spaced in ascending longitude."
      );
    }
  }
}

// Each row's points must be contiguous in the data, evenly spaced around the
// full circle and in ascending longitude, as GRIB stores reduced Gaussian grids.
export function buildGaussianReducedGrid(
  latitudes: ArrayLike<number>,
  longitudes: ArrayLike<number>
): TGaussianReducedGrid {
  const starts: number[] = [];
  for (let index = 0; index < latitudes.length; index++) {
    if (index === 0 || latitudes[index] !== latitudes[index - 1]) {
      starts.push(index);
    }
  }
  const order = starts
    .map((_, row) => row)
    .sort((a, b) => latitudes[starts[b]] - latitudes[starts[a]]);
  const grid: TGaussianReducedGrid = {
    rowLatitudes: new Float64Array(starts.length),
    rowFirstLongitudes: new Float64Array(starts.length),
    rowPointCounts: new Uint32Array(starts.length),
    rowOffsets: new Uint32Array(starts.length),
  };
  order.forEach((sourceRow, row) => {
    const offset = starts[sourceRow];
    const count = (starts[sourceRow + 1] ?? latitudes.length) - offset;
    grid.rowLatitudes[row] = latitudes[offset];
    grid.rowFirstLongitudes[row] = longitudes[offset];
    grid.rowPointCounts[row] = count;
    grid.rowOffsets[row] = offset;
    if (row > 0 && grid.rowLatitudes[row] === grid.rowLatitudes[row - 1]) {
      throw new Error("Gaussian reduced rows must be stored contiguously.");
    }
    assertEvenlySpacedRow(longitudes, offset, count);
  });
  return grid;
}

// Mirrors findRow/main in gaussianReduced.frag.glsl: the nearest row in
// latitude, then the point whose cell (centered on it) contains lon.
function findGaussianReducedPoint(
  grid: TGaussianReducedGrid,
  lat: number,
  lon: number
) {
  const { rowLatitudes } = grid;
  let low = 0;
  let high = rowLatitudes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rowLatitudes[mid] > lat) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const row =
    low === rowLatitudes.length ||
    (low > 0 && rowLatitudes[low - 1] - lat < lat - rowLatitudes[low])
      ? low - 1
      : low;
  const count = grid.rowPointCounts[row];
  const spacing = 360 / count;
  const firstLongitude = grid.rowFirstLongitudes[row];
  const column =
    Math.floor(
      ((((lon - firstLongitude + spacing / 2) % 360) + 360) % 360) / spacing
    ) % count;
  return {
    index: grid.rowOffsets[row] + column,
    lat: rowLatitudes[row],
    lon: ProjectionHelper.normalizeLongitude(firstLongitude + column * spacing),
  };
}

export function createGaussianReducedSampleIndex(
  grid: TGaussianReducedGrid,
  values: Float32Array
) {
  return {
    findNearest(lat: number, lon: number) {
      const point = findGaussianReducedPoint(grid, lat, lon);
      return { lat: point.lat, lon: point.lon, value: values[point.index] };
    },
  };
}

/**
 * A global lat/lon mesh whose uv holds (lon, lat) in degrees. The cells are
 * resolved per fragment, so the mesh only has to follow the projection.
 */
export function buildGaussianReducedMesh(
  stepDegrees: number,
  projection: ProjectionHelper
): TGaussianReducedMesh {
  const lonCount = Math.round(360 / stepDegrees) + 1;
  const latCount = Math.round(180 / stepDegrees) + 1;
  const vertexCount = lonCount * latCount;
  const positionValues = new Float32Array(vertexCount * 3);
  const latLonValues = new Float32Array(vertexCount * 2);
  const uvValues = new Float32Array(vertexCount * 2);
  for (let latIt = 0; latIt < latCount; latIt++) {
    const lat = -90 + (180 * latIt) / (latCount - 1);
    for (let lonIt = 0; lonIt < lonCount; lonIt++) {
      const lon = -180 + (360 * lonIt) / (lonCount - 1);
      const vertex = latIt * lonCount + lonIt;
      projection.projectLatLonToArrays(
        lat,
        lon,
        positionValues,
        vertex * 3,
        latLonValues,
        vertex * 2
      );
      // projectLatLonToArrays maps +180 to -180; keep the seam column apart.
      latLonValues[vertex * 2 + 1] = lon;
      uvValues[vertex * 2] = lon;
      uvValues[vertex * 2 + 1] = lat;
    }
  }
  const indices = new Uint32Array((latCount - 1) * (lonCount - 1) * 6);
  let indexOffset = 0;
  for (let latIt = 0; latIt < latCount - 1; latIt++) {
    for (let lonIt = 0; lonIt < lonCount - 1; lonIt++) {
      const lowLeft = latIt * lonCount + lonIt;
      const topLeft = lowLeft + lonCount;
      indices.set(
        [lowLeft, topLeft + 1, topLeft, lowLeft, lowLeft + 1, topLeft + 1],
        indexOffset
      );
      indexOffset += 6;
    }
  }
  return { positionValues, latLonValues, uvValues, indices };
}
