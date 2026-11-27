import { geoAzimuthalEquidistant, geoEquirectangular } from "d3-geo";
import { geoMollweide } from "d3-geo-projection";
import { describe, expect, it } from "vitest";

import {
  countryContains,
  prepareCountry,
} from "../../../../src/lib/analysis/countryRegion.ts";
import { boxLonSpan } from "../../../../src/lib/analysis/sphere.ts";
import {
  GEOMETRY_KINDS,
  type TGeometry,
} from "../../../../src/lib/analysis/types.ts";
import {
  alignedWithGraticule,
  drawnOutline,
  rectangleSelection,
  screenBoxPaths,
} from "../../../../src/ui/analysis/boxFootprint.ts";

const DEG = Math.PI / 180;

// An equirectangular map 720 × 360 px at the origin: 2 px a degree.
const flat = {
  pick: (x: number, y: number) =>
    x >= 0 && x <= 720 && y >= 0 && y <= 360
      ? { lat: 90 - y / 2, lon: x / 2 - 180 }
      : null,
  project: (lat: number, lon: number) => ({
    x: ((((lon + 180) % 360) + 360) % 360) * 2,
    y: (90 - lat) * 2,
    visible: true,
  }),
};

/**
 * An orthographic globe of radius 300 px centred at (500, 500), looking
 * straight at a pole (`pole` −1 south, 1 north).
 */
function globe(pole: 1 | -1, radius = 300) {
  return {
    pick: (x: number, y: number) => {
      const [u, v] = [(x - 500) / radius, (y - 500) / radius];
      const r = Math.hypot(u, v);
      if (r > 1) {
        return null;
      }
      const c = Math.asin(r) / DEG; // degrees from the pole
      return { lat: pole * (90 - c), lon: Math.atan2(u, pole * v) / DEG };
    },
    project: (lat: number, lon: number) => {
      const c = (90 - pole * lat) * DEG;
      const r = Math.sin(c);
      return {
        x: 500 + radius * r * Math.sin(lon * DEG),
        y: 500 + radius * pole * r * Math.cos(lon * DEG),
        visible: c < Math.PI / 2,
      };
    },
  };
}

// d3's Mollweide, 150 px a radian, centred at (500, 300): a curved outline,
// parallels straight across, the poles single points at top and bottom.
const mollweideProjection = geoMollweide().scale(150).translate([500, 300]);
const mollweide = {
  pick: (x: number, y: number) => {
    const ll = mollweideProjection.invert!([x, y]);
    const back = ll && mollweideProjection(ll);
    return ll && back && Math.hypot(back[0] - x, back[1] - y) < 1e-3
      ? { lat: ll[1], lon: ll[0] }
      : null;
  },
  project: (lat: number, lon: number) => {
    const [x, y] = mollweideProjection([lon, lat])!;
    return { x, y, visible: true };
  },
};

// Azimuthal equidistant centred on the North Pole, radius 300 px at
// (500, 500): its rim is the South Pole, stretched round a circle.
const azimuthalProjection = geoAzimuthalEquidistant()
  .rotate([0, -90])
  .scale(300 / Math.PI)
  .translate([500, 500]);
const azimuthal = {
  pick: (x: number, y: number) => {
    if (Math.hypot(x - 500, y - 500) > 300) {
      return null;
    }
    const ll = azimuthalProjection.invert!([x, y]);
    return ll ? { lat: ll[1], lon: ll[0] } : null;
  },
  project: (lat: number, lon: number) => {
    const [x, y] = azimuthalProjection([lon, lat])!;
    return { x, y, visible: true };
  },
};

type TMap = typeof flat;
function select(map: TMap, corner: [number, number], to: [number, number]) {
  return rectangleSelection(
    map.pick,
    map.project,
    { x: corner[0], y: corner[1] },
    { x: to[0], y: to[1] }
  );
}
/** Whether a selection holds a place, by the analysis's own rules. */
function holds(geometry: TGeometry | undefined, lat: number, lon: number) {
  if (geometry?.kind === GEOMETRY_KINDS.SHAPE) {
    return countryContains(
      prepareCountry(geometry.polygons, geometry.poles),
      lat,
      lon
    );
  }
  if (geometry?.kind === GEOMETRY_KINDS.BOX) {
    const inLon =
      boxLonSpan(geometry) >= 360 ||
      (((lon - geometry.west) % 360) + 360) % 360 <= boxLonSpan(geometry);
    return inLon && lat >= geometry.south && lat <= geometry.north;
  }
  throw new Error("no selection");
}

