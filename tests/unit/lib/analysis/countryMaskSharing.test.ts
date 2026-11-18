import { expect, it } from "vitest";

import { queryRegionSelection } from "@/lib/analysis/operations.ts";
import { countriesGeometry, emptyCounters } from "@/lib/analysis/types.ts";
import type { TVariableContext } from "@/lib/analysis/variableContext.ts";

// A 0.5° grid over North America.
function axis(start: number, n: number, longitude: boolean) {
  return {
    values: Float64Array.from({ length: n }, (_, i) => start + (i + 0.5) / 2),
    bounds: Float64Array.from(
      { length: 2 * n },
      (_, i) => start + (Math.floor(i / 2) + (i % 2)) / 2
    ),
    longitude,
    periodic: false,
  };
}

it("four windows asking for the same country mask at once share one", async () => {
  const context = {
    dims: ["lat", "lon"],
    grid: {
      kind: "rectilinear",
      regionKey: `north-america-${Math.random()}`,
      latAxis: 0,
      lonAxis: 1,
      lat: axis(40, 80, false),
      lon: axis(-140, 160, true),
    },
  } as unknown as TVariableContext;
  const canada = { kind: "country", id: "124", resolution: "50m" } as const;
  const masks = await Promise.all(
    [0, 1, 2, 3].map(() =>
      queryRegionSelection(context, canada, [[], []], emptyCounters())
    )
  );
  expect(masks[0].storedCells).toBeGreaterThan(1000);
  expect(masks.every((mask) => mask.points === masks[0].points)).toBe(true);
});

it("v30: several countries select the cells of each, once, with their weights", async () => {
  const context = {
    dims: ["lat", "lon"],
    grid: {
      kind: "rectilinear",
      regionKey: `north-america-${Math.random()}`,
      latAxis: 0,
      lonAxis: 1,
      lat: axis(40, 80, false),
      lon: axis(-140, 160, true),
    },
  } as unknown as TVariableContext;
  const one = (id: string) =>
    queryRegionSelection(
      context,
      { kind: "country", id, resolution: "50m" },
      [[], []],
      emptyCounters()
    );
  // Canada (124) and the United States (840) share a long border.
  const [canada, states] = [await one("124"), await one("840")];
  const both = await queryRegionSelection(
    context,
    countriesGeometry(["840", "124"], "50m"),
    [[], []],
    emptyCounters()
  );
  expect(both.storedCells).toBe(canada.storedCells + states.storedCells);
  expect(both.totalWeight).toBeCloseTo(
    canada.totalWeight + states.totalWeight,
    9
  );
  const cells = (selection: typeof both) => {
    const p = selection.points!.positions;
    return new Set(
      Array.from(
        { length: p.length / 2 },
        (_, k) => `${p[2 * k]},${p[2 * k + 1]}`
      )
    );
  };
  const union = new Set([...cells(canada), ...cells(states)]);
  expect(cells(both)).toEqual(union);
  // The same choice in another order is the same mask.
  const again = await queryRegionSelection(
    context,
    countriesGeometry(["124", "840", "124"], "50m"),
    [[], []],
    emptyCounters()
  );
  expect(again.points).toBe(both.points);
});
