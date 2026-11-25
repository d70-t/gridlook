/**
 * A Box on the globe checked against the camera itself: the app's perspective
 * camera (7.5° field, north up, looking at the centre), its pick (a ray on the
 * unit sphere) and its projection (a place shows when it faces the camera, p·c
 * > 1). The oracle: a grid centre belongs to the Box when the camera shows it
 * inside the screen rectangle.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  countryContains,
  prepareCountry,
} from "../../../../src/lib/analysis/countryRegion.ts";
import { GEOMETRY_KINDS } from "../../../../src/lib/analysis/types.ts";
import { CAMERA_VERTICAL_FOV_DEGREES } from "../../../../src/lib/camera/cameraSettings.ts";
import {
  drawnOutline,
  rectangleSelection,
} from "../../../../src/ui/analysis/boxFootprint.ts";
import { altitudeToCameraDistance } from "../../../../src/ui/grids/composables/useGridCameraState.ts";

const DEG = Math.PI / 180;
const [WIDTH, HEIGHT] = [1536, 850];
const unit = (lat: number, lon: number) =>
  new THREE.Vector3(
    Math.cos(lat * DEG) * Math.cos(lon * DEG),
    Math.cos(lat * DEG) * Math.sin(lon * DEG),
    Math.sin(lat * DEG)
  );

/** The globe as the app shows it from above (lat, lon) at `altitude` m. */
function globeCamera(lat: number, lon: number, altitude: number) {
  const camera = new THREE.PerspectiveCamera(
    CAMERA_VERTICAL_FOV_DEGREES,
    WIDTH / HEIGHT,
    0.1,
    1000
  );
  camera.up.set(0, 0, 1);
  camera.position.copy(
    unit(lat, lon).multiplyScalar(altitudeToCameraDistance(altitude, false))
  );
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const sphere = new THREE.Sphere(new THREE.Vector3(), 1);
  const ray = new THREE.Raycaster();
  const hit = new THREE.Vector3();
  const pick = (x: number, y: number) => {
    const ndc = new THREE.Vector2((x / WIDTH) * 2 - 1, 1 - (y / HEIGHT) * 2);
    ray.setFromCamera(ndc, camera);
    const p = ray.ray.intersectSphere(sphere, hit);
    return p
      ? {
          lat: Math.asin(p.z / p.length()) / DEG,
          lon: Math.atan2(p.y, p.x) / DEG,
        }
      : null;
  };
  const project = (la: number, lo: number) => {
    const p = unit(la, lo);
    const visible = p.dot(camera.position) > 1;
    p.project(camera);
    return {
      x: ((p.x + 1) / 2) * WIDTH,
      y: ((1 - p.y) / 2) * HEIGHT,
      visible: visible && p.z < 1,
    };
  };
  return { pick, project };
}

type TCamera = ReturnType<typeof globeCamera>;
type TRect = [number, number, number, number];

/** The 2° polar strip: 0.05° rows by 1° columns, 88°N to the pole. */
const STRIP = Array.from({ length: 40 * 360 }, (_, k) => [
  88.025 + 0.05 * Math.floor(k / 360),
  -179.5 + (k % 360),
]);

/**
 * Centres the selection holds against those the camera shows inside the
 * rectangle; a centre within `tie` px of a side is a tie either way.
 */
function compare(view: TCamera, [x0, y0, x1, y1]: TRect, tie = 0.015) {
  const selection = rectangleSelection(
    view.pick,
    view.project,
    { x: x0, y: y0 },
    { x: x1, y: y1 },
    false,
    true
  );
  const geometry = selection?.geometry;
  const region =
    geometry?.kind === GEOMETRY_KINDS.SHAPE
      ? prepareCountry(geometry.polygons, geometry.poles)
      : undefined;
  const [lx, hx, ly, hy] = [
    Math.min(x0, x1),
    Math.max(x0, x1),
    Math.min(y0, y1),
    Math.max(y0, y1),
  ];
  let [shown, held, wrong] = [0, 0, 0];
  for (const [lat, lon] of STRIP) {
    const p = view.project(lat, lon);
    const inside =
      p.visible && p.x >= lx && p.x <= hx && p.y >= ly && p.y <= hy;
    const holds = !!region && countryContains(region, lat, lon);
    shown += inside ? 1 : 0;
    held += holds ? 1 : 0;
    const side = Math.min(
      Math.abs(p.x - lx),
      Math.abs(p.x - hx),
      Math.abs(p.y - ly),
      Math.abs(p.y - hy)
    );
    wrong += inside !== holds && !(p.visible && side < tie) ? 1 : 0;
  }
  return { selected: !!region, shown, held, wrong };
}

