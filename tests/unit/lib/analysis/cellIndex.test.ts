import { describe, expect, it } from "vitest";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import {
  compactedRuns,
  createDenseIndex,
  createMappedIndex,
  createRunsIndex,
  createSortedIndex,
  createValidatedIndex,
  INDEX_VALIDATION,
  rangeRuns,
} from "@/lib/analysis/cellIndex.ts";
import {
  childRange,
  decodeZuniq,
  encodeZuniq,
  healpixCellCount,
  mergeIdRanges,
  parseCellId,
  toSafeNumber,
} from "@/lib/analysis/healpixIds.ts";

const ORDER = 17;
// Stored cells straddle 2^31 and 2^32, beyond 32-bit bitwise arithmetic.
const STORED: bigint[] = [];
for (const base of [2n ** 31n - 3n, 2n ** 32n - 2n, 10_000_000_000n]) {
  for (let k = 0n; k < 6n; k++) {
    STORED.push(base + k);
  }
}

function value(id: bigint) {
  return Number(id % 97n);
}

function sortedReader(ids: bigint[], chunkLength: number) {
  let reads = 0;
  return {
    reader: {
      length: ids.length,
      chunkLength,
      async readChunk(chunk: number) {
        reads++;
        return ids.slice(chunk * chunkLength, (chunk + 1) * chunkLength);
      },
    },
    reads: () => reads,
  };
}

async function valuesVia(
  index: Awaited<ReturnType<typeof createDenseIndex>>,
  data: (position: number) => number,
  query: bigint[]
) {
  const positions = await index.positionsOf(query);
  return positions.map((position) => (position < 0 ? NaN : data(position)));
}

