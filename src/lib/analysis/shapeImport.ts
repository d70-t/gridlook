/**
 * Shapes a user imports to plot over: GeoJSON, KML/KMZ and Shapefiles, read
 * in the page (nothing is uploaded). Only polygons count; coordinates must
 * be longitude/latitude in degrees. Anything else gets a plain reason the
 * user can act on.
 */
import { unzipSync } from "fflate";

type TPolygons = number[][][][];

type TImportedFeature = {
  name: string;
  /** GeoJSON MultiPolygon coordinates: polygons, rings, [lon, lat]. */
  polygons: TPolygons;
  points: number;
};

export type TImportedShape = {
  /** The file the shapes came from (the.shp's, for a set). */
  file: string;
  features: TImportedFeature[];
  /** Points, lines and other non-areas the file also held. */
  skipped: number;
};

/** A file that cannot become a shape, with the reason in plain words. */
export class ShapeImportError extends Error {}

/**
 * Larger files and shapes are refused: the page parses them whole. An
 * archive is measured by what it expands to before anything is inflated,
 * and points are counted as rings are read, so a refusal comes early.
 */
const SHAPE_LIMITS = {
  bytes: 50 * 2 ** 20,
  expanded: 200 * 2 ** 20,
  points: 500_000,
};
/** At most this many points in a shape, imported or restored from a link. */
export const SHAPE_POINT_LIMIT = SHAPE_LIMITS.points;

const TOO_MANY_POINTS = (points: number) =>
  `The shape has ${points.toLocaleString("en-US")} points or more, more than ${SHAPE_LIMITS.points.toLocaleString("en-US")}. Simplify it (e.g. with mapshaper.org) and import it again.`;

/** Points read so far in this import. */
let pointsRead = 0;

const SHAPE_FORMATS =
  "GeoJSON, KML/KMZ or a Shapefile (.zip, or .shp with .dbf and .prj)";

/** The file picker's filter. */
export const SHAPE_ACCEPT =
  ".geojson,.json,.kml,.kmz,.zip,.shp,.dbf,.prj,.shx,.cpg";

const NOT_DEGREES =
  "The coordinates are not longitude/latitude in degrees (they look projected, e.g. metres). Export the shape in WGS 84 (EPSG:4326) and import it again.";

type TEntry = { name: string; bytes: Uint8Array };

const extension = (name: string) =>
  name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
const baseName = (name: string) =>
  name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
/** A file's path without its extension: its directory and base name. */
const stemOf = (name: string) =>
  name
    .replace(/\\/g, "/")
    .replace(/\.[^./]+$/, "")
    .toLowerCase();
const text = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

/** Read a picked or dropped file (or a Shapefile's set of files). */
export async function importShapeFiles(
  files: { name: string; arrayBuffer(): Promise<ArrayBuffer>; size: number }[]
): Promise<TImportedShape> {
  if (!files.length) {
    throw new ShapeImportError("Choose a file.");
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > SHAPE_LIMITS.bytes) {
    throw new ShapeImportError(
      `The file is larger than ${SHAPE_LIMITS.bytes / 2 ** 20} MB. Simplify the shape (e.g. with mapshaper.org) and import it again.`
    );
  }
  const entries = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    }))
  );
  return importEntries(expand(entries));
}

/** Zip and KMZ archives become the files they hold. */
function expand(entries: TEntry[]): TEntry[] {
  return entries.flatMap((entry) => {
    if (!["zip", "kmz"].includes(extension(entry.name))) {
      return [entry];
    }
    let inner: Record<string, Uint8Array>;
    let expanded = 0;
    try {
      // The directory gives each file's size: refuse before inflating.
      inner = unzipSync(entry.bytes, {
        filter: (file) => {
          expanded += file.originalSize;
          if (expanded > SHAPE_LIMITS.expanded) {
            throw new ShapeImportError(
              `${entry.name} expands to more than ${SHAPE_LIMITS.expanded / 2 ** 20} MB. Simplify the shape (e.g. with mapshaper.org) and import it again.`
            );
          }
          return true;
        },
      });
    } catch (cause) {
      if (cause instanceof ShapeImportError) {
        throw cause;
      }
      throw new ShapeImportError(`${entry.name} is not a readable archive.`);
    }
    return Object.entries(inner)
      .filter(([name]) => !/(^|\/)(__MACOSX|\.)/.test(name))
      .map(([name, bytes]) => ({ name, bytes }));
  });
}