describe("a Box over a visible pole at the globe's limb", () => {
  // 3°N, 157°W, 37 radii out: the North Pole is drawn 0.06 px inside the
  // limb, and the limb within 3 px of it lies up to 1.5° beyond it.
  const far = globeCamera(3, -157, 235_727_000);

  it("holds the polar cells the camera shows, both ways round", () => {
    for (const rect of [
      [754.4, 256.8, 775.8, 222.2],
      [775.8, 256.8, 754.4, 222.2],
      [788.0, 258.4, 725.2, 141.8],
    ] as TRect[]) {
      const { shown, held, wrong } = compare(far, rect);
      expect(shown).toBe(13_808);
      expect(wrong).toBe(0);
      expect(Math.abs(held - shown)).toBeLessThan(10);
    }
  });

  it("takes in no centre hidden just beyond the limb", () => {
    // A lat/lon chord between two horizon points sags onto the far side,
    // 0.002° beyond the limb.
    const { wrong } = compare(far, [754.4, 256.8, 775.8, 222.2], 0);
    expect(wrong).toBe(0);
  });

  it("makes a selection from half a pixel below the pole", () => {
    const { selected, shown, wrong } = compare(
      far,
      [767.5566, 254.8828, 834.0924, 209.3072]
    );
    expect(selected).toBe(true);
    expect(shown).toBe(8_309);
    expect(wrong).toBe(0);
  });
});

type TXY = { x: number; y: number };

/** Whether (x, y) is within half a pixel of the drawn polyline. */
function onOutline(drawn: TXY[], x: number, y: number) {
  return drawn.some((p, i) => {
    const q = drawn[i + 1] ?? p;
    const [dx, dy] = [q.x - p.x, q.y - p.y];
    const f = Math.max(
      0,
      Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / (dx * dx + dy * dy || 1))
    );
    return Math.hypot(p.x + f * dx - x, p.y + f * dy - y) < 0.5;
  });
}

/**
 * Pixels along the rectangle's sides with no drawn outline within half a
 * pixel, once the Box is committed and drawn as a saved shape.
 */
function sidesMissing(view: TCamera, [x0, y0, x1, y1]: TRect) {
  const geometry = rectangleSelection(
    view.pick,
    view.project,
    { x: x0, y: y0 },
    { x: x1, y: y1 },
    false,
    true
  )?.geometry;
  if (geometry?.kind !== GEOMETRY_KINDS.SHAPE) {
    return Infinity;
  }
  const drawn = drawnOutline(geometry.polygons).flatMap((run) =>
    run.map((p) => view.project(p.lat, p.lon))
  );
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  let missing = 0;
  corners.forEach(([ax, ay], k) => {
    const [bx, by] = corners[(k + 1) % 4];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let j = 0; j <= n; j++) {
      const [x, y] = [ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n];
      missing += onOutline(drawn, x, y) ? 0 : 1;
    }
  });
  return missing;
}

describe("a thin Box by the pole at close zoom keeps its outline", () => {
  // 89.99°N, 15°E, 31,855 m: 12 px is about 0.0005° here.
  const near = globeCamera(89.99, 15, 31_855);
  const pole = near.project(90, 0);

  it("draws both long sides of a 12 × 295 px box beside the pole", () => {
    for (const rect of [
      [pole.x - 12.3, pole.y - 280, pole.x - 0.3, pole.y + 15],
      [pole.x + 6, pole.y + 10, pole.x + 18, pole.y - 285],
      [pole.x - 150, pole.y + 3, pole.x + 145, pole.y + 15],
    ] as TRect[]) {
      expect(sidesMissing(near, rect)).toBe(0);
    }
  });
});
