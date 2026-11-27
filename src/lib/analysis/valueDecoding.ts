/**
 * CF decoding of stored values for analysis, in Float64. Missing markers and
 * valid ranges are compared in the stored (packed) domain, before scale and
 * offset; a zero is only missing when it is the declared marker.
 */

type TAttrs = Record<string, unknown>;

export type TValueCodec = {
  scale: number;
  offset: number;
  /** Stored values that mark missing data. */
  markers: number[];
  validMin: number;
  validMax: number;
  validRanges: [number, number][];
  /**
   * The decoded value of an element in a chunk that was never written: the
   * array's logical fill value, decoded like any stored value (NaN when the
   * array has no fill value or it is a missing marker).
   */
  absentValue: number;
  /** Missing markers of 64-bit integer data, compared before conversion. */
  bigMarkers: bigint[];
  /** The valid range of 64-bit integer data, compared before conversion. */
  bigRange?: { min?: bigint; max?: bigint };
  /** Disjoint `valid_ranges` of 64-bit integer data, compared exactly. */
  bigRanges?: [bigint, bigint][];
  /**
   * An integer scale and offset given as exact 64-bit integers: applied without
   * rounding through binary64.
   */
  bigScale?: bigint;
  bigOffset?: bigint;
  categorical: boolean;
  /**
   * CF `_Unsigned = "true"` on signed storage: a negative stored value is
   * its unsigned twin (value + 2^bits), markers and ranges included.
   */
  unsignedBits?: number;
  /** Plain-language description recorded with every result. */
  rule: string;
};

function present(attrs: TAttrs, key: string) {
  return Object.hasOwn(attrs, key) && attrs[key] !== null;
}

/**
 * A numeric attribute. xarray writes a floating `_FillValue` of a Zarr v3
 * array as base64 of its little-endian bytes ("AAAAAAA4j8A=" is -999):
 * those are decoded, so a finite fill stays a missing marker.
 */
function attrNumber(value: unknown): number {
  if (typeof value !== "string") {
    return Number(value);
  }
  const text = value.trim();
  const plain = Number(text);
  if (text !== "" && (!Number.isNaN(plain) || /^[-+]?nan$/i.test(text))) {
    return plain;
  }
  if (/^[A-Za-z0-9+/]{2,}={0,2}$/.test(text) && text.length % 4 === 0) {
    try {
      const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
      const view = new DataView(bytes.buffer);
      if (bytes.length === 8) {
        return view.getFloat64(0, true);
      }
      if (bytes.length === 4) {
        return view.getFloat32(0, true);
      }
    } catch {
      // not base64 after all
    }
  }
  return Number.NaN;
}

function asNumbers(value: unknown): number[] {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return Array.from(value as ArrayLike<unknown>, attrNumber);
  }
  return [attrNumber(value)];
}

/** Bits of signed storage declared `_Unsigned = "true"` (CF), or undefined. */
function unsignedBitsOf(attrs: TAttrs, dtype: string) {
  const flag = attrs._Unsigned;
  const declared = flag === true || String(flag).toLowerCase() === "true";
  const bits = /^int(8|16|32|64)$/.exec(dtype)?.[1];
  return declared && bits ? Number(bits) : undefined;
}

/** The unsigned twin of a stored (or marker/range) value. */
function unsignedOf(value: number, bits: number | undefined) {
  return bits !== undefined && value < 0 ? value + 2 ** bits : value;
}

/** The same for exact 64-bit integers. */
function unsignedBig(value: bigint, bits: number | undefined) {
  return bits === 64 && value < 0n ? value + 2n ** 64n : value;
}

function unsignedFill(fill: number | undefined, bits: number | undefined) {
  return fill === undefined ? undefined : unsignedOf(fill, bits);
}

function wideMarkers(
  attrs: TAttrs,
  fillValue: unknown,
  fillMasks: boolean,
  bits: number | undefined
) {
  return bigIntMarkers(attrs, fillValue, fillMasks).map((m) =>
    unsignedBig(m, bits)
  );
}

