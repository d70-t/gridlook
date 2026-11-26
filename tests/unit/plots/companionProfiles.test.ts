import { expect, it } from "vitest";

import {
  alignTo,
  partnerQuery,
  partnerTimeChunks,
} from "@/lib/analysis/companionAlign.ts";
import {
  ANALYSIS_KINDS,
  type TAnalysisQuery,
  type TAnalysisResult,
} from "@/lib/analysis/types.ts";

const query: TAnalysisQuery = {
  version: 1,
  kind: ANALYSIS_KINDS.PROFILE,
  geometry: { kind: "point", lat: 48, lon: 11 },
  fixed: { obs: 1 },
  source: { ref: "fixture", versionStatus: "session" },
  variable: "temperature",
};
const axis = (raw: number[]) => ({
  dimension: "obs",
  units: "days since 2001-01-01",
  calendar: "standard",
  raw,
});
const depth = { dimension: "depth", values: [5, 10], units: "m" };

it("interim48 withholds a companion profile at a missing time even when both axes agree elsewhere", () => {
  const own = { time: axis([0, NaN, 2]), vertical: depth };
  const partner = { time: axis([0, NaN, 2]), vertical: depth };
  const planned = partnerQuery(query, own, partner, "salinity");
  const profile = (values: number[]) =>
    ({
      time: axis([NaN]),
      vertical: depth,
      dims: ["depth"],
      values,
      shape: [2],
    }) as TAnalysisResult;
  const scores =
    "reason" in planned ? planned : alignTo(profile([5, 1]), profile([2, 8]));
  expect(scores).toHaveProperty("reason");
});

it("interim48 reuses confirmed equal coordinates and separately allocated interval bounds for repeat point prices", () => {
  const n = 8192;
  let reads = 0;
  const counted = (raw: number[]) =>
    new Proxy(raw, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          reads++;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  const field = () => ({
    time: {
      ...axis(counted(Array.from({ length: n }, (_, i) => i + 0.5))),
      bounds: counted(
        Array.from({ length: 2 * n }, (_, i) => Math.ceil(i / 2))
      ),
      chunk: 24,
      cellMethods: "obs: mean",
    },
  });
  const a = field(),
    b = field();
  const point = {
    ...query,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    fixed: {},
    time: { start: 100, stop: 101 },
  };
  const price = () => partnerTimeChunks(point, a, b, "salinity");
  expect([...price()!]).toEqual([4]);
  reads = 0;
  expect([...price()!]).toEqual([4]);
  expect(reads).toBeLessThan(100);
});

it("interim48 applies the next sparse Extend row without rescanning every selected run", async () => {
  const { extendJoiner } = await import("@/lib/analysis/partialUpdates.ts");
  const n = 4096;
  let visits = 0;
  const runs = Array.from(
    { length: n },
    (_, i) =>
      new Proxy([2 * i + 2, 2 * i + 3] as [number, number], {
        get(target, key, receiver) {
          if (key === "0") {
            visits++;
          }
          return Reflect.get(target, key, receiver);
        },
      })
  );
  const time = { start: 2, stop: 2 * n + 1, runs };
  const prefix = {
    values: [10],
    shape: [1],
    query: { ...query, time: { start: 0, stop: 1 } },
    counters: {},
  } as TAnalysisResult;
  const values = Array<number>(n).fill(Number.NaN);
  values[0] = 11;
  const part = (k: number) => ({
    ...prefix,
    values,
    shape: [n],
    query: { ...query, time },
    partial: { done: k, total: n, readUntil: 2 * k + 1 },
  });
  const join = extendJoiner(prefix);
  join(part(1));
  visits = 0;
  values[1] = 12;
  const next = join(part(2));
  expect(next.values.slice(0, 3)).toEqual([10, 11, 12]);
  expect(visits).toBeLessThan(64);
});
