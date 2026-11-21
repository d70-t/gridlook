import { describe, expect, it } from "vitest";

import { alignTo, partnerQuery } from "@/lib/analysis/companionAlign.ts";
import type { TAnalysisQuery, TAnalysisResult } from "@/lib/analysis/types.ts";
import {
  converter,
  convertValues,
  sameUnits,
} from "@/lib/analysis/unitConvert.ts";
import { isCurrentPair } from "@/store/analysisStore.ts";
import { windText } from "@/ui/analysis/windBarbs.ts";

const series = (
  values: number[],
  raw: number[],
  units = "days since 2000-01-01"
) =>
  ({
    values,
    dims: ["time"],
    shape: [values.length],
    time: { dimension: "time", raw, units, calendar: "standard" },
  }) as unknown as TAnalysisResult;

// eslint-disable-next-line max-lines-per-function
describe("companions at the plot's own samples", () => {
  it("matches by time, whatever the order or units of the time axis", () => {
    const shown = series([1, 2, 3, 4], [0, 1, 2, 3]);
    // The same days stored backwards, and in hours.
    const backwards = series(
      [40, 30, 20, 10],
      [72, 48, 24, 0],
      "hours since 2000-01-01"
    );
    expect(alignTo(shown, backwards)).toEqual({
      values: [10, 20, 30, 40],
      matched: 4,
    });
  });

  it("refuses disjoint dates instead of pairing them by index", () => {
    const shown = series([1, 2, 3, 4], [0, 1, 2, 3]);
    const later = series([5, 6, 7, 8], [10, 11, 12, 13]);
    expect(alignTo(shown, later)).toEqual({
      reason: "it shares no times with this plot",
    });
  });

  it("leaves the plot's samples the other lacks missing", () => {
    const shown = series([1, 2, 3], [0, 1, 2]);
    const partial = series([7, 9], [0, 2]);
    expect(alignTo(shown, partial)).toEqual({
      values: [7, NaN, 9],
      matched: 2,
    });
  });

  it("matches profiles by level, and refuses another fixed level", () => {
    const profile = (values: number[], levels: number[]) =>
      ({
        values,
        dims: ["level"],
        shape: [values.length],
        vertical: { values: levels, units: "hPa" },
      }) as unknown as TAnalysisResult;
    expect(
      alignTo(profile([1, 2], [850, 500]), profile([5, 8], [500, 850]))
    ).toEqual({
      values: [8, 5],
      matched: 2,
    });
    const at = (value: number) =>
      ({
        ...series([1], [0]),
        fixedLevel: { dimension: "lev", index: 0, value },
      }) as TAnalysisResult;
    expect(alignTo(at(850), at(500))).toEqual({
      reason: "it is at another level",
    });
  });
});

describe("units of the same quantity convert", () => {
  it("K, °C and °F; m s-1, cm s-1 and knots; hPa and Pa", () => {
    expect(convertValues([273.15, 274.15], "K", "degC")).toEqual([0, 1]);
    expect(convertValues([0, 1], "°C", "K")).toEqual([273.15, 274.15]);
    expect(converter("degF", "degC")!(212)).toBeCloseTo(100);
    expect(converter("cm s-1", "m s-1")!(100)).toBeCloseTo(1);
    expect(converter("m/s", "knots")!(1)).toBeCloseTo(1.943844, 5);
    expect(converter("hPa", "Pa")!(1)).toBe(100);
    expect(converter("mm/day", "kg m-2 s-1")!(86400)).toBeCloseTo(1);
    expect(converter("K", "m s-1")).toBeUndefined();
    expect(converter("furlongs", "m")).toBeUndefined();
    expect(sameUnits("m s**-1", "m s-1")).toBe(true);
  });

  it("U = 1 m/s east and V = 100 cm/s north is √2 m/s from the south-west", () => {
    const v = converter("cm s-1", "m s-1")!(100);
    expect(windText(1, v, "m s-1")).toBe(
      "Wind 3 kn (1.4 m s-1) from 225° (SW)"
    );
  });
});

describe("ocean currents are told by where they go", () => {
  it("recognises grouped current variables, and says 'towards'", () => {
    expect(
      isCurrentPair({ u: "ocean/uo", v: "ocean/vo", kind: "custom" }, {})
    ).toBe(true);
    expect(
      isCurrentPair(
        { u: "a", v: "b" },
        { a: { standardName: "eastward_sea_water_velocity" } }
      )
    ).toBe(true);
    expect(
      isCurrentPair({ u: "atmos/ua", v: "atmos/va", kind: "ua/va" }, {})
    ).toBe(false);
    // Eastward flow goes towards the east.
    expect(windText(0.3, 0, "m s-1", true)).toBe(
      "Current 0.30 m s-1 towards 90° (E)"
    );
  });
});

