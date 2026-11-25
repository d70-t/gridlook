import { expect, it } from "vitest";

import {
  buildValueCodec,
  decodeStoredValue,
  f16round,
} from "@/lib/analysis/valueDecoding.ts";

it("review of interim45: half precision rounding, without Math.f16round", () => {
  const math = Math as { f16round?: unknown };
  const native = math.f16round;
  delete math.f16round;
  try {
    expect(f16round(0.1)).toBe(0.0999755859375);
    expect(f16round(1)).toBe(1);
    expect(f16round(65504)).toBe(65504);
    expect(f16round(65519)).toBe(65504);
    expect(f16round(65520)).toBe(Infinity);
    expect(f16round(-2.5e-8)).toBe(-0);
    expect(f16round(3e-8)).toBe(2 ** -24);
    // Ties to even: 1 + 2^-11 lies halfway between 1 and 1 + 2^-10.
    expect(f16round(1 + 2 ** -11)).toBe(1);
    expect(f16round(1 + 3 * 2 ** -11)).toBe(1 + 2 * 2 ** -10);
    expect(f16round(2049)).toBe(2048);
  } finally {
    if (native) {
      math.f16round = native;
    }
  }
});

it("review of interim45: a float16 fill of 0.1 is missing, not a value", () => {
  // As _FillValue (CF), and as a Zarr v2 fill: stored as 0.0999755859375.
  for (const codec of [
    buildValueCodec({ _FillValue: 0.1 }, null, "float16", 3),
    buildValueCodec({}, 0.1, "float16", 2),
  ]) {
    expect(decodeStoredValue(codec, f16round(0.1))).toBeNaN();
    expect(decodeStoredValue(codec, 10)).toBe(10);
  }
  // The float32 control is unchanged.
  const single = buildValueCodec({ _FillValue: 0.1 }, null, "float32", 3);
  expect(decodeStoredValue(single, Math.fround(0.1))).toBeNaN();
});

it("independent review of interim45: sub-millisecond times keep distinct, correct labels", async () => {
  const { timeLabels } = await import("@/lib/analysis/calendar.ts");
  const labels = timeLabels({
    raw: [100, 400, 999_600, 1_000_100, 86_399_999_999, 86_400_000_001],
    units: "microseconds since 2001-01-01",
    calendar: "standard",
  });
  expect(labels).toEqual([
    "2001-01-01 00:00:00.000100",
    "2001-01-01 00:00:00.000400",
    "2001-01-01 00:00:00.999600",
    "2001-01-01 00:00:01.000100",
    "2001-01-01 23:59:59.999999",
    "2001-01-02 00:00:00.000001",
  ]);
  // Milliseconds and whole seconds as before; a 360-day calendar too.
  expect(
    timeLabels({
      raw: [0, 10.5, 20],
      units: "seconds since 2001-01-01",
      calendar: "360_day",
    })
  ).toEqual([
    "2001-01-01 00:00:00",
    "2001-01-01 00:00:10.500",
    "2001-01-01 00:00:20",
  ]);
  // A large day count keeps its seconds.
  expect(
    timeLabels({
      raw: [730_000.5],
      units: "days since 0001-01-01",
      calendar: "proleptic_gregorian",
    })[0]
  ).toMatch(/ 12:00:00$/);
});

it("independent review of interim45: a remote NetCDF says its transfer is unmeasured, prefixed or not", async () => {
  const { transferUnseen } = await import("@/lib/analysis/analysisClient.ts");
  const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
  const nc = ZARR_FORMAT.NETCDF;
  expect(transferUnseen({ format: nc, store: "http://host/big.nc" })).toBe(
    true
  );
  expect(
    transferUnseen({ format: nc, store: "netcdf+http://host/big.nc" })
  ).toBe(true);
  expect(
    transferUnseen({ format: nc, store: "netcdf+HTTPS://host/big.nc" })
  ).toBe(true);
  // A local file is read here: nothing unseen.
  expect(
    transferUnseen({
      format: nc,
      store: "big.nc",
      file: new File([], "big.nc"),
    })
  ).toBe(false);
  expect(
    transferUnseen({ format: ZARR_FORMAT.V3, store: "https://host/a.zarr" })
  ).toBe(false);
});