describe("a box is the rectangle drawn on a latitude/longitude map", () => {
  it("is a box; at the map's bottom edge it reaches the South Pole", () => {
    expect(alignedWithGraticule(flat.project, { lat: 0, lon: 0 })).toBe(true);
    const down = select(flat, [100, 100], [800, 420]);
    expect(down?.geometry).toEqual({
      kind: GEOMETRY_KINDS.BOX,
      west: -130,
      east: 180,
      south: -90,
      north: 40,
    });
    // Back up diagonally: the pole is out at once, no lock.
    const back = select(flat, [100, 100], [700, 300]);
    expect(back?.geometry).toMatchObject({ east: 170, south: -60 });
    expect(holds(back?.geometry, -89.9, 0)).toBe(false);
  });

  it("is the same box drawn either way round (review of interim7)", () => {
    const one = select(flat, [6, 140], [16, 180]);
    const other = select(flat, [16, 180], [6, 140]);
    expect(one?.geometry).toEqual(other?.geometry);
    expect(one?.geometry).toMatchObject({ west: -180, east: -172 });
  });
});

describe("boxes by a flat map's border", () => {
  it("keeps a narrow strip by a border (review of interim8)", () => {
    // 6 px (3°) wide, both corners within the snap of the left edge.
    const strip = select(flat, [1, 100], [7, 240]);
    expect(strip?.geometry).toMatchObject({ west: -179.5, east: -176.5 });
  });

  it("says how wide a box near a full turn is, never 360°", () => {
    // A world 72,000 px wide (200 px a degree): pressed 9 px inside the left
    // edge (no snap), dragged past the right: 359.955°, a real gap.
    const wide = {
      pick: (x: number, y: number) =>
        x >= 0 && x <= 72_000 && y >= 0 && y <= 36_000
          ? { lat: 90 - y / 200, lon: x / 200 - 180 }
          : null,
      project: (lat: number, lon: number) => ({
        x: ((((lon + 180) % 360) + 360) % 360) * 200,
        y: (90 - lat) * 200,
        visible: true,
      }),
    };
    const near = select(wide, [9, 10_000], [72_100, 12_000]);
    expect(near?.label).toBe("359.96° of longitude, 30°N–40°N");
  });

  it("stops at 90°S where the map's pick runs on past its edge", () => {
    // As the app's flat maps do: below the map, latitudes beyond −90°.
    const runsOn = {
      ...flat,
      pick: (x: number, y: number) =>
        x >= 0 && x <= 720 ? { lat: 90 - y / 2, lon: x / 2 - 180 } : null,
    };
    for (const y of [365, 400, 500]) {
      const box = select(runsOn, [100, 100], [500, y]);
      expect(box?.geometry).toMatchObject({ south: -90, north: 40 });
      expect(box?.label).toBe("200° of longitude, 90°S–40°N");
    }
  });
});

describe("a box on a latitude/longitude map: edges and seams", () => {
  it("edge to edge from the seam of a map centred at 6.36°W: all longitudes", () => {
    const centre = -6.36;
    const shifted = {
      pick: (x: number, y: number) =>
        x >= 0 && x <= 720 && y >= 0 && y <= 360
          ? {
              lat: 90 - y / 2,
              lon: ((((x / 2 - 180 + centre + 180) % 360) + 360) % 360) - 180,
            }
          : null,
      project: (lat: number, lon: number) => ({
        x: ((((lon - centre + 180) % 360) + 360) % 360) * 2,
        y: (90 - lat) * 2,
        visible: true,
      }),
    };
    const all = select(shifted, [1e-6, 100], [719.9999, 200]);
    expect(all?.geometry).toMatchObject({ west: -180, east: 180 });
    // Stopping short of the far edge keeps a measurable gap.
    const short = select(shifted, [1e-6, 100], [700, 200]);
    expect(short?.label).toBe("350° of longitude, 10°S–40°N");
  });

  it("pressed a pixel or two inside an edge, the box starts on it", () => {
    // The user's A3: pressed just inside the left edge, dragged past the
    // right and bottom edges: all longitudes, down to the pole.
    const cap = select(flat, [1.6, 66.4], [800, 420]);
    expect(cap?.geometry).toEqual({
      kind: GEOMETRY_KINDS.BOX,
      west: -180,
      east: 180,
      south: -90,
      north: 56.8,
    });
    // Pressed near the bottom edge and dragged up: from the pole.
    const up = select(flat, [300, 357], [400, 300]);
    expect(up?.geometry).toMatchObject({ south: -90, north: -60 });
    // Pressed 20 px in: no snap, the box starts where it was pressed.
    const inside = select(flat, [20, 100], [800, 200]);
    expect(inside?.geometry).toMatchObject({ west: -170, east: 180 });
  });

  it("below the bottom edge a sideways move still changes the width", () => {
    const a = select(flat, [100, 100], [300, 500]);
    const b = select(flat, [100, 100], [500, 500]);
    expect(a?.geometry).toMatchObject({ east: -30, south: -90 });
    expect(b?.geometry).toMatchObject({ east: 70, south: -90 });
  });

  it("edge to edge is all longitudes", () => {
    const all = select(flat, [0, 100], [900, 200]);
    expect(all?.geometry).toMatchObject({ west: -180, east: 180 });
    expect(all?.label).toBe("All longitudes, 10°S–40°N");
  });
});