// eslint-disable-next-line max-lines-per-function
describe("v24 review: companions by physical time and level", () => {
  const axis = (raw: number[], units = "days since 2000-01-01") => ({
    dimension: "time",
    raw,
    units,
    calendar: "standard",
  });
  const query = {
    version: 1,
    kind: "point-series",
    source: { ref: "memory", versionStatus: "session" },
    variable: "tas",
    geometry: { kind: "point", lat: 0, lon: 0 },
    fixed: {},
  } as unknown as TAnalysisQuery;

  it("reads the plot's first two days where a reversed partner keeps them", () => {
    const own = { time: axis([0, 1, 2, 3]) };
    const partner = { time: { ...axis([3, 2, 1, 0]), dimension: "t" } };
    const subset = { ...query, time: { start: 0, stop: 2 } };
    expect(partnerQuery(subset, own, partner, "hus")).toMatchObject({
      variable: "hus",
      time: { start: 2, stop: 4 },
    });
    // Read there, its days line up with the plot's.
    const shown = series([1, 2], [0, 1]);
    expect(alignTo(shown, series([20, 10], [1, 0]))).toEqual({
      values: [10, 20],
      matched: 2,
    });
    expect(partnerQuery(subset, own, { time: axis([10, 11]) }, "hus")).toEqual({
      reason: "it shares no times with this plot",
    });
  });

  it("refuses a pair in another calendar, direction or member set (review of interim8)", () => {
    const own = {
      time: axis([0, 1]),
      vertical: {
        dimension: "z",
        values: [10],
        units: "m",
        positive: "up" as const,
      },
      others: [{ dimension: "member", size: 10 }],
    };
    const same = { ...own, time: { ...axis([0, 1]), calendar: "gregorian" } };
    expect(partnerQuery(query, own, same, "hus")).toMatchObject({
      variable: "hus",
    });
    expect(
      partnerQuery(
        query,
        own,
        { ...own, time: { ...axis([0, 1]), calendar: "noleap" } },
        "hus"
      )
    ).toEqual({ reason: "its calendar is noleap, this plot's is standard" });
    expect(
      partnerQuery(
        query,
        own,
        { ...own, vertical: { ...own.vertical, positive: "down" as const } },
        "hus"
      )
    ).toEqual({ reason: "its levels count downward, this plot's upward" });
    const member = { ...query, fixed: { member: 3 } };
    expect(partnerQuery(member, own, { ...own, others: [] }, "hus")).toEqual({
      reason: "it has no member dimension to match this plot's",
    });
    expect(
      partnerQuery(
        member,
        own,
        { ...own, others: [{ dimension: "member", size: 5 }] },
        "hus"
      )
    ).toEqual({ reason: "its member has 5 entries, this plot's 10" });
  });

  it("finds a profile's fixed time, and a series' level, on the partner's axes", () => {
    const own = {
      time: axis([0, 1, 2]),
      vertical: { dimension: "plev", values: [1000, 500], units: "hPa" },
    };
    const partner = {
      time: { ...axis([48, 24, 0], "hours since 2000-01-01"), dimension: "t" },
      vertical: { dimension: "lev", values: [50000, 100000], units: "Pa" },
    };
    const next = partnerQuery(
      { ...query, fixed: { time: 0 }, level: 1 },
      own,
      partner,
      "hus"
    );
    expect(next).toMatchObject({ fixed: { t: 2 }, level: 0 });
    expect((next as TAnalysisQuery).fixed.time).toBeUndefined();
    // 500 Pa is not 500 hPa.
    expect(
      partnerQuery(
        { ...query, level: 1 },
        own,
        {
          vertical: { dimension: "lev", values: [500], units: "Pa" },
        },
        "hus"
      )
    ).toEqual({ reason: "it is not at this plot's level" });
  });

  it("matches repeated dates in order, not to the first", () => {
    const shown = series([1, 2, 3], [0, 0, 1]);
    expect(alignTo(shown, series([100, 200, 300], [0, 0, 1]))).toEqual({
      values: [100, 200, 300],
      matched: 3,
    });
    // Repeated differently: which is which is unknown.
    expect(alignTo(shown, series([100, 300], [0, 1]))).toEqual({
      values: [NaN, NaN, 300],
      matched: 1,
    });
  });

  it("raw offsets of an undecoded calendar from different origins are different times", () => {
    const leap = (origin: string) =>
      ({
        values: [1, 2],
        dims: ["time"],
        shape: [2],
        time: {
          dimension: "time",
          raw: [0, 1],
          units: `days since ${origin}`,
          calendar: "all_leap",
        },
      }) as unknown as TAnalysisResult;
    expect(alignTo(leap("1980-01-01"), leap("2000-01-01"))).toEqual({
      reason: "it shares no times with this plot",
    });
    expect(alignTo(leap("1980-01-01"), leap("1980-01-01"))).toMatchObject({
      matched: 2,
    });
  });

  it("levels compare in one unit: 50,000 Pa is 500 hPa, 500 Pa is not", () => {
    const at = (value: number, units: string) =>
      ({
        values: [1],
        dims: ["time"],
        shape: [1],
        time: axis([0]),
        fixedLevel: { dimension: "lev", index: 0, value, units },
      }) as unknown as TAnalysisResult;
    expect(alignTo(at(500, "hPa"), at(50000, "Pa"))).toMatchObject({
      matched: 1,
    });
    expect(alignTo(at(500, "hPa"), at(500, "Pa"))).toEqual({
      reason: "it is at another level",
    });
  });

  it("a curtain on other per-column pressure surfaces is refused", () => {
    const curtain = (columnVertical: number[]) =>
      ({
        values: [1, 2, 3, 4],
        dims: ["sample", "level"],
        shape: [2, 2],
        vertical: { dimension: "lev", values: [0, 1], units: "hPa" },
        columnVertical,
      }) as unknown as TAnalysisResult;
    expect(
      alignTo(curtain([1000, 900, 990, 880]), curtain([1000, 900, 990, 880]))
    ).toMatchObject({ matched: 4 });
    expect(
      alignTo(curtain([1000, 900, 990, 880]), curtain([700, 500, 690, 480]))
    ).toEqual({
      reason: "its times or levels differ from this plot's",
    });
  });
});

