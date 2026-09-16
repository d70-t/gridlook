import { PerspectiveCamera, type CustomOrbitControls } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { expect, it, vi } from "vitest";

import {
  handleKeyDown,
  useSurfaceZoom,
} from "@/lib/camera/OrbitControlsAddOn.ts";

it.each(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])(
  "slows %s near the surface while preserving distant rotation",
  (key) => {
    for (const distance of [16, 2, 1.1461, 1.146, 1.1459, 1.1, 1.01, 1.001]) {
      const camera = new PerspectiveCamera();
      camera.position.set(distance, 0, 0);
      const controls = new OrbitControls(camera);
      const before = camera.position.clone();
      handleKeyDown(
        { key, preventDefault() {} } as KeyboardEvent,
        controls,
        false
      );
      controls.update();
      const angle = before.angleTo(camera.position);
      if (distance >= 2) {
        expect(angle).toBeCloseTo(0.025, 6);
      } else {
        // Around 930 km and below, use at most 1/8 of the previous 0.025 step
        // per unit altitude, without making close navigation unresponsive.
        const stepPerAltitude = angle / (distance - 1);
        expect(stepPerAltitude).toBeGreaterThan(0.0024);
        expect(stepPerAltitude).toBeLessThan(0.025 / 8);
      }
      expect(camera.position.length()).toBeCloseTo(distance, 12);
    }
  }
);

it("preserves arrow-key panning in flat projections", () => {
  const camera = new PerspectiveCamera();
  camera.position.set(0, 0, 0.1);
  const controls: OrbitControls = new OrbitControls(camera);
  const pan = vi
    .spyOn(controls as CustomOrbitControls, "_pan")
    .mockImplementation(() => {});
  handleKeyDown(
    { key: "ArrowRight", preventDefault() {} } as KeyboardEvent,
    controls,
    true
  );
  expect(pan).toHaveBeenCalledWith(controls.keyPanSpeed, 0);
});

it("takes small altitude steps down to the limit and zooms back out", () => {
  const camera = new PerspectiveCamera();
  camera.position.set(1.02, 0, 0);
  const controls = new OrbitControls(camera);
  controls.minDistance = 1.001;
  useSurfaceZoom(controls, () => false);

  let steps = 0;
  while (camera.position.length() > controls.minDistance + 1e-12) {
    const previousAltitude = camera.position.length() - 1;
    controls.dollyIn(0.95);
    expect(camera.position.length() - 1).toBeCloseTo(
      Math.max(0.001, previousAltitude * 0.95),
      12
    );
    expect(++steps).toBeLessThan(100);
  }
  expect(steps).toBe(59);
  controls.dollyOut(0.95);
  expect(camera.position.length() - 1).toBeCloseTo(0.001 / 0.95, 12);
});

it("scales accumulated keyboard zoom and preserves flat projection zoom", () => {
  const camera = new PerspectiveCamera();
  camera.position.set(1.01, 0, 0);
  const controls = new OrbitControls(camera);
  let isFlat = false;
  useSurfaceZoom(controls, () => isFlat);
  const event = { key: "+", preventDefault() {} } as KeyboardEvent;
  handleKeyDown(event, controls, false);
  handleKeyDown(event, controls, false);
  controls.update();
  expect(camera.position.length() - 1).toBeCloseTo(
    0.01 * 0.95 ** (0.96 * 2),
    12
  );

  isFlat = true;
  const previousDistance = camera.position.length();
  controls.dollyIn(0.95);
  expect(camera.position.length()).toBeCloseTo(previousDistance * 0.95, 12);
});
