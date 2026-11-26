import { expect, it } from "vitest";

import { alignTo, partnerQuery } from "@/lib/analysis/companionAlign.ts";

const profile = (
  values: number[],
  bounds: number[],
  extra: Record<string, unknown> = {}
) =>
  ({
    kind: "profile",
    query: { variable: "thetao" },
    values,
    units: "K",
    dims: ["lev"],
    shape: [3],
    notes: [],
    vertical: {
      dimension: "lev",
      label: "depth (m)",
      units: "m",
      positive: "down",
      physical: true,
      values: [5, 15, 25],
      bounds,
    },
    ...extra,
  }) as never;

const finite = (r: ReturnType<typeof alignTo>) =>
  "values" in r ? r.values.filter(Number.isFinite) : [];

it("an intensive quantity without a vertical method is a sample at its level", () => {
  const a = profile([1, 2, 3], [0, 10, 10, 20, 20, 30]);
  const b = profile([271, 272, 273], [4, 6, 14, 16, 24, 26]);
  const declared = (r: object) => ({ ...r, cellMethods: "lev: point" });
  // The same with or without `lev: point`.
  expect(finite(alignTo(a, b))).toEqual([271, 272, 273]);
  expect(finite(alignTo(declared(a) as never, declared(b) as never))).toEqual([
    271, 272, 273,
  ]);
  // Declared means over other layers stay apart.
  const means = (r: object) => ({ ...r, cellMethods: "lev: mean" });
  expect(finite(alignTo(means(a) as never, means(b) as never))).toEqual([]);
  // An extensive amount without a method keeps its layers compared.
  const amount = (r: object) => ({
    ...r,
    units: "kg m-2",
    standardName: "",
  });
  expect(finite(alignTo(amount(a) as never, amount(b) as never))).toEqual([]);
});

const curtain = (
  values: number[],
  depth: { values: number[]; bounds?: number[] },
  time: { raw: number[]; bounds?: number[] },
  cellMethods?: string
) =>
  ({
    kind: "time-depth",
    query: { variable: "thetao" },
    values,
    dims: ["time", "depth"],
    shape: [2, 2],
    notes: [],
    ...(cellMethods ? { cellMethods } : {}),
    time: { dimension: "time", units: "days since 2000-01-01", ...time },
    vertical: {
      dimension: "depth",
      label: "depth (m)",
      units: "m",
      positive: "down",
      physical: true,
      ...depth,
    },
  }) as never;

it("a two-axis partner over other layers at the same depths is refused", () => {
  const time = { raw: [0, 1] };
  const a = curtain(
    [1, 2, 3, 4],
    { values: [5, 15], bounds: [0, 10, 10, 20] },
    time,
    "depth: mean"
  );
  const b = curtain(
    [5, 6, 7, 8],
    { values: [5, 15], bounds: [4, 6, 14, 16] },
    time,
    "depth: mean"
  );
  expect(alignTo(a, b)).toEqual({
    reason: "its times or levels differ from this plot's",
  });
  expect(finite(alignTo(a, a))).toEqual([1, 2, 3, 4]);
});

it("an unknown depth or an unknown time cell of a two-axis partner pairs nothing", () => {
  const time = { raw: [0, 1] };
  const depth = { values: [5, Number.NaN] };
  expect(
    finite(
      alignTo(
        curtain([1, 2, 3, 4], depth, time),
        curtain([5, 6, 7, 8], depth, time)
      )
    )
  ).toEqual([5, 7]);
  // Means over days, the second day's ends unknown: its row is no
  // observation of both.
  const cells = { raw: [0.5, 1.5], bounds: [0, 1, Number.NaN, Number.NaN] };
  const known = { values: [5, 15] };
  expect(
    finite(
      alignTo(
        curtain([1, 2, 3, 4], known, cells, "time: mean"),
        curtain([5, 6, 7, 8], known, cells, "time: mean")
      )
    )
  ).toEqual([5, 6]);
});

it("a fixed level's other layer is refused before any partner read", () => {
  const axes = (bounds: number[]) => ({
    vertical: {
      dimension: "lev",
      values: [5],
      units: "m",
      positive: "down" as const,
      bounds,
      cellMethods: "lev: mean",
      quantity: "intensive",
    },
  });
  const query = { variable: "a", fixed: {}, level: 0 } as never;
  expect(partnerQuery(query, axes([0, 10]), axes([4, 6]), "b")).toEqual({
    reason: "it is a statistic over another layer",
  });
  expect(partnerQuery(query, axes([0, 10]), axes([0, 10]), "b")).toMatchObject({
    variable: "b",
    level: 0,
  });
  // Samples at the level: their nominal bounds do not matter.
  const point = (bounds: number[]) => {
    const a = axes(bounds);
    return { vertical: { ...a.vertical, cellMethods: undefined } };
  };
  expect(partnerQuery(query, point([0, 10]), point([4, 6]), "b")).toMatchObject(
    { level: 0 }
  );
});

it("Against choices say what each variable is", async () => {
  const { pairHint } = await import("@/lib/analysis/companionAlign.ts");
  expect(
    pairHint("so", { standardName: "sea_water_salinity", units: "g/kg" })
  ).toEqual({
    name: "so",
    label: "so (sea water salinity, g/kg)",
    title: "sea water salinity",
  });
  expect(pairHint("var129", { units: "m" }).label).toBe("var129 (m)");
  expect(pairHint("x", undefined).label).toBe("x");
});
