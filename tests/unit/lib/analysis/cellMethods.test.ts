import { expect, it } from "vitest";

import {
  parseCellMethods,
  quantityKind,
  timeCellMethod,
} from "@/lib/analysis/cellMethods.ts";

it("reads CF cell_methods: shared names, qualifiers and comments", () => {
  expect([
    ...parseCellMethods(
      "lat: lon: mean area: mean where sea (comment: x) time: maximum (interval: 1 day)"
    ),
  ]).toEqual([
    ["lat", "mean"],
    ["lon", "mean"],
    ["area", "mean"],
    ["time", "maximum"],
  ]);
});

it("finds the method over time under `time` or the time dimension's own name", () => {
  expect(timeCellMethod("time: point")).toBe("point");
  expect(timeCellMethod("record: point", "record")).toBe("point");
  expect(timeCellMethod("timeA: mean", "timeA")).toBe("mean");
  // Another dimension's method is not time's.
  expect(timeCellMethod("depth: mean", "timeA")).toBeUndefined();
  expect(timeCellMethod(undefined, "time")).toBeUndefined();
});

it("tells intensive quantities from amounts (CF's default without cell_methods)", () => {
  expect(quantityKind("K")).toBe("intensive");
  expect(quantityKind("kg m-2 s-1", "precipitation_flux")).toBe("intensive");
  expect(quantityKind("kg m-2", "precipitation_amount")).toBe("extensive");
  expect(quantityKind("J m-2")).toBe("extensive");
  // A length alone is a depth or an accumulated depth: unknown, in m as in mm;
  // the standard name decides.
  expect(quantityKind("mm")).toBeUndefined();
  expect(quantityKind("m")).toBeUndefined();
  expect(quantityKind("mm", "surface_snow_thickness")).toBe("intensive");
  expect(quantityKind("m", "sea_surface_height_above_geoid")).toBe("intensive");
  expect(quantityKind("mm", "lwe_thickness_of_precipitation_amount")).toBe(
    "extensive"
  );
  expect(quantityKind(undefined)).toBeUndefined();
});