function importEntries(entries: TEntry[]): TImportedShape {
  pointsRead = 0;
  const find = (...kinds: string[]) =>
    entries.find((entry) => kinds.includes(extension(entry.name)));
  const shp = find("shp");
  // A Shapefile's.dbf and.prj are the ones with its name in its own directory
  // (an archive may hold several layers, in several folders); a lone one is
  // taken only beside a lone.shp.
  const layers = entries.filter((entry) => extension(entry.name) === "shp");
  const sidecar = (kind: string) => {
    const all = entries.filter((entry) => extension(entry.name) === kind);
    const own = all.find((entry) => stemOf(entry.name) === stemOf(shp!.name));
    return (
      own ?? (all.length === 1 && layers.length === 1 ? all[0] : undefined)
    );
  };
  const shape = shp
    ? readShapefile(shp, sidecar("dbf"), sidecar("prj"))
    : find("geojson", "json")
      ? readGeoJSON(find("geojson", "json")!)
      : find("kml")
        ? readKML(find("kml")!)
        : undefined;
  if (!shape) {
    throw new ShapeImportError(
      entries.some((entry) =>
        ["dbf", "prj", "shx"].includes(extension(entry.name))
      )
        ? "A Shapefile needs its .shp file too: choose the .shp, .dbf and .prj together, or a .zip of them."
        : `Choose ${SHAPE_FORMATS}.`
    );
  }
  if (!shape.features.length) {
    throw new ShapeImportError(
      shape.skipped
        ? "The file holds no areas (polygons), only points or lines. Plots need an area."
        : "The file holds no shapes."
    );
  }
  return shape;
}

/** Closed rings in degrees; null for one with too few points. */
function closedRing(ring: number[][]) {
  pointsRead += ring.length;
  if (pointsRead > SHAPE_LIMITS.points) {
    throw new ShapeImportError(TOO_MANY_POINTS(SHAPE_LIMITS.points));
  }
  const points = ring
    .map(([lon, lat]) => [Number(lon), Number(lat)])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  for (const [lon, lat] of points) {
    if (Math.abs(lat) > 90 || lon < -180 || lon > 360) {
      throw new ShapeImportError(NOT_DEGREES);
    }
  }
  if (points.length < 3) {
    return null;
  }
  const [first, last] = [points[0], points[points.length - 1]];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    points.push([...first]);
  }
  return points.length >= 4 ? points : null;
}

function feature(
  name: string,
  polygons: number[][][][]
): TImportedFeature | null {
  const kept = polygons
    .map((polygon) => {
      const [outer, ...holes] = polygon.map(closedRing);
      return outer
        ? [outer, ...holes.filter((h): h is number[][] => h !== null)]
        : null;
    })
    .filter((p): p is number[][][] => p !== null);
  const points = kept.reduce(
    (sum, polygon) => sum + polygon.reduce((n, ring) => n + ring.length, 0),
    0
  );
  return kept.length ? { name, polygons: kept, points } : null;
}

// ---------------------------------------------------------------------------
// GeoJSON

type TJson = Record<string, unknown>;

