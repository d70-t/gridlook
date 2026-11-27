/* eslint-disable max-lines-per-function -- each case builds its view inline. */
import * as THREE from "three";
import { expect, it } from "vitest";

import {
  countryContains,
  prepareCountry,
} from "@/lib/analysis/countryRegion.ts";
import {
  frameProject,
  frameRule,
  type TScreenFrame,
} from "@/lib/analysis/screenFrame.ts";
import { GEOMETRY_KINDS, type TShapeGeometry } from "@/lib/analysis/types.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";
import { rectangleSelection } from "@/ui/analysis/boxFootprint.ts";

/** The map's own globe view: a camera close above 89.9°N, 1536 × 850 px. */
function globeView() {
  const helper = new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
    lat: 0,
    lon: 0,
  });
  const camera = new THREE.PerspectiveCamera(30, 1152 / 850, 1e-6, 10);
  const [x, y, z] = helper.project(89.9, 3);
  camera.position.set(x * 1.0004, y * 1.0004, z * 1.0004);
  camera.up.set(1, 0, 0);
  camera.lookAt(x, y, z);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const viewport = { left: 384, top: 0, width: 1152, height: 850 };
  const view: Omit<TScreenFrame, "rect" | "band"> = {
    projection: { type: helper.type, center: { lat: 0, lon: 0 } },
    view: [...camera.matrixWorldInverse.elements],
    lens: [...camera.projectionMatrix.elements],
    eye: camera.position.toArray() as [number, number, number],
    viewport,
  };
  const raycaster = new THREE.Raycaster();
  const sphere = new THREE.Sphere(new THREE.Vector3(), 1);
  const hit = new THREE.Vector3();
  // As useGridScene picks: the ray through the pixel against the unit globe.
  const pick = (cx: number, cy: number) => {
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((cx - viewport.left) / viewport.width) * 2 - 1,
        -((cy - viewport.top) / viewport.height) * 2 + 1
      ),
      camera
    );
    if (!raycaster.ray.intersectSphere(sphere, hit)) {
      return null;
    }
    return ProjectionHelper.cartesianToLatLon(hit.x, hit.y, hit.z);
  };
  const project = (lat: number, lon: number) =>
    frameProject(view, helper, lat, lon) ?? null;
  return { pick, project, view };
}

it("independent review of interim45: a polar Box's mean holds exactly the centres shown inside it", () => {
  const { pick, project, view } = globeView();
  const centre = project(89.9, 3)!;
  let [withFrame, withoutFrame, tested] = [0, 0, 0];
  for (const [w, h] of [
    [8, 8],
    [40, 23],
    [3, 120],
  ]) {
    const from = { x: centre.x - w / 2, y: centre.y - h / 2 };
    const to = { x: centre.x + w / 2, y: centre.y + h / 2 };
    const geometry = rectangleSelection(
      pick,
      project,
      from,
      to,
      false,
      true,
      view
    )!.geometry as TShapeGeometry;
    expect(geometry.kind).toBe(GEOMETRY_KINDS.SHAPE);
    expect(geometry.frame?.band).toBeGreaterThan(0);
    const rings = prepareCountry(geometry.polygons, geometry.poles);
    const framed = {
      ...prepareCountry(geometry.polygons, geometry.poles),
      frame: frameRule(geometry.frame!),
    };
    // Centres along every edge, a ten-thousandth of a pixel apart or less.
    const edges: [number, number][] = [];
    for (let k = 0; k <= 400; k++) {
      const t = k / 400;
      for (const d of [-1e-4, -3e-5, -1e-5, 0, 1e-5, 3e-5, 1e-4]) {
        edges.push(
          [from.x + d, from.y + t * h],
          [to.x + d, from.y + t * h],
          [from.x + t * w, from.y + d],
          [from.x + t * w, to.y + d]
        );
      }
    }
    for (const [x, y] of edges) {
      const at = pick(x, y);
      if (!at) {
        continue;
      }
      const p = project(at.lat, at.lon)!;
      const shown =
        p.visible &&
        p.x >= from.x &&
        p.x <= to.x &&
        p.y >= from.y &&
        p.y <= to.y;
      tested++;
      withFrame += countryContains(framed, at.lat, at.lon) === shown ? 0 : 1;
      withoutFrame += countryContains(rings, at.lat, at.lon) === shown ? 0 : 1;
    }
  }
  expect(tested).toBeGreaterThan(30_000);
  // Exactly the centres shown inside, however near an edge.
  expect(withFrame).toBe(0);
  // The traced rings alone disagree within a fraction of a pixel.
  // The traced rings alone disagree within a fraction of a pixel (13,803 here).
  expect(withoutFrame).toBeGreaterThan(1000);
});

