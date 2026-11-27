import { describe, expect, it } from "vitest";

import { outlinePaths } from "../../../../src/ui/analysis/outlinePaths.ts";

const DEG = Math.PI / 180;

/** The points of a path, with where the pen was put down ("M"). */
function points(d: string) {
  return [...d.matchAll(/([ML])(-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({
    move: m[1] === "M",
    x: Number(m[2]),
    y: Number(m[3]),
  }));
}

describe("outlines on screen are cut where the map is", () => {
  it("reaches both edges of a flat map at its seam", () => {
    // 2 px a degree, the seam at ±180° (x 0 and 720).
    const project = (lat: number, lon: number) => ({
      x: ((((lon + 180) % 360) + 360) % 360) * 2,
      y: (90 - lat) * 2,
      visible: true,
    });
    // An outline across the date line, points 7° apart (as stored).
    const edge = [166, 173, 180, -173, -166].map((lon) => ({ lat: -60, lon }));
    const [d] = outlinePaths([edge], project);
    const p = points(d);
    const breaks = p.filter((q, k) => k > 0 && q.move);
    expect(breaks).toHaveLength(1);
    const at = p.indexOf(breaks[0]);
    // Up to the right edge, on again from the left edge.
    expect(p[at - 1].x).toBeGreaterThan(719);
    expect(p[at].x).toBeLessThan(1);
  });

  it("does not draw across a small world on a wide screen", () => {
    // A 390 px world: the seam step (about 390 px) is no longer "a jump".
    const project = (lat: number, lon: number) => ({
      x: 296 + (((((lon + 180) % 360) + 360) % 360) * 390) / 360,
      y: 400 - (lat * 390) / 360,
      visible: true,
    });
    const edge = [178, 179, 180, -179, -178].map((lon) => ({ lat: -70, lon }));
    const [d] = outlinePaths([edge], project);
    const p = points(d);
    const steps = p
      .slice(1)
      .map((q, k) => (q.move ? 0 : Math.abs(q.x - p[k].x)));
    expect(Math.max(...steps)).toBeLessThan(5);
  });

  it("goes up to the globe's horizon and comes back from it", () => {
    // Orthographic, radius 300 px at (500, 500), looking at 0°N 0°E.
    const project = (lat: number, lon: number) => {
      const [c, l] = [lat * DEG, lon * DEG];
      return {
        x: 500 + 300 * Math.cos(c) * Math.sin(l),
        y: 500 - 300 * Math.sin(c),
        visible: Math.cos(c) * Math.cos(l) > 0,
      };
    };
    // Along the equator from 60°E round the back to 60°W, 20° steps.
    const edge = Array.from({ length: 13 }, (_, k) => ({
      lat: 0,
      lon: 60 + 20 * k,
    }));
    const [d] = outlinePaths([edge], project);
    const p = points(d);
    // To the right limb (x 800), the pen lifted, back from the left (x 200).
    const lifted = p.findIndex((q, k) => k > 0 && q.move);
    expect(p[lifted - 1].x).toBeGreaterThan(799.9);
    expect(p[lifted].x).toBeLessThan(200.1);
  });
});
