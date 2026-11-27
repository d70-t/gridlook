import { expect, it } from "vitest";

import { partnerTimeChunks } from "../../../src/lib/analysis/companionAlign";
import { ANALYSIS_KINDS } from "../../../src/lib/analysis/types";

const axes = (dates: number) => ({
  time: {
    dimension: "time",
    raw: Array.from({ length: dates }, (_, t) => t),
    units: "hours since 2000-01-01",
    chunk: 24,
  },
});

const query = (dates: number) => ({
  version: 1 as const,
  kind: ANALYSIS_KINDS.POINT_SERIES,
  geometry: { kind: "point" as const, lat: 0, lon: 0 },
  variable: "tas",
  fixed: {},
  time: { start: dates - 792, stop: dates },
  source: {
    ref: "https://example.org/a.zarr",
    versionStatus: "best-effort" as const,
  },
});

/** Milliseconds for twelve prices once the axes' keys are known. */
function twelvePrices(dates: number) {
  const [own, partner] = [axes(dates), axes(dates)];
  const asked = query(dates);
  const first = partnerTimeChunks(asked, own, partner, "uas");
  const began = performance.now();
  for (let i = 0; i < 12; i++) {
    expect(partnerTimeChunks(asked, own, partner, "uas")).toEqual(first);
  }
  return { ms: performance.now() - began, chunks: first };
}

it("independent review of interim45: a price looks up the shown rows, not the whole partner axis", () => {
  const small = twelvePrices(2_000);
  const large = twelvePrices(200_000);
  // The 792 shown hours lie in 34 stored days, on either axis length.
  expect(large.chunks?.size).toBe(34);
  expect([...large.chunks!][0]).toBe(Math.floor((200_000 - 792) / 24));
  // One hundred times the dates, about the same work.
  expect(large.ms).toBeLessThan(10 * Math.max(small.ms, 2));
});

it("independent review of interim45: Against leaves out a field with members the plot lacks", async () => {
  const { pairCandidates } =
    await import("../../../src/lib/analysis/companionAlign");
  const variables = {
    tas: { dims: ["time", "lat", "lon"], shape: [10, 4, 4] },
    // Two members the plot has not: cannot pair.
    pr: { dims: ["time", "member", "lat", "lon"], shape: [10, 2, 4, 4] },
    // One member: its only one is the plot's sample.
    ps: { dims: ["time", "member", "lat", "lon"], shape: [10, 1, 4, 4] },
    // Dimensions not listed: offered, decided when chosen.
    uas: {},
    member: { support: true },
    lat: { support: true },
  };
  expect(pairCandidates(variables, "tas")).toEqual(["ps", "uas"]);
  // A realization coordinate by its standard name, whatever its name.
  const runs = {
    tas: { dims: ["time", "cell"], shape: [10, 48] },
    pr: { dims: ["time", "run", "cell"], shape: [10, 3, 48] },
    run: { support: true, standardName: "realization" },
  };
  expect(pairCandidates(runs, "tas")).toEqual([]);
  // A plot with the members: offered.
  expect(pairCandidates(variables, "pr")).toEqual(["ps", "tas", "uas"]);
});
