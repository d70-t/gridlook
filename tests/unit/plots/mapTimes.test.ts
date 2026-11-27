/* eslint-disable camelcase -- CF attribute names. */
import { expect, it } from "vitest";

import {
  buildValueCodec,
  decodeStoredBigInt,
} from "@/lib/analysis/valueDecoding.ts";
import {
  pointerTime,
  rowUnder,
  timeCells,
} from "@/ui/analysis/heatmapRaster.ts";
import {
  correspondingIndex,
  mapCoordinateOf,
} from "@/ui/analysis/plotLayout.ts";

const units = "days since 2000-01-01";
const globe = (values: unknown, attrs: Record<string, unknown>) =>
  ({
    varinfo: {
      dimRanges: [{ name: "time" }],
      dimInfo: [{ values, attrs: { units, ...attrs } }],
    },
  }) as never;

it("packed 64-bit map times match the plot's rows exactly", () => {
  const big = 2n ** 53n;
  const raw = BigInt64Array.of(big, big + 1n, big + 2n, big + 3n);
  const attrs = { scale_factor: 0.5, add_offset: -(2 ** 52) };
  const map = mapCoordinateOf(globe(raw, attrs), "time")!;
  const codec = buildValueCodec(attrs, null, "int64", 2);
  const plot = Array.from(raw, (v) => decodeStoredBigInt(codec, v));
  expect(plot).toEqual([0, 0.5, 1, 1.5]);
  expect(map.values).toEqual(plot);
  expect(
    [0, 1, 2, 3].map((at) =>
      correspondingIndex(map, at, { values: plot, units }, "time")
    )
  ).toEqual([0, 1, 2, 3]);
  // Ordinary packing as before.
  expect(
    Array.from(
      mapCoordinateOf(globe([0, 1, 2], { scale_factor: 2 }), "time")!.values
    )
  ).toEqual([0, 2, 4]);
});

it("a map time at its declared fill is no date", () => {
  const map = mapCoordinateOf(globe([0, 1, 2], { _FillValue: 0 }), "time")!;
  expect(
    correspondingIndex(map, 0, { values: [0, 3, 4], units }, "time")
  ).toBeUndefined();
  expect(correspondingIndex(map, 1, { values: [1, 3, 4], units }, "time")).toBe(
    0
  );
});

it("the same numbers up and down are no common level", () => {
  const up = { values: [0, 100], units: "m", positive: "up" };
  const down = { values: [0, 100], units: "m", positive: "down" };
  expect(correspondingIndex(up, 1, down, "level")).toBeUndefined();
  // The surface is both.
  expect(correspondingIndex(up, 0, down, "level")).toBe(0);
  expect(correspondingIndex(up, 1, { ...up }, "level")).toBe(1);
});

it("two axes with one content hash keep their own dates", () => {
  // 32-bit FNV-1a gives both axes 650842870.
  const shared = Array.from({ length: 1023 }, (_, i) => i * 3600);
  const seconds = "seconds since 2025-01-01";
  const a = { values: [...shared, 3685281, 3686426], units: seconds };
  const b = { values: [...shared, 3685280, 3686427], units: seconds };
  const plot = { values: [3685281, 3685280], units: seconds };
  expect([
    correspondingIndex(a, 1023, plot, "time"),
    correspondingIndex(b, 1023, plot, "time"),
  ]).toEqual([0, 1]);
});

it("heatmap pointer moves read the time axis once, and pick the right rows", () => {
  const n = 200_000;
  const base = Date.UTC(2023, 0, 1);
  const dt = 60_000;
  const values = Float64Array.from({ length: n }, (_, i) => base + i * dt);
  const cells = timeCells(values);
  const scale = (v: number) => ((v - base) / (dt * (n - 1))) * 2000;
  expect(
    [0, 100000, n - 1].map((i) => {
      const p = pointerTime(scale, values, scale(values[i]))!;
      return rowUnder(values, cells, n, p.t, p.tolerance);
    })
  ).toEqual([0, 100000, n - 1]);
  let reads = 0;
  const axis = new Proxy(
    {},
    {
      get: (_, key) =>
        key === "length" ? n : (++reads, values[Number(String(key))]),
    }
  ) as ArrayLike<number>;
  for (let move = 0; move < 3; move++) {
    pointerTime(scale, axis, 200 + move);
  }
  expect(reads).toBe(n);
});

it("a refused Compare visits no reference date", async () => {
  const { pairSeries } = await import("@/ui/analysis/compare.ts");
  const n = 100_000;
  let visits = 0;
  const counted = <T>(list: T[]) =>
    new Proxy(list, {
      get: (target, key, receiver) => {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          visits++;
        }
        return Reflect.get(target, key, receiver);
      },
    });
  const reference = {
    dates: counted(
      Array.from({ length: n }, (_, h) =>
        new Date(Date.UTC(2001, 0, 1) + h * 3600e3).toISOString().slice(0, 19)
      )
    ),
    values: counted(Array.from({ length: n }, (_, h) => h)),
  };
  const pair = pairSeries(reference, { dates: [], values: [] });
  expect(pair.keys).toEqual([]);
  expect(visits).toBe(0);
});

it("Use map settings is offered after the map changes only the level", async () => {
  const { mapSettingsDiffer } = await import("@/ui/analysis/plotLayout.ts");
  const w = {
    kind: "point-series",
    committed: {
      variable: "thetao",
      fixed: {},
      level: 2,
      time: { start: 0, stop: 10 },
    },
    summary: { vertical: { dimension: "depth" }, time: { dimension: "time" } },
  } as never;
  const map = (depth: number) =>
    ({ variable: "thetao", indices: { depth, time: 3 } }) as never;
  expect(mapSettingsDiffer(w, map(2))).toBe(false);
  expect(mapSettingsDiffer(w, map(5))).toBe(true);
});
