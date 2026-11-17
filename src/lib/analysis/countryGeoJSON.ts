import { geoArea, geoEquirectangular } from "d3-geo";
import { geoProject } from "d3-geo-projection";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { feature, mesh } from "topojson-client";

import {
  countryContains,
  prepareCountry,
  type TCountryRegion,
} from "./countryRegion.ts";
import type { TLatLon } from "./sphere.ts";
import type { TCountryResolution } from "./types.ts";

// The atlas shape, typed through topojson-client's own signature.
type TGeometryObject = Parameters<typeof feature>[1] & {
  type: string;
  properties?: { name?: string };
};
type TTopology = Parameters<typeof feature>[0] & {
  objects: { countries: { geometries: TGeometryObject[] } };
};

const load = {
  "110m": () => import("world-atlas/countries-110m.json?raw"),
  "50m": () => import("world-atlas/countries-50m.json?raw"),
  "10m": () => import("world-atlas/countries-10m.json?raw"),
};
const topologies = new Map<TCountryResolution, Promise<TTopology>>();

function topology(resolution: TCountryResolution) {
  let pending = topologies.get(resolution);
  if (!pending) {
    pending = load[resolution]().then(
      ({ default: json }) => JSON.parse(json) as TTopology
    );
    topologies.set(resolution, pending);
    pending.catch(() => topologies.delete(resolution));
  }
  return pending;
}

// world-atlas contains D3 spherical polygons that may cross the antimeridian.
// Clip there before returning GeoJSON, retaining holes on the appropriate side.
// A degree-scale equirectangular projection keeps the atlas vertices.
const projection = geoEquirectangular()
  .scale(180 / Math.PI)
  .translate([0, 0])
  .precision(0);

/**
 * Polygons as D3 spherical polygons. A few 10m Maldives islets are wound
 * clockwise, which D3 reads as the whole sphere except the islet; imported
 * shapes are often wound the other way round (RFC 7946). No country or
 * plausible plot region covers more than a hemisphere, so rewind any
 * polygon that does.
 */
function rewound(polygons: number[][][][]): MultiPolygon {
  const coordinates = polygons.map((polygon) =>
    geoArea({ type: "Polygon", coordinates: polygon }) > 2 * Math.PI
      ? polygon.map((ring) => [...ring].reverse())
      : polygon
  );
  return { type: "MultiPolygon", coordinates };
}

function geometryOf(data: TTopology, object: TGeometryObject) {
  const { geometry } = feature(data, object) as Feature<Polygon | MultiPolygon>;
  return rewound(
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates
  );
}

function ringsOf(data: TTopology, object: TGeometryObject, name: string) {
  return projectedRings(geometryOf(data, object), name);
}

/**
 * An imported shape's polygons, read as GeoJSON defines them (RFC 7946
 * §3.1.1): edges are straight lines in longitude and latitude, and a ring
 * encloses what it encloses on the map whichever way it is wound (no
 * rewinding to the other side of the globe). Parts past 180° E are moved
 * to the west of the antimeridian; exteriors are wound counterclockwise,
 * holes clockwise, as country boundaries are.
 */
export function shapeRings(polygons: number[][][][], name: string) {
  const out: number[][][][] = [];
  for (const polygon of polygons) {
    // The part west of 180° as it is, the part east of it shifted by 360°.
    for (const [west, east, shift] of [
      [-Infinity, 180, 0],
      [180, Infinity, -360],
    ]) {
      const clipped = polygon
        .map((ring) => densified(clipToBand(ring, west, east)))
        .map((ring) => ring.map(([lon, lat]) => [lon + shift, lat]));
      // A hole the antimeridian cuts is a notch in the exterior now, not a
      // ring touching it (an invalid polygon).
      const rings = notched(clipped, 180 + shift);
      const [exterior, ...holes] = rings.map((ring) => ({
        ring,
        area: planarArea(ring),
      }));
      if (!exterior || exterior.area === 0) {
        continue;
      }
      out.push([
        exterior.area > 0 ? exterior.ring : exterior.ring.reverse(),
        ...holes
          .filter(({ area }) => area !== 0)
          .map(({ ring, area }) => (area < 0 ? ring : ring.reverse())),
      ]);
    }
  }
  if (!out.length) {
    throw new Error(`The boundary for "${name}" is empty.`);
  }
  return out;
}

/**
 * Holes cut by the clip line `lon` spliced into the exterior: each such
 * hole's edge along the line is dropped and the rest of it joins the
 * exterior's edge along the line where it lies. Other rings are kept.
 */
