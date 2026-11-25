/* eslint-disable max-lines-per-function -- one describe block of Method checks. */
import { describe, expect, it } from "vitest";

import { distributionSummary } from "@/lib/analysis/distributionStats.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  emptyCounters,
  type TAnalysisResult,
} from "@/lib/analysis/types.ts";
import { methodSections, readDiagnostics } from "@/ui/analysis/methodFacts.ts";

const base = {
  query: {
    version: ALGORITHM_VERSION,
    source: { ref: "memory", versionStatus: "session" },
    variable: "tas",
    geometry: { kind: "box", west: 0, east: 10, south: 40, north: 50 },
    fixed: {},
    time: { start: 0, stop: 4 },
    minCoverage: 0.5,
  },
  units: "K",
  dims: ["time"],
  grid: {
    kind: "regular",
    conflicts: ["lon wraps at 360"],
    indexValidation: "checked",
  },
  decoding: "CF",
  notes: ["Cells by centre"],
};

function areaSeries(): TAnalysisResult {
  const counters = {
    ...emptyCounters(),
    chunkReads: 3,
    cacheHits: 1,
    fetchedBytes: 3 * 2 ** 20,
    decodedBytes: 12 * 2 ** 20,
    readMs: 900,
    fetchMs: 400,
  };
  return {
    ...base,
    kind: ANALYSIS_KINDS.REGION_SERIES,
    query: { ...base.query, kind: ANALYSIS_KINDS.REGION_SERIES },
    values: [280, 282, Number.NaN, 284],
    shape: [4],
    time: {
      dimension: "time",
      raw: [0, 1, 2, 3],
      units: "days since 2000-01-01",
      calendar: "standard",
    },
    region: {
      totalCells: "20",
      storedCells: 20,
      coverage: [1, 0.9, 0, 1],
      validCells: [20, 18, 0, 20],
      footprintCoverage: 1,
      weighting: "areacella (m2, from the CMIP6 fixed field)",
    },
    approximation: "Centres in the area",
    counters,
  } as unknown as TAnalysisResult;
}

describe("the Method dialog", () => {
  it("explains selection, calculation, weighting, coverage, statistics and reads", () => {
    const sections = methodSections(areaSeries(), {
      selection: "Area mean | 40° N–50° N, 0° E–10° E",
      grid: "Regular 1° | CF",
      view: "the anomaly view",
    });
    expect(sections.map((s) => s.title)).toEqual([
      "Selection",
      "Calculation",
      "Weighting",
      "Coverage",
      "Statistics",
    ]);
    // Reads have their own tab.
    const diagnostics = readDiagnostics(areaSeries(), {
      grid: "Regular 1° | CF",
      read: {
        state: "Reading",
        parts: "2 of 4",
        requested: { first: "2000-01-01", last: "2000-01-10", count: 10 },
      },
    });
    const text = (title: string) =>
      (title === "Read diagnostics"
        ? diagnostics
        : sections.find((s) => s.title === title)!.rows
      )
        .map((r) => `${r.label}: ${r.value}`)
        .join("\n");
    expect(text("Read diagnostics")).toContain("State: Reading");
    expect(text("Read diagnostics")).toContain("Dates read: 4 of 10 asked for");
    expect(text("Read diagnostics")).toContain("Read part: 2 of 4");
    expect(text("Read diagnostics")).toContain(
      "Requested: 2000-01-01 – 2000-01-10"
    );
    // What the window leaves out of its surface: why Read all is off and
    // how a heatmap is drawn.
    const rows = readDiagnostics(areaSeries(), {
      read: {
        state: "First dates shown",
        allRefused: "Not offered: all 10 dates would hold 9 values",
        allActions: [
          { id: "dates", label: "Change dates" },
          { id: "extend", label: "+2 dates" },
        ],
        drawing: ["Each pixel shows the most extreme of up to 2 cells"],
      },
    });
    // Read all offers its ways on as buttons, not only words.
    expect(
      rows.find((r) => r.label === "Read all")?.actions?.map((a) => a.id)
    ).toEqual(["dates", "extend"]);
    const more = rows.map((r) => `${r.label}: ${r.value}`);
    expect(more).toContain(
      "Read all: Not offered: all 10 dates would hold 9 values"
    );
    expect(more.at(-1)).toBe(
      "Drawing: Each pixel shows the most extreme of up to 2 cells"
    );
    expect(text("Selection")).toContain("2000-01-01");
    expect(text("Calculation")).toMatch(/area-weighted mean/);
    expect(text("Calculation")).toContain("Shown as: the anomaly view");
    // Everything Details held: the approximation, notes, grid and conflicts.
    expect(text("Calculation")).toContain("Centres in the area");
    expect(text("Calculation")).toContain("Cells by centre");
    expect(text("Weighting")).toContain("areacella");
    expect(text("Coverage")).toContain("Valid area per date: 0 – 100 %");
    expect(text("Coverage")).toContain("Hidden below: 50 %");
    expect(text("Statistics")).toContain("Valid dates: 3 of 4");
    expect(text("Statistics")).toContain("Maximum: 284 K at 2000-01-04");
    expect(text("Read diagnostics")).toContain(
      "3 stored chunks, 1 from the cache"
    );
    expect(text("Read diagnostics")).toContain("Fetched: 3.0 MiB");
    expect(text("Read diagnostics")).toContain("Decoded: 12 MiB");
    expect(text("Read diagnostics")).toContain("lon wraps at 360");
    expect(text("Read diagnostics")).toContain("Grid: Regular 1° | CF");
  });

  it("gives a distribution's precise statistics", () => {
    const n = 101;
    const values = Float64Array.from({ length: n }, (_, k) => k / 10);
    const weights = new Float64Array(n).fill(1);
    const r = {
      ...base,
      kind: ANALYSIS_KINDS.DISTRIBUTION,
      query: {
        ...base.query,
        kind: ANALYSIS_KINDS.DISTRIBUTION,
        time: { start: 0, stop: 1 },
      },
      values: [0.5, 0.5],
      shape: [2],
      histogram: {
        edges: [0, 5, 10],
        validFraction: 1,
        validCells: n,
        selectedCells: n,
        mean: 5,
        weighting: "cos(latitude) bands",
        summary: distributionSummary(values, weights, n, 0, 10),
      },
      counters: emptyCounters(),
    } as unknown as TAnalysisResult;
    const levelled = methodSections(r, {
      selection: "Distribution",
      level: "The first of 3 levels (zoom/8)",
    });
    expect(
      levelled[0].rows.find((row) => row.label === "Level read")?.value
    ).toMatch(/first of 3 levels/);
    const stats = methodSections(r, { selection: "Distribution" }).find(
      (s) => s.title === "Statistics"
    )!;
    const labels = stats.rows.map((row) => row.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Mean",
        "Median",
        "σ (population)",
        "P90, P95, P99",
      ])
    );
    expect(stats.rows.find((row) => row.label === "Median")?.value).toBe("5 K");
  });
});