function nameOf(properties: unknown, fallback: string) {
  const props = (properties ?? {}) as TJson;
  for (const key of [
    "name",
    "NAME",
    "Name",
    "title",
    "NAME_EN",
    // Gridlook's own selection export, imported again.
    "shape_name",
    "country_name",
    "id",
    "ID",
  ]) {
    const value = props[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return fallback;
}

function readGeoJSON(entry: TEntry): TImportedShape {
  let json: TJson;
  try {
    json = JSON.parse(text(entry.bytes)) as TJson;
  } catch {
    throw new ShapeImportError(`${entry.name} is not valid GeoJSON.`);
  }
  // The 2008 GeoJSON `crs` member: anything but longitude/latitude.
  const crs = JSON.stringify((json.crs as TJson | undefined) ?? "");
  if (crs !== '""' && !/CRS84|4326|WGS\s?84/i.test(crs)) {
    throw new ShapeImportError(NOT_DEGREES);
  }
  const features: TImportedFeature[] = [];
  let skipped = 0;
  const add = (geometry: unknown, name: string) => {
    const g = (geometry ?? {}) as TJson;
    if (g.type === "GeometryCollection") {
      for (const part of (g.geometries as unknown[]) ?? []) {
        add(part, name);
      }
      return;
    }
    const polygons =
      g.type === "Polygon"
        ? [g.coordinates as number[][][]]
        : g.type === "MultiPolygon"
          ? (g.coordinates as number[][][][])
          : null;
    const made = polygons && feature(name, polygons);
    if (made) {
      features.push(made);
    } else if (g.type) {
      skipped++;
    }
  };
  const list =
    json.type === "FeatureCollection"
      ? ((json.features as TJson[]) ?? [])
      : json.type === "Feature"
        ? [json]
        : [{ geometry: json }];
  list.forEach((f, at) =>
    add(f.geometry, nameOf(f.properties, `Feature ${at + 1}`))
  );
  return { file: entry.name, features, skipped };
}

// ---------------------------------------------------------------------------
// KML (and KMZ, unzipped above)

/** Elements named `tag` (any namespace prefix), as their inner text. */
function kmlElements(xml: string, tag: string) {
  const pattern = new RegExp(
    `<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`,
    "g"
  );
  return [...xml.matchAll(pattern)].map((match) => match[1]);
}

function kmlRing(xml: string | undefined) {
  return (kmlElements(xml ?? "", "coordinates")[0] ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tuple) => tuple.split(",").slice(0, 2).map(Number));
}

/**
 * KML edges follow the globe the short way (as Google Earth draws them): a
 * ring from 175° to −175° crosses the antimeridian. Its longitudes are
 * unwrapped so every edge is under 180°, holes in their exterior's frame,
 * and the polygon kept within −180°..360° (GeoJSON and Shapefile edges are
 * straight in longitude and latitude, and are read as written).
 */
function shortWay(rings: number[][][]) {
  const unwrapped = rings.map((ring) => {
    let previous: number | undefined;
    return ring.map(([lon, lat]) => {
      const next =
        previous === undefined
          ? lon
          : previous + ((((lon - previous + 180) % 360) + 360) % 360) - 180;
      previous = next;
      return [next, lat];
    });
  });
  const centre = (ring: number[][]) =>
    ring.reduce((sum, [lon]) => sum + lon, 0) / (ring.length || 1);
  const outer = centre(unwrapped[0] ?? []);
  const framed = unwrapped.map((ring, at) => {
    const shift = at ? 360 * Math.round((outer - centre(ring)) / 360) : 0;
    return ring.map(([lon, lat]) => [lon + shift, lat]);
  });
  let west = Infinity;
  for (const ring of framed) {
    for (const [lon] of ring) {
      west = Math.min(west, lon);
    }
  }
  const shift = west < -180 ? 360 : 0;
  return framed.map((ring) => ring.map(([lon, lat]) => [lon + shift, lat]));
}

/** KML is read as text (a DOM parser is not in workers or tests). */
function readKML(entry: TEntry): TImportedShape {
  const xml = text(entry.bytes);
  if (!/<(?:\w+:)?kml\b/.test(xml)) {
    throw new ShapeImportError(`${entry.name} is not valid KML.`);
  }
  const features: TImportedFeature[] = [];
  let skipped = 0;
  kmlElements(xml, "Placemark").forEach((placemark, at) => {
    const name =
      (kmlElements(placemark, "name")[0] ?? "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]+>/g, "")
        .trim() || `Placemark ${at + 1}`;
    const polygons = kmlElements(placemark, "Polygon").map((polygon) =>
      shortWay([
        kmlRing(kmlElements(polygon, "outerBoundaryIs")[0]),
        ...kmlElements(polygon, "innerBoundaryIs").map(kmlRing),
      ])
    );
    const made = polygons.length ? feature(name, polygons) : null;
    if (made) {
      features.push(made);
    } else {
      skipped++;
    }
  });
  return { file: entry.name, features, skipped };
}

// ---------------------------------------------------------------------------
// Shapefile:.shp geometry.dbf names.prj coordinate system

/** Signed area of a ring in the plane: positive when counterclockwise. */
function signedArea(ring: number[][]) {
  let twice = 0;
  for (let at = 1; at < ring.length; at++) {
    twice += ring[at - 1][0] * ring[at][1] - ring[at][0] * ring[at - 1][1];
  }
  return twice / 2;
}

function ringContains(ring: number[][], [x, y]: number[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * A record's rings as polygons. Shapefile outer rings run clockwise and
 * holes counterclockwise; each hole joins the outer ring around it.
 */
type TBox = { west: number; east: number; south: number; north: number };

/** A ring's longitude and latitude extent. */
function boxOf(ring: number[][]): TBox {
  let [west, east, south, north] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [x, y] of ring) {
    [west, east] = [Math.min(west, x), Math.max(east, x)];
    [south, north] = [Math.min(south, y), Math.max(north, y)];
  }
  return { west, east, south, north };
}

/** Each ring's nesting depth from its parents, each counted once. */
function depthsOf(parent: number[]) {
  const depths = new Map<number, number>();
  const depth = (at: number): number => {
    let known = depths.get(at);
    if (known === undefined) {
      known = parent[at] < 0 ? 0 : 1 + depth(parent[at]);
      depths.set(at, known);
    }
    return known;
  };
  return depth;
}

/**
 * The boxes that may hold a point: boxes bucketed on a grid of about one
 * cell per box over their extent; a box over many cells is kept aside and
 * always offered.
 */
function boxGrid(boxes: TBox[]) {
  const side = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(boxes.length))));
  let [west, east, south, north] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const b of boxes) {
    [west, east] = [Math.min(west, b.west), Math.max(east, b.east)];
    [south, north] = [Math.min(south, b.south), Math.max(north, b.north)];
  }
  const dx = (east - west) / side || 1;
  const dy = (north - south) / side || 1;
  const column = (x: number) =>
    Math.min(side - 1, Math.max(0, Math.floor((x - west) / dx)));
  const row = (y: number) =>
    Math.min(side - 1, Math.max(0, Math.floor((y - south) / dy)));
  const cells = new Map<number, number[]>();
  const wide: number[] = [];
  boxes.forEach((b, at) => {
    const [c0, c1, r0, r1] = [
      column(b.west),
      column(b.east),
      row(b.south),
      row(b.north),
    ];
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 64) {
      wide.push(at);
      return;
    }
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const key = r * side + c;
        const list = cells.get(key);
        if (list) {
          list.push(at);
        } else {
          cells.set(key, [at]);
        }
      }
    }
  });
  return (x: number, y: number) => [
    ...(cells.get(row(y) * side + column(x)) ?? []),
    ...wide,
  ];
}

