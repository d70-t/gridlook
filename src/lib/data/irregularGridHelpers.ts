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

/** Selected index of each named dimension, e.g. { time: 3 }. */
function getDimensionIndices(
  names: string[],
  dimensions: string[],
  indices: (number | null | zarr.Slice)[]
): Record<string, number> {
  return Object.fromEntries(
    names.map((name) => [name, indices[dimensions.indexOf(name)] as number])
  );
}

/**
 * Fix some dimensions of a C-ordered chunk to single indices, e.g. the time
 * step of latitude(time, ny). Dimensions not in `fixedIndices` are kept.
 */
export function selectChunkIndices(
  chunk: zarr.Chunk<zarr.DataType>,
  dimensionNames: string[],
  fixedIndices: Record<string, number>
): zarr.Chunk<zarr.DataType> {
  // Also covers coordinates without dimension names.
  if (Object.keys(fixedIndices).length === 0) {
    return chunk;
  }
  const kept: number[] = [];
  let offset = 0;
  for (let i = 0; i < dimensionNames.length; i++) {
    if (dimensionNames[i] in fixedIndices) {
      offset += fixedIndices[dimensionNames[i]] * chunk.stride[i];
    } else {
      kept.push(i);
    }
  }
  if (kept.length === dimensionNames.length) {
    return chunk;
  }
  const shape = kept.map((i) => chunk.shape[i]);
  const source = chunk.data as Float32Array;
  let size = 1;
  for (const length of shape) {
    size *= length;
  }
  const data = new Float32Array(size);
  for (let index = 0; index < size; index++) {
    let remainder = index;
    let sourceIndex = offset;
    for (let k = kept.length - 1; k >= 0; k--) {
      sourceIndex += (remainder % shape[k]) * chunk.stride[kept[k]];
      remainder = Math.floor(remainder / shape[k]);
    }
    data[index] = source[sourceIndex];
  }
  const stride = new Array<number>(shape.length);
  let strideValue = 1;
  for (let k = shape.length - 1; k >= 0; k--) {
    stride[k] = strideValue;
    strideValue *= shape[k];
  }
  return { data, shape, stride } as zarr.Chunk<zarr.DataType>;
}

/**
 * Slice lat/lon that move over time (e.g. latitude(time, ny)) at the time
 * step selected for the data variable.
 */
export function selectCoordinateTimeStep(
  coordinates: {
    latitudes: zarr.Chunk<zarr.DataType>;
    longitudes: zarr.Chunk<zarr.DataType> | null;
    latitudesAttrs: zarr.Attributes;
    longitudesAttrs: zarr.Attributes | null;
    timeDimensions: string[];
  },
  dimensions: string[],
  indices: (number | null | zarr.Slice)[]
) {
  const timeIndices = getDimensionIndices(
    coordinates.timeDimensions,
    dimensions,
    indices
  );
  return {
    latitudes: selectChunkIndices(
      coordinates.latitudes,
      coordinates.latitudesAttrs.dimensionNames as string[],
      timeIndices
    ),
    longitudes: selectChunkIndices(
      coordinates.longitudes!,
      coordinates.longitudesAttrs!.dimensionNames as string[],
      timeIndices
    ),
  };
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
  return reconcileCoordinateArrays(
    latitudes,
    longitudes,
    latitudesVar.shape,
    longitudesVar.shape,
    dataLength
  );
}

export function reconcileCoordinateArrays(
  latitudes: Float32Array,
  longitudes: Float32Array,
  latitudeShape: number[],
  longitudeShape: number[],
  dataLength: number
): { latitudes: Float32Array; longitudes: Float32Array } {
  // Case 1: All arrays already have same length (typical irregular grid)
  if (latitudes.length === dataLength && longitudes.length === dataLength) {
    return { latitudes, longitudes };
  }

  // Case 2: 2D coordinate arrays - just ensure they're flattened and match data
  // (zarr.Chunk.data should already be flattened)
  if (latitudeShape.length === 2 && longitudeShape.length === 2) {
    const latTotal = latitudeShape[0] * latitudeShape[1];
    const lonTotal = longitudeShape[0] * longitudeShape[1];
    if (latTotal === dataLength && lonTotal === dataLength) {
      // Already flattened by zarr, should match
      return { latitudes, longitudes };
    }
  }

  // Case 3: 1D separate coordinates - expand via meshgrid
  if (latitudeShape.length === 1 && longitudeShape.length === 1) {
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
