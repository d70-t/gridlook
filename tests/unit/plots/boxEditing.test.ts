import * as THREE from "three";
import { expect, it } from "vitest";

import {
  frameRule,
  frameProject,
  type TScreenFrame,
} from "@/lib/analysis/screenFrame.ts";
import { editHandles, moveHandle } from "@/lib/analysis/shapeEdit.ts";
import { GEOMETRY_KINDS, type TShapeGeometry } from "@/lib/analysis/types.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";
import { rectangleSelection } from "@/ui/analysis/boxFootprint.ts";
import { describeGeometry } from "@/ui/analysis/plotLayout.ts";

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

it("interim49: moving one Box corner keeps the untouched sides exactly as drawn", () => {
  const { pick, project, view } = globeView();
  const centre = project(89.9, 3)!;
  const [from, to] = [
    { x: centre.x - 20, y: centre.y - 12 },
    { x: centre.x + 20, y: centre.y + 12 },
  ];
  const drawn = rectangleSelection(pick, project, from, to, false, true, view)!
    .geometry as TShapeGeometry;
  const handles = editHandles(drawn);
  // The corner nearest the top left, moved half a pixel inwards.
  const helper = new ProjectionHelper(
    view.projection.type,
    view.projection.center
  );
  const onScreen = handles.map((h) =>
    frameProject(view, helper, h.lat, h.lon)!
  );
  const k = onScreen.reduce(
    (best, p, at) =>
      Math.hypot(p.x - from.x, p.y - from.y) <
      Math.hypot(onScreen[best].x - from.x, onScreen[best].y - from.y)
        ? at
        : best,
    0
  );
  const moved = pick(from.x + 0.5, from.y + 0.5)!;
  const edited = moveHandle(drawn, handles[k], moved) as TShapeGeometry;
  expect(edited.kind).toBe(GEOMETRY_KINDS.SHAPE);
  expect(edited.frame?.quad).toHaveLength(4);
  const rule = frameRule(edited.frame as TScreenFrame);
  // Points just inside and outside the untouched bottom and right sides
  // keep the drawn rectangle's answer.
  for (const d of [-1e-3, 1e-3]) {
    for (let t = 0.1; t < 1; t += 0.2) {
      const bottom = pick(from.x + t * (to.x - from.x), to.y + d)!;
      const right = pick(to.x + d, from.y + t * (to.y - from.y))!;
      expect(rule.inside(bottom.lat, bottom.lon)).toBe(d < 0);
      expect(rule.inside(right.lat, right.lon)).toBe(d < 0);
    }
  }
  // Its title from its rings now, not the drawing's name.
  expect(edited.edited).toBe(true);
  const far = moveHandle(
    drawn,
    handles[k],
    pick(from.x - 15, from.y - 9)!
  ) as TShapeGeometry;
  expect(describeGeometry(far)).not.toBe(describeGeometry(drawn));
});

it("interim49: a frame behind a reactive proxy is read once, not per point", () => {
  const { view } = globeView();
  let reads = 0;
  const counted = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, key, r) {
        reads++;
        const value = Reflect.get(t, key, r);
        return value && typeof value === "object" ? counted(value) : value;
      },
    });
  const frame = counted({
    ...view,
    rect: { x0: 0, y0: 0, x1: 2000, y1: 2000 },
    band: 1e-6,
  } as TScreenFrame);
  const rule = frameRule(frame);
  const before = reads;
  for (let k = 0; k < 1000; k++) {
    rule.inside(89.9, 3 + k * 1e-6);
  }
  expect(reads - before).toBe(0);
});

it("interim49: a returning latitude track's axis spans every sample", async () => {
  const { finiteSpan } = await import("@/ui/analysis/plotFigure.ts");
  // Out from 20°S to 20°N and back: both ends at 20°S.
  const lats = [-20, -10, 0, 10, 20, 10, 0, -10, -20];
  expect(finiteSpan(lats)).toEqual({ min: -20, max: 20 });
  expect(finiteSpan([5, 5])).toEqual({ min: 4, max: 6 });
});