describe("v24 reviews: units keep their case and their metadata", () => {
  it("MPa is not mPa, Mm is not mm; spelled-out units ignore case", () => {
    expect(sameUnits("MPa", "mPa")).toBe(false);
    expect(converter("MPa", "mPa")).toBeUndefined();
    expect(converter("Mm", "mm")).toBeUndefined();
    expect(converter("hPa", "Pa")!(5)).toBe(500);
    expect(converter("HPA", "Pa")!(5)).toBe(500);
    expect(sameUnits("Kelvin", "kelvin")).toBe(true);
    expect(converter("K", "degC")!(273.15)).toBeCloseTo(0, 12);
  });

  it("temperature differences convert without the offset", () => {
    const diff = {
      from: "temperature: difference",
      to: "temperature: difference",
    };
    expect(converter("K", "degC", diff)!(2)).toBeCloseTo(2, 12);
    expect(converter("degC", "degF", diff)!(2)).toBeCloseTo(3.6, 12);
    // A difference is not a position on the scale.
    expect(
      converter("K", "degC", { from: "temperature: difference" })
    ).toBeUndefined();
    expect(
      converter("K", "degC", { from: "temperature: on_scale" })!(273.15)
    ).toBeCloseTo(0, 12);
  });
});

describe("v24 review: streamed companions align by a kept match", () => {
  it("ten updates of 200,000 dates reuse the match and follow the values", () => {
    const n = 200_000;
    const time = {
      dimension: "time",
      raw: Array.from({ length: n }, (_, k) => k),
      units: "hours since 2000-01-01",
      calendar: "standard",
    };
    const backwards = { ...time, raw: [...time.raw].reverse() };
    const shown = {
      values: new Array(n).fill(1),
      dims: ["time"],
      shape: [n],
      time,
    } as unknown as TAnalysisResult;
    const started = performance.now();
    alignTo(shown, {
      ...shown,
      time: backwards,
      values: new Array(n).fill(0),
    } as never);
    const first = performance.now() - started;
    const later = performance.now();
    let last: ReturnType<typeof alignTo> | undefined;
    for (let part = 1; part <= 10; part++) {
      // The same axis object, more values each time (a streaming part).
      const values = Array.from({ length: n }, (_, k) =>
        k < part * 1000 ? k : NaN
      );
      last = alignTo(shown, { ...shown, time: backwards, values } as never);
    }
    const ten = performance.now() - later;
    console.info(
      `first alignment ${first.toFixed(0)} ms, ten more ${ten.toFixed(0)} ms`
    );
    // Row k of the backwards partner is hour n − 1 − k.
    const values = (last as { values: number[] }).values;
    expect(values[n - 1]).toBe(0);
    expect(values[n - 10_000]).toBe(9999);
    expect(values[0]).toBeNaN();
  });
});

describe("what a plot can be scattered against (review of interim8)", () => {
  it("offers the dataset's other fields, not its coordinates or bounds", async () => {
    const { pairCandidates } = await import("@/lib/analysis/companionAlign.ts");
    const variables = {
      flux2: {},
      tas: {},
      lat: { support: true },
      lon: { support: true },
      time: { support: true },
      ["time_bnds"]: { support: true },
    };
    expect(pairCandidates(variables, "tas")).toEqual(["flux2"]);
    expect(pairCandidates(variables, "flux2")).toEqual(["tas"]);
  });
});

