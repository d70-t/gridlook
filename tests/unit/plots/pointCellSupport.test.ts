import { describe, expect, it } from "vitest";

import { samplingNote } from "@/ui/analysis/scatterFigure.ts";

const at = (lon: number, west: number, width: number) => ({
  lat: 0.5,
  lon,
  footprint: { lat: 1, lon: width, south: 0, west },
});

describe("review of interim43: the support of two point cells", () => {
  it("names a 270° cell and a 90° cell at the same centre", () => {
    expect(
      samplingNote(
        { cell: at(45, 0, 270), name: "a" },
        { cell: at(45, 0, 90), name: "b" }
      )
    ).toMatch(/Other cells: a's spans 0° E to 90° W/);
  });

  it("names two equal widths in other places", () => {
    expect(
      samplingNote(
        { cell: at(45, 0, 90), name: "a" },
        { cell: at(45, 30, 90), name: "b" }
      )
    ).toMatch(/Other cells/);
  });

  it("finds one cell written at 45° W and at 315° E the same", () => {
    expect(
      samplingNote(
        { cell: at(-45, -90, 90), name: "a" },
        { cell: at(315, 270, 90), name: "b" }
      )
    ).toBeUndefined();
  });
});

describe("independent review of interim45: small cells away from the equator", () => {
  const cell = (south: number, lat: number, west: number, lon: number) => ({
    lat: south + lat / 2,
    lon: west + lon / 2,
    footprint: { lat, lon, south, west },
  });
  it("tells apart two 80° N cells overlapping by 2.63 %", () => {
    const [a, b] = [
      cell(79.999925, 0.000076, 10, 1),
      cell(79.999999, 0.000076, 10, 1),
    ];
    expect(
      samplingNote({ cell: a, name: "a" }, { cell: b, name: "b" })
    ).toMatch(/Other cells/);
    // As at the equator.
    const [c, d] = [
      cell(-0.000075, 0.000076, 10, 1),
      cell(-0.000001, 0.000076, 10, 1),
    ];
    expect(
      samplingNote({ cell: c, name: "a" }, { cell: d, name: "b" })
    ).toMatch(/Other cells/);
  });
  it("still finds coincident edges, and one cell in two longitude conventions, the same", () => {
    const a = cell(79.999925, 0.000076, -45.5, 0.000076);
    const same = cell(79.999925 + 1e-13, 0.000076, 314.5, 0.000076);
    expect(
      samplingNote({ cell: a, name: "a" }, { cell: same, name: "b" })
    ).toBeUndefined();
  });
});
