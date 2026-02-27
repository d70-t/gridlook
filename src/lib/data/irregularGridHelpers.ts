import * as zarr from "zarrita";

/**
 * Expand 1D lat/lon arrays to match data length via meshgrid-style expansion.
 * If lat[nj] and lon[ni], expands to lat[nj*ni], lon[nj*ni] where each lat
 * value is repeated ni times and lon values cycle nj times.
 */
function expandCoordinatesToMeshgrid(
  lat: Float32Array,
  lon: Float32Array,
  dataLength: number
): { latitudes: Float32Array; longitudes: Float32Array } {
  const nj = lat.length;
  const ni = lon.length;

  if (nj * ni !== dataLength) {
    throw new Error(
      `Cannot expand coordinates: lat[${nj}] × lon[${ni}] = ${nj * ni} but data has ${dataLength} points`
    );
  }

  const latitudes = new Float32Array(dataLength);
  const longitudes = new Float32Array(dataLength);

  for (let j = 0; j < nj; j++) {
    for (let i = 0; i < ni; i++) {
      const idx = j * ni + i;
      latitudes[idx] = lat[j];
      longitudes[idx] = lon[i];
    }
  }

  return { latitudes, longitudes };
}

/**
 * Reconcile coordinate arrays with data array, handling various cases:
 * 1. All same length: use as-is
 * 2. 2D coordinates: flatten to 1D
 * 3. 1D separate coords (meshgrid): expand lat[nj] × lon[ni] to match data[nj*ni]
 */
export function reconcileCoordinates(
  latitudesVar: zarr.Chunk<zarr.DataType>,
  longitudesVar: zarr.Chunk<zarr.DataType>,
  dataLength: number
): { latitudes: Float32Array; longitudes: Float32Array } {
  const latitudes = latitudesVar.data as Float32Array;
  const longitudes = longitudesVar.data as Float32Array;
  const latShape = latitudesVar.shape;
  const lonShape = longitudesVar.shape;

  // Case 1: All arrays already have same length (typical irregular grid)
  if (latitudes.length === dataLength && longitudes.length === dataLength) {
    return { latitudes, longitudes };
  }

  // Case 2: 2D coordinate arrays - just ensure they're flattened and match data
  // (zarr.Chunk.data should already be flattened)
  if (latShape.length === 2 && lonShape.length === 2) {
    const latTotal = latShape[0] * latShape[1];
    const lonTotal = lonShape[0] * lonShape[1];
    if (latTotal === dataLength && lonTotal === dataLength) {
      // Already flattened by zarr, should match
      return { latitudes, longitudes };
    }
  }

  // Case 3: 1D separate coordinates - expand via meshgrid
  if (latShape.length === 1 && lonShape.length === 1) {
    const product = latitudes.length * longitudes.length;
    if (product === dataLength) {
      return expandCoordinatesToMeshgrid(latitudes, longitudes, dataLength);
    }
  }

  // Case 4: Mixed or other shapes - try to adapt if total elements match
  const latTotal = latitudes.length;
  const lonTotal = longitudes.length;

  // If flattened coords match data length, use them directly
  if (latTotal === dataLength && lonTotal === dataLength) {
    return { latitudes, longitudes };
  }

  // Last resort: try meshgrid expansion if product matches
  if (latTotal * lonTotal === dataLength) {
    return expandCoordinatesToMeshgrid(latitudes, longitudes, dataLength);
  }

  throw new Error(
    `Cannot reconcile coordinates with data: lat has ${latTotal} values, ` +
      `lon has ${lonTotal} values, but data has ${dataLength} points. ` +
      `Expected either matching lengths or lat×lon=${dataLength}.`
  );
}