function notched(rings: number[][][], lon: number) {
  const [exterior, ...holes] = rings;
  if (!exterior?.length) {
    return rings;
  }
  const onLine = (p: number[]) => p[0] === lon;
  let shell = exterior.slice(0, -1);
  const kept: number[][][] = [];
  for (const hole of holes) {
    const open = hole.slice(0, -1);
    const k = open.findIndex(
      (p, at) => onLine(p) && onLine(open[(at + 1) % open.length])
    );
    // From one end of its edge on the line, round to the other.
    const path = k < 0 ? [] : [...open.slice(k + 1), ...open.slice(0, k + 1)];
    const [a, b] = [path[0], path.at(-1)];
    const i = path.length
      ? shell.findIndex((p, at) => {
          const q = shell[(at + 1) % shell.length];
          const [low, high] = [Math.min(p[1], q[1]), Math.max(p[1], q[1])];
          return (
            onLine(p) &&
            onLine(q) &&
            [a[1], b![1]].every((lat) => lat >= low && lat <= high)
          );
        })
      : -1;
    if (i < 0) {
      kept.push(hole);
      continue;
    }
    // Entered from the shell's vertex at i: the nearer end first.
    const from = shell[i];
    const ordered =
      Math.abs(a[1] - from[1]) <= Math.abs(b![1] - from[1])
        ? path
        : [...path].reverse();
    shell = [...shell.slice(0, i + 1), ...ordered, ...shell.slice(i + 1)];
  }
  return [[...shell, [...shell[0]]], ...kept];
}

/**
 * Straight edges cut into steps of at most 10° of longitude, so that the
 * containment test (which takes each edge the short way round, as
 * coastlines are) reads a long edge where it is drawn.
 */
function densified(ring: number[][]) {
  const out: number[][] = [];
  ring.forEach((point, at) => {
    const previous = ring[at - 1];
    if (previous) {
      const steps = Math.ceil(Math.abs(point[0] - previous[0]) / 10);
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        out.push([
          previous[0] + t * (point[0] - previous[0]),
          previous[1] + t * (point[1] - previous[1]),
        ]);
      }
    }
    out.push(point);
  });
  return out;
}

/** A closed ring clipped to west ≤ lon ≤ east (Sutherland–Hodgman). */
function clipToBand(ring: number[][], west: number, east: number) {
  let points = ring.slice(0, -1);
  for (const [edge, keep] of [
    [east, (lon: number) => lon <= east],
    [west, (lon: number) => lon >= west],
  ] as const) {
    if (!Number.isFinite(edge) || !points.length) {
      continue;
    }
    const kept: number[][] = [];
    points.forEach((current, at) => {
      const previous = points[(at + points.length - 1) % points.length];
      const [inNow, inBefore] = [keep(current[0]), keep(previous[0])];
      if (inNow !== inBefore) {
        const t = (edge - previous[0]) / (current[0] - previous[0]);
        kept.push([edge, previous[1] + t * (current[1] - previous[1])]);
      }
      if (inNow) {
        kept.push(current);
      }
    });
    points = kept;
  }
  return points.length >= 3 ? [...points, [...points[0]]] : [];
}

function projectedRings(geometry: MultiPolygon, name: string) {
  const projected = geoProject(geometry, projection);
  if (!projected) {
    throw new Error(`The boundary for "${name}" is empty.`);
  }
  const polygons =
    projected.type === "Polygon"
      ? [projected.coordinates]
      : projected.coordinates;
  // Undo the projection's screen y direction, then keep only rings with
  // area (quantization leaves some with fewer than four distinct points,
  // which contain nothing), wound as RFC 7946 asks: exteriors
  // counterclockwise, holes clockwise. Neither changes which points a
  // boundary contains.
  const out: number[][][][] = [];
  for (const polygon of polygons) {
    const [exterior, ...holes] = polygon.map((ring) => {
      const flipped = ring.map(([lon, y]) => [lon, -y]);
      return { ring: flipped, area: planarArea(flipped) };
    });
    if (!exterior || exterior.area === 0) {
      continue;
    }
    out.push([
      exterior.area > 0 ? exterior.ring : exterior.ring.reverse(),
      ...holes
        .filter(({ area }) => area !== 0)
        .map(({ ring, area }) => (area < 0 ? ring : ring.reverse())),
    ]);
  }
  return out;
}

/** Signed area of a closed lon/lat ring: positive when counterclockwise. */
function planarArea(ring: number[][]) {
  let twice = 0;
  for (let at = 1; at < ring.length; at++) {
    twice += ring[at - 1][0] * ring[at][1] - ring[at][0] * ring[at - 1][1];
  }
  return twice / 2;
}

const isPolygonal = (g: TGeometryObject) =>
  g.type === "Polygon" || g.type === "MultiPolygon";

/** Recently prepared rings: a preview, its plot and its export share them. */
const ringCache = new Map<string, number[][][][]>();
const RING_CACHE_ENTRIES = 16;

