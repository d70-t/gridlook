/** Member and other identifiers as numbers, where they are written as such. */

/** A number written as one ("12", "-3", "0.5"; not "001", "1.0", "1e0"). */
export function canonicalNumber(text: string | undefined): text is string {
  if (text === undefined || text.trim() !== text || text === "") {
    return false;
  }
  if (/^-?\d+$/.test(text)) {
    return String(BigInt(text)) === text;
  }
  const value = Number(text);
  return Number.isFinite(value) && String(value) === text;
}

/**
 * How a dimension's identifiers are written, one way for all of them, each
 * exactly and each distinct: as signed or unsigned 64-bit integers, as float64
 * numbers, or as text. Text when no one number type holds them all.
 */
export type TIdEncoding = "i8" | "u8" | "f8" | "text";

const encodings = new WeakMap<(string | undefined)[], TIdEncoding>();
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

/**
 * By the source's stored type, so every partition of one publication is written
 * alike: text stays text, signed integers int64, unsigned uint64, floats
 * float64. A type that cannot hold them all exactly and distinctly (packed
 * values, duplicates) is text. Missing identifiers (undefined) are left out.
 */
export function idEncoding(
  ids: (string | undefined)[],
  /** The source's stored type: `int32`, `uint64`, `float64`, `string`… */
  idType = ""
): TIdEncoding {
  let known = encodings.get(ids);
  if (known === undefined) {
    known = encodingOf(
      ids.filter((id): id is string => id !== undefined),
      idType
    );
    encodings.set(ids, known);
  }
  return known;
}

function encodingOf(ids: string[], idType: string): TIdEncoding {
  const type = idType.replace(/^v[23]:/i, "").toLowerCase();
  const integer = /^u?int\d+$/.test(type);
  const float = /^float\d+$/.test(type);
  // A stored type unknown (an older result): by the values, as before.
  if (!integer && !float && type !== "") {
    return "text";
  }
  if (!ids.every(canonicalNumber)) {
    return "text";
  }
  if (ids.every((id) => /^-?\d+$/.test(id))) {
    const values = ids.map((id) => BigInt(id));
    if (new Set(values).size !== values.length) {
      return "text";
    }
    const unsigned = /^u/.test(type);
    if (
      unsigned ||
      (!integer &&
        !values.some((v) => v < 0n) &&
        values.some((v) => v > INT64_MAX))
    ) {
      return values.every((v) => v >= 0n && v <= UINT64_MAX) ? "u8" : "text";
    }
    if (integer || !float) {
      return values.every((v) => v >= -INT64_MAX - 1n && v <= INT64_MAX)
        ? "i8"
        : "text";
    }
  }
  const numbers = ids.map(Number);
  return new Set(numbers).size === numbers.length &&
    numbers.every((n, k) => String(n) === ids[k])
    ? "f8"
    : "text";
}