/**
 * Rings into polygons by what contains what, in any order and either
 * winding: a ring inside an even number of others is an exterior, one
 * inside an odd number a hole of the smallest ring around it (land, lake,
 * island, pond: the pond is a hole of the island, not of the land).
 */
function groupRings(rings: number[][][]): number[][][][] {
  const area = rings.map((ring) => Math.abs(signedArea(ring)));
  const box = rings.map(boxOf);
  const within = (inner: number, outer: number) => {
    const [x, y] = rings[inner][0];
    const b = box[outer];
    return (
      area[outer] > area[inner] &&
      x >= b.west &&
      x <= b.east &&
      y >= b.south &&
      y <= b.north &&
      ringContains(rings[outer], rings[inner][0])
    );
  };
  // Candidates by a grid over the rings' boxes: 8,000 disjoint rings no
  // longer test 64 million pairs.
  const candidates = boxGrid(box);
  const parent = rings.map((_, inner) => {
    let best = -1;
    const [x, y] = rings[inner][0];
    for (const outer of candidates(x, y)) {
      if (
        outer !== inner &&
        within(inner, outer) &&
        (best < 0 || area[outer] < area[best])
      ) {
        best = outer;
      }
    }
    return best;
  });
  const depth = depthsOf(parent);
  const polygons = new Map<number, number[][][]>();
  rings.forEach((ring, at) => {
    if (depth(at) % 2 === 0) {
      polygons.set(at, [ring]);
    }
  });
  rings.forEach((ring, at) => {
    if (depth(at) % 2 === 1) {
      polygons.get(parent[at])?.push(ring);
    }
  });
  return [...polygons.values()];
}