describe("on the globe the outline decides: a pole is in while inside", () => {
  for (const pole of [-1, 1] as const) {
    const map = globe(pole);
    const name = pole < 0 ? "South" : "North";
    it(`${name} Pole: in, out when pulled back diagonally, in again`, () => {
      const corner: [number, number] = [400, 400];
      // The pole is at (500, 500). Diagonally out to (600, 600), back to
      // (420, 420), forward again: membership follows the pointer.
      const path: [number, number][] = [];
      for (let k = 0; k <= 180; k++) {
        path.push([600 - k, 600 - k]);
      }
      for (let k = 0; k <= 180; k++) {
        path.push([420 + k, 420 + k]);
      }
      const flips: number[] = [];
      let before: boolean | undefined;
      for (const [x, y] of path) {
        const selection = select(map, corner, [x, y]);
        expect(selection?.geometry.kind).toBe(GEOMETRY_KINDS.SHAPE);
        const now = holds(selection!.geometry, pole * 89.99, 33);
        if (before !== undefined && now !== before) {
          flips.push(x);
        }
        before = now;
      }
      // Out as the pointer passes the pole going back, in as it passes it
      // going forward: within a pixel, once each way.
      expect(flips).toHaveLength(2);
      expect(Math.abs(flips[0] - 500)).toBeLessThanOrEqual(1);
      expect(Math.abs(flips[1] - 500)).toBeLessThanOrEqual(1);
      const around = select(map, corner, [600, 600]);
      expect(around?.label).toMatch(`round the ${name} Pole`);
    });
  }
});

describe("on the globe, away from the pole and at the horizon", () => {
  it("keeps a box away from the pole to its own corners", () => {
    const map = globe(-1);
    const box = select(map, [550, 650], [650, 750]);
    const g = box!.geometry;
    expect(holds(g, -90, 0)).toBe(false);
    // Its corners' places are just inside, a step outside is not.
    const inner = map.pick(552, 652)!;
    const outer = map.pick(548, 648)!;
    expect(holds(g, inner.lat, inner.lon)).toBe(true);
    expect(holds(g, outer.lat, outer.lon)).toBe(false);
  });

  it("beyond the horizon follows its edge, and still changes with the pointer", () => {
    const map = globe(-1);
    const a = select(map, [450, 450], [1000, 700]);
    const b = select(map, [450, 450], [1000, 760]);
    expect(holds(a!.geometry, -90, 0)).toBe(true);
    // Near the horizon, below a's bottom edge (y 700): only in b.
    const p = map.pick(680, 730)!;
    expect(holds(a!.geometry, p.lat, p.lon)).toBe(false);
    expect(holds(b!.geometry, p.lat, p.lon)).toBe(true);
    // Everything selected is on the visible (southern) side.
    for (const [lon, lat] of (b!.geometry as { polygons: number[][][][] })
      .polygons[0][0]) {
      expect(lat).toBeLessThanOrEqual(1e-6);
      expect(Number.isFinite(lon)).toBe(true);
    }
  });

  it("commits what it previews: the same pointer gives the same footprint", () => {
    const map = globe(-1);
    const preview = select(map, [380, 420], [640, 590]);
    const commit = select(map, [380, 420], [640, 590]);
    expect(commit).toEqual(preview);
  });
});

describe("on a curved map the outline is clipped to it", () => {
  it("is not a latitude/longitude grid", () => {
    expect(alignedWithGraticule(mollweide.project, { lat: 0, lon: 0 })).toBe(
      false
    );
  });

  it("a band past the map's right edge runs to the date line", () => {
    const band = select(mollweide, [300, 250], [700, 330])!.geometry;
    // From about 170°W (x 100) to beyond the right-hand outline.
    const wide = select(mollweide, [100, 250], [960, 330])!.geometry;
    const lat = mollweide.pick(500, 290)!.lat;
    expect(holds(band, lat, 170)).toBe(false);
    expect(holds(wide, lat, 179.5)).toBe(true);
    expect(holds(wide, lat, -165)).toBe(true);
    expect(holds(wide, lat, -175)).toBe(false);
    expect(holds(wide, lat + 20, 0)).toBe(false);
  });

  it("holds the North Pole when the rectangle covers the map's top", () => {
    const [, top] = mollweideProjection([0, 90])!;
    const over = select(mollweide, [450, 200], [560, top - 30])!.geometry;
    const under = select(mollweide, [450, 200], [560, top + 30])!.geometry;
    expect(holds(over, 89.99, 120)).toBe(true);
    expect(holds(under, 89.99, 120)).toBe(false);
  });
});

