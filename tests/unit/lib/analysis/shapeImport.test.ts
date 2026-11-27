import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { shapeRings } from "@/lib/analysis/countryGeoJSON.ts";
import {
  countryContains,
  prepareCountry,
} from "@/lib/analysis/countryRegion.ts";
import {
  importShapeFiles,
  ShapeImportError,
  shapeDigest,
  shapeOfFeatures,
} from "@/lib/analysis/shapeImport.ts";

const file = (name: string, content: string | Uint8Array) => {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () =>
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer,
  };
};

// A 10° square around (5° E, 5° N), and a hole in it.
const square = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];
const hole = [
  [4, 4],
  [4, 6],
  [6, 6],
  [6, 4],
  [4, 4],
];

// eslint-disable-next-line max-lines-per-function
describe("importing shapes", () => {
  // eslint-disable-next-line max-lines-per-function
  it("reads GeoJSON polygons and multipolygons, named, skipping points", async () => {
    const collection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Square" },
          geometry: { type: "Polygon", coordinates: [square, hole] },
        },
        {
          type: "Feature",
          properties: { NAME: "Two" },
          geometry: {
            type: "MultiPolygon",
            coordinates: [[square], [square.map(([x, y]) => [x + 20, y])]],
          },
        },
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [1, 1] },
        },
      ],
    };
    const shape = await importShapeFiles([
      file("regions.geojson", JSON.stringify(collection)),
    ]);
    expect(shape.features.map((f) => f.name)).toEqual(["Square", "Two"]);
    expect(shape.features[0].polygons[0]).toHaveLength(2);
    expect(shape.features[1].polygons).toHaveLength(2);
    expect(shape.skipped).toBe(1);
    const all = shapeOfFeatures(shape, "all");
    expect(all.name).toBe("regions");
    expect(all.polygons).toHaveLength(3);
    expect(shapeOfFeatures(shape, 1).name).toBe("Two");
    const some = shapeOfFeatures(shape, [1, 0, 1]);
    expect(some.polygons).toEqual([
      ...shapeOfFeatures(shape, 0).polygons,
      ...shapeOfFeatures(shape, 1).polygons,
    ]);
    expect(some.name).toBe("regions");
    const five = {
      file: "districts.geojson",
      skipped: 0,
      features: ["A", "B", "C", "D", "E"].map((name) => ({
        name,
        points: 4,
        polygons: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      })),
    };
    expect(shapeOfFeatures(five, [2, 0]).name).toBe("A + C");
    expect(shapeOfFeatures(five, [0, 1, 2, 3]).name).toBe(
      "districts: 4 of 5 areas"
    );
    // Gridlook's own selection download, imported again, keeps its name.
    const exported = await importShapeFiles([
      file(
        "selection.geojson",
        JSON.stringify({
          type: "Feature",
          // eslint-disable-next-line camelcase
          properties: { shape_name: "Sahara" },
          geometry: { type: "MultiPolygon", coordinates: [[square, hole]] },
        })
      ),
    ]);
    expect(exported.features.map((f) => f.name)).toEqual(["Sahara"]);
  });

  it("refuses projected coordinates and a projected crs with a reason", async () => {
    const projected = {
      type: "Polygon",
      coordinates: [
        [
          [652340, 5781230],
          [662340, 5781230],
          [662340, 5791230],
          [652340, 5781230],
        ],
      ],
    };
    await expect(
      importShapeFiles([file("utm.geojson", JSON.stringify(projected))])
    ).rejects.toThrow(/not longitude\/latitude/);
    await expect(
      importShapeFiles([
        file(
          "old.geojson",
          JSON.stringify({
            type: "Polygon",
            coordinates: [square],
            crs: { type: "name", properties: { name: "EPSG:3857" } },
          })
        ),
      ])
    ).rejects.toThrow(/WGS 84/);
    await expect(
      importShapeFiles([
        file("dots.geojson", '{"type":"Point","coordinates":[1,2]}'),
      ])
    ).rejects.toThrow(/only points or lines/);
    await expect(importShapeFiles([file("notes.txt", "x")])).rejects.toThrow(
      ShapeImportError
    );
  });

  it("refuses an archive by its expanded size, before inflating it", async () => {
    const zip = zipSync({ "big.geojson": new TextEncoder().encode("{}") });
    // Claim 3.75 GB uncompressed in the central directory entry.
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let at = zip.length - 22; at >= 0; at--) {
      if (view.getUint32(at, true) === 0x02014b50) {
        view.setUint32(at + 24, 0xf0000000, true);
        break;
      }
    }
    await expect(importShapeFiles([file("bomb.zip", zip)])).rejects.toThrow(
      /expands to more than 200 MB/
    );
  });

  it("stops reading as soon as the point budget is passed", async () => {
    const ring = Array.from({ length: 500_001 }, (_, i) => [
      (i / 500_001) * 10,
      (i % 2) * 0.001,
    ]);
    await expect(
      importShapeFiles([
        file(
          "dense.geojson",
          JSON.stringify({ type: "Polygon", coordinates: [ring] })
        ),
      ])
    ).rejects.toThrow(/500,000 points or more/);
  });

  it("reads KML placemarks, and KMZ archives", async () => {
    const coords = (ring: number[][]) => ring.map((p) => p.join(",")).join(" ");
    const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      <Placemark><name><![CDATA[Lake area]]></name><Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${coords(square)}</coordinates></LinearRing></outerBoundaryIs>
        <innerBoundaryIs><LinearRing><coordinates>${coords(hole)}</coordinates></LinearRing></innerBoundaryIs>
      </Polygon></Placemark>
      <Placemark><name>Pin</name><Point><coordinates>1,1</coordinates></Point></Placemark>
    </Document></kml>`;
    const shape = await importShapeFiles([file("area.kml", kml)]);
    expect(shape.features).toHaveLength(1);
    expect(shape.features[0].name).toBe("Lake area");
    expect(shape.features[0].polygons[0]).toHaveLength(2);
    expect(shape.skipped).toBe(1);
    const kmz = zipSync({ "doc.kml": new TextEncoder().encode(kml) });
    const zipped = await importShapeFiles([file("area.kmz", kmz)]);
    expect(zipped.features[0].polygons).toEqual(shape.features[0].polygons);
  });

  it("reads a Shapefile set (holes joined to their ring, names from .dbf)", async () => {
    // Shapefile rings: outer clockwise, hole counterclockwise.
    const outer = [...square].reverse();
    const shp = shapefile([[outer, [...hole].reverse()]]);
    const dbf = dbfNames(["Basin"]);
    const prj = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984"]]';
    const shape = await importShapeFiles([
      file("basins.shp", shp),
      file("basins.dbf", dbf),
      file("basins.prj", prj),
    ]);
    expect(shape.features).toHaveLength(1);
    expect(shape.features[0].name).toBe("Basin");
    expect(shape.features[0].polygons).toHaveLength(1);
    expect(shape.features[0].polygons[0]).toHaveLength(2);
    // The same set zipped.
    const zip = zipSync({ "basins.shp": shp, "basins.dbf": dbf });
    expect(
      (await importShapeFiles([file("basins.zip", zip)])).features[0].name
    ).toBe("Basin");
    // A projected.prj is refused.
    await expect(
      importShapeFiles([
        file("utm.shp", shp),
        file("utm.prj", 'PROJCS["WGS_1984_UTM_Zone_32N",GEOGCS["WGS84"]]'),
      ])
    ).rejects.toThrow(/WGS 84/);
    // A.dbf without its.shp says what is missing.
    await expect(importShapeFiles([file("basins.dbf", dbf)])).rejects.toThrow(
      /needs its \.shp/
    );
  });

  it("prepares the shape like a country: inside, the hole and outside", async () => {
    const shape = await importShapeFiles([
      file(
        "s.geojson",
        JSON.stringify({ type: "Polygon", coordinates: [square, hole] })
      ),
    ]);
    const region = prepareCountry(
      shapeRings(shapeOfFeatures(shape, 0).polygons, "s")
    );
    expect(countryContains(region, 2, 2)).toBe(true);
    expect(countryContains(region, 5, 5)).toBe(false);
    expect(countryContains(region, 20, 20)).toBe(false);
    // Wound clockwise (D3's order) or counterclockwise (RFC 7946): the same.
    const reversed = prepareCountry(shapeRings([[[...square].reverse()]], "r"));
    expect(countryContains(reversed, 2, 2)).toBe(true);
    expect(countryContains(reversed, 20, 20)).toBe(false);
    expect(shapeDigest([[square]])).toBe(shapeDigest([[square]]));
    expect(shapeDigest([[square]])).not.toBe(shapeDigest([[square, hole]]));
  });

  it("clips a hole across the antimeridian with its exterior: a notch, no touching ring (v24 review)", () => {
    const rect = (w: number, e: number, south: number, north: number) => [
      [w, south],
      [e, south],
      [e, north],
      [w, north],
      [w, south],
    ];
    const out = shapeRings(
      [[rect(170, 190, -10, 10), rect(175, 185, -5, 5).reverse()]],
      "h"
    );
    expect(out).toHaveLength(2);
    const area = (ring: number[][]) =>
      ring
        .slice(1)
        .reduce(
          (sum, p, at) => sum + ring[at][0] * p[1] - p[0] * ring[at][1],
          0
        ) / 2;
    for (const polygon of out) {
      // One ring: the hole is part of the outline, not a ring touching it.
      expect(polygon).toHaveLength(1);
      expect(area(polygon[0])).toBeCloseTo(150, 6);
      // A simple ring: no vertex twice but the closing one.
      const keys = polygon[0].slice(0, -1).map((p) => p.join(","));
      expect(new Set(keys).size).toBe(keys.length);
    }
    const region = prepareCountry(out);
    expect(countryContains(region, 0, 172)).toBe(true);
    expect(countryContains(region, 0, -172)).toBe(true);
    expect(countryContains(region, 8, 179.5)).toBe(true);
    expect(countryContains(region, 0, 177)).toBe(false);
    expect(countryContains(region, 0, -177)).toBe(false);
  });

  it("splits a shape across the antimeridian; KML edges go the short way", async () => {
    // GeoJSON past 180° (RFC 7946 edges are straight: 175° to 185°).
    const fiji = [
      [175, -20],
      [185, -20],
      [185, -15],
      [175, -15],
      [175, -20],
    ];
    const region = prepareCountry(shapeRings([[fiji]], "across"));
    expect(countryContains(region, -17, 178)).toBe(true);
    expect(countryContains(region, -17, -178)).toBe(true);
    expect(countryContains(region, -17, 0)).toBe(false);
    // The same in KML written 175° → −175°: the short way, across.
    const coords = [
      [175, -20],
      [-175, -20],
      [-175, -15],
      [175, -15],
      [175, -20],
    ]
      .map((p) => p.join(","))
      .join(" ");
    const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>Fiji</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
    const imported = await importShapeFiles([file("fiji.kml", kml)]);
    const kmlRegion = prepareCountry(
      shapeRings(shapeOfFeatures(imported, 0).polygons, "fiji")
    );
    expect(countryContains(kmlRegion, -17, 178)).toBe(true);
    expect(countryContains(kmlRegion, -17, -178)).toBe(true);
    expect(countryContains(kmlRegion, -17, 0)).toBe(false);
  });
});

/** A minimal polygon Shapefile (.shp) with the given records' rings. */
function shapefile(records: number[][][][]) {
  const contents = records.map((rings) => {
    const points = rings.flat();
    const bytes = new ArrayBuffer(44 + 4 * rings.length + 16 * points.length);
    const view = new DataView(bytes);
    view.setInt32(0, 5, true);
    view.setInt32(36, rings.length, true);
    view.setInt32(40, points.length, true);
    let start = 0;
    rings.forEach((ring, r) => {
      view.setInt32(44 + 4 * r, start, true);
      start += ring.length;
    });
    points.forEach(([x, y], k) => {
      view.setFloat64(44 + 4 * rings.length + 16 * k, x, true);
      view.setFloat64(52 + 4 * rings.length + 16 * k, y, true);
    });
    return new Uint8Array(bytes);
  });
  const length = 100 + contents.reduce((n, c) => n + 8 + c.byteLength, 0);
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setInt32(0, 9994, false);
  view.setInt32(24, length / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, 5, true);
  let at = 100;
  contents.forEach((content, r) => {
    view.setInt32(at, r + 1, false);
    view.setInt32(at + 4, content.byteLength / 2, false);
    out.set(content, at + 8);
    at += 8 + content.byteLength;
  });
  return out;
}

/** A minimal.dbf with one character column NAME. */
function dbfNames(names: string[]) {
  const size = 20;
  const header = 32 + 32 + 1;
  const record = 1 + size;
  const out = new Uint8Array(header + record * names.length + 1);
  const view = new DataView(out.buffer);
  out[0] = 3;
  view.setUint32(4, names.length, true);
  view.setUint16(8, header, true);
  view.setUint16(10, record, true);
  out.set(new TextEncoder().encode("NAME"), 32);
  out[32 + 11] = "C".charCodeAt(0);
  out[32 + 16] = size;
  out[64] = 0x0d;
  names.forEach((name, r) => {
    const at = header + r * record;
    out[at] = 0x20;
    out.set(new TextEncoder().encode(name.padEnd(size)), at + 1);
  });
  out[out.length - 1] = 0x1a;
  return out;
}

// eslint-disable-next-line max-lines-per-function
describe("imported polygons keep their meaning (v20 reviews)", () => {
  const inside = (polygons: number[][][][], lat: number, lon: number) =>
    countryContains(prepareCountry(shapeRings(polygons, "test")), lat, lon);
  const rectangle = (
    west: number,
    east: number,
    south: number,
    north: number
  ) => [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ];

  it("edges are straight in longitude and latitude: 100° W to 100° E holds Greenwich", () => {
    const box = [rectangle(-100, 100, -20, 20)];
    expect(inside(box, 0, 0)).toBe(true);
    expect(inside(box, 0, 120)).toBe(false);
  });

  it("a ring larger than a hemisphere is not turned into its complement", () => {
    // Counterclockwise, −150°..150°, −60°..60°, with points along the edges.
    const ring = [
      [-150, -60],
      [-75, -60],
      [0, -60],
      [75, -60],
      [150, -60],
      [150, 60],
      [75, 60],
      [0, 60],
      [-75, 60],
      [-150, 60],
      [-150, -60],
    ];
    for (const winding of [ring, [...ring].reverse()]) {
      expect(inside([[winding]], 0, 0)).toBe(true);
      expect(inside([[winding]], 0, 179)).toBe(false);
      expect(inside([[winding]], 80, 0)).toBe(false);
    }
  });

  it("re-imports Gridlook's own full-longitude band with its cells inside", () => {
    const band = [rectangle(-180, 180, -10, 10)];
    for (const lon of [-179.5, 0, 90, 179.5]) {
      expect(inside(band, 0, lon)).toBe(true);
    }
    expect(inside(band, 20, 0)).toBe(false);
  });

  it("a shape past 180° E is moved west of the antimeridian", () => {
    const pacific = [rectangle(170, 190, -5, 5)];
    expect(inside(pacific, 0, 175)).toBe(true);
    expect(inside(pacific, 0, -175)).toBe(true);
    expect(inside(pacific, 0, -165)).toBe(false);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("Shapefiles: rings, coordinate system and layers (v20 reviews)", () => {
  const square = (
    west: number,
    south: number,
    size: number,
    clockwise: boolean
  ) => {
    const ring = [
      [west, south],
      [west + size, south],
      [west + size, south + size],
      [west, south + size],
      [west, south],
    ];
    return clockwise ? ring.reverse() : ring;
  };

  it("land, lake, island, pond: the pond is outside, in any ring order", async () => {
    // Nested squares: land 0–40, lake 10–30, island 15–25, pond 18–22.
    const rings = [
      square(0, 0, 40, true),
      square(10, 10, 20, false),
      square(15, 15, 10, true),
      square(18, 18, 4, false),
    ];
    for (const order of [
      rings,
      [...rings].reverse(),
      [rings[2], rings[0], rings[3], rings[1]],
    ]) {
      const imported = await importShapeFiles([
        file("lakes.shp", shapefile([order])),
        file("lakes.dbf", dbfNames(["Lakes"])),
      ]);
      const region = prepareCountry(
        shapeRings(shapeOfFeatures(imported, 0).polygons, "lakes")
      );
      expect(
        [5, 12, 16, 20].map((lon) => countryContains(region, lon, lon))
      ).toEqual([
        true, // land
        false, // lake
        true, // island
        false, // pond
      ]);
    }
  });

  it("refuses a geographic system in grads or from another meridian; WKT2 degrees pass", async () => {
    const shp = shapefile([[square(0, 0, 1, true)]]);
    const paris =
      'GEOGCS["NTF (Paris)",DATUM["Nouvelle_Triangulation_Francaise_Paris",SPHEROID["Clarke 1880 (IGN)",6378249.2,293.4660212936269]],PRIMEM["Paris",2.5969213],UNIT["grad",0.01570796326794897]]';
    await expect(
      importShapeFiles([file("paris.shp", shp), file("paris.prj", paris)])
    ).rejects.toThrow(/Paris meridian/);
    const grads =
      'GEOGCS["x",DATUM["y"],PRIMEM["Greenwich",0],UNIT["grad",0.0157]]';
    await expect(
      importShapeFiles([file("g.shp", shp), file("g.prj", grads)])
    ).rejects.toThrow(/in grad/);
    const wkt2 =
      'GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],CS[ellipsoidal,2],ANGLEUNIT["degree",0.0174532925199433]]';
    const ok = await importShapeFiles([
      file("w.shp", shp),
      file("w.prj", wkt2),
    ]);
    expect(ok.features).toHaveLength(1);
  });

  it("review #32: refuses NAD27 (Clarke 1866); NAD83 (GRS 80) passes", async () => {
    const shp = shapefile([[square(0, 0, 1, true)]]);
    const nad27 =
      'GEOGCS["GCS_North_American_1927",DATUM["D_North_American_1927",SPHEROID["Clarke_1866",6378206.4,294.9786982]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
    await expect(
      importShapeFiles([file("n.shp", shp), file("n.prj", nad27)])
    ).rejects.toThrow(/North American 1927 \(Clarke 1866\) datum, not WGS 84/);
    const nad83 =
      'GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
    const ok = await importShapeFiles([
      file("m.shp", shp),
      file("m.prj", nad83),
    ]);
    expect(ok.features).toHaveLength(1);
  });

  it("review of interim30: GGRS87 on GRS 80 is refused; ETRS89 passes; a WGS 84 with a shift is refused", async () => {
    const shp = shapefile([[square(0, 0, 1, true)]]);
    const ggrs87 =
      'GEOGCS["GGRS87",DATUM["Greek_Geodetic_Reference_System_1987",SPHEROID["GRS 1980",6378137,298.257222101],TOWGS84[-199.87,74.79,246.62,0,0,0,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
    await expect(
      importShapeFiles([file("g.shp", shp), file("g.prj", ggrs87)])
    ).rejects.toThrow(
      /Greek Geodetic Reference System 1987 \(GRS 1980\) datum, not WGS 84/
    );
    const etrs89 =
      'GEOGCS["ETRS89",DATUM["European_Terrestrial_Reference_System_1989",SPHEROID["GRS 1980",6378137,298.257222101],TOWGS84[0,0,0,0,0,0,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
    expect(
      (await importShapeFiles([file("e.shp", shp), file("e.prj", etrs89)]))
        .features
    ).toHaveLength(1);
    const shifted =
      'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563],TOWGS84[10,0,0,0,0,0,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
    await expect(
      importShapeFiles([file("s.shp", shp), file("s.prj", shifted)])
    ).rejects.toThrow(/not WGS 84/);
  });

  it("review #37: a Shapefile cut short is refused, not imported in part", async () => {
    const shp = shapefile([[square(0, 0, 1, true)], [square(5, 5, 1, true)]]);
    expect(
      (await importShapeFiles([file("two.shp", shp)])).features
    ).toHaveLength(2);
    const cut = shp.slice(0, shp.byteLength - 16);
    await expect(importShapeFiles([file("cut.shp", cut)])).rejects.toThrow(
      /cut\.shp is incomplete/
    );
    // Its header mended to the shorter length: the last record still is.
    const mended = cut.slice();
    new DataView(mended.buffer).setInt32(24, mended.byteLength / 2, false);
    await expect(importShapeFiles([file("cut.shp", mended)])).rejects.toThrow(
      /incomplete/
    );
  });

  it("pairs each layer's .dbf by name in a multilayer archive", async () => {
    const zip = zipSync({
      "cities.dbf": dbfNames(["Paris", "Lyon"]),
      "basins.shp": shapefile([[square(0, 0, 1, true)]]),
      "basins.dbf": dbfNames(["Seine basin"]),
    });
    const imported = await importShapeFiles([file("layers.zip", zip)]);
    expect(imported.features.map((f) => f.name)).toEqual(["Seine basin"]);
  });

  it("refuses WKT2 axes in grads beside a prime meridian in degrees (v24 review)", async () => {
    const shp = shapefile([[square(0, 0, 1, true)]]);
    const wkt2 =
      'GEOGCRS["x",DATUM["y",ELLIPSOID["z",6378137,298.25,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],CS[ellipsoidal,2],AXIS["latitude",north,ORDER[1],ANGLEUNIT["grad",0.015707963267949]],AXIS["longitude",east,ORDER[2],ANGLEUNIT["grad",0.015707963267949]]]';
    await expect(
      importShapeFiles([file("g.shp", shp), file("g.prj", wkt2)])
    ).rejects.toThrow(/in grad/);
  });

  it("takes a layer's .dbf from its own directory, not a same-named one elsewhere (v24 review)", async () => {
    const zip = zipSync({
      "a/basins.shp": shapefile([[square(0, 0, 1, true)]]),
      "b/basins.dbf": dbfNames(["Other directory"]),
      "c/rivers.shp": shapefile([[square(2, 2, 1, true)]]),
      "c/rivers.dbf": dbfNames(["Rhône"]),
    });
    const imported = await importShapeFiles([file("layers.zip", zip)]);
    expect(imported.features.map((f) => f.name)).toEqual(["Shape 1"]);
  });

  it("groups 8,000 disjoint rings by a spatial search (v24 review)", async () => {
    // One record of 8,000 small squares on a grid, and a lake in one.
    const rings = Array.from({ length: 8000 }, (_, k) =>
      square((k % 100) * 1.5 - 75, Math.floor(k / 100) * 1 - 40, 0.5, true)
    );
    const lake = square(-74.9, -39.9, 0.2, false);
    const shp = shapefile([[...rings, lake]]);
    const started = performance.now();
    const imported = await importShapeFiles([file("many.shp", shp)]);
    console.info(
      `8,000 rings grouped in ${(performance.now() - started).toFixed(0)} ms`
    );
    const polygons = shapeOfFeatures(imported, 0).polygons;
    expect(polygons).toHaveLength(8000);
    // The lake is a hole of the square around it, of no other.
    expect(polygons.filter((p) => p.length === 2)).toHaveLength(1);
  });
});