const POLYGON_TYPES = new Set([5, 15, 25]);

/** One polygon record's rings (start: its content; end: the next record). */
function polygonRings(view: DataView, start: number, end: number) {
  const parts = view.getInt32(start + 36, true);
  const count = view.getInt32(start + 40, true);
  const pointsAt = start + 44 + 4 * parts;
  if (parts < 0 || count < 0 || pointsAt + 16 * count > end) {
    return undefined;
  }
  const rings: number[][][] = [];
  for (let p = 0; p < parts; p++) {
    const from = view.getInt32(start + 44 + 4 * p, true);
    const to = p + 1 < parts ? view.getInt32(start + 48 + 4 * p, true) : count;
    const ring: number[][] = [];
    for (let k = from; k < to; k++) {
      const offset = pointsAt + 16 * k;
      ring.push([
        view.getFloat64(offset, true),
        view.getFloat64(offset + 8, true),
      ]);
    }
    rings.push(ring);
  }
  return rings;
}

function readShp(bytes: Uint8Array, name: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 100 || view.getInt32(0, false) !== 9994) {
    throw new ShapeImportError(`${name} is not a Shapefile.`);
  }
  // A cut file (a partial download, a lost tail) would silently make a
  // smaller region: its declared length and every record must be there.
  const truncated = () =>
    new ShapeImportError(
      `${name} is incomplete (cut short): a part of its shapes is missing. Copy or download the file again.`
    );
  const declared = view.getInt32(24, false) * 2;
  if (declared > bytes.byteLength) {
    throw truncated();
  }
  // No length declared (0): the file's own.
  const end = declared > 100 ? declared : bytes.byteLength;
  const records: (number[][][] | null)[] = [];
  let at = 100;
  while (at < end) {
    const length = at + 8 <= end ? view.getInt32(at + 4, false) * 2 : -1;
    const start = at + 8;
    at = start + length;
    if (length < 4 || at > end) {
      throw truncated();
    }
    if (!POLYGON_TYPES.has(view.getInt32(start, true))) {
      records.push(null);
      continue;
    }
    const rings = polygonRings(view, start, at);
    if (!rings) {
      throw truncated();
    }
    records.push(rings);
  }
  return records;
}

