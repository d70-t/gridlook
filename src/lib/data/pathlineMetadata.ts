import type * as zarr from "zarrita";

import { timeUnitSeconds } from "./timeHandling.ts";

export type TPathlineTimeAxis = {
  values: ArrayLike<number | bigint | string>;
  attrs: zarr.Attributes;
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

/** Require metadata that distinguishes earth-relative from grid-relative flow. */
export function pathlineComponents(u: zarr.Attributes, v: zarr.Attributes) {
  const uScale = velocityScale(u.units),
    vScale = velocityScale(v.units);
  const un = String(u.standard_name ?? ""),
    vn = String(v.standard_name ?? "");
  const eastNorth =
    /^(?:eastward_wind|eastward_sea_water_velocity(?:_at_sea_floor|_due_to_tides)?|eastward_sea_ice_velocity)$/.test(
      un
    ) && vn === un.replace("eastward", "northward");
  const gridRelative =
    (un === "grid_eastward_wind" && vn === "grid_northward_wind") ||
    (un === "x_wind" && vn === "y_wind") ||
    (un === "sea_water_x_velocity" && vn === "sea_water_y_velocity");
  const flags = [
    u.uvRelativeToGrid ?? u.GRIB_uvRelativeToGrid,
    v.uvRelativeToGrid ?? v.GRIB_uvRelativeToGrid,
  ];
  if (
    (!eastNorth && !gridRelative) ||
    flags.some(
      (flag) => flag !== undefined && Number(flag) !== Number(gridRelative)
    )
  ) {
    throw new Error(
      "Velocity orientation is missing or inconsistent. Select matching east/north or grid-relative velocity components with CF standard names."
    );
  }
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
  for (const axis of [u, v]) {
    if (
      !timeUnitSeconds(axis.attrs.units) ||
      origin(axis) !== origin(scalar) ||
      calendar(axis.attrs) !== calendar(scalar.attrs) ||
      axis.values.length !== scalar.values.length
    ) {
      // ponytail: differing epochs need calendar-aware reconciliation before support.
      throw new Error(
        "Scalar and velocity time axes must have matching epochs, calendars and lengths."
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
        throw new Error("Scalar and velocity timestamps do not match.");
      }
    }
    times.push(elapsed);
  }
  return times;
}
