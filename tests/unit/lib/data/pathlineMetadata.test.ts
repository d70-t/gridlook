import { expect, it } from "vitest";

import {
  pathlineComponents,
  pathlineTimes,
} from "@/lib/data/pathlineMetadata.ts";

const u = { ["standard_name"]: "eastward_wind", units: "m s-1" };
const v = { ["standard_name"]: "northward_wind", units: "cm/s" };
const time = {
  values: [10, 11, 13],
  attrs: { units: "hours since 2000-01-01", calendar: "360_day" },
};

it("normalizes physical component units and validates orientation", () => {
  expect(pathlineComponents(u, v)).toEqual({
    uScale: 1,
    vScale: 0.01,
    gridRelative: false,
  });
  expect(
    pathlineComponents(
      { ["standard_name"]: "x_wind", units: "m s**-1", uvRelativeToGrid: 1 },
      { ["standard_name"]: "y_wind", units: "m s**-1", uvRelativeToGrid: 1 }
    ).gridRelative
  ).toBe(true);
});

it.each([
  [{ ...u, units: "knots" }, v],
  [{ ...u, units: undefined }, v],
  [v, u],
  [{ ...u, ["standard_name"]: undefined }, v],
  [{ ...u, uvRelativeToGrid: 1 }, v],
  [{ ...u, ["grid_mapping"]: "other" }, v],
  [{ ...u, ["cell_methods"]: "time: sum" }, v],
  [{ ...u, ["flag_values"]: [1, 2] }, v],
])("fails unsafe velocity metadata before preparation: %j", (a, b) => {
  expect(() => pathlineComponents(a, b)).toThrow();
});

it("preserves elapsed seconds and model calendars, including unequal intervals", () => {
  const seconds = {
    values: [36000, 39600, 46800],
    attrs: { ...time.attrs, units: "seconds since 2000-01-01" },
  };
  expect(pathlineTimes(time, seconds, time, 0, 2)).toEqual([0, 3600, 10800]);
  expect(pathlineTimes(time, time, time, 1, 2)).toEqual([0, 7200]);
});

it.each([
  { ...time, values: [10, 12, 13] },
  { ...time, values: [10, 11] },
  { ...time, attrs: { ...time.attrs, calendar: "standard" } },
  { ...time, attrs: { ...time.attrs, units: "hours since 2001-01-01" } },
])("rejects incompatible component times: %j", (other) => {
  expect(() => pathlineTimes(time, time, other, 0, 2)).toThrow();
});

it.each([
  [0, 0, 1],
  [0, NaN, 2],
  [2, 1, 0],
])("rejects non-increasing source times: %j", (...values) => {
  const axis = { ...time, values };
  expect(() => pathlineTimes(axis, axis, axis, 0, 2)).toThrow();
});