describe("pole edges, plots that need a box, and a smooth drag", () => {
  it("on an azimuthal map, the rim it crosses is the South Pole, partly", () => {
    // Corner near the centre, pointer far beyond the rim down-right.
    const g = select(azimuthal, [480, 480], [1000, 1000])!.geometry;
    expect(holds(g, 89.99, 0)).toBe(true);
    const inLon = azimuthal.pick(700, 700)!.lon; // toward the pointer
    const outLon = azimuthal.pick(300, 300)!.lon; // the other way
    expect(holds(g, -89.5, inLon)).toBe(true);
    expect(holds(g, -89.5, outLon)).toBe(false);
  });

  it("gives a Hovmöller the latitude/longitude box round what it covers", () => {
    const map = globe(-1);
    const cap = rectangleSelection(
      map.pick,
      map.project,
      { x: 400, y: 400 },
      { x: 600, y: 620 },
      true
    )!;
    expect(cap.geometry).toMatchObject({
      kind: GEOMETRY_KINDS.BOX,
      west: -180,
      east: 180,
      south: -90,
    });
    expect(cap.label).toMatch(/^All longitudes, /);
  });

  it("moves its outline smoothly as the pointer crosses the pole", () => {
    const map = globe(-1);
    for (let x = 560; x >= 440; x--) {
      const g = select(map, [400, 400], [x, x])!.geometry as {
        polygons: number[][][][];
      };
      // The far corner's place, as the outline traces it.
      const far = map.pick(x - 0.5, x - 0.5)!;
      const nearest = Math.min(
        ...g.polygons[0]
          .at(-1)!
          .map(([lon, lat]) =>
            Math.hypot(lat - far.lat, (lon - far.lon) * Math.cos(far.lat * DEG))
          )
      );
      expect(nearest).toBeLessThan(0.5);
    }
  });
});

describe("a drawn box's outline as shown", () => {
  it("leaves out the cut to the pole it goes round, and the pole", () => {
    const g = select(globe(-1), [400, 400], [600, 600])!.geometry as {
      polygons: number[][][][];
    };
    const edges = drawnOutline(g.polygons);
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      for (const p of edge) {
        expect(Math.abs(p.lat)).toBeLessThan(90);
      }
    }
    // Steps of a degree at most: it curves on other maps as the region
    // (straight in latitude/longitude) does.
    for (const edge of edges) {
      for (let k = 1; k < edge.length; k++) {
        const dLon = Math.abs(edge[k].lon - edge[k - 1].lon) % 360;
        expect(Math.min(dLon, 360 - dLon)).toBeLessThanOrEqual(1 + 1e-9);
        expect(Math.abs(edge[k].lat - edge[k - 1].lat)).toBeLessThanOrEqual(
          1 + 1e-9
        );
      }
    }
    // Every point shown is on the rectangle's own outline: the cut from
    // corner 1 to the pole (crossing its inside) is not drawn.
    const map = globe(-1);
    for (const p of edges.flat()) {
      const s = map.project(p.lat, p.lon);
      const onSide = Math.min(
        Math.abs(s.x - 400),
        Math.abs(s.x - 600),
        Math.abs(s.y - 400),
        Math.abs(s.y - 600)
      );
      expect(onSide).toBeLessThan(0.5);
    }
  });
});

describe("boxes starting at a pole (review of interim5)", () => {
  for (const pole of [-1, 1] as const) {
    it(`${pole < 0 ? "South" : "North"} Pole: from it and toward it alike`, () => {
      const map = globe(pole);
      // Corner 1 on the pole (500, 500), 140 × 140 px, and the reverse.
      const out = select(map, [500, 500], [640, 640]);
      const back = select(map, [640, 640], [500, 500]);
      expect(out).toBeDefined();
      expect(back).toBeDefined();
      const inner = map.pick(570, 570)!;
      const outer = map.pick(430, 570)!;
      for (const g of [out!.geometry, back!.geometry]) {
        expect(holds(g, inner.lat, inner.lon)).toBe(true);
        expect(holds(g, outer.lat, outer.lon)).toBe(false);
      }
    });
  }

  it("keeps a box within the last degree at close zoom, edges and all", () => {
    // 1° of latitude is about 520 px: a box 0.2°–0.6° from the pole.
    const map = globe(-1, 30_000);
    const g = select(map, [600, 560], [800, 760])!.geometry;
    if (g.kind !== GEOMETRY_KINDS.SHAPE) {
      throw new Error("expected a drawn shape");
    }
    const inner = map.pick(700, 660)!;
    expect(holds(g, inner.lat, inner.lon)).toBe(true);
    expect(holds(g, -89.999, 0)).toBe(false);
    // Its outline is drawn the whole way round: no piece cut away.
    const shown = drawnOutline(g.polygons).flat();
    const sides = [600, 800, 560, 760];
    for (const p of shown) {
      const s = map.project(p.lat, p.lon);
      const off = Math.min(
        Math.abs(s.x - 600),
        Math.abs(s.x - 800),
        Math.abs(s.y - 560),
        Math.abs(s.y - 760)
      );
      expect(off).toBeLessThan(0.5);
    }
    expect(shown.length).toBeGreaterThan(sides.length * 10);
  });
});

