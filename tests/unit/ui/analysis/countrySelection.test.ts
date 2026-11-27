import { expect, it, vi } from "vitest";

import { countryOutline } from "@/lib/analysis/countryOutline.ts";
import { ANALYSIS_KINDS, type TCountryGeometry } from "@/lib/analysis/types.ts";
import type { TPlotWindow } from "@/store/analysisStore.ts";

vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
vi.stubGlobal("location", { hash: "", pathname: "/", search: "" });
const { figuresOf, SECTORS } = await import("@/ui/analysis/orbitDial.ts");
const { describeGeometry, pendingChanges } =
  await import("@/ui/analysis/plotLayout.ts");

it("offers country selection for both supported area plots and labels the chosen scale", () => {
  // Country is its own main entry (dial piece and right-click menu).
  expect(figuresOf(SECTORS.COUNTRY).map((row) => row.kind)).toEqual([
    ANALYSIS_KINDS.REGION_SERIES,
    ANALYSIS_KINDS.DISTRIBUTION,
  ]);
  const geometry: TCountryGeometry = {
    kind: "country",
    id: "276",
    resolution: "50m",
  };
  expect(describeGeometry(geometry)).toBe("Germany (1:50 million)");
  expect(describeGeometry({ ...geometry, resolution: "10m" })).toBe(
    "Germany (1:10 million)"
  );
});

it("keeps separate closed island and hole outlines while sampling a detailed coast", () => {
  const coast = Array.from({ length: 8000 }, (_, i) => [
    Math.cos((i / 8000) * 2 * Math.PI),
    Math.sin((i / 8000) * 2 * Math.PI),
  ]);
  coast.push(coast[0]);
  const hole = [
    [0, 0],
    [0.1, 0],
    [0, 0.1],
    [0, 0],
  ];
  const island = [
    [5, 5],
    [6, 5],
    [5, 6],
    [5, 5],
  ];
  const shown = countryOutline([[coast, hole], [island]]);
  expect(shown).toHaveLength(3);
  expect(shown[0].length).toBeLessThan(2049);
  expect(shown[1]).toHaveLength(4);
  expect(shown[2]).toHaveLength(4);
  expect(shown.map((ring) => ring[0])).toEqual(
    shown.map((ring) => ring.at(-1))
  );
  expect(coast).toHaveLength(8001);
});

it("lets a latitude–vertical bin width change be applied on its own", () => {
  const geometry = { kind: "box", west: 0, east: 20, south: 0, north: 20 };
  const committed = { geometry, variable: "u", fixed: {}, binDegrees: 2 };
  const w = {
    kind: ANALYSIS_KINDS.LAT_VERTICAL,
    committed,
    draft: { ...committed, binDegrees: 4 },
  } as TPlotWindow;
  expect(pendingChanges(w)).toEqual(["bin width"]);
});

it("24 Nov: the edges the atlas adds to close Antarctica are not drawn", () => {
  // A coast from 180° W round to 180° E, closed down the date line to the
  // pole, along it, and back up: only the coast is a drawn line.
  const coast = Array.from({ length: 37 }, (_, k) => [-180 + 10 * k, -70]);
  const ring = [
    ...coast,
    [180, -80],
    [180, -90],
    [-180, -90],
    [-180, -80],
    [-180, -70],
  ];
  const lines = countryOutline([[ring]]);
  expect(lines).toHaveLength(1);
  expect(lines[0].every((p) => p.lat === -70)).toBe(true);
  expect(lines[0][0]).toEqual({ lon: -180, lat: -70 });
  expect(lines[0].at(-1)).toEqual({ lon: 180, lat: -70 });
  // An ordinary island stays one closed ring.
  const island = [
    [10, 10],
    [11, 10],
    [11, 11],
    [10, 10],
  ];
  const [closed] = countryOutline([[island]]);
  expect(closed[0]).toEqual(closed.at(-1));
});