/** The first text column that looks like a name, per record. */
function readDbfNames(bytes: Uint8Array | undefined, count: number) {
  if (!bytes || bytes.byteLength < 32) {
    return [];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const fields: { name: string; type: string; offset: number; size: number }[] =
    [];
  let offset = 1;
  for (let at = 32; at + 32 <= headerLength && bytes[at] !== 0x0d; at += 32) {
    const name = String.fromCharCode(...bytes.subarray(at, at + 11))
      .replace(/\0.*$/, "")
      .trim();
    const size = bytes[at + 16];
    fields.push({
      name,
      type: String.fromCharCode(bytes[at + 11]),
      offset,
      size,
    });
    offset += size;
  }
  const field =
    fields.find((f) => /^(name|name_en|nom|title|label)$/i.test(f.name)) ??
    fields.find((f) => /name/i.test(f.name)) ??
    fields.find((f) => f.type === "C");
  if (!field) {
    return [];
  }
  const decoder = new TextDecoder("utf-8");
  return Array.from({ length: Math.min(records, count) }, (_, r) => {
    const at = headerLength + r * recordLength + field.offset;
    return decoder.decode(bytes.subarray(at, at + field.size)).trim();
  });
}

/**
 * Datums whose degrees are WGS 84's to within a metre or two: WGS 84
 * itself and the ITRF-aligned realizations (NAD83, ETRS89, GDA, SIRGAS,
 * JGD, NZGD2000, CGCS2000, Hartebeesthoek94, KGD2002), by the names WKT
 * and ESRI give them.
 */
const WGS84_ALIGNED =
  /^(d_)?(wgs[_ ]?(19)?84|world[_ ]geodetic[_ ]system[_ ]1984|north[_ ]american[_ ](datum[_ ])?1983|nad[_ ]?83|european[_ ]terrestrial[_ ]reference[_ ](system|frame)[_ ]1989|etrs[_ ]?89|itrf\w*|international[_ ]terrestrial[_ ]reference[_ ]frame\w*|gda[_ ]?(94|2020)|geocentric[_ ]datum[_ ]of[_ ]australia[_ ](1994|2020)|sirgas\w*|sistema[_ ]de[_ ]referencia\w*|jgd[_ ]?20(00|11)|japanese[_ ]geodetic[_ ]datum[_ ]20(00|11)|nzgd[_ ]?2000|new[_ ]zealand[_ ]geodetic[_ ]datum[_ ]2000|cgcs[_ ]?2000|china[_ ]geodetic[_ ]coordinate[_ ]system[_ ]2000|hartebeesthoek[_ ]?94|kgd[_ ]?2002|korean[_ ]geodetic[_ ]datum[_ ]2002)\b/i;

/**
 * A declared datum whose degrees are not WGS 84's, by name: its own name and
 * ellipsoid, for the refusal. The ellipsoid alone settles nothing, so a datum
 * is taken only when it is WGS 84 or aligned with it, and without a shift to
 * WGS 84 (TOWGS84) other than zero. No datum declared: taken as is.
 */
function otherDatum(wkt: string) {
  const datum = /DATUM\[\s*"([^"]*)"/i.exec(wkt)?.[1];
  if (datum === undefined) {
    return undefined;
  }
  const shift = /TOWGS84\[([^\]]*)\]/i.exec(wkt)?.[1];
  const shifted =
    shift !== undefined &&
    shift.split(",").some((v) => Math.abs(Number(v)) > 1e-9);
  if (WGS84_ALIGNED.test(datum.trim()) && !shifted) {
    return undefined;
  }
  const ellipsoid = /(?:SPHEROID|ELLIPSOID)\[\s*"([^"]*)"/i.exec(wkt)?.[1];
  const tidy = (name: string) => name.replace(/^D_/, "").replace(/_/g, " ");
  return `${tidy(datum)}${ellipsoid ? ` (${tidy(ellipsoid)})` : ""}`;
}

