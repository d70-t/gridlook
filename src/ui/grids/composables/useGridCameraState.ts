import { useDebounceFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import type * as THREE from "three";

import { useUrlParameterStore } from "@/store/paramStore.ts";

export type TCameraState = {
  position: number[];
  quaternion: number[];
};

export type TCameraUrlState = {
  px: number;
  py: number;
  alt: number;
};

export type TGridCameraState = {
  encodeCameraToURL: (camera: THREE.PerspectiveCamera, isFlat: boolean) => void;
  decodeCameraFromURL: () => TCameraUrlState | null;
  applyCameraState: (
    camera: THREE.PerspectiveCamera,
    data: TCameraState
  ) => void;
  debouncedEncodeCameraToURL: (
    camera: THREE.PerspectiveCamera,
    isFlat: boolean
  ) => void;
};

// The renderer models Earth as a unit sphere. URL camera coordinates use the
// IUGG mean Earth radius to expose that sphere in physical metres.
export const EARTH_RADIUS_METERS = 6_371_008.8;

function formatCameraParam(value: number) {
  const rounded = Math.round(value);
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function parseCameraParam(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function cameraDistanceToAltitude(distance: number, isFlat: boolean) {
  return (distance - (isFlat ? 0 : 1)) * EARTH_RADIUS_METERS;
}

export function altitudeToCameraDistance(altitude: number, isFlat: boolean) {
  return altitude / EARTH_RADIUS_METERS + (isFlat ? 0 : 1);
}

/* eslint-disable-next-line max-lines-per-function */
export function useGridCameraState(): TGridCameraState {
  const urlParameterStore = useUrlParameterStore();
  const { paramCameraPx, paramCameraPy, paramCameraAlt } =
    storeToRefs(urlParameterStore);

  function encodeCameraToURL(camera: THREE.PerspectiveCamera, isFlat: boolean) {
    paramCameraPx.value = formatCameraParam(
      isFlat ? camera.position.x * EARTH_RADIUS_METERS : 0
    );
    paramCameraPy.value = formatCameraParam(
      isFlat ? camera.position.y * EARTH_RADIUS_METERS : 0
    );
    const distance = isFlat ? camera.position.z : camera.position.length();
    paramCameraAlt.value = formatCameraParam(
      cameraDistanceToAltitude(distance, isFlat)
    );
  }

  function decodeCameraFromURL(): TCameraUrlState | null {
    const alt = parseCameraParam(paramCameraAlt.value);
    if (alt === undefined) {
      return null;
    }
    return {
      px: parseCameraParam(paramCameraPx.value) ?? 0,
      py: parseCameraParam(paramCameraPy.value) ?? 0,
      alt,
    };
  }

  function applyCameraState(
    camera: THREE.PerspectiveCamera,
    data: TCameraState
  ) {
    if (!data) {
      return;
    }

    if (data.position && data.position.length === 3) {
      camera.position.fromArray(data.position);
    }

    if (data.quaternion && data.quaternion.length === 4) {
      camera.quaternion.fromArray(data.quaternion);
    }
    camera.updateProjectionMatrix();
  }

  const debouncedEncodeCameraToURL = useDebounceFn(
    (camera: THREE.PerspectiveCamera, isFlat: boolean) => {
      encodeCameraToURL(camera, isFlat);
    },
    300
  );

  return {
    encodeCameraToURL,
    decodeCameraFromURL,
    applyCameraState,
    debouncedEncodeCameraToURL,
  };
}