describe("HEALPix id arithmetic", () => {
  it("keeps ids above 2^31, 2^32 and 2^53 exact", () => {
    expect(healpixCellCount(17)).toBe(206158430208n);
    expect(healpixCellCount(29)).toBe(3458764513820540928n);
    expect(childRange(2n ** 31n, 16, 17)).toEqual([2n ** 33n, 2n ** 33n + 4n]);
    expect(parseCellId("3458764513820540927")).toBe(3458764513820540927n);
    expect(() => toSafeNumber(2n ** 53n + 1n)).toThrow(/exact Number range/);
    expect(() => parseCellId(2 ** 53 + 2)).toThrow(/not an exact integer/);
  });

  it("round-trips zuniq ids, including level-29 cells beyond 2^53", () => {
    const ipix = 3458764513820540000n;
    expect(decodeZuniq(encodeZuniq(29, ipix))).toEqual({ order: 29, ipix });
    expect(decodeZuniq(encodeZuniq(3, 700n))).toEqual({ order: 3, ipix: 700n });
  });

  it("merges touching and overlapping ranges", () => {
    expect(
      mergeIdRanges([
        [5n, 7n],
        [0n, 2n],
        [2n, 3n],
        [6n, 9n],
      ])
    ).toEqual([
      [0n, 3n],
      [5n, 9n],
    ]);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("cell indices resolve the same known values", () => {
  const query = [...STORED, 2n ** 31n - 4n, 2n ** 32n + 4n, 5n];
  const expected = query.map((id) => (STORED.includes(id) ? value(id) : NaN));

  it("dense: position is the cell id", async () => {
    const dense = createDenseIndex(ORDER, Number(healpixCellCount(ORDER)));
    const got = await valuesVia(dense, (p) => p % 97, query);
    expect(got.slice(0, STORED.length)).toEqual(STORED.map(value));
    expect(() => createDenseIndex(ORDER, 1000)).toThrow(/dense order-17 level/);
  });

  it("sorted packed: lazy chunked lower bound with fences", async () => {
    const { reader, reads } = sortedReader(STORED, 4);
    const index = createSortedIndex(
      reader,
      new ByteLru(1 << 20),
      "k",
      INDEX_VALIDATION.ACCESSED
    );
    expect(await valuesVia(index, (p) => value(STORED[p]), query)).toEqual(
      expected
    );
    // 5 chunks: a cold lookup reads at most log2(5)+1 chunks; repeats hit the cache.
    expect(reads()).toBeLessThanOrEqual(5);
  });

  it("compacted zuniq runs and level-29 ranges", async () => {
    // Runs [2^31-3, 2^31+3), [2^32-2, 2^32+4), [1e10, 1e10+6) as ranges at order 29.
    const shift = 2n * (29n - BigInt(ORDER));
    const bounds: bigint[] = [];
    for (let at = 0; at < STORED.length; at += 6) {
      bounds.push(STORED[at] << shift, (STORED[at] + 6n) << shift);
    }
    expect(bounds[5]).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    const ranges = createRunsIndex(rangeRuns(ORDER, bounds));
    expect(await valuesVia(ranges, (p) => value(STORED[p]), query)).toEqual(
      expected
    );
    const zuniq = STORED.map((id) => encodeZuniq(ORDER, id));
    const compacted = createRunsIndex(compactedRuns(ORDER, zuniq));
    expect(await valuesVia(compacted, (p) => value(STORED[p]), query)).toEqual(
      expected
    );
    const spans = await compacted.spansOf([[2n ** 32n, 2n ** 32n + 100n]]);
    expect(spans).toEqual({ spans: [[8, 12]], stored: 4 });
  });

  it("unsorted small coordinates are mapped; duplicates and disorder are refused", async () => {
    const shuffled = [...STORED].reverse();
    const mapped = createMappedIndex(shuffled);
    expect(await valuesVia(mapped, (p) => value(shuffled[p]), query)).toEqual(
      expected
    );
    expect(() => createMappedIndex([1n, 2n, 1n])).toThrow(/repeats/);
    const { reader } = sortedReader([5n, 6n, 7n, 1n, 2n, 3n], 3);
    const index = createSortedIndex(
      reader,
      new ByteLru(1 << 20),
      "x",
      INDEX_VALIDATION.ACCESSED
    );
    await expect(index.positionsOf([2n, 6n])).rejects.toThrow(
      /out of order|ascending/
    );
  });
});

describe("resident validated index", () => {
  it("finds exact ids and ranges without decoding chunks on repeated queries", async () => {
    const base = 2n ** 54n;
    const index = createValidatedIndex(
      BigInt64Array.from([base, base + 2n, base + 5n, base + 9n])
    );
    for (let n = 0; n < 3; n++) {
      expect(await index.positionsOf([base + 9n, base + 1n, base])).toEqual([
        3, -1, 0,
      ]);
      expect(await index.spansOf([[base + 1n, base + 9n]])).toEqual({
        spans: [[1, 3]],
        stored: 2,
      });
    }
    expect(index.counters.chunkReads).toBe(0);
  });
});

// eslint-disable-next-line max-lines-per-function -- three related cases.
describe("v15 review: packed index costs", () => {
  it("validates 8,192 declared-sorted chunks with a few fence checks each", async () => {
    // Exact ids above 2^32: 2^40 + 3k, 64 per chunk, one target per chunk.
    const chunks = 8192;
    const ids = Array.from(
      { length: chunks * 64 },
      (_, k) => 2n ** 40n + 3n * BigInt(k)
    );
    const { reader } = sortedReader(ids, 64);
    const index = createSortedIndex(
      reader,
      new ByteLru(1 << 30),
      "fences",
      INDEX_VALIDATION.DECLARED
    );
    const targets = Array.from({ length: chunks }, (_, c) => ids[c * 64 + 7]);
    const positions = await index.positionsOf(targets);
    expect(positions).toEqual(targets.map((_, c) => c * 64 + 7));
    expect(index.counters.fenceChecks).toBeLessThanOrEqual(3 * chunks);
  });

  it("still refuses chunks out of order and a chunk that changed on re-read", async () => {
    // Chunk 2 holds ids below chunk 0's: found once a search reads it.
    const { reader } = sortedReader([10n, 11n, 20n, 21n, 1n, 2n], 2);
    const index = createSortedIndex(
      reader,
      new ByteLru(1 << 20),
      "order",
      INDEX_VALIDATION.DECLARED
    );
    await expect(index.positionsOf([10n, 21n, 22n])).rejects.toThrow(
      /out of order/
    );
    let zeroReads = 0;
    const changing = {
      length: 4,
      chunkLength: 2,
      async readChunk(chunk: number) {
        if (chunk === 0) {
          zeroReads++;

          return zeroReads <= 1 ? [0n, 1n] : [0n, 9n];
        }
        return [10n, 11n];
      },
    };
    // No cache: a query reads chunk 0 once (kept for its own lookups); the
    // next query reads it again, and that read differs.
    const index2 = createSortedIndex(
      changing as never,
      new ByteLru(0),
      "changing",
      INDEX_VALIDATION.DECLARED
    );
    expect(await index2.positionsOf([1n])).toEqual([1]);
    await expect(index2.positionsOf([1n])).rejects.toThrow(/changed/);
  });

  it("maps a million unsorted ids into merged spans", async () => {
    const n = 1_000_000;
    // Stored in reverse order: unsorted, yet every id range is one
    // contiguous storage interval.
    const ids = new BigInt64Array(n);
    for (let at = 0; at < n; at++) {
      ids[at] = BigInt(n - 1 - at) * 4n + 2n ** 33n;
    }
    const index = createMappedIndex(ids);
    expect(await index.spansOf([[0n, 2n ** 40n]])).toEqual({
      spans: [[0, n]],
      stored: n,
    });
    // Ids of positions 100..199: one span, not 100.
    const lo = ids[199];
    const hi = ids[100] + 1n;
    expect(await index.spansOf([[lo, hi]])).toEqual({
      spans: [[100, 200]],
      stored: 100,
    });
    expect(await index.positionsOf([ids[12345], ids[12345] + 1n])).toEqual([
      12345, -1,
    ]);
  });
});

describe("v20 review: an index chunk just over the cache", () => {
  it("reads it once for nearby ids of one query, declared or validated", async () => {
    // 64 ids per chunk, 8 bytes each: 512 B; the cache holds 504 B.
    const ids = Array.from(
      { length: 64 * 8 },
      (_, k) => 2n ** 40n + 2n * BigInt(k)
    );
    for (const validation of [
      INDEX_VALIDATION.DECLARED,
      INDEX_VALIDATION.ACCESSED,
    ]) {
      const { reader, reads } = sortedReader(ids, 64);
      const index = createSortedIndex(
        reader,
        new ByteLru(504),
        `over-${validation}`,
        validation
      );
      const before = reads();
      const near = [ids[200], ids[201], ids[202]];
      expect(await index.positionsOf(near)).toEqual([200, 201, 202]);
      const touched = reads() - before;
      // Without the pin each lookup re-read its chunk (7 reads for 3 ids).
      // The first id's search (log2(8) + 1 chunks at most), then none.
      expect(touched, validation).toBeLessThanOrEqual(Math.log2(8) + 1);
      const spans = await index.spansOf([[ids[200], ids[205] + 1n]]);
      expect(spans.stored).toBe(6);
    }
  });
});

describe("v24 review: lookups grouped by chunk", () => {
  it("ids alternating between two chunks read each chunk once, positions in order", async () => {
    // Two chunks of 1,000 ids; a cache too small to hold either.
    const ids = Array.from({ length: 2000 }, (_, k) => BigInt(k * 3));
    const { reader, reads } = sortedReader(ids, 1000);
    const index = createSortedIndex(
      reader,
      new ByteLru<BigInt64Array>(16),
      `alternating-${Math.random()}`,
      INDEX_VALIDATION.ACCESSED
    );
    const query = Array.from({ length: 32 }, (_, k) =>
      BigInt((k % 2 ? 1000 + k : k) * 3)
    );
    const positions = await index.positionsOf(query);
    expect(positions).toEqual(
      Array.from({ length: 32 }, (_, k) => (k % 2 ? 1000 + k : k))
    );
    expect(reads()).toBeLessThanOrEqual(3);
  });
});
