import * as zarr from "zarrita";

export type TDataBounds = {
  min: number;
  max: number;
  fillValue: number;
  missingValue: number;
};

// `null` (e.g. xarray's `_FillValue: None`) means "not set". Number(null)
// would turn it into 0 and mask every exact zero, such as longitude 0.
function hasNonNullAttribute(attributes: zarr.Attributes, key: string) {
  return Object.hasOwn(attributes, key) && attributes[key] !== null;
}

export function getMissingValue(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const attributes = datavar.attrs;
  if (hasNonNullAttribute(attributes, "missingValue")) {
    return new Float32Array([Number(attributes.missingValue)])[0];
  }
  if (hasNonNullAttribute(attributes, "missing_value")) {
    return new Float32Array([Number(attributes.missing_value)])[0];
  }
  return NaN;
}

// Arrays opened as Zarr v2. zarrita converts v2 metadata to the v3 layout,
// so the array itself no longer tells which format it came from.
const zarrV2Arrays = new WeakSet<object>();

export function markZarrV2Array(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  zarrV2Arrays.add(datavar);
}

// A zero `fill_value` only marks missing data in Zarr v2, where it is optional
// (`null` means "not set") and xarray masks it. Zarr v3 always stores one and
// zarr-python writes 0 when none was given; xarray keeps the v3 mask in
// `_FillValue` instead.
function isZeroZarrV2FillValue(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  // Only numbers: zarrita passes a v2 bool `false` or string `""` through as
  // is, and both would also read as 0.
  const fillValue = datavar.fillValue;
  return (
    (typeof fillValue === "number" || typeof fillValue === "bigint") &&
    Number(fillValue) === 0 &&
    zarrV2Arrays.has(datavar)
  );
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
  if (isZeroZarrV2FillValue(datavar)) {
    return 0;
  }
  const attributes = datavar.attrs;
  if (hasNonNullAttribute(attributes, "fillValue")) {
    return new Float32Array([Number(attributes.fillValue)])[0];
  }
  if (hasNonNullAttribute(attributes, "fill_value")) {
    return new Float32Array([Number(attributes.fill_value)])[0];
  }
  if (hasNonNullAttribute(attributes, "_FillValue")) {
    return new Float32Array([Number(attributes._FillValue)])[0];
  }
  if (hasNonNullAttribute(attributes, "_fillvalue")) {
    return new Float32Array([Number(attributes._fillvalue)])[0];
  }
  return NaN;
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
export function castDataVarToFloat32(rawData: zarr.TypedArray<zarr.DataType>) {
  if (rawData instanceof Float32Array) {
    return rawData;
  }
  if (rawData instanceof BigInt64Array || rawData instanceof BigUint64Array) {
    return Float32Array.from(rawData, Number);
  }
  return Float32Array.from(rawData as ArrayLike<number>);
}
