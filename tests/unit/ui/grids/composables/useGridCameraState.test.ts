import * as THREE from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
});

const { createPinia, setActivePinia } = await import("pinia");
const { STORE_PARAM_MAPPING, useUrlParameterStore } =
  await import("@/store/paramStore.ts");
const {
  altitudeToCameraDistance,
  cameraDistanceToAltitude,
  EARTH_RADIUS_METERS,
  useGridCameraState,
} = await import("@/ui/grids/composables/useGridCameraState.ts");
const { URL_PARAMETERS } = await import("@/utils/urlParams.ts");

beforeEach(() => {
  setActivePinia(createPinia());
});

/* eslint-disable-next-line max-lines-per-function */
describe("camera URL parameters", () => {
  it("uses the projection-independent parameter names", () => {
    expect(URL_PARAMETERS.CAMERA_PX).toBe("px");
    expect(URL_PARAMETERS.CAMERA_PY).toBe("py");
    expect(URL_PARAMETERS.CAMERA_ALT).toBe("alt");
    expect(URL_PARAMETERS.LAT).toBe("lat");
    expect(URL_PARAMETERS.LON).toBe("lon");

    expect(STORE_PARAM_MAPPING).not.toHaveProperty("x");
    expect(STORE_PARAM_MAPPING).not.toHaveProperty("y");
    expect(STORE_PARAM_MAPPING).not.toHaveProperty("z");
    expect(STORE_PARAM_MAPPING).not.toHaveProperty("projectionCenterLat");
    expect(STORE_PARAM_MAPPING).not.toHaveProperty("projectionCenterLon");
  });

  it("converts altitude differently from globe radius and flat distance", () => {
    expect(cameraDistanceToAltitude(2, false)).toBe(EARTH_RADIUS_METERS);
    expect(cameraDistanceToAltitude(2, true)).toBe(2 * EARTH_RADIUS_METERS);
    expect(altitudeToCameraDistance(EARTH_RADIUS_METERS, false)).toBe(2);
    expect(altitudeToCameraDistance(EARTH_RADIUS_METERS, true)).toBe(1);
  });

  it("encodes flat camera-plane coordinates and altitude in metres", () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1.25, -0.5, 3.5);
    const cameraState = useGridCameraState();

    cameraState.encodeCameraToURL(camera, true);

    const params = useUrlParameterStore();
    expect(params.paramCameraPx).toBe(
      String(Math.round(1.25 * EARTH_RADIUS_METERS))
    );
    expect(params.paramCameraPy).toBe(
      String(Math.round(-0.5 * EARTH_RADIUS_METERS))
    );
    expect(params.paramCameraAlt).toBe(
      String(Math.round(3.5 * EARTH_RADIUS_METERS))
    );
  });

  it("encodes globe altitude above the surface", () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(3, 4, 12);
    const cameraState = useGridCameraState();

    cameraState.encodeCameraToURL(camera, false);

    const params = useUrlParameterStore();
    expect(params.paramCameraPx).toBe("0");
    expect(params.paramCameraPy).toBe("0");
    expect(params.paramCameraAlt).toBe(
      String(Math.round(12 * EARTH_RADIUS_METERS))
    );
  });

  it("requires a finite altitude and defaults omitted offsets to zero", () => {
    const params = useUrlParameterStore();
    const cameraState = useGridCameraState();

    expect(cameraState.decodeCameraFromURL()).toBeNull();
    params.paramCameraAlt = "1000";
    expect(cameraState.decodeCameraFromURL()).toEqual({
      px: 0,
      py: 0,
      alt: 1000,
    });
    params.paramCameraAlt = "not-a-number";
    expect(cameraState.decodeCameraFromURL()).toBeNull();
  });
});
