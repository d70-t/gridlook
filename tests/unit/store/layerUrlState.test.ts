import { expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", { getItem: () => null });

const { formatLayersParam, legacyMaskToLayersParam, parseLayersParam } =
  await import("@/store/layerUrlState.ts");

const FULL =
  "coastlines,1,10m;graticules,0,15;volume,1,0.8,ta,ff8800,0.6,hus,0088ff,1;" +
  "streamlines,1,0.4,ua,va,1;mask,1,0.7,versatiles-satellite,0;grid";

it("round-trips every layer kind", () => {
  expect(formatLayersParam(parseLayersParam(FULL))).toBe(FULL);
  expect(parseLayersParam(FULL)[2]).toEqual({
    kind: "volume",
    visible: true,
    opacity: 0.8,
    selections: [
      { variable: "ta", color: "#ff8800", opacity: 0.6 },
      { variable: "hus", color: "#0088ff", opacity: 1 },
    ],
  });
});

it("omits defaults and the default stack", () => {
  expect(formatLayersParam(parseLayersParam(undefined))).toBe("");
  expect(formatLayersParam(parseLayersParam("coastlines,1,50m;grid,1,1"))).toBe(
    ""
  );
  expect(
    formatLayersParam(parseLayersParam("streamlines,1,0.55,,,1;grid"))
  ).toBe("streamlines,1,0.55,,,1;grid");
});

it("falls back on invalid input and always keeps the grid", () => {
  expect(
    formatLayersParam(
      parseLayersParam("bogus;texture;mask,x,7,moon,odd;mask,0;coastlines,1,1m")
    )
  ).toBe("mask,1,1,moon;coastlines;grid");
});

it("translates legacy mask parameters in the old layer order", () => {
  expect(legacyMaskToLayersParam("land", undefined)).toBe(
    "coastlines;mask,1,1,versatiles-osm,0,1,0;grid"
  );
  expect(legacyMaskToLayersParam("sea", "false")).toBe(
    "coastlines;mask,1,1,versatiles-osm,1,0,0;grid"
  );
  expect(legacyMaskToLayersParam("globe", "true")).toBe(
    "coastlines;grid;mask,1,1,versatiles-satellite,1,1,0"
  );
  expect(legacyMaskToLayersParam("off", "true")).toBeUndefined();
});

it("keeps basemap options, labels off by default", () => {
  const param = "grid;mask,1,1,versatiles-osm,1,0,1";
  expect(formatLayersParam(parseLayersParam(param))).toBe(param);
  expect(parseLayersParam(param)[1]).toMatchObject({
    options: { water: true, land: false, labels: true },
  });
  expect(formatLayersParam(parseLayersParam("grid;mask,1,1,esri,1,1,0"))).toBe(
    "grid;mask,1,1,esri"
  );
});

it("keeps the RGB composite settings", () => {
  const param = "rgb,1,0.9,band,3,2,1,0,0.3,1.5;coastlines;grid";
  expect(formatLayersParam(parseLayersParam(param))).toBe(param);
  expect(parseLayersParam(param)[0]).toEqual({
    kind: "rgb",
    visible: true,
    opacity: 0.9,
    settings: {
      dimension: "band",
      channels: [3, 2, 1],
      low: 0,
      high: 0.3,
      gamma: 1.5,
    },
  });
});

it("falls back to the RGB defaults and drops them from the URL", () => {
  expect(parseLayersParam("rgb;grid")[0]).toEqual({
    kind: "rgb",
    visible: true,
    opacity: 1,
    settings: {
      dimension: undefined,
      channels: [0, 1, 2],
      low: undefined,
      high: undefined,
      gamma: 1,
    },
  });
  expect(
    formatLayersParam(parseLayersParam("rgb,1,1,band,-1,x,2,,0.3,9;grid"))
  ).toBe("rgb,1,1,band,0,1,2,,0.3;grid");
  expect(formatLayersParam(parseLayersParam("rgb,1,1,,0,1,2,,,1;grid"))).toBe(
    "rgb;grid"
  );
});
