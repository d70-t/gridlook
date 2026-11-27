import { expect, it, vi } from "vitest";

vi.mock("@/store/store.ts", () => ({ useGlobeControlStore: () => ({}) }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
const { otherMemberReads, windAt } = await import("@/store/analysisStore.ts");

const time = {
  dimension: "time",
  raw: [0, 1],
  units: "days since 2001-01-01",
  calendar: "standard",
};
const series = (values: number[], extra: Record<string, unknown> = {}) =>
  ({
    kind: "point-series",
    query: { variable: "x", time: { start: 0, stop: 2 } },
    time,
    values,
    units: "m s-1",
    dims: ["time"],
    shape: [2],
    notes: [],
    ...extra,
  }) as never;
const pair = { u: "uo", v: "vo" };

it("refuses components stored on different cells (review of interim37)", () => {
  const cell = (lat: number, lon: number) => ({
    cell: { id: "c", lat, lon, selection: "", footprint: { lat: 1, lon: 1 } },
  });
  const shown = series([1, 1], cell(0, 0));
  expect(
    windAt(shown, pair, series([3, 3], cell(0, 0)), series([4, 4], cell(1, 2)))
  ).toMatch(/different cells/);
  expect(
    typeof windAt(
      shown,
      pair,
      series([3, 3], cell(0, 0)),
      series([4, 4], cell(0, 0))
    )
  ).toBe("object");
});

it("draws a regional vector only where both components are valid together (review of interim37)", () => {
  const region = (coverage: number[]) => ({
    region: {
      totalCells: "3",
      storedCells: 3,
      coverage,
      validCells: [1, 1],
      footprintCoverage: 1,
      weighting: "",
    },
  });
  const shown = {
    ...(series([280, 280], region([1, 1])) as object),
    query: { variable: "t", time: { start: 0, stop: 2 }, minCoverage: 0.8 },
  } as never;
  const third = 1 / 3;
  const apartThirds = windAt(
    shown,
    pair,
    series([3, 3], region([third, third])),
    series([4, 4], region([third, third]))
  ) as { u: { values: number[] }; v: { values: number[] } };
  expect(apartThirds.u.values.every(Number.isNaN)).toBe(true);
  const whole = windAt(
    shown,
    pair,
    series([3, 3], region([1, 1])),
    series([4, 4], region([1, 1]))
  ) as { u: { values: number[] } };
  expect(whole.u.values).toEqual([3, 3]);
});

it("interim48: a point vector refuses componentwise extremes and unlike chains", () => {
  const shown = series([1, 1]);
  const methods = (cellMethods: string) => ({ cellMethods });
  const daily = "time: maximum within days time: mean over days";
  expect(
    windAt(
      shown,
      pair,
      series([3, 3], methods(daily)),
      series([4, 4], methods(daily))
    )
  ).toMatch(/maximum of each component is taken apart/);
  expect(
    windAt(
      shown,
      pair,
      series([3, 3], methods("area: mean where land time: mean")),
      series([4, 4], methods("area: mean where sea time: mean"))
    )
  ).toMatch(/cell methods differ/);
  expect(
    typeof windAt(
      shown,
      pair,
      series([3, 3], methods("time: mean")),
      series([4, 4], methods("time: mean"))
    )
  ).toBe("object");
});

it("interim48: members stored together are priced as one read", () => {
  expect(otherMemberReads({ size: 4, chunk: 4 })).toBe(0);
  expect(otherMemberReads({ size: 4, chunk: 1 })).toBe(3);
  expect(otherMemberReads({ size: 5, chunk: 2 })).toBe(2);
  expect(otherMemberReads({ size: 4 })).toBe(3);
});
