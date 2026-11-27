/**
 * The view a Box was drawn in, kept with the shape it made: its centres near
 * the traced outline are decided as the map showed them, inside the drawn
 * rectangle or not. The rest are decided by the traced shape itself.
 */
import {
  isAzimuthalProjectionType,
  ProjectionHelper,
  withinAzimuthalClip,
  type TProjectionCenter,
  type TProjectionType,
} from "@/lib/projection/projectionUtils.ts";

export type TScreenFrame = {
  projection: { type: TProjectionType; center: TProjectionCenter };
  /** The camera: view and projection matrices (column-major) and eye. */
  view: number[];
  lens: number[];
  eye: [number, number, number];
  /** The canvas on screen (px). */
  viewport: { left: number; top: number; width: number; height: number };
  /** The drawn rectangle (px). */
  rect: { x0: number; y0: number; x1: number; y1: number };
  /**
   * The rectangle with a corner moved (px, four corners in order): its
   * untouched sides stay the drawn ones exactly.
   */
  quad?: [number, number][];
  /**
   * Centres nearer the traced outline than this (radians) are decided on
   * screen; the outline strays from the rectangle by far less.
   */
  band: number;
};

/** A point on screen as the map placed it, and whether it showed. */
export function frameProject(
  frame: Pick<TScreenFrame, "view" | "lens" | "eye" | "viewport"> & {
    projection: TScreenFrame["projection"];
  },
  helper: ProjectionHelper,
  lat: number,
  lon: number
) {
  const [x, y, z] = helper.project(lat, lon);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  const [ex, ey, ez] = frame.eye;
  const visible = helper.isFlat
    ? !isAzimuthalProjectionType(helper.type) ||
      withinAzimuthalClip(helper.center, lat, lon)
    : x * ex + y * ey + z * ez > 1;
  // As three.js's Vector3.project: the view, then the lens, each divided by w.
  const apply = (e: number[], p: [number, number, number]) => {
    const w = 1 / (e[3] * p[0] + e[7] * p[1] + e[11] * p[2] + e[15]);
    return [
      (e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12]) * w,
      (e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13]) * w,
      (e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]) * w,
    ] as [number, number, number];
  };
  const ndc = apply(frame.lens, apply(frame.view, [x, y, z]));
  const { left, top, width, height } = frame.viewport;
  return {
    x: left + ((ndc[0] + 1) / 2) * width,
    y: top + ((1 - ndc[1]) / 2) * height,
    visible: visible && ndc[2] < 1,
  };
}

/**
 * A frame's numbers copied out once: read through a reactive proxy, every
 * projected point read the camera's 32 matrix entries anew.
 */
function plainFrame(frame: TScreenFrame): TScreenFrame {
  return {
    projection: {
      type: frame.projection.type,
      center: { ...frame.projection.center },
    },
    view: Array.from(frame.view),
    lens: Array.from(frame.lens),
    eye: [frame.eye[0], frame.eye[1], frame.eye[2]],
    viewport: { ...frame.viewport },
    rect: { ...frame.rect },
    band: frame.band,
    ...(frame.quad
      ? { quad: frame.quad.map(([x, y]) => [x, y] as [number, number]) }
      : {}),
  };
}

/** Whether a centre shows inside the drawn rectangle, in its frame. */
export function frameRule(reactive: TScreenFrame) {
  const frame = plainFrame(reactive);
  const helper = new ProjectionHelper(
    frame.projection.type,
    frame.projection.center
  );
  const { x0, y0, x1, y1 } = frame.rect;
  const quad = frame.quad;
  return {
    band: frame.band,
    inside(lat: number, lon: number) {
      const p = frameProject(frame, helper, lat, lon);
      if (!p || !p.visible) {
        return false;
      }
      return quad
        ? insideQuad(quad, p.x, p.y)
        : p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    },
  };
}