it("independent review of interim45: after a change of projection the spotlight lights what the rings hold", async () => {
  const { geoMollweide } = await import("d3-geo-projection");
  const { litPieces } = await import("@/ui/analysis/spotlight.ts");
  const mollweide = geoMollweide()
    .scale(4e5)
    .translate([0, 0])
    .center([4, 88.4])
    .translate([768, 425]);
  const project = (lat: number, lon: number) => {
    const p = mollweide([lon, lat]);
    return p ? { x: p[0], y: p[1], visible: true } : null;
  };
  // An oblique four-sided ring near the pole, its edges straight in lon/lat.
  const ring = [
    { lat: 88.3, lon: 2.6 },
    { lat: 88.36, lon: 6.1 },
    { lat: 88.52, lon: 5.2 },
    { lat: 88.46, lon: 2.1 },
  ];
  const region = prepareCountry([[ring.map((p) => [p.lon, p.lat])]]);
  const pieces = litPieces(ring, project).map((path) =>
    [...path.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ])
  );
  const lit = (x: number, y: number) => {
    let inside = false;
    for (const piece of pieces) {
      for (let a = 0, b = piece.length - 1; a < piece.length; b = a++) {
        const [[xa, ya], [xb, yb]] = [piece[a], piece[b]];
        if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) {
          inside = !inside;
        }
      }
    }
    return inside;
  };
  const nearEdge = (x: number, y: number) =>
    pieces.some((piece) =>
      piece.some(([xa, ya], a) => {
        const [xb, yb] = piece[(a + 1) % piece.length];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - xa) * (xb - xa) + (y - ya) * (yb - ya)) /
              ((xb - xa) ** 2 + (yb - ya) ** 2 || 1)
          )
        );
        return (
          Math.hypot(x - xa - t * (xb - xa), y - ya - t * (yb - ya)) < 0.02
        );
      })
    );
  let [disagree, tested] = [0, 0];
  for (let j = 0; j <= 60; j++) {
    for (let i = 0; i <= 60; i++) {
      const [lat, lon] = [88.28 + 0.0042 * j, 2.0 + 0.07 * i];
      const p = project(lat, lon)!;
      if (nearEdge(p.x, p.y)) {
        continue;
      }
      tested++;
      disagree += lit(p.x, p.y) === countryContains(region, lat, lon) ? 0 : 1;
    }
  }
  expect(tested).toBeGreaterThan(3000);
  expect(disagree).toBe(0);
});

it("interim47 independent: a corner centre inside the polar screen frame survives the rectilinear prefilter", async () => {
  const { pick, project, view } = globeView();
  const centre = project(89.9, 3)!;
  const from = { x: centre.x - 4, y: centre.y - 4 };
  const to = { x: centre.x + 4, y: centre.y + 4 };
  const geometry = rectangleSelection(
    pick,
    project,
    from,
    to,
    false,
    true,
    view
  )!.geometry as TShapeGeometry;
  const cell = pick(to.x - 1e-8, from.y)!;
  const country = {
    ...prepareCountry(geometry.polygons, geometry.poles),
    frame: frameRule(geometry.frame!),
  };
  expect(country.frame.inside(cell.lat, cell.lon)).toBe(true);
  expect(countryContains(country, cell.lat, cell.lon)).toBe(true);
  const { regionSelection } = await import("@/lib/analysis/operations.ts");
  const { emptyCounters } = await import("@/lib/analysis/types.ts");
  const axis = (v: number, longitude: boolean) => ({
    values: Float64Array.of(v),
    bounds: Float64Array.of(v - 1e-6, v + 1e-6),
    longitude,
    periodic: false,
  });
  const grid = {
    kind: "rectilinear",
    latAxis: 0,
    lonAxis: 1,
    lat: axis(cell.lat, false),
    lon: axis(cell.lon, true),
  };
  const selected = await regionSelection(
    { grid, dims: ["lat", "lon"] } as never,
    { kind: "country", country },
    [[], []],
    emptyCounters()
  );
  expect(selected.storedCells).toBe(1);
});

it("interim48: a Box drawn in another view is outlined on its frame's boundary", async () => {
  const { framedRings } = await import("@/lib/analysis/screenFrame.ts");
  const { pick, project, view } = globeView();
  const centre = project(89.9, 3)!;
  const from = { x: centre.x - 20, y: centre.y - 12 };
  const to = { x: centre.x + 20, y: centre.y + 12 };
  const geometry = rectangleSelection(
    pick,
    project,
    from,
    to,
    false,
    true,
    view
  )!.geometry as TShapeGeometry;
  const traced = geometry.polygons
    .flat()
    .map((ring) => ring.map(([lon, lat]) => ({ lat, lon })));
  const snapped = framedRings(traced, geometry.frame!);
  // On the drawing view's screen: how far each outline is from the drawn
  // rectangle's edge, in pixels.
  const stray = (rings: { lat: number; lon: number }[][]) => {
    let most = 0;
    for (const ring of rings) {
      for (const p of ring) {
        const s = project(p.lat, p.lon)!;
        const edge = Math.min(
          Math.abs(s.x - from.x),
          Math.abs(s.x - to.x),
          Math.abs(s.y - from.y),
          Math.abs(s.y - to.y)
        );
        most = Math.max(most, edge);
      }
    }
    return most;
  };
  expect(stray(snapped)).toBeLessThan(1e-6);
  expect(stray(snapped)).toBeLessThanOrEqual(stray(traced));
});