describe("a box drawn on a latitude/longitude map previews as its rectangle", () => {
  it("is the rectangle clipped to the map, with the box's own edges", () => {
    // From 30°N 120°W past the bottom-right: clipped at the map's corner.
    const s = select(flat, [120, 120], [900, 500])!;
    const { x0, y0, x1, y1 } = s.screen!;
    [x0, y0, x1, y1].forEach((v, k) =>
      expect(v).toBeCloseTo([120, 120, 720, 360][k], 3)
    );
    expect(s.geometry).toMatchObject({ south: -90, east: 180 });
    // South at the pole: no edge there; a band has no sides.
    const box = s.geometry as { south: number; north: number };
    expect(box.south).toBe(-90);
    const shown = screenBoxPaths(s.screen!, [1, 2, 3], { x: 100, y: 10 });
    expect(shown.paths).toEqual([
      "M620.0,350.0V110.0",
      "M20.0,110.0H620.0",
      "M20.0,110.0V350.0",
    ]);
    expect(shown.ring).toEqual(["M20.0,110.0H620.0V350.0H20.0Z"]);
  });
});

describe("a pole strictly inside a small box (review of interim7)", () => {
  for (const pole of [-1, 1] as const) {
    it(`${pole < 0 ? "South" : "North"} Pole: a grid centre at exactly ${pole * 90}° is in`, () => {
      const g = select(globe(pole), [492, 492], [508, 508])!.geometry;
      for (const lon of [0, 45, 123, -180]) {
        expect(holds(g, pole * 90, lon)).toBe(true);
      }
    });
  }
});

describe("bounds for plots along latitude or longitude (review of interim7)", () => {
  for (const pole of [-1, 1] as const) {
    it(`${pole < 0 ? "South" : "North"} Pole on a side: 180° of longitude, not all`, () => {
      const map = globe(pole);
      // The pole (500, 500) on the rectangle's top side.
      const s = rectangleSelection(
        map.pick,
        map.project,
        { x: 450, y: 500 },
        { x: 640, y: 640 },
        true
      )!;
      expect(s.geometry.kind).toBe(GEOMETRY_KINDS.BOX);
      const box = s.geometry as Parameters<typeof boxLonSpan>[0] & {
        south: number;
        north: number;
      };
      expect(Math.abs(boxLonSpan(box) - 180)).toBeLessThan(1);
      expect(pole < 0 ? box.south : box.north).toBe(pole * 90);
    });
  }
});

describe("an edge that ends at a pole keeps its end (review of interim7)", () => {
  it("draws a corner on the South Pole right up to it", () => {
    const g = select(globe(-1), [500, 500], [640, 640])!.geometry;
    if (g.kind !== GEOMETRY_KINDS.SHAPE) {
      throw new Error("expected a drawn shape");
    }
    const points = drawnOutline(g.polygons).flat();
    expect(points.some((p) => p.lat === -90)).toBe(true);
    // And no line along the pole or back to the start: every point is on
    // the rectangle's own sides.
    const map = globe(-1);
    for (const p of points) {
      const at = map.project(p.lat, p.lon);
      const off = Math.min(
        Math.abs(at.x - 500),
        Math.abs(at.x - 640),
        Math.abs(at.y - 500),
        Math.abs(at.y - 640)
      );
      expect(off).toBeLessThan(0.5);
    }
  });
});

describe("an edge passing a pole by a fraction of a pixel (review of interim8)", () => {
  for (const pole of [-1, 1] as const) {
    const name = pole < 0 ? "South" : "North";
    it(`${name} Pole 0.3 px outside: no pole-row cell; 0.3 px inside: all`, () => {
      // Radius 1,700 px, the pole at (500, 500): 1° is about 30 px.
      const map = globe(pole, 1700);
      // The pole at mid-height, 0.3 px left of the box or
      // 0.3 px inside it.
      const out = select(map, [500.3, 483], [539, 515])!.geometry;
      const into = select(map, [499.7, 483], [539, 515])!.geometry;
      const lons = Array.from({ length: 36 }, (_, k) => -175 + 10 * k);
      expect(lons.filter((lon) => holds(out, pole * 90, lon))).toEqual([]);
      expect(lons.filter((lon) => !holds(into, pole * 90, lon))).toEqual([]);
    });
  }

  it("a 4 × 4 px box round the pole appears and holds it", () => {
    const map = globe(-1, 1700);
    const tiny = select(map, [498, 498], [502, 502]);
    expect(tiny).toBeDefined();
    expect(holds(tiny!.geometry, -90, 77)).toBe(true);
  });

  it("a Hovmöller box with the pole 0.1 px inside spans all longitudes", () => {
    const map = globe(-1);
    const s = rectangleSelection(
      map.pick,
      map.project,
      { x: 450, y: 499.9 },
      { x: 640, y: 640 },
      true
    )!;
    expect(boxLonSpan(s.geometry as Parameters<typeof boxLonSpan>[0])).toBe(
      360
    );
  });
});