/** Closed rings per polygon of a country (read-only: shared by callers). */
export async function countryRings(
  name: string,
  resolution: TCountryResolution
): Promise<number[][][][]> {
  const key = `${resolution}|${name}`;
  const kept = ringCache.get(key);
  if (kept) {
    ringCache.delete(key);
    ringCache.set(key, kept);
    return kept;
  }
  const rings = await prepareRings(name, resolution);
  ringCache.set(key, rings);
  if (ringCache.size > RING_CACHE_ENTRIES) {
    ringCache.delete(ringCache.keys().next().value!);
  }
  return rings;
}

async function prepareRings(name: string, resolution: TCountryResolution) {
  const data = await topology(resolution);
  const object = data.objects.countries.geometries.find(
    (g) => isPolygonal(g) && g.properties?.name === name
  );
  if (!object) {
    throw new Error(`The ${resolution} atlas has no polygon for "${name}".`);
  }
  return ringsOf(data, object, name);
}

type TCandidate = {
  name: string;
  object: TGeometryObject;
  /** Vertex bounds [west, south, east, north]; none when wider than 180°. */
  box?: number[];
  region?: TCountryRegion | null;
};
const lookups = new Map<TCountryResolution, Promise<TCandidate[]>>();

/** Each arc's vertex bounds, decoding the quantized topology once. */
function arcBoxes(data: TTopology) {
  const { arcs, transform } = data as unknown as {
    arcs: number[][][];
    transform?: { scale: number[]; translate: number[] };
  };
  return arcs.map((arc) => {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    let x = 0,
      y = 0;
    for (const [a, b] of arc) {
      [x, y] = transform ? [x + a, y + b] : [a, b];
      const lon = transform
        ? x * transform.scale[0] + transform.translate[0]
        : x;
      const lat = transform
        ? y * transform.scale[1] + transform.translate[1]
        : y;
      box[0] = Math.min(box[0], lon);
      box[1] = Math.min(box[1], lat);
      box[2] = Math.max(box[2], lon);
      box[3] = Math.max(box[3], lat);
    }
    return box;
  });
}

/** Countries with the vertex bounds of their arcs: a cheap prefilter. */
async function candidates(resolution: TCountryResolution) {
  const data = await topology(resolution);
  const boxes = arcBoxes(data);
  const out: TCandidate[] = [];
  for (const object of data.objects.countries.geometries) {
    const name = object.properties?.name;
    if (!isPolygonal(object) || name === undefined) {
      continue;
    }
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const indices = (object as unknown as { arcs: unknown[] }).arcs.flat(2);
    for (const index of indices as number[]) {
      const arc = boxes[index < 0 ? ~index : index];
      box[0] = Math.min(box[0], arc[0]);
      box[1] = Math.min(box[1], arc[1]);
      box[2] = Math.max(box[2], arc[2]);
      box[3] = Math.max(box[3], arc[3]);
    }
    // Rings across the date line or around a pole: no useful bounds.
    out.push({ name, object, box: box[2] - box[0] > 180 ? undefined : box });
  }
  return out;
}

/**
 *  The name of the country whose boundary contains a point, if any. The
 * plot mask uses the same prepared rings, so a pick and its plot agree.
 * Only countries whose vertex bounds hold the point are prepared (once).
 */
export async function countryNameAt(
  lat: number,
  lon: number,
  resolution: TCountryResolution
) {
  let pending = lookups.get(resolution);
  if (!pending) {
    pending = candidates(resolution);
    lookups.set(resolution, pending);
    pending.catch(() => lookups.delete(resolution));
  }
  const [list, data] = await Promise.all([pending, topology(resolution)]);
  const x = ((((lon + 180) % 360) + 360) % 360) - 180;
  const near = (box: number[]) =>
    lat >= box[1] - 1e-6 &&
    lat <= box[3] + 1e-6 &&
    ((x >= box[0] - 1e-6 && x <= box[2] + 1e-6) ||
      x + 360 <= box[2] + 1e-6 ||
      x - 360 >= box[0] - 1e-6);
  for (const entry of list) {
    if (entry.box && !near(entry.box)) {
      continue;
    }
    if (entry.region === undefined) {
      try {
        entry.region = prepareCountry(ringsOf(data, entry.object, entry.name));
      } catch {
        // Quantization collapses some territories (Vatican at 10m) to a line.
        entry.region = null;
      }
    }
    if (entry.region && countryContains(entry.region, lat, lon)) {
      return entry.name;
    }
  }
  return undefined;
}

/**
 * The borders between countries (coastlines excluded: the map draws those),
 * at the coarse scale: a light guide on the map while a country is chosen.
 */
export async function countryBorders(): Promise<TLatLon[][]> {
  const data = await topology("110m");
  const countries = data.objects.countries as Parameters<typeof mesh>[1];
  const lines = mesh(data, countries, (a, b) => a !== b);
  return lines.coordinates.map((line) =>
    line.map(([lon, lat]) => ({ lat, lon }))
  );
}
