import type * as zarr from "zarrita";

import { timeUnitSeconds } from "./timeHandling.ts";

export type TPathlineTimeAxis = {
  values: ArrayLike<number | bigint | string>;
  attrs: zarr.Attributes;
  variable?: string;
};

function velocityScale(units: unknown) {
  const unit = String(units ?? "")
    .trim()
    .replace(/\s|\*|\^/g, "");
  const match = /^(m|cm|mm|km)(?:\/s|s-1)$/.exec(unit);
  const scale: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, km: 1000 };
  if (!match) {
    throw new Error(
      `Unsupported velocity units: ${String(units ?? "missing")}. Pathlines need length per second.`
    );
  }
  return scale[match[1]];
}

function velocityGridRelative(u: zarr.Attributes, v: zarr.Attributes) {
  let gridRelative: boolean | undefined;
  for (const [index, attrs] of [u, v].entries()) {
    const name = String(attrs.standard_name ?? "");
    const geographic = /^(eastward|northward)_/.exec(name);
    const grid =
      /^(?:grid_(eastward|northward)_|([xy])_wind$|sea_water_([xy])_velocity$)/.exec(
        name
      );
    const direction = (geographic ?? grid)?.slice(1).find(Boolean);
    if (
      direction &&
      (index === 0 ? ["northward", "y"] : ["eastward", "x"]).includes(direction)
    ) {
      throw new Error(
        "Select eastward/x velocity as u and northward/y velocity as v."
      );
    }
    for (const flag of [
      geographic ? false : grid ? true : undefined,
      attrs.uvRelativeToGrid,
      attrs.GRIB_uvRelativeToGrid,
    ]) {
      if (flag === undefined || flag === null) {
        continue;
      }
      const value = Number(flag);
      if (
        (value !== 0 && value !== 1) ||
        (gridRelative !== undefined && gridRelative !== Boolean(value))
      ) {
        throw new Error(
          "Velocity components declare inconsistent geographic/grid-relative orientations."
        );
      }
      gridRelative = Boolean(value);
    }
  }
  // ponytail: assume selected u/v are east/north without orientation metadata.
  // Unannotated grid-relative flow needs explicit metadata or a future override.
  return gridRelative ?? false;
}

/** Convert physical units and honor explicit orientation; otherwise assume east/north. */
export function pathlineComponents(u: zarr.Attributes, v: zarr.Attributes) {
  const uScale = velocityScale(u.units),
    vScale = velocityScale(v.units);
  const gridRelative = velocityGridRelative(u, v);
  if (u.grid_mapping !== v.grid_mapping || u.coordinates !== v.coordinates) {
    throw new Error(
      "Velocity components declare different grid coordinates or projections."
    );
  }
  for (const attrs of [u, v]) {
    if (
      attrs.flag_values !== undefined ||
      attrs.flag_masks !== undefined ||
      attrs.flag_meanings !== undefined ||
      /(?:^|\s)time:\s*(?:sum|integral)\b/i.test(
        String(attrs.cell_methods ?? "")
      ) ||
      (attrs.GRIB_stepType ?? attrs.stepType) === "accum"
    ) {
      throw new Error(
        "Pathlines require velocity fields, not categorical or accumulated quantities."
      );
    }
  }
  return { uScale, vScale, gridRelative };
}

function calendar(attrs: zarr.Attributes) {
  const value = String(attrs.calendar ?? "standard");
  if (value === "gregorian") {
    return "standard";
  }
  if (value === "365_day") {
    return "noleap";
  }
  if (value === "366_day") {
    return "all_leap";
  }
  return value;
}

/** Align numeric time axes without converting model calendars to Gregorian dates. */
// eslint-disable-next-line max-lines-per-function
export function pathlineTimes(
  scalar: TPathlineTimeAxis,
  u: TPathlineTimeAxis,
  v: TPathlineTimeAxis,
  start: number,
  end: number
) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end >= scalar.values.length
  ) {
    throw new Error(
      "Choose a valid pathline time range with at least two keyframes."
    );
  }
  const seconds = timeUnitSeconds(scalar.attrs.units);
  const origin = (axis: TPathlineTimeAxis) =>
    String(axis.attrs.units)
      .split(/ since /i)[1]
      ?.trim();
  const allowed = [
    "standard",
    "proleptic_gregorian",
    "julian",
    "noleap",
    "all_leap",
    "360_day",
  ];
  if (!seconds || !allowed.includes(calendar(scalar.attrs))) {
    throw new Error(
      "Pathlines require fixed-duration time units and a supported CF calendar."
    );
  }
  const times: number[] = [];
  const mismatch = (axis: TPathlineTimeAxis, detail: string) =>
    new Error(
      `Time-axis mismatch between ${scalar.variable ?? "scalar"} and ${axis.variable ?? "velocity"}: ${detail}.`
    );
  for (const axis of [u, v]) {
    if (!timeUnitSeconds(axis.attrs.units)) {
      throw mismatch(
        axis,
        `unsupported velocity time units: ${axis.attrs.units}`
      );
    }
    if (origin(axis) !== origin(scalar)) {
      // ponytail: differing epochs need calendar-aware reconciliation before support.
      throw mismatch(
        axis,
        `epochs differ (${origin(scalar)} vs ${origin(axis)})`
      );
    }
    if (calendar(axis.attrs) !== calendar(scalar.attrs)) {
      throw mismatch(
        axis,
        `calendars differ (${calendar(scalar.attrs)} vs ${calendar(axis.attrs)})`
      );
    }
    if (axis.values.length !== scalar.values.length) {
      throw mismatch(
        axis,
        `${scalar.values.length} scalar timestamps vs ${axis.values.length} velocity timestamps`
      );
    }
  }
  const first = Number(scalar.values[start]);
  for (let i = start; i <= end; i++) {
    const value = Number(scalar.values[i]);
    const elapsed = (value - first) * seconds;
    if (
      !Number.isFinite(value) ||
      !Number.isFinite(elapsed) ||
      (times.length && elapsed <= times.at(-1)!)
    ) {
      throw new Error(
        "Pathline timestamps must be finite and strictly increasing."
      );
    }
    for (const axis of [u, v]) {
      const physical =
        Number(axis.values[i]) * timeUnitSeconds(axis.attrs.units)!;
      if (
        !Number.isFinite(physical) ||
        Math.abs(physical - value * seconds) > 1e-6
      ) {
        throw mismatch(axis, `timestamps differ at index ${i}`);
      }
    }
    times.push(elapsed);
  }
  return times;
}
