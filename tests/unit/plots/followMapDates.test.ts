/* eslint-disable camelcase -- CF attributes use snake_case keys. */
import { expect, it } from "vitest";

import {
  correspondingIndex,
  mapCoordinateOf,
} from "@/ui/analysis/plotLayout.ts";

it("review of interim45: one raw array under a changed time origin names other instants", () => {
  const raw = [0, 1, 2];
  const plot = {
    values: raw,
    units: "days since 2001-01-01",
    calendar: "standard",
  };
  expect(correspondingIndex({ ...plot }, 2, plot, "time")).toBe(2);
  // The same array, its origin two days earlier: its day 2 is the plot's day 0.
  const moved = {
    values: raw,
    units: "days since 2000-12-30",
    calendar: "standard",
  };
  expect(correspondingIndex(moved, 2, plot, "time")).toBe(0);
  expect(correspondingIndex(moved, 0, plot, "time")).toBeUndefined();
});

it("review of interim45: the map's dates are masked by its valid ranges, as the plot's are", () => {
  const globe = {
    varinfo: {
      dimRanges: [{ name: "time" }],
      dimInfo: [
        {
          values: [0, 5, 10],
          units: "days since 2001-01-01",
          attrs: {
            valid_ranges: [
              [0, 1],
              [10, 11],
            ],
          },
        },
      ],
    },
  };
  const map = mapCoordinateOf(globe as never, "time")!;
  expect(Number.isNaN(map.values[1] as number)).toBe(true);
  // Another store's valid day 5 is not the map's masked day 5.
  const plot = { values: [5, 6], units: "days since 2001-01-01" };
  expect(correspondingIndex(map, 1, plot, "time")).toBeUndefined();
  expect(
    correspondingIndex(
      map,
      0,
      { values: [0, 5], units: "days since 2001-01-01" },
      "time"
    )
  ).toBe(0);
});

it("independent review of interim45: a path can be drawn against latitude, in the order sampled", async () => {
  const { chartSpec, latitudeMonotonic, latitudeVaries } =
    await import("@/ui/analysis/plotFigure.ts");
  const { SECTION_MODES } = await import("@/lib/analysis/types.ts");
  // A track that turns: 20° S up to 10° N, then back to 0°.
  const lats = [-20, -10, 0, 10, 5, 0];
  const result = {
    kind: "section",
    query: { variable: "tas" },
    units: "K",
    values: [1, 2, 3, 4, 5, 6],
    sectionMode: SECTION_MODES.PATH,
    samples: {
      distances: lats.map((_, k) => k * 1000),
      lats,
      lons: lats.map(() => 0),
      cells: lats.map(String),
      status: lats.map(() => "ok"),
    },
  };
  expect(latitudeVaries(result as never)).toBe(true);
  expect(latitudeMonotonic(result as never)).toBe(false);
  const byDistance = chartSpec(result as never)!;
  expect(byDistance.xTitle).toBe("Distance along path (km)");
  const byLatitude = chartSpec(result as never, undefined, "latitude")!;
  expect(byLatitude.xTitle).toBe("Latitude (degrees_north)");
  // As walked, not folded into latitude order.
  expect(byLatitude.x).toEqual(lats);
  expect(byLatitude.y).toEqual([1, 2, 3, 4, 5, 6]);
  // A meridional track that does not turn may be a section too.
  expect(
    latitudeMonotonic({ samples: { lats: [-20, -10, 0, 20] } } as never)
  ).toBe(true);
});

it("interim48: a turning track against latitude is drawn as walked and hovered by its distance", async () => {
  const { chartSpec, nearestSample, walkedPoints } =
    await import("@/ui/analysis/plotFigure.ts");
  const { SECTION_MODES } = await import("@/lib/analysis/types.ts");
  const lats = [10, 12, 11];
  const result = {
    kind: "section",
    query: { variable: "tas" },
    units: "K",
    values: [5, 9, 7],
    sectionMode: SECTION_MODES.PATH,
    samples: {
      distances: [0, 222_000, 333_000],
      lats,
      lons: lats.map(() => 0),
      cells: lats.map(String),
      status: lats.map(() => "ok"),
    },
  };
  const spec = chartSpec(result as never, undefined, "latitude")!;
  expect(spec.along).toEqual([0, 222_000, 333_000]);
  expect(walkedPoints(spec).map((p) => [p.x, p.y])).toEqual([
    [10, 5],
    [12, 9],
    [11, 7],
  ]);
  // The map's cursor 220 km along: the sample at 12° N, not 220°.
  expect(nearestSample(spec.along!, 220_000)).toBe(1);
  expect(chartSpec(result as never)!.along).toBeUndefined();
});

it("interim48: the script draws a latitude view against latitude, in walking order", async () => {
  const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
  const { SECTION_MODES } = await import("@/lib/analysis/types.ts");
  const lats = [10, 12, 11];
  const result = {
    kind: "section",
    query: {
      version: 1,
      kind: "section",
      variable: "tas",
      fixed: {},
      geometry: { kind: "polyline", vertices: [] },
      source: { ref: "https://x.org/a.zarr", versionStatus: "best-effort" },
    },
    units: "K",
    values: [5, 9, 7],
    dims: ["sample"],
    shape: [3],
    notes: [],
    sectionMode: SECTION_MODES.PATH,
    samples: {
      distances: [0, 222_000, 333_000],
      lats,
      lons: lats.map(() => 0),
      cells: lats.map(String),
      status: lats.map(() => "ok"),
    },
  };
  const latitude = pythonScript(
    result as never,
    "p",
    "P",
    undefined,
    "latitude"
  );
  expect(latitude).toContain('ax.set_xlabel("Latitude (degrees_north)")');
  expect(latitude).toContain('ax.plot(df["lat"], ');
  expect(pythonScript(result as never, "p", "P")).toContain(
    'ax.set_xlabel("Distance along path (km)")'
  );
});
