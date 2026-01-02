import debounce from "lodash.debounce";
import { storeToRefs } from "pinia";
import type * as THREE from "three";

import { useUrlParameterStore } from "@/store/paramStore.ts";

export type TCameraState = {
  position: number[];
  quaternion: number[];
  fov: number;
  aspect: number;
  near: number;
  far: number;
};

export type GridCameraState = {
  encodeCameraToURL: (camera: THREE.PerspectiveCamera) => void;
  decodeCameraFromURL: () => TCameraState | null;
  applyCameraState: (
    camera: THREE.PerspectiveCamera,
    data: TCameraState
  ) => void;
  debouncedEncodeCameraToURL: (camera: THREE.PerspectiveCamera) => void;
};

/* eslint-disable-next-line max-lines-per-function */
export function useGridCameraState(): GridCameraState {
  const urlParameterStore = useUrlParameterStore();
  const { paramCameraState } = storeToRefs(urlParameterStore);

  function encodeCameraToURL(camera: THREE.PerspectiveCamera) {
    const state: TCameraState = {
      position: camera.position.toArray(),
      quaternion: camera.quaternion.toArray(),
      fov: camera.fov,
      aspect: camera.aspect,
      near: camera.near,
      far: camera.far,
    };

    const json = JSON.stringify(state);
    const encoded = btoa(json)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    paramCameraState.value = encoded;
  }

  function decodeCameraFromURL(): TCameraState | null {
    const encoded = paramCameraState.value;
    if (!encoded) {
      return null;
    }

    try {
      const json = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
      return JSON.parse(json);
    } catch {
      return null;
    }
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

    if (typeof data.fov === "number") {
      camera.fov = data.fov;
    }

    if (typeof data.aspect === "number") {
      camera.aspect = data.aspect;
    }

    if (typeof data.near === "number") {
      camera.near = data.near;
    }

    if (typeof data.far === "number") {
      camera.far = data.far;
    }

    camera.updateProjectionMatrix();
  }

  const debouncedEncodeCameraToURL = debounce(
    (camera: THREE.PerspectiveCamera) => {
      encodeCameraToURL(camera);
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
