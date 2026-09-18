import { getRegularLatLonGridBounds } from "@/lib/layers/gridExportMetadata.ts";

export function orderedAxis(values: Float32Array, longitude = false) {
  if (values.length === 0 || !values.every(Number.isFinite)) {
    throw new Error("Volume coordinates must be finite and non-empty.");
  }
  const coordinates = values.slice();
  if (longitude) {
    for (let index = 1; index < coordinates.length; index++) {
      coordinates[index] +=
        360 * Math.round((coordinates[index - 1] - coordinates[index]) / 360);
    }
  }
  const reversed = coordinates[0] > coordinates[coordinates.length - 1];
  if (reversed) {
    coordinates.reverse();
  }
  for (let index = 1; index < coordinates.length; index++) {
    if (coordinates[index] <= coordinates[index - 1]) {
      throw new Error("Volume coordinates must form ordered axes.");
    }
  }
  return { coordinates, reversed };
}

export function nearestIndex(
  axis: ReturnType<typeof orderedAxis>,
  value: number
) {
  const { coordinates, reversed } = axis;
  let low = 0;
  let high = coordinates.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (coordinates[middle] < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low > 0 && value - coordinates[low - 1] < coordinates[low] - value) {
    low--;
  }
  return reversed ? coordinates.length - 1 - low : low;
}

export function getRegularVolumeMapping(
  latitudes: Float32Array,
  longitudes: Float32Array,
  width: number,
  height: number,
  onProgress?: (completed: number, total: number) => void
) {
  if (latitudes.some((latitude) => Math.abs(latitude) > 90)) {
    throw new Error("Volume latitudes must be in degrees north.");
  }
  const latitude = orderedAxis(latitudes);
  const longitude = orderedAxis(longitudes, true);
  const bounds = getRegularLatLonGridBounds(
    latitude.coordinates,
    longitude.coordinates
  );
  if (!bounds) {
    throw new Error("Could not determine regular volume bounds.");
  }
  bounds.east = Math.min(bounds.east, bounds.west + 360);
  const sourceCells = new Int32Array(width * height);
  const columns = Int32Array.from({ length: width }, (_, x) =>
    nearestIndex(
      longitude,
      bounds.west + ((x + 0.5) / width) * (bounds.east - bounds.west)
    )
  );
  for (let y = 0; y < height; y++) {
    const row = nearestIndex(
      latitude,
      bounds.south + ((y + 0.5) / height) * (bounds.north - bounds.south)
    );
    for (let x = 0; x < width; x++) {
      sourceCells[y * width + x] = row * longitudes.length + columns[x];
    }
    onProgress?.(y + 1, height);
  }
  return { sourceCells, bounds };
}
