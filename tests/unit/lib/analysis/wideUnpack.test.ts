/* eslint-disable camelcase, max-lines-per-function -- CF attribute names; one describe of decoder checks. */
import { describe, expect, it } from "vitest";

import {
  buildValueCodec,
  decodeStoredBigInt,
} from "@/lib/analysis/valueDecoding.ts";

/** The binary64 nearest to stored · scale + offset, by exact rationals. */
function oracle(stored: bigint, scale: number, offset: number) {
  const frac = (x: number): [bigint, bigint] => {
    if (!Number.isFinite(x)) {
      throw new Error(`not finite: ${x}`);
    }
    let y = x;
    let den = 1n;
    while (!Number.isInteger(y)) {
      y *= 2;
      den *= 2n;
    }
    return [BigInt(y), den];
  };
  const [sn, sd] = frac(scale);
  const [on, od] = frac(offset);
  const num = stored * sn * od + on * sd;
  const den = sd * od;
  // Nearest double by bisection over the two candidates around Number. First
  // guess within an ulp: the quotient scaled into range by bigints.
  const bits = (x: bigint) => (x < 0n ? -x : x).toString(2).length;
  const k = bits(den) - bits(num) + 64;
  const q = k >= 0 ? (num << BigInt(k)) / den : num / (den << BigInt(-k));
  let guess = Number(q);
  for (let rest = -k; rest !== 0;) {
    const step = Math.max(-1000, Math.min(1000, rest));
    guess *= 2 ** step;
    rest -= step;
  }
  const candidates = [guess, ...[-1, 1].map((d) => nextAfter(guess, d))];
  const error = (x: number) => {
    const [xn, xd] = frac(x);
    const diff = xn * den - num * xd;
    return diff < 0n ? -diff : diff;
  };
  const scaleOf = (x: number) => frac(x)[1];
  return candidates.reduce((best, x) =>
    error(x) * scaleOf(best) < error(best) * scaleOf(x) ? x : best
  );
}

function nextAfter(x: number, direction: number) {
  if (x === 0) {
    return direction * Number.MIN_VALUE;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigInt64(0);
  view.setBigInt64(0, bits + (x >= 0 === direction > 0 ? 1n : -1n));
  return view.getFloat64(0);
}

const codec = (attrs: Record<string, unknown>) =>
  buildValueCodec({ _ARRAY_DIMENSIONS: ["i"], ...attrs }, null, "int64", 2);

const N = 2n ** 53n;

describe("wide integer unpacking (review of interim37)", () => {
  it("matches exact arithmetic where intermediate products lose bits", () => {
    const c = codec({ scale_factor: 1.5, add_offset: -1.5 * 2 ** 53 });
    const raw = [N - 2n, N - 1n, N, N + 1n];
    expect(raw.map((r) => decodeStoredBigInt(c, r))).toEqual([
      -3, -1.5, 0, 1.5,
    ]);
  });

  it("decodes a tiny scale and an offset near the largest double", () => {
    const tiny = codec({ scale_factor: 2 ** -1010 });
    expect(decodeStoredBigInt(tiny, N + 1n)).toBe(
      oracle(N + 1n, 2 ** -1010, 0)
    );
    const huge = codec({ scale_factor: 0.5, add_offset: 1.2e308 });
    const values = [N - 1n, N, N + 1n, N + 2n].map((r) =>
      decodeStoredBigInt(huge, r)
    );
    expect(values.every((v) => v === 1.2e308)).toBe(true);
  });

  it("agrees with the oracle on both sides of 2^53 for decimal packing", () => {
    for (const [scale, offset] of [
      // eslint-disable-next-line no-loss-of-precision -- the case's own coefficient
      [0.1, -900719925474099.2],
      [0.01, 273.15],
      [2.5, -11258999068426240],
      [1e-300, 0],
    ]) {
      const c = codec({ scale_factor: scale, add_offset: offset });
      for (const r of [
        -N - 3n,
        -(2n ** 40n),
        -7n,
        0n,
        5n,
        2n ** 40n + 1n,
        N - 1n,
        N,
        N + 1n,
        N + 7n,
      ]) {
        const got = decodeStoredBigInt(c, r);
        const want = oracle(r, scale, offset);
        // NetCDF readers' binary64 result where nothing can cancel:
        // within one unit in the last place of the exact value.
        const ulp = Math.abs(nextAfter(want, 1) - want);
        expect(Math.abs(got - want)).toBeLessThanOrEqual(ulp);
        if (Math.abs(Number(r) * scale) > Math.abs(want)) {
          expect(got).toBe(want);
        }
      }
    }
  });

  it("states a wide integer offset as published in the decoding rule", () => {
    const c = codec({ add_offset: -9007199254740993n });
    expect(c.rule).toContain("-9007199254740993");
    expect(decodeStoredBigInt(c, N + 1n)).toBe(0);
  });

  it("unpacks 1 MiB of wide values without per-value coefficient work", () => {
    // eslint-disable-next-line no-loss-of-precision -- the case's own coefficient
    const c = codec({ scale_factor: 0.1, add_offset: -900719925474099.2 });
    const start = performance.now();
    let sum = 0;
    for (let i = 0n; i < 131072n; i++) {
      sum += decodeStoredBigInt(c, N + i);
    }
    const elapsed = performance.now() - start;
    expect(Number.isFinite(sum)).toBe(true);
    // Timed on a quiet benchmark run only (GRIDLOOK_TIMING=1): a full parallel
    // suite measures 246 ms against 150 alone.
    if (process.env.GRIDLOOK_TIMING === "1") {
      expect(elapsed).toBeLessThan(150);
    }
  });
});
