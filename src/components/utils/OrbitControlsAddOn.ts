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
  }
}

const twoPI = 2 * Math.PI;
export function handleKeyDown(event: KeyboardEvent, oC: OrbitControls) {
  const orbitControls = oC as CustomOrbitControls;
  let needsUpdate = false;

  switch (event.code) {
    case "ArrowUp":
      orbitControls._rotateUp(
        (twoPI * orbitControls.rotateSpeed) /
          orbitControls.domElement.clientHeight
      );

      needsUpdate = true;
      break;

    case "ArrowDown":
      orbitControls._rotateUp(
        (-twoPI * orbitControls.rotateSpeed) /
          orbitControls.domElement.clientHeight
      );

      needsUpdate = true;
      break;

    case "ArrowLeft":
      orbitControls._rotateLeft(
        (twoPI * orbitControls.rotateSpeed) /
          orbitControls.domElement.clientHeight
      );

      needsUpdate = true;
      break;

    case "ArrowRight":
      orbitControls._rotateLeft(
        (-twoPI * orbitControls.rotateSpeed) /
          orbitControls.domElement.clientHeight
      );

      needsUpdate = true;
      break;
  }

  if (needsUpdate) {
    // prevent the browser from scrolling on cursor keys
    event.preventDefault();

    orbitControls.update();
  }
}