function unsignedRange(
  range: { min?: bigint; max?: bigint } | undefined,
  bits: number | undefined
) {
  return (
    range && {
      min: range.min === undefined ? undefined : unsignedBig(range.min, bits),
      max: range.max === undefined ? undefined : unsignedBig(range.max, bits),
    }
  );
}

/**
 * A number as half precision stores it, rounded to nearest, ties to even
 * (Math.f16round where the runtime has it).
 */
export function f16round(value: number) {
  const native = (Math as { f16round?: (x: number) => number }).f16round;
  if (native) {
    return native(value);
  }
  if (!Number.isFinite(value) || value === 0) {
    return value;
  }
  const size = Math.abs(value);
  // Past the largest half (65504) by half a step: infinite.
  if (size >= 65520) {
    return Math.sign(value) * Infinity;
  }
  let exponent = Math.floor(Math.log2(size));
  if (2 ** exponent > size) {
    exponent--;
  } else if (2 ** (exponent + 1) <= size) {
    exponent++;
  }
  // Ten fraction bits; below 2^-14 the step of subnormals.
  const step = 2 ** (Math.max(exponent, -14) - 10);
  const steps = size / step;
  const low = Math.floor(steps);
  const over = steps - low;
  const n = over > 0.5 || (over === 0.5 && low % 2 === 1) ? low + 1 : low;
  return Math.sign(value) * n * step;
}

function storedDomain(value: number, dtype: string) {
  // A marker compares with values as stored: a float16 fill of 0.1 is
  // 0.0999755859375.
  return dtype === "float32"
    ? Math.fround(value)
    : dtype === "float16"
      ? f16round(value)
      : value;
}

function zarrFillValue(fillValue: unknown) {
  if (fillValue === null || fillValue === undefined) {
    return undefined;
  }
  if (typeof fillValue === "bigint") {
    return Number(fillValue);
  }
  const numeric = Number(fillValue);
  return Number.isFinite(numeric) ? numeric : undefined;
}

const CF_FILL_KEYS = ["_FillValue", "fillValue", "fill_value", "_fillvalue"];

function collectMarkers(
  attrs: TAttrs,
  fill: number | undefined,
  fillMasks: boolean
) {
  const markers: number[] = [];
  const parts: string[] = [];
  const cfKey = CF_FILL_KEYS.find((key) => present(attrs, key));
  if (cfKey) {
    markers.push(...asNumbers(attrs[cfKey]));
    parts.push(`${cfKey} ${String(attrs[cfKey])}`);
  }
  for (const key of ["missing_value", "missingValue"]) {
    if (present(attrs, key)) {
      markers.push(...asNumbers(attrs[key]));
      parts.push(`${key} ${String(attrs[key])}`);
    }
  }
  // Zarr v2 (as xarray reads it): the array fill value is a missing marker,
  // a zero one only when no CF fill attribute is declared (the map's rule).
  // Zarr v3 and NetCDF: it only fills storage; CF attributes mark missing.
  if (fillMasks && fill !== undefined && (fill !== 0 || !cfKey)) {
    markers.push(fill);
    parts.push(`array fill_value ${fill}`);
  }
  return { markers, parts };
}

function rangeOf(attrs: TAttrs) {
  let validMin = Number.NEGATIVE_INFINITY;
  let validMax = Number.POSITIVE_INFINITY;
  if (present(attrs, "valid_range")) {
    const [low, high] = asNumbers(attrs.valid_range);
    validMin = low;
    validMax = high;
  }
  if (present(attrs, "valid_min")) {
    validMin = attrNumber(attrs.valid_min);
  }
  if (present(attrs, "valid_max")) {
    validMax = attrNumber(attrs.valid_max);
  }
  const ranges = attrs.valid_ranges;
  const validRanges: [number, number][] = Array.isArray(ranges)
    ? (Array.isArray(ranges[0]) ? ranges : [ranges]).map((pair) => [
        attrNumber((pair as unknown[])[0]),
        attrNumber((pair as unknown[])[1]),
      ])
    : [];
  return { validMin, validMax, validRanges };
}

