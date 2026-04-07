import { inflateSync, strFromU8, deflate } from "fflate";
import debounce from "lodash.debounce";
import { storeToRefs } from "pinia";
import type * as THREE from "three";

import { useUrlParameterStore } from "@/store/paramStore.ts";

export type TCameraState = {
  position: number[];
  quaternion: number[];
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
    };

    const json = JSON.stringify(state);
    deflate(new TextEncoder().encode(json), { level: 9 }, (err, compressed) => {
      if (err) {
        console.error("Compression failed, falling back to uncompressed:", err);
        // Fallback to uncompressed base64
        const encoded = btoa(json)
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        paramCameraState.value = encoded;
      } else {
        const encoded = btoa(strFromU8(compressed, true))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        paramCameraState.value = encoded;
      }
    });
  }

  function decodeCameraFromURL(): TCameraState | null {
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
