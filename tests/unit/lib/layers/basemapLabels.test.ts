import { describe, expect, it } from "vitest";

import {
  getLabelImageScale,
  layoutLabels,
  prepareLabels,
  type TBasemapLabel,
} from "@/lib/layers/basemapLabels.ts";

const label = (
  name: string,
  kind: TBasemapLabel["kind"],
  rank: number,
  lon = 0
): TBasemapLabel => ({ name, kind, rank, lat: 0, lon });

describe("prepareLabels", () => {
  it("drops repeats and puts countries first, then larger places", () => {
    const labels = prepareLabels(
      [
        label("Bonn", "city", 300_000),
        label("Cologne", "city", 1_000_000),
        label("Germany", "country", 1),
        // Repeated by a neighbouring tile with a slightly different position.
        label("Cologne", "city", 1_000_000, 0.01),
      ],
      8
    );
    expect(labels.map((entry) => entry.name)).toEqual([
      "Germany",
      "Cologne",
      "Bonn",
    ]);
  });

  it("shows each kind from its zoom on", () => {
    const labels = [
      label("Germany", "country", 1),
      label("Berlin", "capital", 1),
      label("Munich", "state_capital", 1),
      label("Bonn", "city", 1),
    ];
    const names = (zoom: number) =>
      prepareLabels(labels, zoom).map((entry) => entry.name);
    expect(names(3)).toEqual(["Germany"]);
    expect(names(6)).toEqual(["Germany", "Berlin", "Munich"]);
    expect(names(8)).toEqual(["Germany", "Berlin", "Munich", "Bonn"]);
  });
});

describe("layoutLabels", () => {
  it("skips hidden labels and those overlapping a more important one", () => {
    const labels = prepareLabels(
      [
        label("Germany", "country", 1, 0),
        label("Hidden", "capital", 1, 50),
        label("Cologne", "city", 2, 1),
        label("Faraway", "city", 1, 10),
      ],
      8
    );
    // Longitude 1° is 10 px; Hidden lies outside the image.
    const project = (_lat: number, lon: number) =>
      lon === 50 ? undefined : { x: 100 + lon * 10, y: 100 };
    const placed = layoutLabels(
      labels,
      project,
      () => 40,
      () => 1
    );
    expect(placed.map((entry) => entry.name)).toEqual(["Germany", "Faraway"]);
  });
});

describe("getLabelImageScale", () => {
  const window = { zoom: 8, x: 0, y: 0, width: 6, height: 6 };

  it("keeps text size on screen and sharpens magnified tiles", () => {
    // Tile pixels shown smaller than screen pixels: enlarge the text.
    expect(getLabelImageScale(window, 0.8)).toEqual({
      tilePixels: 256,
      textScale: 1.25,
    });
    // Magnified: twice the image pixels instead.
    expect(getLabelImageScale(window, 1.25)).toEqual({
      tilePixels: 512,
      textScale: 1.6,
    });
    expect(getLabelImageScale(window, 4)).toEqual({
      tilePixels: 512,
      textScale: 0.5,
    });
  });

  it("caps the image size and lets labels shrink with a small globe", () => {
    const wide = { ...window, width: 32 };
    expect(getLabelImageScale(wide, 1).tilePixels).toBe(128);
    expect(getLabelImageScale(window, 0.1).textScale).toBeCloseTo(Math.SQRT2);
  });
});
