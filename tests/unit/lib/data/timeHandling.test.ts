import assert from "node:assert/strict";

import { it } from "vitest";

import { decodeTime, findTimeIndex } from "@/lib/data/timeHandling.ts";

it("decodes raw CMIP6 int64 coordinates before selecting their timestamps", () => {
  const attrs = { units: "hours since 1915-01-16 12:00:00.000000" };
  const values = new BigInt64Array([0n, 708n, 1416n, 2148n]);
  const expected = [
    "1915-01-16T12:00:00.000Z",
    "1915-02-15T00:00:00.000Z",
    "1915-03-16T12:00:00.000Z",
    "1915-04-16T00:00:00.000Z",
  ];
  for (let i = 0; i < values.length; i++) {
    const date = decodeTime(values[i], attrs);
    assert.equal(date.toISOString(), expected[i]);
    assert.equal(findTimeIndex(date, values, attrs), i);
  }
});

it("accepts bigint and numeric string values in every decoding branch", () => {
  for (const value of [1n, "1"]) {
    assert.equal(
      decodeTime(value, { units: "months since 2000-01-31" }).toISOString(),
      "2000-02-29T00:00:00.000Z"
    );
    assert.equal(
      decodeTime(value, { units: "days since 2000-01-01" }).toISOString(),
      "2000-01-02T00:00:00.000Z"
    );
  }
  assert.equal(
    decodeTime(-12n, { units: "hours since 2000-01-01" }).toISOString(),
    "1999-12-31T12:00:00.000Z"
  );
  assert.equal(
    decodeTime(1000000n, { units: "ns since 2000-01-01" }).toISOString(),
    "2000-01-01T00:00:00.001Z"
  );
});

it("decodes and selects COSMO fractional days at hourly resolution", () => {
  const attrs = { units: "days since 1979-01-01 00:00:00" };
  const values = new Float64Array([
    5844.041666666667, 5844.083333333333, 5844.125, 5844.166666666667,
  ]);
  for (let i = 0; i < values.length; i++) {
    const expected = `1995-01-01T0${i + 1}:00:00.000Z`;
    assert.equal(decodeTime(values[i], attrs).toISOString(), expected);
    assert.equal(findTimeIndex(expected, values, attrs), i);
  }
  assert.equal(findTimeIndex("1995-01-01T02:59:59.999Z", values, attrs), 1);
});

it("preserves fractional and integer fixed-duration units and aliases", () => {
  const unitsAndValues: [string, number, number][] = [
    ["weeks", 0.5, 302400000],
    ["w", 0.5, 302400000],
    ["DAYS", 0.5, 43200000],
    ["d", 0.5, 43200000],
    ["hours", 1.5, 5400000],
    ["h", 1.5, 5400000],
    ["minutes", 1.5, 90000],
    ["m", 1.5, 90000],
    ["seconds", 1.5, 1500],
    ["s", 1.5, 1500],
    ["milliseconds", 1500, 1500],
    ["ms", 1500, 1500],
    ["nanoseconds", 1.5e9, 1500],
    ["ns", 1.5e9, 1500],
  ];
  for (const [unit, value, milliseconds] of unitsAndValues) {
    const attrs = { units: `${unit} since 2000-01-01` };
    for (const values of [
      [-value, 0, value, 2 * value],
      [0, 2 * value, 4 * value],
    ]) {
      for (let i = 0; i < values.length; i++) {
        const date = decodeTime(values[i], attrs);
        assert.equal(
          date.valueOf(),
          Date.UTC(2000, 0, 1) + (values[i] / value) * milliseconds,
          unit
        );
        assert.equal(findTimeIndex(date, values, attrs), i, unit);
      }
    }
  }
  assert.equal(
    decodeTime(-0.5, { units: "days since 2000-03-01" }).toISOString(),
    "2000-02-29T12:00:00.000Z"
  );
  assert.equal(
    decodeTime(0.5, { units: "weeks since 2000-01-01" }).toISOString(),
    "2000-01-04T12:00:00.000Z"
  );
});

it("rounds floating-point residue consistently when selecting exact timestamps", () => {
  const attrs = { units: "days since 1979-01-01" };
  const values = [5844, 5844 + 1 / 86400000, 5844 + 2 / 86400000];
  for (let i = 0; i < values.length; i++) {
    const expected = `1995-01-01T00:00:00.00${i}Z`;
    assert.equal(decodeTime(values[i], attrs).toISOString(), expected);
    assert.equal(findTimeIndex(expected, values, attrs), i);
  }
});

it("keeps floor selection, irregular steps, clamping, and coordinate array types", () => {
  const attrs = { units: "hours since 2000-01-01 00:00:00.0 0:00" };
  for (const values of [
    new Int32Array([0, 1, 4, 10]),
    new BigInt64Array([0n, 1n, 4n, 10n]),
    ["0", "1", "4", "10"],
  ]) {
    assert.equal(findTimeIndex("1999-12-31", values, attrs), 0);
    assert.equal(findTimeIndex("2000-01-01T03:30:00Z", values, attrs), 1);
    assert.equal(findTimeIndex("2000-01-01T04:00:00Z", values, attrs), 2);
    assert.equal(findTimeIndex("2000-01-02", values, attrs), 3);
  }
  assert.equal(findTimeIndex("2000-01-01", [0], attrs), 0);
  assert.throws(() => findTimeIndex("2000-01-01", [], attrs), /empty/);
});

it("preserves calendar month and year arithmetic and case-sensitive aliases", () => {
  for (const unit of ["month", "months", "M"]) {
    const attrs = { units: `${unit} since 2000-01-31` };
    assert.equal(
      decodeTime(1, attrs).toISOString(),
      "2000-02-29T00:00:00.000Z"
    );
    assert.equal(findTimeIndex("2000-02-29", [0, 1, 2], attrs), 1);
  }
  for (const unit of ["year", "years", "y"]) {
    const attrs = { units: `${unit} since 2000-02-29` };
    assert.equal(
      decodeTime(1, attrs).toISOString(),
      "2001-02-28T00:00:00.000Z"
    );
    assert.equal(findTimeIndex("2001-02-28", [0, 1, 2], attrs), 1);
  }
});

it("preserves nanosecond floor comparisons and millisecond display precision", () => {
  const attrs = { units: "NS since 2000-01-01" };
  assert.equal(
    findTimeIndex("2000-01-01", new BigInt64Array([0n, 1n, 2n]), attrs),
    0
  );
  assert.equal(
    findTimeIndex(
      "2000-01-01T00:00:00.001Z",
      [0, 999999, 1000000, 2000000],
      attrs
    ),
    2
  );
  assert.equal(
    decodeTime(900000, attrs).toISOString(),
    "2000-01-01T00:00:00.000Z"
  );
});
