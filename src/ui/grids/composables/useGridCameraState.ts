import { useDebounceFn } from "@vueuse/core";
import { inflateSync } from "fflate";
import { storeToRefs } from "pinia";
import type * as THREE from "three";

import { useUrlParameterStore } from "@/store/paramStore.ts";

export type TCameraState = {
  position: number[];
  quaternion: number[];
};

export type TCameraUrlState = {
  x: number;
  y: number;
  z: number;
};

export type TDecodedCameraState = TCameraState | TCameraUrlState;

export type TGridCameraState = {
  encodeCameraToURL: (camera: THREE.PerspectiveCamera, isFlat: boolean) => void;
  decodeCameraFromURL: () => TDecodedCameraState | null;
  applyCameraState: (
    camera: THREE.PerspectiveCamera,
    data: TCameraState
  ) => void;
  debouncedEncodeCameraToURL: (
    camera: THREE.PerspectiveCamera,
    isFlat: boolean
  ) => void;
};

const CAMERA_PARAM_PRECISION = 10_000;

function formatCameraParam(value: number) {
  const rounded =
    Math.round(value * CAMERA_PARAM_PRECISION) / CAMERA_PARAM_PRECISION;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function parseCameraParam(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/* eslint-disable-next-line max-lines-per-function */
export function useGridCameraState(): TGridCameraState {
  const urlParameterStore = useUrlParameterStore();
  const { paramCameraState, paramCameraX, paramCameraY, paramCameraZ } =
    storeToRefs(urlParameterStore);

  function encodeCameraToURL(camera: THREE.PerspectiveCamera, isFlat: boolean) {
    paramCameraX.value = formatCameraParam(isFlat ? camera.position.x : 0);
    paramCameraY.value = formatCameraParam(isFlat ? camera.position.y : 0);
    paramCameraZ.value = formatCameraParam(
      isFlat ? camera.position.z : camera.position.length()
    );
    paramCameraState.value = undefined;
  }

  function decodeUrlCameraState(): TCameraUrlState | null {
    const z = parseCameraParam(paramCameraZ.value);
    if (z === undefined) {
      return null;
    }
    return {
      x: parseCameraParam(paramCameraX.value) ?? 0,
      y: parseCameraParam(paramCameraY.value) ?? 0,
      z,
    };
  }

  function decodeLegacyCameraState(): TCameraState | null {
    const encoded = paramCameraState.value;
    if (!encoded) {
      return null;
    }

    try {
      const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const paddingLength = (4 - (base64.length % 4)) % 4;
      const paddedBase64 = `${base64}${"=".repeat(paddingLength)}`;
      const binary = atob(paddedBase64);

      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));

      // Try decompressing first (new format)
      try {
        const decompressed = inflateSync(bytes);
        const json = new TextDecoder().decode(decompressed);
        return JSON.parse(json);
      } catch {
        // Fall back to legacy uncompressed base64
        return JSON.parse(binary);
      }
    } catch {
      return null;
    }
  }

  function decodeCameraFromURL(): TDecodedCameraState | null {
    return decodeUrlCameraState() ?? decodeLegacyCameraState();
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
