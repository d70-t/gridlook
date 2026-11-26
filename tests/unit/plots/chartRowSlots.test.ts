import { expect, it } from "vitest";

import { orderedPoints } from "@/ui/analysis/seriesDates.ts";

/** An array whose numbered reads are counted. */
function counted(values: number[]) {
  const box = { reads: 0 };
  const proxy = new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        box.reads++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  return { proxy, box };
}

it("final review of interim45: one more row read does not copy every row read", () => {
  const n = 200_000;
  const { proxy, box } = counted(Array.from({ length: n }, (_, k) => k));
  const y = Array.from({ length: n }, (_, k) => Math.sin(k / 100));
  orderedPoints(proxy, y, 600, 100_000);
  box.reads = 0;
  orderedPoints(proxy, y, 600, 100_001);
  // 303,827 before: the read rows copied, then reduced.
  expect(box.reads).toBeLessThan(220_000);
});

it("final review of interim45: dates out of order are sorted from one copy", () => {
  const n = 200_000;
  const dates = Array.from({ length: n }, (_, k) => (k * 7919) % n);
  const { proxy, box } = counted(dates);
  const y = new Array<number>(n).fill(Number.NaN);
  for (let k = 0; k < 61; k++) {
    y[k] = k;
  }
  orderedPoints(proxy, y, 600, 61);
  // 4,260,155 before: each comparison read two slots. Now a scan, a copy
  // and the grouping.
  expect(box.reads).toBeLessThan(4 * n);
});
