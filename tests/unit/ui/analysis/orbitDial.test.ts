/* eslint-disable max-lines-per-function -- one describe of related cases. */
import { describe, expect, it } from "vitest";

import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import {
  beadAt,
  besideSelection,
  bezelPaths,
  chooserReasons,
  compareReason,
  figuresOf,
  nextBeadTurn,
  PIECE,
  placeDial,
  placeMenu,
  placeSubmenu,
  quietReason,
  RING,
  SECTOR_LIST,
  SECTORS,
  wedgeCentre,
  wedgePath,
} from "@/ui/analysis/orbitDial.ts";

describe("the Orbit dial's model", () => {
  it("lays out five pieces clockwise from the top: Point, Path, Box, Polygon, Country", () => {
    expect(SECTOR_LIST.map((s) => [s.label, s.angle])).toEqual([
      ["Point", 0],
      ["Path", 72],
      ["Box", 144],
      ["Polygon", 216],
      ["Country", 288],
    ]);
    expect(PIECE).toBe(72);
    const centre = RING.size / 2;
    const [point, path, box, polygon, country] = SECTOR_LIST.map((s) =>
      wedgeCentre(s.angle)
    );
    expect(Math.abs(point.x - centre)).toBeLessThan(1e-9);
    expect(point.y).toBeLessThan(centre);
    expect(path.x > centre && path.y < centre).toBe(true);
    expect(box.x > centre && box.y > centre).toBe(true);
    expect(polygon.x < centre && polygon.y > centre).toBe(true);
    expect(country.x < centre && country.y < centre).toBe(true);
    for (const s of SECTOR_LIST) {
      expect(wedgePath(s.angle)).toMatch(/^M .* A .* L .* A .* Z$/);
    }
  });

  it("engraves a bezel scale: longer ticks on the five seams, the chosen piece lit", () => {
    const count = (d: string) => (d.match(/M /g) ?? []).length;
    const plain = bezelPaths();
    expect(count(plain.groove)).toBe(60); // every 6°
    expect(count(plain.lip)).toBe(60);
    expect(plain.lit).toBe("");
    // Box (144°): the 11 ticks between its seams (108°, 180°), never a seam.
    const box = bezelPaths(144);
    expect(count(box.lit)).toBe(11);
    expect(count(box.groove)).toBe(49);
    // Point straddles 0°; its seams are 324° and 36°.
    expect(count(bezelPaths(0).lit)).toBe(11);
    expect(nextBeadTurn(0, 72)).toBe(72);
    expect(nextBeadTurn(72, 288)).toBe(-72);
    const bead = beadAt(144);
    expect(bead.x).toBeGreaterThan(RING.size / 2);
    expect(bead.y).toBeGreaterThan(RING.size / 2);
  });

  it("offers each geometry's figures with one plain line each", () => {
    const titles = (sector: (typeof SECTORS)[keyof typeof SECTORS]) =>
      figuresOf(sector).map((f) => f.title);
    expect(titles(SECTORS.POINT)).toEqual([
      "Time series",
      "Vertical profile",
      "Time–vertical diagram",
    ]);
    expect(titles(SECTORS.PATH)).toEqual([
      "Cross-section",
      "Distance × time (Hovmöller)",
    ]);
    expect(titles(SECTORS.BOX)).toEqual([
      "Area-mean time series",
      "Value distribution",
      "Longitude × time (Hovmöller)",
      "Latitude × time (Hovmöller)",
      "Latitude–vertical section",
      "Longitude–vertical section",
    ]);
    expect(titles(SECTORS.POLYGON)).toEqual([
      "Area-mean time series",
      "Value distribution",
    ]);
    expect(titles(SECTORS.COUNTRY)).toEqual([
      "Area-mean time series",
      "Value distribution",
    ]);
    const lon = figuresOf(SECTORS.BOX).find(
      (f) => f.kind === ANALYSIS_KINDS.HOVMOLLER_LON
    )!;
    expect(lon.help).toBe(
      "Average over latitude to see how the field varies by longitude and time."
    );
    for (const sector of Object.values(SECTORS)) {
      for (const figure of figuresOf(sector)) {
        expect(figure.help).toMatch(/^[A-Z].*\.$/);
      }
    }
  });

  it("names the time–vertical diagram after the actual coordinate", () => {
    const depth = { physical: true, label: "depth", units: "m" };
    expect(figuresOf(SECTORS.POINT, depth)[2].title).toBe("Time–depth diagram");
    const pressure = { physical: true, label: "air pressure", units: "hPa" };
    expect(figuresOf(SECTORS.POINT, pressure)[2].title).toBe(
      "Time–pressure diagram"
    );
  });

  it("says quietly why a plot is unavailable", () => {
    expect(quietReason("The variable has no vertical dimension.")).toBe(
      "Needs vertical levels"
    );
    expect(quietReason("The variable has no time dimension.")).toBe(
      "Needs a time axis"
    );
    // The whole phrase, not cut at "time" (seen in the menu, 25 Nov).
    expect(quietReason("The variable has only one time step.")).toBe(
      "Needs more than one time step"
    );
    expect(quietReason("")).toBe("");
  });

  it("always opens in the lower-left corner, just above Plotting tools", () => {
    const area = { width: 1200, height: 800 };
    const button = { x: 16, y: 748, w: 170, h: 36 };
    const dial = placeDial(button, { w: 600, h: 420 }, area);
    expect(dial.x).toBe(16);
    expect(button.y - (dial.y + dial.h)).toBe(10);
    // A short map: the dial shrinks (and scrolls) rather than covering it.
    const short = placeDial(button, { w: 600, h: 900 }, area);
    expect(short.y).toBe(8);
    expect(short.y + short.h).toBe(738);
    // A narrow map keeps the dial inside it.
    const narrow = placeDial(
      button,
      { w: 600, h: 420 },
      { width: 500, height: 800 }
    );
    expect(narrow.x).toBe(8);
  });

  it("settles a new window beside its selection when there is room", () => {
    const area = { width: 1200, height: 800 };
    const rect = { x: 600, y: 64, w: 420, h: 360 };
    expect(
      besideSelection({ x: 100, y: 200, w: 300, h: 80 }, rect, area)
    ).toEqual({ x: 416, y: 200, w: 420, h: 360 });
    expect(
      besideSelection({ x: 700, y: 200, w: 300, h: 80 }, rect, area)
    ).toEqual({ x: 264, y: 200, w: 420, h: 360 });
    expect(
      besideSelection({ x: 300, y: 200, w: 700, h: 80 }, rect, area)
    ).toEqual(rect);
  });

  it("opens the right-click menu at the pointer, flipping at the edges", () => {
    const area = { width: 1400, height: 800 };
    const size = { w: 236, h: 286 };
    // On the left part of the map: at the click, not pushed right.
    expect(placeMenu({ x: 300, y: 200 }, size, 300, area)).toEqual({
      x: 302,
      y: 202,
      beside: true,
    });
    // Near the right and bottom edges: flipped left and up of the pointer.
    const corner = placeMenu({ x: 1300, y: 700 }, size, 300, area);
    expect([corner.x, corner.y]).toEqual([1300 - 2 - 236, 700 - 2 - 286]);
    expect(corner.beside).toBe(true);
    // No room for a submenu on either side: it takes the menu's place.
    const narrow = placeMenu({ x: 200, y: 100 }, size, 300, {
      width: 600,
      height: 800,
    });
    expect(narrow).toEqual({ x: 202, y: 102, beside: false });
  });

  it("draws seams of one width from hub to rim", () => {
    // Distance from a piece corner to the seam line between two pieces.
    const seamAt = (angle: number) => (angle - 90) * (Math.PI / 180);
    const c = RING.size / 2;
    const corners = (d: string) =>
      [...d.matchAll(/(-?\d+\.\d+) (-?\d+\.\d+)/g)].map((m) => [
        Number(m[1]) - c,
        Number(m[2]) - c,
      ]);
    for (const s of SECTOR_LIST) {
      const [o0, o1, i1, i0] = corners(wedgePath(s.angle));
      const left = seamAt(s.angle - PIECE / 2);
      const right = seamAt(s.angle + PIECE / 2);
      const off = ([x, y]: number[], t: number) =>
        Math.abs(x * Math.sin(t) - y * Math.cos(t));
      const gaps = [
        off(o0, left),
        off(i0, left),
        off(o1, right),
        off(i1, right),
      ];
      for (const g of gaps) {
        expect(g).toBeCloseTo(RING.gap / 2, 1);
      }
    }
  });

  it("keeps the right-click submenu inside a narrow map", () => {
    // A 375 px map; the 236 px menu near the right edge, at x = 131.
    const area = { width: 375, height: 700 };
    const menu = { left: 131, right: 367, top: 100 };
    const narrow = placeSubmenu(menu, 140, { w: 300, h: 260 }, area, false);
    expect(narrow.x + narrow.w).toBeLessThanOrEqual(367);
    expect(narrow.w).toBe(300);
    // Narrower than the submenu: narrowed to the map.
    const tiny = placeSubmenu(
      menu,
      140,
      { w: 300, h: 260 },
      { width: 280, height: 700 },
      false
    );
    expect([tiny.x, tiny.w]).toEqual([8, 264]);
    // Wide: beside the menu, left when the right has no room.
    const wide = { width: 1000, height: 700 };
    expect(
      placeSubmenu(
        { left: 100, right: 336, top: 100 },
        140,
        { w: 300, h: 260 },
        wide,
        true
      ).x
    ).toBe(340);
    expect(
      placeSubmenu(
        { left: 660, right: 896, top: 100 },
        140,
        { w: 300, h: 260 },
        wide,
        true
      ).x
    ).toBe(356);
  });

  // 25 Nov: a Sentinel-2 scene (no time axis) offered Compare places in the
  // dial and in Plotting tools, though every pick in Compare was locked.
  it("locks Compare where no time series can be made, unless two are open", () => {
    const timeless = chooserReasons(undefined, {
      dimRanges: [null, null],
      dimInfo: [{}, {}],
    } as never);
    expect(compareReason(timeless, "", 0)).toBe("Needs a time axis");
    expect(compareReason(timeless, "", 2)).toBe("");
    const timed = chooserReasons(undefined, {
      dimRanges: [{ name: "time", minBound: 0, maxBound: 9 }, null, null],
      dimInfo: [{ attrs: { units: "days since 2000-01-01" } }, {}, {}],
    } as never);
    expect(compareReason(timed, "", 0)).toBe("");
    // Areas alone still make series to compare.
    const noPoint = {
      ...timed,
      [ANALYSIS_KINDS.POINT_SERIES]: "The point is off the grid.",
    };
    expect(compareReason(noPoint, "", 0)).toBe("");
  });
});