it("final review of interim41: names the catalog level a result was read from", async () => {
  const { levelReadText } = await import("@/ui/analysis/methodFacts.ts");
  const { levelText } = await import("@/store/analysisStore.ts");
  const source = {
    key: "k",
    store: "https://example.org/b.zarr",
    dataset: "",
    format: 3 as const,
    level: { index: 0, count: 2, label: "0", paths: ["0", "1/physics"] },
  };
  // A variable in the second level's group: that level, not "the first".
  const text = levelReadText(levelText(source as never, "1/physics/tas"));
  expect(text).toMatch(/^Level 2 of 2: 1\/physics/);
  expect(text).not.toMatch(/first/);
  expect(levelReadText(undefined)).toBeUndefined();
});

it("independent review of interim43: the time axis's reads and NetCDF transfers are said apart", () => {
  const rows = (context: Record<string, unknown>) =>
    readDiagnostics(areaSeries(), {
      read: { state: "Read" },
      ...context,
    } as never).map((r) => `${r.label}: ${r.value}`);
  expect(rows({ timeReads: { reads: 8192, bytes: 65536 } })).toContain(
    "Time axis: 8,192 stored chunks (64 KiB decoded) read to list its dates, once for this source"
  );
  // Transfers of the NetCDF reader's own worker: not measured, not zero.
  const netcdf = rows({
    opened: { requests: 0, bytes: 0, unknown: 0, uncounted: true },
  });
  expect(netcdf).toContain("Fetched: transfer not measured");
  expect(netcdf).toContain(
    "Requests: not measured: the NetCDF reader requests in a worker of its own"
  );
});

it("an extreme on a row without a date says so", () => {
  const r = areaSeries();
  // The highest value, 284, sits on an undated row.
  const undated = { ...r, time: { ...r.time!, raw: [0, 1, 2, Number.NaN] } };
  const rows = methodSections(undated, {} as never)
    .flatMap((section) => section.rows)
    .map((row) => `${row.label}: ${row.value}`);
  expect(rows).toContain("Valid dates: 3 of 4 (1 without a date)");
  expect(rows.find((row) => row.startsWith("Maximum:"))).toMatch(
    /at an unknown date$/
  );
  expect(rows.find((row) => row.startsWith("Minimum:"))).toMatch(
    /at 2000-01-01/
  );
});
