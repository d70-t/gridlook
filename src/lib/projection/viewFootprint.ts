import { Vector3, type Camera } from "three";

import { screenToGeo, type TViewport } from "./distanceScale.ts";
import type { ProjectionHelper } from "./projectionUtils.ts";

/** Lat/lon box (degrees) holding the part of the surface the camera sees. */
export type TViewFootprint = {
  latMin: number;
  latMax: number;
  // western edge in [-180, 180) and extent eastward; 360 is every longitude
  lonStart: number;
  lonSpan: number;
  // the point of the surface below the camera: what a view that has to be
  // cut down is cut down around
  centreLat: number;
  centreLon: number;
};

type TScreenPoint = { x: number; y: number };

const SAMPLES_PER_AXIS = 9;
const EDGE_BISECTIONS = 12;
const DEGREES = 180 / Math.PI;

function normalizeLon(lon: number) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** The cap of the unit globe a camera sees when the horizon is in view. */
function globeCap(camera: Camera): TViewFootprint {
  const { x, y, z } = camera.position;
  const distance = camera.position.length();
  const lat = Math.asin(z / distance) * DEGREES;
  const lon = Math.atan2(y, x) * DEGREES;
  const radius = Math.acos(Math.min(1, 1 / distance)) * DEGREES;
  const centre = { centreLat: lat, centreLon: lon };
  if (lat + radius >= 90 || lat - radius <= -90) {
    return {
      latMin: lat - radius <= -90 ? -90 : lat - radius,
      latMax: lat + radius >= 90 ? 90 : lat + radius,
      lonStart: -180,
      lonSpan: 360,
      ...centre,
    };
  }
  const halfSpan =
    Math.asin(Math.sin(radius / DEGREES) / Math.cos(lat / DEGREES)) * DEGREES;
  return {
    latMin: lat - radius,
    latMax: lat + radius,
    lonStart: normalizeLon(lon - halfSpan),
    lonSpan: 2 * halfSpan,
    ...centre,
  };
}

/** The shortest arc holding every longitude, as its western edge and extent. */
function longitudeArc(lons: number[]) {
  const sorted = lons.map(normalizeLon).sort((a, b) => a - b);
  let gap = sorted[0] + 360 - sorted[sorted.length - 1];
  let start = sorted[0];
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index] - sorted[index - 1] > gap) {
      gap = sorted[index] - sorted[index - 1];
      start = sorted[index];
    }
  }
  return { lonStart: start, lonSpan: 360 - gap };
}

function boundingBox(lons: number[], lats: number[], onGlobe: boolean) {
  let latMin = lats[0];
  let latMax = lats[0];
  for (const lat of lats) {
    latMin = lat < latMin ? lat : latMin;
    latMax = lat > latMax ? lat : latMax;
  }
  const arc = longitudeArc(lons);
  if (arc.lonSpan <= 180) {
    return { latMin, latMax, ...arc };
  }
  // Too wide for the samples to tell where the arc ends: every longitude.
  // On the globe such a view wraps a pole and reaches up to it.
  const south = onGlobe && -latMin > latMax;
  const north = onGlobe && !south;
  return {
    latMin: south ? -90 : latMin,
    latMax: north ? 90 : latMax,
    lonStart: -180,
    lonSpan: 360,
  };
}

/**
 * The lat/lon box of what a camera sees, from a lattice of screen points
 * unprojected onto the surface. On the globe a screen point off the sphere
 * means the horizon is in view; the box is then the whole visible cap. On a
 * flat map a point off the map means its edge is in view; the edge is found
 * by bisecting towards a point on the map. Null when the surface is not in
 * view at all.
 */
// eslint-disable-next-line max-lines-per-function
export function viewFootprint(
  camera: Camera,
  helper: ProjectionHelper,
  rect: TViewport
): TViewFootprint | null {
  const geoAt = ({ x, y }: TScreenPoint) =>
    screenToGeo(camera, helper, rect, x, y);
  const toScreen = (point: Vector3): TScreenPoint => {
    point.project(camera);
    return {
      x: rect.left + ((point.x + 1) * rect.width) / 2,
      y: rect.top + ((1 - point.y) * rect.height) / 2,
    };
  };
  if (!helper.isFlat) {
    const lons: number[] = [];
    const lats: number[] = [];
    for (let i = 0; i < SAMPLES_PER_AXIS; i++) {
      for (let j = 0; j < SAMPLES_PER_AXIS; j++) {
        const geo = geoAt({
          x: rect.left + (rect.width * i) / (SAMPLES_PER_AXIS - 1),
          y: rect.top + (rect.height * j) / (SAMPLES_PER_AXIS - 1),
        });
        if (!geo) {
          return globeCap(camera);
        }
        lons.push(geo[0]);
        lats.push(geo[1]);
      }
    }
    const { x, y, z } = camera.position;
    return {
      ...boundingBox(lons, lats, true),
      centreLat: Math.asin(z / camera.position.length()) * DEGREES,
      centreLon: Math.atan2(y, x) * DEGREES,
    };
  }

  const points: TScreenPoint[] = [];
  const hits: ([number, number] | null)[] = [];
  for (let i = 0; i < SAMPLES_PER_AXIS; i++) {
    for (let j = 0; j < SAMPLES_PER_AXIS; j++) {
      const point = {
        x: rect.left + (rect.width * i) / (SAMPLES_PER_AXIS - 1),
        y: rect.top + (rect.height * j) / (SAMPLES_PER_AXIS - 1),
      };
      points.push(point);
      hits.push(geoAt(point));
    }
  }
  const samples = hits.filter((geo) => geo !== null);
  /** The last point on the map going from `inside` towards `outside`. */
  const edge = (inside: TScreenPoint, outside: TScreenPoint) => {
    let near = inside;
    let far = outside;
    let geo = geoAt(inside)!;
    for (let step = 0; step < EDGE_BISECTIONS; step++) {
      const middle = { x: (near.x + far.x) / 2, y: (near.y + far.y) / 2 };
      const found = geoAt(middle);
      if (found) {
        near = middle;
        geo = found;
      } else {
        far = middle;
      }
    }
    return geo;
  };
  // The middle of the map, when it is on screen: every lattice point off the
  // map then has an edge between itself and there, however small the map is.
  const middle = toScreen(
    new Vector3(...helper.project(helper.center.lat, helper.center.lon))
  );
  const anchor = geoAt(middle) ? middle : null;
  for (const [index, point] of points.entries()) {
    if (hits[index]) {
      continue;
    }
    if (anchor) {
      samples.push(edge(anchor, point));
    }
    const i = Math.floor(index / SAMPLES_PER_AXIS);
    const j = index % SAMPLES_PER_AXIS;
    for (const [di, dj] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      const neighbour = (i + di) * SAMPLES_PER_AXIS + (j + dj);
      if (
        i + di >= 0 &&
        i + di < SAMPLES_PER_AXIS &&
        j + dj >= 0 &&
        j + dj < SAMPLES_PER_AXIS &&
        hits[neighbour]
      ) {
        samples.push(edge(points[neighbour], point));
      }
    }
  }
  if (samples.length === 0) {
    return null;
  }
  const box = boundingBox(
    samples.map((geo) => geo[0]),
    samples.map((geo) => geo[1]),
    false
  );
  const below = geoAt(
    toScreen(new Vector3(camera.position.x, camera.position.y, 0))
  );
  return {
    ...box,
    centreLat: below ? below[1] : (box.latMin + box.latMax) / 2,
    centreLon: below ? below[0] : normalizeLon(box.lonStart + box.lonSpan / 2),
  };
}
