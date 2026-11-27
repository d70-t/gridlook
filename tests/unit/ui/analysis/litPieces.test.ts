import { describe, expect, it } from "vitest";

import { litPieces, ringAround } from "@/ui/analysis/spotlight.ts";

/** The polygons of closed SVG paths (M…L…Z). */
function polygons(paths: string[]) {
  return paths.map((d) =>
    [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ])
  );
}

/** Whether a screen point is lit: inside an odd number of pieces. */
function lit(paths: string[], x: number, y: number) {
  let count = 0;
  for (const poly of polygons(paths)) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    count += inside ? 1 : 0;
  }
  return count % 2 === 1;
}

/** A box's edges as GeometryOverlay densifies them (parallels eastward). */
function box(west: number, east: number, south: number, north: number) {
  const span = (((east - west) % 360) + 360) % 360;
  const along = (lat: number) =>
    Array.from({ length: 21 }, (_, k) => ({
      lat,
      lon: ((((west + (span * k) / 20 + 180) % 360) + 360) % 360) - 180,
    }));
  const side = (lon: number, from: number, to: number) =>
    Array.from({ length: 11 }, (_, k) => ({
      lat: from + ((to - from) * k) / 10,
      lon,
    }));
  return ringAround(
    [
      along(south),
      side(east, south, north),
      along(north),
      side(west, north, south),
    ],
    true
  );
}

describe("v24 review: spotlight pieces", () => {
  it("lights both sides of a box from 170°E to 170°W on a flat map", () => {
    // Equirectangular, 2 px per degree, the seam at ±180°.
    const project = (lat: number, lon: number) => ({
      x: (lon + 180) * 2,
      y: (90 - lat) * 2,
      visible: true,
    });
    const paths = litPieces(box(170, -170, -10, 10), project);
    const at = (lat: number, lon: number) => {
      const p = project(lat, lon);
      return lit(paths, p.x, p.y);
    };
    expect(at(0, 175)).toBe(true);
    expect(at(0, -175)).toBe(true);
    expect(at(5, 179)).toBe(true);
    expect(at(-5, -179)).toBe(true);
    // Outside: the rest of the world, which a jump across the map would light.
    expect(at(0, 0)).toBe(false);
    expect(at(0, 160)).toBe(false);
    expect(at(20, 175)).toBe(false);
  });
});

describe("the spotlight at a small world's seam", () => {
  it("lights right up to the seam on both sides (review of interim7)", () => {
    // Cells that do not line up with 180°: the last one across it was
    // left out, a strip beside both edges dimmed.
    const project = (lat: number, lon: number) => ({
      x: (lon + 180) * 14.66,
      y: (90 - lat) * 14.66,
      visible: true,
    });
    const paths = litPieces(box(171.3, -168.9, -10, 10), project);
    const at = (lat: number, lon: number) => {
      const p = project(lat, lon);
      return lit(paths, p.x, p.y);
    };
    for (const lon of [179.5, 179.9, -179.9, -179.5, -178.9]) {
      expect(at(0, lon)).toBe(true);
    }
    expect(at(0, -168)).toBe(false);
  });
});

describe("the spotlight in a small world", () => {
  it("tells the seam whatever the world's width on screen", () => {
    const project = (lat: number, lon: number) => ({
      x: 296 + ((lon + 180) * 390) / 360,
      y: 400 - (lat * 390) / 360,
      visible: true,
    });
    const paths = litPieces(box(170, -170, -10, 10), project);
    const at = (lat: number, lon: number) => {
      const p = project(lat, lon);
      return lit(paths, p.x, p.y);
    };
    expect(at(0, 175)).toBe(true);
    expect(at(0, -175)).toBe(true);
    expect(at(0, 0)).toBe(false);
    expect(at(0, 90)).toBe(false);
  });

  it("lights a box crossing the horizon up to the limb, nothing behind", () => {
    // Orthographic, centred on (0, 0), radius 100 px.
    const rad = Math.PI / 180;
    const project = (lat: number, lon: number) => ({
      x: 100 * Math.cos(lat * rad) * Math.sin(lon * rad),
      y: -100 * Math.sin(lat * rad),
      visible: Math.cos(lat * rad) * Math.cos(lon * rad) > 0,
    });
    const paths = litPieces(box(40, 140, -30, 30), project);
    const at = (lat: number, lon: number) => {
      const p = project(lat, lon);
      return lit(paths, p.x, p.y);
    };
    for (const lon of [45, 60, 75, 85]) {
      for (const lat of [-25, 0, 25]) {
        expect(at(lat, lon)).toBe(true);
      }
    }
    expect(at(0, 30)).toBe(false);
    expect(at(40, 60)).toBe(false);
  });
});

describe("a drawn box stored as the world less a hole (review of interim7)", () => {
  it("lights everything but the hole, on another projection too", () => {
    // The shape's rings: the whole globe (along both poles) and the hole.
    const world = [
      ...[-180, -90, 0, 90, 180].map((lon) => ({ lat: -90, lon })),
      ...[180, 90, 0, -90, -180].map((lon) => ({ lat: 90, lon })),
    ];
    const hole = box(-20, 40, -30, 10);
    const project = (lat: number, lon: number) => ({
      x: (lon + 180) * 2,
      y: (90 - lat) * 2,
      visible: true,
    });
    const paths = [...litPieces(world, project), ...litPieces(hole, project)];
    const at = (lat: number, lon: number) => {
      const p = project(lat, lon);
      return lit(paths, p.x, p.y);
    };
    expect(at(0, 10)).toBe(false); // in the hole
    for (const [lat, lon] of [
      [50, 10],
      [0, 100],
      [-60, -150],
      [0, -100],
    ]) {
      expect(at(lat, lon)).toBe(true);
    }
  });
});