describe("a full-width strip on a tilted map (review of interim8)", () => {
  it("draws only its top edge, not the map's seam inside it", () => {
    // 1,450 × 725 px, centred 0.5°S: the strip from y 618 past the bottom
    // and both sides.
    const view = geoEquirectangular()
      .rotate([0, 0.5])
      .scale(1450 / (2 * Math.PI))
      .translate([725, 362.5]);
    const map = {
      pick: (x: number, y: number) => {
        if (x < 0 || x > 1450 || y < 0 || y > 725) {
          return null;
        }
        const ll = view.invert!([x, y]);
        const back = ll && view(ll);
        return ll && back && Math.hypot(back[0] - x, back[1] - y) < 1e-6
          ? { lat: ll[1], lon: ll[0] }
          : null;
      },
      project: (lat: number, lon: number) => {
        const [x, y] = view([lon, lat])!;
        return { x, y, visible: true };
      },
    };
    const g = rectangleSelection(
      map.pick,
      map.project,
      { x: 0, y: 618 },
      { x: 1455, y: 730 },
      false,
      true
    )!.geometry;
    if (g.kind !== GEOMETRY_KINDS.SHAPE) {
      throw new Error("expected a drawn shape");
    }
    const shown = drawnOutline(g.polygons).flat();
    expect(shown.length).toBeGreaterThan(100);
    const off = shown.map((p) => Math.abs(map.project(p.lat, p.lon).y - 618));
    expect(Math.max(...off)).toBeLessThan(1);
  });
});

/**
 * A camera `distance` Earth radii from the centre, straight above a pole
 * (`pole` −1 south, 1 north), 7.5° vertical field of view on a 720 × 360
 * view: the pole at (360, 180), a degree hundreds of pixels wide.
 */
function closeCamera(pole: 1 | -1, distance: number) {
  const focal = 180 / Math.tan((7.5 / 2) * DEG);
  return {
    pick: (x: number, y: number) => {
      // The ray from the camera through the pixel, against the sphere.
      const dir = [(x - 360) / focal, (pole * (y - 180)) / focal, -1];
      const a = dir[0] ** 2 + dir[1] ** 2 + 1;
      const b = -2 * distance;
      const disc = b * b - 4 * a * (distance ** 2 - 1);
      if (disc < 0) {
        return null;
      }
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      const [px, py, pz] = [t * dir[0], t * dir[1], distance - t];
      return {
        lat: pole * (90 - Math.acos(Math.max(-1, Math.min(1, pz))) / DEG),
        lon: Math.atan2(px, py) / DEG,
      };
    },
    project: (lat: number, lon: number) => {
      const c = (90 - pole * lat) * DEG;
      const [px, py, pz] = [
        Math.sin(c) * Math.sin(lon * DEG),
        Math.sin(c) * Math.cos(lon * DEG),
        Math.cos(c),
      ];
      const depth = distance - pz;
      return {
        x: 360 + (focal * px) / depth,
        y: 180 + (pole * focal * py) / depth,
        visible: pz * distance > 1,
      };
    },
  };
}

describe("a pole at close zoom is in or out as drawn (review of interim10)", () => {
  const lons = Array.from({ length: 360 }, (_, k) => -179.5 + k);
  const polar = (geometry: TGeometry | undefined, lat: number) =>
    lons.filter((lon) => holds(geometry, lat, lon)).length;
  for (const pole of [-1, 1] as const) {
    it(`${pole < 0 ? "South" : "North"} Pole: 0.3 px out holds none of its row, 0.3 px in all`, () => {
      const map = closeCamera(pole, 1.0005);
      const out = select(map, [360.3, 163], [399, 195]);
      const into = select(map, [359.7, 163], [399, 195]);
      expect(out?.geometry).toBeDefined();
      expect(polar(out!.geometry, pole * 90)).toBe(0);
      expect(polar(into!.geometry, pole * 90)).toBe(360);
      // Reversed drags agree.
      expect(
        polar(select(map, [399, 195], [360.3, 163])!.geometry, pole * 90)
      ).toBe(0);
      expect(
        polar(select(map, [399, 195], [359.7, 163])!.geometry, pole * 90)
      ).toBe(360);
    });
  }

  it("a whole pixel either side at 1.0002 radii", () => {
    const map = closeCamera(1, 1.0002);
    expect(polar(select(map, [361, 163], [399, 195])!.geometry, 90)).toBe(0);
    expect(polar(select(map, [359, 163], [399, 195])!.geometry, 90)).toBe(360);
  });

  it("an axis box with the South Pole 0.3 px inside its top spans all longitudes", () => {
    const map = closeCamera(-1, 1.0005);
    const s = rectangleSelection(
      map.pick,
      map.project,
      { x: 330, y: 179.7 },
      { x: 400, y: 215 },
      true
    )!;
    expect(boxLonSpan(s.geometry as Parameters<typeof boxLonSpan>[0])).toBe(
      360
    );
  });
});

