/**
 * Exact HEALPix cell-id arithmetic. Ids are BigInt throughout: JavaScript
 * bitwise operators truncate to 32 bits, order-17 ids exceed 2^31, and
 * order-29 ids (and `zuniq` or level-29 range endpoints) exceed 2^53.
 */

export const HEALPIX_MAX_ORDER = 29;

/** A sorted, disjoint list of half-open id ranges at one order. */
export type TIdRange = [start: bigint, end: bigint];

function assertOrder(order: number) {
  if (!Number.isInteger(order) || order < 0 || order > HEALPIX_MAX_ORDER) {
    throw new Error(`HEALPix order must be an integer in 0..29, not ${order}.`);
  }
}

export function healpixCellCount(order: number) {
  assertOrder(order);
  return 12n << BigInt(2 * order);
}

/** Convert an id or count to a Number, refusing values that would round. */
export function toSafeNumber(value: bigint, what = "value") {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new Error(`The ${what} ${value} exceeds the exact Number range.`);
  }
  return Number(value);
}

/** Parse a stored or serialized id without rounding it. */
export function parseCellId(value: number | bigint | string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Cell id ${value} is not an exact integer.`);
    }
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value.trim())) {
    throw new Error(`Cell id "${value}" is not a decimal integer.`);
  }
  return BigInt(value.trim());
}

/** All cells at `toOrder` inside cell `id` of `fromOrder`. */
export function childRange(
  id: bigint,
  fromOrder: number,
  toOrder: number
): TIdRange {
  if (toOrder < fromOrder) {
    throw new Error("Child order must not be coarser than the parent order.");
  }
  const shift = BigInt(2 * (toOrder - fromOrder));
  return [id << shift, (id + 1n) << shift];
}

/**
 * The order and nested id of a `zuniq` id: `(2 * ipix + 1)` shifted left so
 * its lowest set bit sits at `2 * (29 - order)`.
 */
export function decodeZuniq(id: bigint) {
  if (id <= 0n) {
    throw new Error(`Not a zuniq cell id: ${id}`);
  }
  let trailing = 0n;
  while (((id >> trailing) & 1n) === 0n) {
    trailing++;
  }
  if (trailing % 2n !== 0n) {
    throw new Error(`Not a zuniq cell id: ${id}`);
  }
  return {
    order: HEALPIX_MAX_ORDER - Number(trailing / 2n),
    ipix: id >> (trailing + 1n),
  };
}

export function encodeZuniq(order: number, ipix: bigint) {
  return ((ipix << 1n) | 1n) << BigInt(2 * (HEALPIX_MAX_ORDER - order));
}

/** Sort and merge ranges, joining touching neighbours. */
export function mergeIdRanges(ranges: TIdRange[]): TIdRange[] {
  const sorted = ranges
    .filter(([start, end]) => end > start)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const merged: TIdRange[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) {
        last[1] = end;
      }
      continue;
    }
    merged.push([start, end]);
  }
  return merged;
}

export function idRangeCellCount(ranges: TIdRange[]) {
  let total = 0n;
  for (const [start, end] of ranges) {
    total += end - start;
  }
  return total;
}

export function idRangesContain(ranges: TIdRange[], id: bigint) {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ranges[mid][1] <= id) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo < ranges.length && ranges[lo][0] <= id;
}
