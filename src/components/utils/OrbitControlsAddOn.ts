import type { CustomOrbitControls } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls";

/*
 * The regular OrbitControls type defintion does not include the "private" methods
 * of OrbitControls.
 * The default-behaviour of the OrbitControls keyboardListener moves the earth
 * instead of rotating it, which is not what we want.
 *
 * We declare a custom OrbitControls which expose the rotation-methods write our
 * own keyboardListener
 *
 * Keep in mind that we are using the internal API of OrbitControls here which might change
 * in the future.
 */
declare module "three" {
  interface CustomOrbitControls extends OrbitControls {
    domElement: HTMLElement;
    _rotateUp: (angle: number) => void;
    _rotateLeft: (angle: number) => void;
    _getZoomScale: (delta: number) => number;
    _dollyIn: (scale: number) => void;
    _dollyOut: (scale: number) => void;
  }
}

const TWO_PI = 2 * Math.PI;
const ZOOM_STEP = 96;

export function handleKeyDown(event: KeyboardEvent, oC: OrbitControls) {
  const orbitControls = oC as CustomOrbitControls;
  switch (event.key) {
    case "ArrowUp":
      orbitControls._rotateUp(
        (TWO_PI * orbitControls.rotateSpeed) /
          orbitControls.domElement.clientHeight
      );
      break;

    case "ArrowDown":
      orbitControls._rotateUp(
        (-TWO_PI * orbitControls.rotateSpeed) /
          orbitControls.domElement.clientHeight
      );
      break;

    case "ArrowLeft":
      orbitControls._rotateLeft(
        (TWO_PI * orbitControls.rotateSpeed) /
          orbitControls.domElement.clientHeight
      );
      break;

    case "ArrowRight":
      orbitControls._rotateLeft(
        (-TWO_PI * orbitControls.rotateSpeed) /
          orbitControls.domElement.clientHeight
      );
      break;

    case "+":
      orbitControls._dollyIn(orbitControls._getZoomScale(-ZOOM_STEP));
      break;

    case "-":
      orbitControls._dollyOut(orbitControls._getZoomScale(ZOOM_STEP));
      break;
  }

  event.preventDefault();
}