/* eslint-disable camelcase -- CF attribute names. */
// eslint-disable-next-line max-lines-per-function
describe("review of interim10: the same observations, not the same label", () => {
  it("tells microseconds apart, and matches equal ones", () => {
    const units = "microseconds since 2000-01-01";
    const shown = series([1, 2], [10, 1010], units);
    expect(alignTo(shown, series([5, 6], [11, 1011], units))).toEqual({
      reason: "it shares no times with this plot",
    });
    expect(alignTo(shown, series([5, 6], [10, 1010], units))).toEqual({
      values: [5, 6],
      matched: 2,
    });
  });

  it("matches calendar aliases with undecoded times", () => {
    const at = (calendar: string) =>
      ({
        ...series([1, 2], [0, 1], "fortnights since 2000-01-01"),
        time: {
          dimension: "time",
          raw: [0, 1],
          units: "fortnights since 2000-01-01",
          calendar,
        },
      }) as unknown as TAnalysisResult;
    expect(alignTo(at("all_leap"), at("366_day"))).toMatchObject({
      matched: 2,
    });
  });

  it("refuses daily means against hundredths of a day on the same dates", () => {
    const bounded = (width: number) =>
      ({
        ...series([1, 2], [0, 1]),
        time: {
          dimension: "time",
          raw: [0, 1],
          units: "days since 2000-01-01",
          calendar: "standard",
          bounds: [0, width, 1, 1 + width],
        },
      }) as unknown as TAnalysisResult;
    expect(alignTo(bounded(1), bounded(0.01))).toEqual({
      reason: "its samples cover 0.24 hours each, this plot's 1 days",
    });
    expect(alignTo(bounded(1), bounded(1))).toMatchObject({ matched: 2 });
  });

  it("matches members by their IDs, not their position", () => {
    const query = {
      version: 1,
      kind: "point-series",
      source: { ref: "memory", versionStatus: "session" },
      variable: "a",
      geometry: { kind: "point", lat: 0.8, lon: 2 },
      fixed: { member: 2 },
    } as unknown as TAnalysisQuery;
    const own = {
      others: [{ dimension: "member", size: 3, ids: ["10", "20", "30"] }],
    };
    // Member 30 is the partner's first.
    const reversed = {
      others: [{ dimension: "member", size: 3, ids: ["30", "20", "10"] }],
    };
    expect(partnerQuery(query, own, reversed, "b")).toMatchObject({
      fixed: { member: 0 },
    });
    // A partner without member 30 is refused, whatever its size.
    const other = {
      others: [{ dimension: "member", size: 2, ids: ["10", "20"] }],
    };
    expect(partnerQuery(query, own, other, "b")).toEqual({
      reason: "it has no member 30",
    });
  });

  it("offers no quality flags or cell measures", async () => {
    const { ancillaryNames } = await import("@/lib/analysis/companionAlign.ts");
    const names = ancillaryNames({
      tas: {
        attrs: {
          cell_measures: "area: areacella",
          ancillary_variables: "tas_qc",
        },
      },
      tas_qc: { attrs: { flag_values: [0, 1], flag_meanings: "good bad" } },
      areacella: { attrs: { standard_name: "cell_area" } },
      orog: { attrs: { standard_name: "surface_altitude" } },
      mask: { attrs: { standard_name: "sea_binary_mask" } },
    });
    expect([...names].sort()).toEqual(["areacella", "tas_qc"]);
  });

  it("offers no cell bounds or auxiliary coordinates (review of interim33)", async () => {
    const { ancillaryNames, pairCandidates } =
      await import("@/lib/analysis/companionAlign.ts");
    const variables = {
      lat: { attrs: { bounds: "latBounds" } },
      lon: { attrs: { bounds: "lonBounds" } },
      time: { attrs: { climatology: "climBounds" } },
      a: { attrs: { coordinates: "station_name" } },
      b: { attrs: {} },
      latBounds: {},
      lonBounds: {},
      climBounds: {},
      station_name: {},
    };
    const support = ancillaryNames(variables);
    const offered = pairCandidates(
      Object.fromEntries(
        Object.keys(variables).map((name) => [
          name,
          {
            support: support.has(name) || ["lat", "lon", "time"].includes(name),
          },
        ])
      ),
      "a"
    );
    expect(offered).toEqual(["b"]);
  });
});
/* eslint-enable camelcase */

describe("review of interim10: sparse partner dates", () => {
  it("reads dates 0 and 40,000 as two chunks, neighbours as one", async () => {
    const { timeRuns } = await import("@/lib/analysis/companionAlign.ts");
    expect(timeRuns([0, 40_000], 128)).toEqual([
      { start: 0, stop: 1 },
      { start: 40_000, stop: 40_001 },
    ]);
    expect(timeRuns([0, 5, 130, 200], 128)).toEqual([{ start: 0, stop: 201 }]);
  });
});