describe("an equatorial edge is not a pole (review of interim10)", () => {
  it("a box with an exactly equatorial side reaches no pole", () => {
    // A globe looking at (0°, 0°): radius 300 px at (360, 180).
    const radius = 300;
    const map = {
      pick: (x: number, y: number) => {
        const [u, v] = [(x - 360) / radius, (180 - y) / radius];
        if (u * u + v * v > 1) {
          return null;
        }
        const lat = Math.asin(v) / DEG;
        return { lat, lon: Math.asin(u / Math.cos(lat * DEG)) / DEG };
      },
      project: (lat: number, lon: number) => ({
        x: 360 + radius * Math.cos(lat * DEG) * Math.sin(lon * DEG),
        y: 180 - radius * Math.sin(lat * DEG),
        visible: Math.cos(lat * DEG) * Math.cos(lon * DEG) > 0,
      }),
    };
    for (const exact of [0, 0.00001]) {
      const s = rectangleSelection(
        map.pick,
        map.project,
        { x: 348, y: 168 + exact },
        { x: 372, y: 192 + exact },
        true
      )!;
      const box = s.geometry as { south: number; north: number };
      expect(box.south).toBeGreaterThan(-5);
      expect(box.north).toBeLessThan(5);
    }
  });
});

describe("a box a few thousandths of a degree across keeps its outline (review of interim10)", () => {
  it("outlines all four sides of a small tilted footprint", () => {
    // A rectangle tilted by 20°, 0.004° × 0.007°, at 0.25°N, 21.1°E.
    const [lat0, lon0, t] = [0.25, 21.1, 20 * DEG];
    const corner = (u: number, v: number) => [
      lon0 + u * Math.cos(t) - v * Math.sin(t),
      lat0 + u * Math.sin(t) + v * Math.cos(t),
    ];
    const ring = [
      corner(-0.002, -0.0035),
      corner(0.002, -0.0035),
      corner(0.002, 0.0035),
      corner(-0.002, 0.0035),
      corner(-0.002, -0.0035),
    ];
    const runs = drawnOutline([[ring]]);
    expect(runs.length).toBe(1);
    // One closed run round all four corners.
    const run = runs[0];
    for (const [lon, lat] of ring.slice(0, 4)) {
      expect(run.some((p) => Math.hypot(p.lat - lat, p.lon - lon) < 1e-9)).toBe(
        true
      );
    }
  });
});

/** An orthographic globe centred at 40°N, 10°E: 1 px ≈ 0.0002°. */
function globeAt40N() {
  const radius = 300_000;
  const [p0, l0] = [40 * DEG, 10 * DEG];
  return {
    pick: (x: number, y: number) => {
      const [u, v] = [(x - 360) / radius, (180 - y) / radius];
      const r = Math.hypot(u, v);
      if (r > 1) {
        return null;
      }
      const c = Math.asin(r);
      const lat = Math.asin(
        Math.cos(c) * Math.sin(p0) + (r && (v * Math.sin(c) * Math.cos(p0)) / r)
      );
      const lon =
        l0 +
        Math.atan2(
          u * Math.sin(c),
          r * Math.cos(p0) * Math.cos(c) - v * Math.sin(p0) * Math.sin(c)
        );
      return { lat: lat / DEG, lon: lon / DEG };
    },
    project: (lat: number, lon: number) => {
      const [p, l] = [lat * DEG, lon * DEG - l0];
      return {
        x: 360 + radius * Math.cos(p) * Math.sin(l),
        y:
          180 -
          radius *
            (Math.cos(p0) * Math.sin(p) -
              Math.sin(p0) * Math.cos(p) * Math.cos(l)),
        visible:
          Math.sin(p0) * Math.sin(p) +
            Math.cos(p0) * Math.cos(p) * Math.cos(l) >
          0,
      };
    },
  };
}

describe("a small box's label tells its ends apart (review of interim10)", () => {
  it("is not 40°N–40°N | 10°E to 10°E", () => {
    const map = globeAt40N();
    const s = rectangleSelection(
      map.pick,
      map.project,
      { x: 310, y: 130 },
      { x: 410, y: 230 }
    )!;
    expect(s.label).not.toMatch(/40°N–40°N/);
    expect(s.label).not.toMatch(/10°E to 10°E/);
    expect(s.label).toMatch(/39\.99\d*°N–40\.0\d*°N/);
    // And it keeps its outline once committed.
    const g = s.geometry as { polygons: number[][][][] };
    expect(drawnOutline(g.polygons).length).toBeGreaterThan(0);
  });
});

it("keeps a tiny box tiny, whichever way it is dragged (review of interim35)", async () => {
  const { geoOrthographic } = await import("d3-geo");
  // Close in at 0°N, 0°E: 8 px span about 0.00001°.
  const scale = 8 / (1e-5 * DEG);
  const projection = geoOrthographic()
    .scale(scale)
    .translate([768, 425])
    .rotate([0, 0]);
  const close = {
    pick: (x: number, y: number) => {
      const ll = projection.invert!([x, y]);
      return ll && Number.isFinite(ll[0]) ? { lat: ll[1], lon: ll[0] } : null;
    },
    project: (lat: number, lon: number) => {
      const p = projection([lon, lat]);
      const visible = Math.cos(lat * DEG) * Math.cos(lon * DEG) > 0;
      return p ? { x: p[0], y: p[1], visible } : null;
    },
  };
  for (const [from, to] of [
    [
      { x: 764, y: 421 },
      { x: 772, y: 429 },
    ],
    [
      { x: 772, y: 429 },
      { x: 764, y: 421 },
    ],
  ]) {
    const selection = rectangleSelection(close.pick, close.project, from, to);
    const geometry = selection?.geometry as TGeometry & {
      polygons?: number[][][][];
    };
    expect(geometry?.polygons).toBeDefined();
    const region = prepareCountry(geometry.polygons!);
    // The box's own middle, and nothing a degree away.
    expect(countryContains(region, 0, 0)).toBe(true);
    for (const [lat, lon] of [
      [1, 1],
      [-1, 0],
      [10, 100],
      [-60, -150],
    ]) {
      expect(countryContains(region, lat, lon)).toBe(false);
    }
  }
});

