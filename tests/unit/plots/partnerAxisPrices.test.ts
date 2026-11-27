import { expect, it } from "vitest";

import { partnerTimeChunks } from "@/lib/analysis/companionAlign.ts";

const n = 200_000;
const axes = (raw: number[]) => ({
  time: {
    dimension: "time",
    raw,
    units: "hours since 2000-01-01",
    calendar: "standard",
    chunk: 24,
  },
  others: [],
});

it("interim48: a partner on the plot's own time axis is priced without keying dates", () => {
  const own = axes(Array.from({ length: n }, (_, k) => k));
  // A separately read copy of the same coordinate.
  const partner = axes(Array.from({ length: n }, (_, k) => k));
  const query = {
    version: 1,
    kind: "point-series",
    geometry: { kind: "point", lat: 0, lon: 0 },
    variable: "u",
    fixed: {},
    source: { ref: "x", versionStatus: "best-effort" },
    time: { start: 0, stop: n },
  } as never;
  const started = performance.now();
  const all = partnerTimeChunks(query, own as never, partner as never, "v");
  const ms = performance.now() - started;
  expect(all?.size).toBe(Math.ceil(n / 24));
  const some = partnerTimeChunks(
    { ...(query as object), time: { start: 30, stop: 50 } } as never,
    own as never,
    partner as never,
    "v"
  );
  expect([...(some ?? [])]).toEqual([1, 2]);
  if (process.env.GRIDLOOK_TIMING === "1") {
    expect(ms).toBeLessThan(100);
  }
});
