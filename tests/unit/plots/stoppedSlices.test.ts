/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
/**
 * Stopped (or failed) inside the fourth slice, the three slices already read
 * came back missing, and Continue skipped them: the slices' own results were
 * kept back until the whole read ended.
 */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { createPartialAssembler } from "@/lib/analysis/partialUpdates.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { rowsBefore } from "@/lib/analysis/timeRows.ts";
import { planInSlices } from "@/lib/analysis/timeSelection.ts";
import {
  ANALYSIS_KINDS,
  type TAnalysisQuery,
  type TAnalysisResult,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

/** Days since 2000-01-01 in storage order; the value is the stored index. */
const DAYS = [0, 10, 1, 11, 2, 12, 3, 4, 13, 14, 15, 16, 5, 17, 6, 18];
const NCELL = 48;

async function buildStore() {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: {} });
  const time = await zarr.create(zarr.root(store).resolve("time"), {
    shape: [DAYS.length],
    chunkShape: [DAYS.length],
    dtype: "float64",
    dimensionNames: ["time"],
    attributes: { units: "days since 2000-01-01", calendar: "standard" },
  });
  await zarr.set(time as never, null, {
    data: Float64Array.from(DAYS),
    shape: [DAYS.length],
    stride: [1],
  } as never);
  await zarr.create(zarr.root(store).resolve("crs"), {
    shape: [],
    chunkShape: [],
    dtype: "int8",
    attributes: {
      grid_mapping_name: "healpix",
      healpix_nside: 2,
      healpix_order: "nest",
    },
  });
  const tas = await zarr.create(zarr.root(store).resolve("tas"), {
    shape: [DAYS.length, NCELL],
    chunkShape: [1, NCELL],
    dtype: "float64",
    dimensionNames: ["time", "cell"],
    fillValue: Number.NaN as never,
    attributes: { grid_mapping: "crs", units: "K" },
  });
  const data = new Float64Array(DAYS.length * NCELL);
  DAYS.forEach((_, t) => data.fill(t, t * NCELL, (t + 1) * NCELL));
  await zarr.set(tas as never, null, {
    data,
    shape: [DAYS.length, NCELL],
    stride: [NCELL, 1],
  } as never);
  return store;
}

const store = await buildStore();

/** January 1 to 7: stored indices 0, 2, 4, 6, 7, 12 and 14. */
const JAN_1_TO_7 = {
  start: 0,
  stop: 15,
  runs: [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 8],
    [12, 13],
    [14, 15],
  ],
} as NonNullable<TAnalysisQuery["time"]>;

async function readStopping(
  time: NonNullable<TAnalysisQuery["time"]>,
  stopAt?: number
) {
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `stop-${Math.random()}`
  );
  const context = await resolveVariableContext(
    dataset,
    "tas",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  const query: TAnalysisQuery = {
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    source: { ref: "memory://stop", versionStatus: "session" },
    variable: "tas",
    geometry: { kind: "point", lat: 41.81, lon: 45 },
    fixed: {},
    time,
  };
  const planned = await planAnalysis(context, query, new ReadContext());
  const stop = new AbortController();
  let last: TAnalysisResult | undefined;
  const assemble = createPartialAssembler((partial) => {
    last = partial;
    if (stopAt !== undefined && partial.partial!.done >= stopAt) {
      stop.abort();
    }
  });
  try {
    return {
      result: await planned.execute(stop.signal, { onPartial: assemble }),
    };
  } catch (error) {
    return { stopped: last, error };
  }
}

describe("review of interim43: a stopped read in slices", () => {
  it("keeps the dates of the slices it finished, and resumes after them", async () => {
    const whole = await readStopping(JAN_1_TO_7);
    expect(whole.result!.values).toEqual([0, 2, 4, 6, 7, 12, 14]);

    const { stopped } = await readStopping(JAN_1_TO_7, 3);
    expect(stopped!.values.slice(0, 3)).toEqual([0, 2, 4]);
    expect(stopped!.partial).toMatchObject({ done: 3, total: 7 });
    // Continue starts after the third date, not before or beyond it.
    expect(rowsBefore(JAN_1_TO_7, stopped!.partial!.readUntil)).toBe(3);
    // The work so far is counted, not zero.
    expect(stopped!.counters.decodedBytes).toBeGreaterThan(0);
  });

  it("keeps the slices read from the end too", async () => {
    const fromEnd = { ...JAN_1_TO_7, fromEnd: true };
    const { stopped } = await readStopping(fromEnd, 2);
    expect(stopped!.values.slice(-2)).toEqual([12, 14]);
    // Read from the end: the two dates after the cursor are the read ones.
    expect(rowsBefore(fromEnd, stopped!.partial!.readFrom!)).toBe(5);
  });
});

describe("review of interim43: planning many slices", () => {
  it("adds up 16,000 one-date slices in one pass", async () => {
    const runs = Array.from(
      { length: 16_000 },
      (_, k) => [2 * k, 2 * k + 1] as [number, number]
    );
    const estimate = {
      chunks: 1,
      decodedBytes: 8,
      workingBytes: 64,
      outputValues: 1,
      modest: true,
      notes: [],
    };
    let admitted: { chunks: number; outputValues: number } | undefined;
    const started = performance.now();
    const planned = await planInSlices(
      {
        version: 1,
        kind: ANALYSIS_KINDS.POINT_SERIES,
        source: { ref: "memory://many", versionStatus: "session" },
        variable: "tas",
        geometry: { kind: "point", lat: 0, lon: 0 },
        fixed: {},
        time: { start: 0, stop: 31_999, runs },
      },
      async () => ({ estimate, execute: async () => ({}) as never }),
      () => undefined,
      {
        bytes: 2 ** 30,
        chunks: 200_000,
        admit: (total) => (admitted = total),
      }
    );
    const ms = performance.now() - started;
    expect(planned.estimate.chunks).toBe(16_000);
    expect(admitted).toMatchObject({ chunks: 16_000, outputValues: 16_000 });
    if (process.env.GRIDLOOK_TIMING === "1") {
      expect(ms).toBeLessThan(100);
    }
  });
});