function readShapefile(
  shp: TEntry,
  dbf: TEntry | undefined,
  prj: TEntry | undefined
): TImportedShape {
  const wkt = prj ? text(prj.bytes) : "";
  if (/^\s*PROJ(CS|CRS)\b/i.test(wkt)) {
    throw new ShapeImportError(NOT_DEGREES);
  }
  // Geographic, but not in degrees from Greenwich (e.g. NTF Paris, EPSG:4807,
  // in grads from the Paris meridian): refused rather than misplaced.
  const meridian = /PRIMEM\[\s*"([^"]*)"\s*,\s*([-+\d.eE]+)/i.exec(wkt);
  // Every angle unit: WKT2 names the prime meridian's and each axis's
  // (an ellipsoid's LENGTHUNIT is no angle); all must be degrees.
  const unit = [
    ...wkt.matchAll(/(?<!LENGTH)(?<!SCALE)(?<!TIME)UNIT\[\s*"([^"]*)"/gi),
  ].find((match) => !/^deg|degree/i.test(match[1]));
  if ((meridian && Number(meridian[2]) !== 0) || unit) {
    throw new ShapeImportError(
      `The coordinates are ${meridian && Number(meridian[2]) !== 0 ? `counted from the ${meridian[1]} meridian` : `in ${unit![1]}`}, not degrees from Greenwich. Export the shape in WGS 84 (EPSG:4326) and import it again.`
    );
  }
  const datum = otherDatum(wkt);
  if (datum) {
    throw new ShapeImportError(
      `The coordinates are on the ${datum} datum, not WGS 84: places can lie up to a few hundred metres off. Export the shape in WGS 84 (EPSG:4326) and import it again.`
    );
  }
  const records = readShp(shp.bytes, shp.name);
  const names = readDbfNames(dbf?.bytes, records.length);
  const features: TImportedFeature[] = [];
  let skipped = 0;
  records.forEach((rings, at) => {
    const made = rings
      ? feature(names[at] || `Shape ${at + 1}`, groupRings(rings))
      : null;
    if (made) {
      features.push(made);
    } else {
      skipped++;
    }
  });
  return { file: shp.name, features, skipped };
}

// ---------------------------------------------------------------------------

/** The features chosen (one, or all together) as one plot shape's polygons. */
export function shapeOfFeatures(
  shape: TImportedShape,
  chosen: number | number[] | "all"
) {
  const at =
    chosen === "all"
      ? shape.features.map((_, index) => index)
      : typeof chosen === "number"
        ? [chosen]
        : [...new Set(chosen)].sort((a, b) => a - b);
  const features = at.map((index) => shape.features[index]);
  const total = shape.features.length;
  // One area by its name; all by the file's; some: up to three names, else
  // how many of the file's areas.
  const name =
    features.length === 1
      ? features[0].name
      : features.length === total
        ? baseName(shape.file)
        : features.length <= 3
          ? features.map((f) => f.name).join(" + ")
          : `${baseName(shape.file)}: ${features.length} of ${total} areas`;
  // Overlapping pieces count once: a cell is inside when inside any one.
  return { name, polygons: features.flatMap((f) => f.polygons) };
}

/**
 * A shape's identity in caches, from its coordinates and (a drawn box) its pole
 * flags, as the importer and the Box tool make it. A restored shape takes it
 * anew: a stale or edited digest in a link could otherwise make two outlines
 * share one prepared region or result.
 */
export function shapeIdentity(
  polygons: number[][][][],
  poles?: { north: boolean; south: boolean },
  /** A drawn Box's view (screenFrame.ts): it decides centres too. */
  frame?: object
) {
  let view = "";
  if (frame) {
    // FNV-1a over its text: the same view, the same identity.
    let hash = 0x811c9dc5;
    for (const c of JSON.stringify(frame)) {
      hash = Math.imul(hash ^ c.charCodeAt(0), 0x01000193) >>> 0;
    }
    view = `.f${hash.toString(36)}`;
  }
  return `${shapeDigest(polygons)}${poles ? `.p${Number(poles.north)}${Number(poles.south)}` : ""}${view}`;
}

/**
 * A short content hash of polygons: their identity in caches and plots.
 * Not cryptographic: `crypto.subtle` is missing on plain-http pages, and an
 * identity needs no secrecy. Two 32-bit FNV-1a passes with different seeds.
 */
export function shapeDigest(polygons: number[][][][]) {
  const flat: number[] = [];
  for (const polygon of polygons) {
    flat.push(Number.NaN);
    for (const ring of polygon) {
      flat.push(Number.POSITIVE_INFINITY);
      for (const [lon, lat] of ring) {
        flat.push(lon, lat);
      }
    }
  }
  const bytes = new Uint8Array(new Float64Array(flat).buffer);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ bytes.length;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul(b ^ byte, 0x5bd1e995);
  }
  return [a, b].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
}