/**
 * Valid ranges where the data lives: in the stored precision (a Float32
 * 0.1 equals valid_max 0.1) and, for _Unsigned, unsigned.
 */
function storageRange(
  attrs: TAttrs,
  dtype: string,
  unsignedBits: number | undefined
) {
  const range = rangeOf(attrs);
  const inStorage = (value: number) =>
    Number.isFinite(value)
      ? storedDomain(unsignedOf(value, unsignedBits), dtype)
      : value;
  return {
    validMin: inStorage(range.validMin),
    validMax: inStorage(range.validMax),
    validRanges: range.validRanges.map(
      ([low, high]) => [inStorage(low), inStorage(high)] as [number, number]
    ),
  };
}

/**
 * NetCDF's rule for a `_FillValue` without any valid range: a positive fill is
 * a valid maximum, any other a valid minimum, one step inside it (an integer:
 * 1; a float: two units in the last place of its type), so values beyond the
 * fill are not data. Unidata's attribute conventions.
 */
function fillImpliedRange(
  attrs: TAttrs,
  dtype: string,
  declared: ReturnType<typeof storageRange>,
  /** NetCDF's default fill of the type, when no `_FillValue` is declared. */
  defaultFill?: number,
  unsignedBits?: number
) {
  // Without `_FillValue`, the type's default fill limits the same way (bytes
  // have none): a float32 value of 1e37 is not data. In the domain the data are
  // compared in: `_Unsigned` shorts with fill −2 have the fill 65534, a valid
  // maximum. A default fill read as unsigned limits nothing: unwritten cells
  // hold the signed type's pattern (a marker, matched exactly), and its place
  // among unsigned values says nothing of the valid ones.
  const explicit = present(attrs, "_FillValue");
  if (!explicit && unsignedBits !== undefined) {
    return declared;
  }
  const fill = unsignedOf(
    explicit
      ? attrNumber(asNumbers(attrs._FillValue)[0])
      : (defaultFill ?? Number.NaN),
    unsignedBits
  );
  if (declaresRange(attrs) || !Number.isFinite(fill) || /int64/.test(dtype)) {
    return declared;
  }
  const float = /float/.test(dtype);
  const step = (x: number, toward: number) =>
    float ? nextFloat(x, toward, dtype) : x + Math.sign(toward - x);
  const inward = (x: number, toward: number) =>
    float ? step(step(x, toward), toward) : step(x, toward);
  return fill > 0
    ? { ...declared, validMax: inward(storedDomain(fill, dtype), -Infinity) }
    : { ...declared, validMin: inward(storedDomain(fill, dtype), Infinity) };
}

/**
 * The next value of the stored float type after `x` towards `toward`, through
 * zero by the smallest subnormal of the other sign, from either zero.
 */
function nextFloat(x: number, toward: number, dtype: string) {
  if (Number.isNaN(x) || x === toward) {
    return x;
  }
  const single = dtype === "float32";
  if (x === 0) {
    const tiny = single ? 2 ** -149 : Number.MIN_VALUE;
    return toward > 0 ? tiny : -tiny;
  }
  const view = single ? new Float32Array(1) : new Float64Array(1);
  const bits = single
    ? new Int32Array(view.buffer)
    : new BigInt64Array(view.buffer);
  view[0] = x;
  // The bits count the magnitude: away from zero is one more.
  const away = toward > x === x > 0;
  if (bits instanceof Int32Array) {
    bits[0] += away ? 1 : -1;
  } else {
    bits[0] += away ? 1n : -1n;
  }
  return view[0];
}

function declaresRange(attrs: TAttrs) {
  return ["valid_range", "valid_min", "valid_max", "valid_ranges"].some((key) =>
    present(attrs, key)
  );
}

/**
 * The fill rule for 64-bit integers, exactly: one step inside an explicit or
 * default fill, compared as stored integers.
 */