it("selects the centres the camera shows in a tiny box at the pole (review of interim37)", async () => {
  const { geoOrthographic } = await import("d3-geo");
  // Close in near the North Pole: 8 px about 0.00002°.
  const scale = 8 / (2e-5 * DEG);
  const projection = geoOrthographic()
    .scale(scale)
    .translate([768, 425])
    .rotate([0, -89.999925]);
  const close = {
    pick: (x: number, y: number) => {
      const ll = projection.invert!([x, y]);
      return ll && Number.isFinite(ll[0]) ? { lat: ll[1], lon: ll[0] } : null;
    },
    project: (lat: number, lon: number) => {
      const p = projection([lon, lat]);
      return p ? { x: p[0], y: p[1], visible: true } : null;
    },
  };
  const [from, to] = [
    { x: 764, y: 421 },
    { x: 772, y: 429 },
  ];
  const geometry = rectangleSelection(close.pick, close.project, from, to)
    ?.geometry as TGeometry;
  // Rows a millionth of a degree apart, a centre every degree of longitude.
  let [camera, chosen, disagree] = [0, 0, 0];
  for (let k = 0; k <= 300; k++) {
    const lat = 89.9997 + k * 1e-6;
    for (let lon = -180; lon < 180; lon++) {
      const p = projection([lon, lat])!;
      const seen = p[0] >= 764 && p[0] <= 772 && p[1] >= 421 && p[1] <= 429;
      const inside = holds(geometry, lat, lon);
      camera += seen ? 1 : 0;
      chosen += inside ? 1 : 0;
      // Half a pixel from an edge may go either way.
      const margin =
        Math.min(
          Math.abs(p[0] - 764),
          Math.abs(p[0] - 772),
          Math.abs(p[1] - 421),
          Math.abs(p[1] - 429)
        ) < 0.5;
      disagree += seen !== inside && !margin ? 1 : 0;
    }
  }
  expect(camera).toBeGreaterThan(0);
  expect(disagree).toBe(0);
  expect(Math.abs(chosen - camera)).toBeLessThanOrEqual(camera * 0.1);
});

// eslint-disable-next-line max-lines-per-function -- one camera, two rectangles.
it("review of interim43: lights and computes the same centres near the pole, to a hundredth of a pixel", async () => {
  const { geoOrthographic } = await import("d3-geo");
  const scale = 8 / (2e-5 * DEG);
  const projection = geoOrthographic()
    .scale(scale)
    .translate([768, 425])
    .rotate([0, -89.999925]);
  const pick = (x: number, y: number) => {
    const ll = projection.invert!([x, y]);
    return ll && Number.isFinite(ll[0]) ? { lat: ll[1], lon: ll[0] } : null;
  };
  const project = (lat: number, lon: number) => {
    const p = projection([lon, lat]);
    return p ? { x: p[0], y: p[1], visible: true } : null;
  };
  let vertices = 0;
  for (const [from, to] of [
    [
      { x: 764, y: 421 },
      { x: 772, y: 429 },
    ],
    [
      { x: 761, y: 418 },
      { x: 775, y: 431 },
    ],
  ]) {
    // As committed (exact), what the mean is computed for.
    const geometry = rectangleSelection(pick, project, from, to, false, true)
      ?.geometry as TGeometry & { polygons?: number[][][][] };
    vertices = Math.max(
      vertices,
      ...(geometry.polygons?.[0] ?? []).map((ring) => ring.length)
    );
    let disagree = 0;
    for (let k = 0; k <= 300; k++) {
      const lat = 89.9997 + k * 1e-6;
      // Centres on half degrees of longitude.
      for (let lon = -179.5; lon < 180; lon++) {
        const p = projection([lon, lat])!;
        const seen =
          p[0] >= from.x && p[0] <= to.x && p[1] >= from.y && p[1] <= to.y;
        const margin =
          Math.min(
            Math.abs(p[0] - from.x),
            Math.abs(p[0] - to.x),
            Math.abs(p[1] - from.y),
            Math.abs(p[1] - to.y)
          ) < 0.01;
        disagree += seen !== holds(geometry, lat, lon) && !margin ? 1 : 0;
      }
    }
    expect(disagree, `${from.x},${from.y}`).toBe(0);
  }
  // Still an outline of modest size.
  expect(vertices).toBeLessThan(5000);
});