/** Whether (x, y) is inside a quadrilateral or on its edge (px). */
function insideQuad(quad: [number, number][], x: number, y: number) {
  let inside = false;
  for (let k = 0, j = quad.length - 1; k < quad.length; j = k++) {
    const [[ax, ay], [bx, by]] = [quad[j], quad[k]];
    // On an edge: inside, as the rectangle's edges are.
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (
      Math.abs(cross) <= 1e-9 * Math.hypot(bx - ax, by - ay) &&
      x >= Math.min(ax, bx) - 1e-9 &&
      x <= Math.max(ax, bx) + 1e-9 &&
      y >= Math.min(ay, by) - 1e-9 &&
      y <= Math.max(ay, by) + 1e-9
    ) {
      return true;
    }
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The frame with the drawn corner nearest `from` moved to where `to`
 * shows in it; undefined when `to` does not show there.
 */
export function frameWithCorner(
  frame: TScreenFrame,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number }
): TScreenFrame | undefined {
  if (!frame.projection || !frame.view || !frame.lens) {
    return undefined;
  }
  const helper = new ProjectionHelper(
    frame.projection.type,
    frame.projection.center
  );
  const [old, now] = [
    frameProject(frame, helper, from.lat, from.lon),
    frameProject(frame, helper, to.lat, to.lon),
  ];
  if (!old || !now || !now.visible) {
    return undefined;
  }
  const { x0, y0, x1, y1 } = frame.rect;
  const quad: [number, number][] = frame.quad?.map(
    (c) => [...c] as [number, number]
  ) ?? [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  let nearest = 0;
  quad.forEach(([x, y], k) => {
    const [qx, qy] = quad[nearest];
    if (Math.hypot(x - old.x, y - old.y) < Math.hypot(qx - old.x, qy - old.y)) {
      nearest = k;
    }
  });
  quad[nearest] = [now.x, now.y];
  return { ...frame, quad };
}

/**
 * A drawn Box's traced rings moved onto the boundary its frame decides by,
 * densely: drawn in another view, magnified, the rings themselves stray from it
 * by up to the frame's band. Each point is found by halving along the ring's
 * normal, within the band, where the frame's rule changes; corners and points
 * without a change there stay as traced.
 */
// eslint-disable-next-line max-lines-per-function
export function framedRings(
  rings: { lat: number; lon: number }[][],
  frame: TScreenFrame,
  /** Points made between two traced ones. */
  subdivide = 8
) {
  const rule = frameRule(frame);
  const reach = (frame.band * 180) / Math.PI;
  // eslint-disable-next-line max-lines-per-function
  return rings.map((ring) => {
    const dense: { lat: number; lon: number }[] = [];
    for (let at = 0; at + 1 < ring.length; at++) {
      const [p, q] = [ring[at], ring[at + 1]];
      let dLon = q.lon - p.lon;
      dLon -= 360 * Math.round(dLon / 360);
      for (let k = 0; k < subdivide; k++) {
        const t = k / subdivide;
        dense.push({ lat: p.lat + t * (q.lat - p.lat), lon: p.lon + t * dLon });
      }
    }
    if (ring.length) {
      dense.push(ring[ring.length - 1]);
    }
    const n = dense.length;
    // eslint-disable-next-line max-lines-per-function
    return dense.map((point, at) => {
      if (Math.abs(point.lat) > 90 - 2 * reach) {
        return point;
      }
      // Neighbours other than itself (a closed ring repeats its first).
      const other = (step: number) => {
        for (let k = 1; k < n; k++) {
          const q = dense[(((at + step * k) % n) + n) % n];
          if (q.lat !== point.lat || q.lon !== point.lon) {
            return q;
          }
        }
        return point;
      };
      const [a, b] = [other(-1), other(1)];
      const scale = Math.cos((point.lat * Math.PI) / 180);
      let dLon = b.lon - a.lon;
      dLon -= 360 * Math.round(dLon / 360);
      const [tx, ty] = [dLon * scale, b.lat - a.lat];
      const length = Math.hypot(tx, ty);
      if (!length || !scale) {
        return point;
      }
      // The normal, in degrees of latitude and of longitude.
      const [nLat, nLon] = [tx / length, -ty / length / scale];
      const along = (s: number) => ({
        lat: point.lat + s * nLat,
        lon: point.lon + s * nLon,
      });
      const halve = (
        to: (s: number) => { lat: number; lon: number },
        [low, high]: [number, number]
      ) => {
        const test = (s: number) => {
          const q = to(s);
          return rule.inside(q.lat, q.lon);
        };
        const inLow = test(low);
        if (inLow === test(high)) {
          return undefined;
        }
        for (let k = 0; k < 40; k++) {
          const mid = (low + high) / 2;
          if (test(mid) === inLow) {
            low = mid;
          } else {
            high = mid;
          }
        }
        return to((low + high) / 2);
      };
      // Across the edge; at a corner, along the line between its sides.
      const across = halve(along, [-reach, reach]);
      if (across) {
        return across;
      }
      const [cLat, cLon] = [
        (a.lat + b.lat) / 2 - point.lat,
        (((a.lon + b.lon) / 2 - point.lon + 540) % 360) - 180,
      ];
      const size = Math.hypot(cLat, cLon * scale);
      return (
        (size &&
          halve(
            (s) => ({
              lat: point.lat + (s * cLat) / size,
              lon: point.lon + (s * cLon) / size,
            }),
            [-2 * reach, 2 * reach]
          )) ||
        point
      );
    });
  });
}

/**
 * Twice the largest angle (radians) from the points' mean direction to any
 * of them: every point of their hull is that near one of them.
 */
export function extentOf(points: { lat: number; lon: number }[]) {
  const unit = ({ lat, lon }: { lat: number; lon: number }) => {
    const [a, b] = [(lat * Math.PI) / 180, (lon * Math.PI) / 180];
    return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
  };
  const sum = [0, 0, 0];
  for (const p of points) {
    unit(p).forEach((v, k) => (sum[k] += v));
  }
  const norm = Math.hypot(...sum);
  if (!norm) {
    return Math.PI;
  }
  let widest = 0;
  for (const p of points) {
    const v = unit(p);
    const cos = (v[0] * sum[0] + v[1] * sum[1] + v[2] * sum[2]) / norm;
    widest = Math.max(widest, Math.acos(Math.max(-1, Math.min(1, cos))));
  }
  return Math.min(Math.PI, 2 * widest);
}