function bigFillRange(
  attrs: TAttrs,
  defaultFill: bigint | undefined,
  unsignedBits?: number
) {
  if (declaresRange(attrs)) {
    return undefined;
  }
  const declared = present(attrs, "_FillValue")
    ? bigIntOf(
        ArrayBuffer.isView(attrs._FillValue) || Array.isArray(attrs._FillValue)
          ? (attrs._FillValue as ArrayLike<unknown>)[0]
          : attrs._FillValue
      )
    : undefined;
  // In the domain stored values are compared in (`_Unsigned` included). A
  // default of signed storage read as `_Unsigned` is no default of the unsigned
  // type: it masks its own value only.
  const either = declared ?? (unsignedBits ? undefined : defaultFill);
  const fill =
    either === undefined ? undefined : unsignedBig(either, unsignedBits);
  if (fill === undefined) {
    return undefined;
  }
  return fill > 0n ? { max: fill - 1n } : { min: fill + 1n };
}

/** The plain-language decoding rule recorded with every result. */
function ruleText(
  unsignedBits: number | undefined,
  parts: string[],
  validMin: number,
  validMax: number,
  scale: number,
  offset: number,
  /** The coefficients as published, when exact integers wider than 2^53. */
  exact: { bigScale?: bigint; bigOffset?: bigint } = {}
) {
  return [
    unsignedBits
      ? `stored int${unsignedBits} read as unsigned (_Unsigned)`
      : "",
    parts.length ? `missing where stored value is ${parts.join(" or ")}` : "",
    "NaN is missing",
    "chunks never written read as the array fill value",
    Number.isFinite(validMin) || Number.isFinite(validMax)
      ? `valid stored range [${validMin}, ${validMax}]`
      : "",
    scale !== 1 || offset !== 0
      ? `value = stored * ${exact.bigScale ?? scale} + ${exact.bigOffset ?? offset}`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * NetCDF's default fill per type: what a file without `_FillValue` holds where
 * nothing was written. Read as missing, as netCDF4-python does, except for
 * bytes, whose default is an ordinary value.
 */
const NETCDF_DEFAULT_FILL: Record<string, number> = {
  int16: -32767,
  uint16: 65535,
  int32: -2147483647,
  uint32: 4294967295,
  float32: 9.969209968386869e36,
  float64: 9.969209968386869e36,
};
/**
 * The 64-bit defaults, exact (NC_FILL_INT64, NC_FILL_UINT64): beyond 2^53 they
 * are compared as stored integers, before any conversion to a Number.
 */
const NETCDF_DEFAULT_FILL_64: Record<string, bigint> = {
  int64: -9223372036854775806n,
  uint64: 18446744073709551614n,
};

/** Zarr format: 2, 3, -1 (Icechunk, v3) or -2 (NetCDF); unknown counts as 2. */
// eslint-disable-next-line max-lines-per-function
export function buildValueCodec(
  attrs: TAttrs,
  fillValue: unknown,
  dtype: string,
  format: number = 2
): TValueCodec {
  const unsignedBits = unsignedBitsOf(attrs, dtype);
  const fill = unsignedFill(zarrFillValue(fillValue), unsignedBits);
  const { markers, parts } = collectMarkers(attrs, fill, format === 2);
  const noFill =
    format === -2 &&
    !present(attrs, "_FillValue") &&
    (fillValue === null || fillValue === undefined);
  const netcdfDefault = noFill ? NETCDF_DEFAULT_FILL[dtype] : undefined;
  if (netcdfDefault !== undefined) {
    // In the domain stored values are compared in, as the 64-bit one.
    markers.push(unsignedOf(netcdfDefault, unsignedBits));
    parts.push(
      `${netcdfDefault} (NetCDF's default fill: no _FillValue declared)`
    );
  }
  const wide = /int64/.test(dtype);
  const bigMarkers = wide
    ? wideMarkers(attrs, fillValue, format === 2, unsignedBits)
    : [];
  const default64 = noFill ? NETCDF_DEFAULT_FILL_64[dtype] : undefined;
  if (default64 !== undefined) {
    // In the domain the stored values are compared in: `_Unsigned` storage
    // reads them as unsigned, its default marker too.
    bigMarkers.push(unsignedBig(default64, unsignedBits));
    parts.push(`${default64} (NetCDF's default fill: no _FillValue declared)`);
  }
  const scale = present(attrs, "scale_factor") ? Number(attrs.scale_factor) : 1;
  const offset = present(attrs, "add_offset") ? Number(attrs.add_offset) : 0;
  const declared = storageRange(attrs, dtype, unsignedBits);
  const { validMin, validMax, validRanges } =
    format === -2
      ? fillImpliedRange(attrs, dtype, declared, netcdfDefault, unsignedBits)
      : declared;
  const packing = wide ? exactPacking(attrs) : {};
  const rule = ruleText(
    unsignedBits,
    parts,
    validMin,
    validMax,
    scale,
    offset,
    packing
  );
  const codec: TValueCodec = {
    scale,
    offset,
    markers: markers.map((marker) =>
      storedDomain(unsignedOf(marker, unsignedBits), dtype)
    ),
    validMin,
    validMax,
    validRanges,
    absentValue: Number.NaN,
    bigMarkers,
    ...(wide
      ? {
          bigRange:
            unsignedRange(bigRangeOf(attrs), unsignedBits) ??
            (format === -2
              ? bigFillRange(attrs, default64, unsignedBits)
              : undefined),
        }
      : {}),
    ...(wide ? bigRangesOf(attrs, unsignedBits) : {}),
    ...packing,
    categorical:
      present(attrs, "flag_values") || present(attrs, "flag_meanings"),
    ...(unsignedBits ? { unsignedBits } : {}),
    rule,
  };
  // Zarr: an unwritten chunk holds the fill value; it is then a missing
  // value only where the format or CF attributes say so.
  // A 64-bit logical fill goes through the same exact markers and range as
  // stored data, before any conversion to Number.
  const bigFill = wide ? bigIntOf(fillValue) : undefined;
  codec.absentValue =
    bigFill !== undefined
      ? decodeStoredBigInt(codec, bigFill)
      : fill === undefined
        ? Number.NaN
        : decodeStoredValue(codec, storedDomain(fill, dtype));
  return codec;
}

/** `scale_factor` and `add_offset` kept exact when given as 64-bit integers. */
function exactPacking(attrs: TAttrs) {
  const exact = (key: string) => {
    const value = attrs[key];
    const one = ArrayBuffer.isView(value)
      ? (value as unknown as ArrayLike<unknown>)[0]
      : value;
    return typeof one === "bigint" ||
      (typeof one === "string" && /^-?\d+$/.test(one))
      ? bigIntOf(one)
      : undefined;
  };
  const [bigScale, bigOffset] = [exact("scale_factor"), exact("add_offset")];
  return {
    ...(bigScale !== undefined ? { bigScale } : {}),
    ...(bigOffset !== undefined ? { bigOffset } : {}),
  };
}

function bigIntOf(value: unknown) {
  try {
    return typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isInteger(value)
        ? BigInt(value)
        : typeof value === "string" && /^-?\d+$/.test(value)
          ? BigInt(value)
          : undefined;
  } catch {
    return undefined;
  }
}

/** Exact 64-bit markers: adjacent int64 values differ only before Number. */
function bigIntMarkers(attrs: TAttrs, fillValue: unknown, fillMasks: boolean) {
  const out: bigint[] = [];
  const cfKey = CF_FILL_KEYS.find((key) => present(attrs, key));
  const candidates = [
    ...(cfKey ? [attrs[cfKey]] : []),
    ...(present(attrs, "missing_value")
      ? Array.isArray(attrs.missing_value)
        ? attrs.missing_value
        : [attrs.missing_value]
      : []),
    // The same rule as other types: a zero storage fill beside a CF fill
    // attribute only fills storage (a written zero stays zero).
    ...(fillMasks &&
    fillValue !== null &&
    fillValue !== undefined &&
    (bigIntOf(fillValue) !== 0n || !cfKey)
      ? [fillValue]
      : []),
  ];
  for (const candidate of candidates) {
    const value = bigIntOf(candidate);
    if (value !== undefined) {
      out.push(value);
    }
  }
  return out;
}

/** valid_min/valid_max/valid_range of 64-bit data, as exact integers. */
/** `valid_ranges` as exact stored integers, when every bound is one. */
function bigRangesOf(attrs: TAttrs, unsignedBits?: number) {
  const ranges = attrs.valid_ranges;
  if (!Array.isArray(ranges)) {
    return {};
  }
  const pairs = (Array.isArray(ranges[0]) ? ranges : [ranges]).map((pair) =>
    [(pair as unknown[])[0], (pair as unknown[])[1]].map((bound) => {
      const big = bigIntOf(bound);
      return big === undefined ? undefined : unsignedBig(big, unsignedBits);
    })
  );
  return pairs.every((pair) => pair.every((bound) => bound !== undefined))
    ? { bigRanges: pairs as [bigint, bigint][] }
    : {};
}

function bigRangeOf(attrs: TAttrs) {
  const range = Array.isArray(attrs.valid_range) ? attrs.valid_range : [];
  const min = bigIntOf(
    present(attrs, "valid_min") ? attrs.valid_min : range[0]
  );
  const max = bigIntOf(
    present(attrs, "valid_max") ? attrs.valid_max : range[1]
  );
  return min === undefined && max === undefined ? undefined : { min, max };
}

/**
 * Decoded value of a 64-bit integer. Markers and the valid range are
 * compared exactly before conversion; disjoint `valid_ranges` always apply;
 * an integer scale and offset are applied exactly (2^53 + 1 with offset
 * −2^53 is 1, not 0).
 */
export function decodeStoredBigInt(codec: TValueCodec, raw: bigint) {
  const stored = unsignedBig(raw, codec.unsignedBits);
  for (const marker of codec.bigMarkers) {
    if (stored === marker) {
      return Number.NaN;
    }
  }
  const range = codec.bigRange;
  if (
    range &&
    ((range.min !== undefined && stored < range.min) ||
      (range.max !== undefined && stored > range.max))
  ) {
    return Number.NaN;
  }
  const value = Number(stored);
  // Number markers only when no exact ones were given; the range only when it
  // was not compared exactly above (Number may round onto its bounds).
  if (!codec.bigMarkers.length && codec.markers.includes(value)) {
    return Number.NaN;
  }
  if (!range && (value < codec.validMin || value > codec.validMax)) {
    return Number.NaN;
  }
  if (codec.validRanges.length) {
    // Exactly, in the stored integers: 2^53 + 1 is not in [2^53, 2^53].
    const exact = codec.bigRanges;
    const inside = exact
      ? exact.some(([low, high]) => stored >= low && stored <= high)
      : codec.validRanges.some(([low, high]) => value >= low && value <= high);
    if (!inside) {
      return Number.NaN;
    }
  }
  return unpackWide(codec, stored, value);
}

/** A codec's scale and offset as one exact fraction: (s, o) / 2^shift. */
type TExactPacking = { scale: bigint; offset: bigint; shift: number };

const exactPackings = new WeakMap<TValueCodec, TExactPacking | null>();

/** Worked out once per codec. */
function exactPackingOf(codec: TValueCodec) {
  let packing = exactPackings.get(codec);
  if (packing === undefined) {
    const finite =
      Number.isFinite(codec.scale) && Number.isFinite(codec.offset);
    if (finite) {
      const [s, ss] =
        codec.bigScale !== undefined
          ? [codec.bigScale, 0]
          : dyadic(codec.scale);
      const [o, os] =
        codec.bigOffset !== undefined
          ? [codec.bigOffset, 0]
          : dyadic(codec.offset);
      const shift = Math.max(ss, os);
      packing = {
        scale: s << BigInt(shift - ss),
        offset: o << BigInt(shift - os),
        shift,
      };
    } else {
      packing = null;
    }
    exactPackings.set(codec, packing);
  }
  return packing;
}

/**
 * A 64-bit stored integer unpacked. Binary64 arithmetic where it rounds once or
 * the sum cannot cancel (as NetCDF readers do); otherwise exactly, rounded
 * once: beyond 2^53, under cancellation (2^52 + 1 at scale 2.5 beside its
 * offset is 2.5, not 2), and for subnormal or very large results.
 */
function unpackWide(codec: TValueCodec, stored: bigint, value: number) {
  if (
    Number.isSafeInteger(value) &&
    codec.bigScale === undefined &&
    codec.bigOffset === undefined
  ) {
    const product = value * codec.scale;
    if (codec.offset === 0) {
      return Number.isFinite(product) ? product : Number.NaN;
    }
    const sum = product + codec.offset;
    if (
      Math.abs(product) <= 2 ** 53 &&
      Math.abs(sum) >= Math.abs(product) &&
      Number.isFinite(sum)
    ) {
      return sum;
    }
  }
  const packing = exactPackingOf(codec);
  if (!packing) {
    return scaled(codec, value);
  }
  const exact = nearestOf(
    stored * packing.scale + packing.offset,
    packing.shift
  );
  return Number.isFinite(exact) ? exact : Number.NaN;
}

/** A finite number as an exact fraction: integer / 2^shift. */
function dyadic(x: number): [bigint, number] {
  let shift = 0;
  let y = x;
  // Doubling a fraction is exact and cannot overflow (|y| < 2^52).
  while (!Number.isInteger(y)) {
    y *= 2;
    shift++;
  }
  return [BigInt(y), shift];
}

/** x · 2^n, in steps that stay within binary64's exponent range. */
function timesPow2(x: number, n: number) {
  let y = x;
  let rest = n;
  while (rest > 1000) {
    y *= 2 ** 1000;
    rest -= 1000;
  }
  while (rest < -1000) {
    y *= 2 ** -1000;
    rest += 1000;
  }
  return y * 2 ** rest;
}

/** The binary64 nearest to num / 2^shift (ties to even), rounded once. */
function nearestOf(num: bigint, shift: number): number {
  if (num === 0n) {
    return 0;
  }
  // Usually: Number rounds once, and scaling a normal result is exact.
  const once = Number(num);
  if (Number.isFinite(once)) {
    const value = timesPow2(once, -shift);
    if (Number.isFinite(value) && Math.abs(value) >= 2 ** -1022) {
      return value;
    }
  }
  const negative = num < 0n;
  const magnitude = negative ? -num : num;
  const exponent = magnitude.toString(2).length - 1 - shift;
  if (exponent > 1023) {
    return negative ? -Infinity : Infinity;
  }
  // The last kept bit: 53 significant bits, or the subnormal grid.
  const unit = Math.max(exponent - 52, -1074);
  const drop = shift + unit;
  let q: bigint;
  if (drop <= 0) {
    q = magnitude << BigInt(-drop);
  } else {
    const d = BigInt(drop);
    q = magnitude >> d;
    const rest = magnitude - (q << d);
    const half = 1n << (d - 1n);
    if (rest > half || (rest === half && (q & 1n) === 1n)) {
      q += 1n;
    }
  }
  const value = timesPow2(Number(q), unit);
  return negative ? -value : value;
}

/** Unpacked value; one that overflows (1e308 × 2) is missing, not ±∞. */
function scaled(codec: TValueCodec, stored: number) {
  const value = stored * codec.scale + codec.offset;
  return Number.isFinite(value) ? value : Number.NaN;
}

/** Decoded value of one stored value, or NaN when it is missing. */
export function decodeStoredValue(codec: TValueCodec, raw: number) {
  if (Number.isNaN(raw)) {
    return Number.NaN;
  }
  const stored =
    codec.unsignedBits !== undefined && raw < 0
      ? raw + 2 ** codec.unsignedBits
      : raw;
  const { markers } = codec;
  for (let at = 0; at < markers.length; at++) {
    if (stored === markers[at]) {
      return Number.NaN;
    }
  }
  if (stored < codec.validMin || stored > codec.validMax) {
    return Number.NaN;
  }
  if (codec.validRanges.length > 0) {
    let inside = false;
    for (const [low, high] of codec.validRanges) {
      if (stored >= low && stored <= high) {
        inside = true;
        break;
      }
    }
    if (!inside) {
      return Number.NaN;
    }
  }
  if (!Number.isFinite(stored)) {
    return Number.NaN;
  }
  return scaled(codec, stored);
}
