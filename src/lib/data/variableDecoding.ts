import * as zarr from "zarrita";

export type TDataBounds = {
  min: number;
  max: number;
  fillValue: number;
  missingValue: number;
};

export function getMissingValue(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const attributes = datavar.attrs;
  if (Object.hasOwn(attributes, "missingValue")) {
    return new Float32Array([Number(attributes.missingValue)])[0];
  }
  if (Object.hasOwn(attributes, "missing_value")) {
    return new Float32Array([Number(attributes.missing_value)])[0];
  }
  return NaN;
}

/**
 * Retrieves the fill value from a Zarr array, normalizing across different
 * naming conventions ("fillValue", "fill_value", "_FillValue", "_fillvalue")
 * that various tools and conventions (Zarr v2, CF conventions, xarray, etc.)
 * may use to store it in the metadata attributes.
 */
export function getFillValue(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  if (datavar.fillValue) {
    return datavar.fillValue as number;
  }
  const attributes = datavar.attrs;
  if (Object.hasOwn(attributes, "fillValue")) {
    return new Float32Array([Number(attributes.fillValue)])[0];
  }
  if (Object.hasOwn(attributes, "fill_value")) {
    return new Float32Array([Number(attributes.fill_value)])[0];
  }
  if (Object.hasOwn(attributes, "_FillValue")) {
    return new Float32Array([Number(attributes._FillValue)])[0];
  }
  if (Object.hasOwn(attributes, "_fillvalue")) {
    return new Float32Array([Number(attributes._fillvalue)])[0];
  }
  return NaN;
}

/**
 * Create a predicate that returns true when a value equals the dataset's
 * missing or fill value (or is NaN).
 */
export function createMissingOrFillPredicate(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const missingValue = getMissingValue(datavar);
  const fillValue = getFillValue(datavar);
  return (value: number) => {
    if (Number.isNaN(value)) {
      return true;
    }
    if (value === missingValue) {
      return true;
    }
    if (value === fillValue) {
      return true;
    }
    return false;
  };
}

function getAttributeNumber(
  attributes: zarr.Attributes | undefined,
  key: string,
  fallback: number
) {
  if (attributes && Object.hasOwn(attributes, key)) {
    return Number(attributes[key]);
  }
  return fallback;
}

function getValidRanges(attributes?: zarr.Attributes): [number, number][] {
  const validRanges = attributes?.valid_ranges;
  if (!Array.isArray(validRanges)) {
    return [];
  }
  const ranges = Array.isArray(validRanges[0])
    ? (validRanges as ArrayLike<ArrayLike<unknown>>)
    : [validRanges as ArrayLike<unknown>];
  return Array.from(ranges, (range) => [Number(range[0]), Number(range[1])]);
}

function hasVariableAttributes(attributes?: zarr.Attributes) {
  return (
    attributes !== undefined &&
    (Object.hasOwn(attributes, "scale_factor") ||
      Object.hasOwn(attributes, "add_offset") ||
      Object.hasOwn(attributes, "valid_ranges"))
  );
}

export function decodeVariableDataInPlace(
  data: Float32Array<ArrayBufferLike>,
  attributes: zarr.Attributes | undefined,
  missingValue = NaN,
  fillValue = NaN
) {
  const scaleFactor = getAttributeNumber(attributes, "scale_factor", 1);
  const addOffset = getAttributeNumber(attributes, "add_offset", 0);
  const validRanges = getValidRanges(attributes);

  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    const outsideValidRanges =
      validRanges.length > 0 &&
      !validRanges.some(([min, max]) => value >= min && value <= max);
    if (
      value === missingValue ||
      value === fillValue ||
      !Number.isFinite(value) ||
      outsideValidRanges
    ) {
      data[i] = NaN;
      continue;
    }
    data[i] = value * scaleFactor + addOffset;
  }
  return data;
}

export function decodeVariableChunkInPlace(
  data?: zarr.Chunk<zarr.DataType>,
  attributes?: zarr.Attributes
) {
  if (!data || !hasVariableAttributes(attributes)) {
    return;
  }
  const values = castDataVarToFloat32(data.data);
  decodeVariableDataInPlace(values, attributes);
  data.data = values;
}

function getFiniteBounds(data: Float32Array<ArrayBufferLike>) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) {
      data[i] = NaN;
      continue;
    }
    if (v < min) {
      min = v;
    }
    if (v > max) {
      max = v;
    }
  }

  if (min === Number.POSITIVE_INFINITY) {
    min = NaN;
  }
  if (max === Number.NEGATIVE_INFINITY) {
    max = NaN;
  }
  return { min, max };
}

export function decodeVariableDataAndGetBounds(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  data: Float32Array<ArrayBufferLike>,
  missingValue = getMissingValue(datavar),
  fillValue = getFillValue(datavar)
): TDataBounds {
  decodeVariableDataInPlace(data, datavar.attrs, missingValue, fillValue);
  const { min, max } = getFiniteBounds(data);
  return { min, max, fillValue, missingValue };
}

/**
 * Gridlook cannot handle Float64 and integer types in textures, so cast to Float32
 */
export function castDataVarToFloat32(
  rawData:
    | unknown[]
    | Int8Array<ArrayBufferLike>
    | Int16Array<ArrayBufferLike>
    | Int32Array<ArrayBufferLike>
    | BigInt64Array<ArrayBufferLike>
    | Uint8Array<ArrayBufferLike>
    | Uint16Array<ArrayBufferLike>
    | Uint32Array<ArrayBufferLike>
    | BigUint64Array<ArrayBufferLike>
    | Float32Array<ArrayBufferLike>
    | Float64Array<ArrayBufferLike>
    | zarr.BoolArray
    | zarr.UnicodeStringArray
    | zarr.ByteStringArray
    | zarr.Chunk<zarr.DataType>
) {
  if (rawData instanceof Float32Array) {
    return rawData;
  }
  return Float32Array.from(rawData as ArrayLike<number>);
}
