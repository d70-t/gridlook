import { describe, expect, it } from "vitest";

import { weightsAt } from "@/lib/analysis/operations.ts";

describe("weights of candidate rows and columns only", () => {
  it("looks up dense and scattered indices, nothing else held", () => {
    const of = (i: number) => i * 0.5;
    const dense = weightsAt([10, 11, 12, 14], of);
    expect([10, 11, 12, 14].map(dense)).toEqual([5, 5.5, 6, 7]);
    expect(dense(13)).toBe(0);
    expect(dense(0)).toBe(0);
    // A wrap-around selection on a two-million-column axis: two ends.
    const wrapped = weightsAt([0, 1, 1_999_998, 1_999_999], of);
    expect(wrapped(1_999_999)).toBe(999_999.5);
    expect(wrapped(1)).toBe(0.5);
    expect(wrapped(1_000_000)).toBe(0);
    expect(weightsAt([], of)(3)).toBe(0);
  });

  it("calls the weight function once per candidate", () => {
    let calls = 0;
    weightsAt([3], () => calls++);
    weightsAt(
      Array.from({ length: 1000 }, (_, k) => k * 5000),
      () => calls++
    );
    expect(calls).toBe(1001);
  });
});
