import { expect, it } from "vitest";

import {
  temperatureMetadata,
  convertValue,
} from "@/lib/analysis/displayUnits.ts";
import { verticalStatistics } from "@/lib/analysis/verticalStats.ts";
import { healpixCellAxis } from "@/lib/grids/analysisGrid.ts";
import { taylorStats } from "@/ui/analysis/compare.ts";
import { spectrum } from "@/ui/analysis/timeViews.ts";

it("does not replace an absent declared cell-coordinate axis with an ensemble axis", () => {
  const axis = healpixCellAxis(
    ["time", "member"],
    [2, 48],
    { coordinate: "pixel_id" },
    "face",
    48
  );
  expect(axis).toBe(-1);
});

it("reports no spectral peak for a physically constant temperature", () => {
  const answer = spectrum(Array(128).fill(273.15), 86400);
  expect(answer?.peak ?? 0).toBeFalsy();
});

it("leaves correlation undefined when neither series varies", () => {
  const result = taylorStats(Array(128).fill(0.1), Array(128).fill(0.2));
  expect(Number.isFinite(result?.correlation)).toBe(false);
});

it("retains an ordinary temperature's meaning in a group named anomaly_analysis", () => {
  const metadata = temperatureMetadata(
    {
      query: { variable: "anomaly_analysis/tas" } as never,
      longName: "Air temperature",
    },
    "air_temperature"
  );
  expect(convertValue(280, "K", "degC", metadata)).toBeCloseTo(6.85);
});

it("does not invent thickness for a published zero-thickness layer", () => {
  const result = verticalStatistics({
    z: [0, 350, 700],
    bounds: [0, 175, 350, 350, 525, 700],
    values: [0, 1, 0],
    zUnits: "m",
    positive: "down",
    units: "kg m-3",
    standardName: "mass_concentration_of_chlorophyll_in_sea_water",
  });
  expect(result.find((r) => r.id === "amount")?.value).toBe(0);
});

it("retains the corrected four-day peak against the Nyquist component", () => {
  const data = Array.from(
    { length: 128 },
    (_, i) => 1.5 * Math.cos((2 * Math.PI * i) / 4) + (-1) ** i
  );
  expect(spectrum(data, 86400)?.peak).toBe(4 * 86400);
});
