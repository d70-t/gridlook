import type { FeatureCollection } from "geojson";
import * as THREE from "three";
import type { ComputedRef, Ref } from "vue";

import { geojson2geometry } from "@/lib/layers/geojson.ts";
import {
  getLandSeaMask,
  LAND_SEA_MASK_MODES,
  type TLandSeaMaskMode,
  updateLandSeaMaskProjection,
} from "@/lib/layers/landSeaMask.ts";
import { ResourceCache } from "@/lib/layers/ResourceCache.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

type UseGridOverlaysOptions = {
  projectionHelper: ComputedRef<ProjectionHelper>;
  showCoastLines: Ref<boolean>;
  showGraticules: Ref<boolean>;
  landSeaMaskChoice: Ref<TLandSeaMaskMode | undefined>;
  landSeaMaskUseTexture: Ref<boolean>;
  getScene: () => THREE.Scene | undefined;
  redraw: () => void;
};

/* eslint-disable-next-line max-lines-per-function */
export function useGridOverlays(options: UseGridOverlaysOptions) {
  const {
    projectionHelper,
    showCoastLines,
    showGraticules,
    landSeaMaskChoice,
    landSeaMaskUseTexture,
    getScene,
    redraw,
  } = options;

  let coast: THREE.LineSegments | undefined = undefined;
  let graticules: THREE.LineSegments | undefined = undefined;
  let landSeaMask: THREE.Object3D | undefined = undefined;
  let coastlineData: FeatureCollection | undefined;
  let graticulesData: FeatureCollection | undefined;

  async function getCoastlines() {
    if (!coastlineData) {
      coastlineData = await ResourceCache.loadGeoJSON(
        "static/ne_50m_coastline.geojson"
      );
    }
    if (!coast) {
      const material = new THREE.LineBasicMaterial({
        color: "#ffffff",
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      coast = new THREE.LineSegments(new THREE.BufferGeometry(), material);
      coast.name = "coastlines";
      coast.renderOrder = 1;
    }
    const geometry = geojson2geometry(coastlineData, projectionHelper.value, {
      radius: projectionHelper.value.isFlat ? 1 : 1.002,
      zOffset: projectionHelper.value.isFlat ? 0.01 : 0,
    });
    coast.geometry.dispose();
    coast.geometry = geometry;
    return coast;
  }

  async function updateCoastlines() {
    const scene = getScene();
    if (!scene) {
      return;
    }
    if (showCoastLines.value === false) {
      if (coast) {
        scene.remove(coast);
      }
    } else {
      scene.add(await getCoastlines());
    }
    redraw();
  }

  async function getGraticulesLayer() {
    if (!graticulesData) {
      graticulesData = await ResourceCache.loadGeoJSON(
        "static/ne_50m_graticules_30.geojson"
      );
    }
    if (!graticules) {
      const material = new THREE.LineBasicMaterial({
        color: "#888888",
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      graticules = new THREE.LineSegments(new THREE.BufferGeometry(), material);
      graticules.name = "graticules";
      graticules.renderOrder = 1;
    }
    const geometry = geojson2geometry(graticulesData, projectionHelper.value, {
      radius: projectionHelper.value.isFlat ? 1 : 1.002,
      zOffset: projectionHelper.value.isFlat ? 0.01 : 0,
    });
    graticules.geometry.dispose();
    graticules.geometry = geometry;
    return graticules;
  }

  async function updateGraticules() {
    const scene = getScene();
    if (!scene) {
      return;
    }
    if (showGraticules.value === false) {
      if (graticules) {
        scene.remove(graticules);
      }
    } else {
      scene.add(await getGraticulesLayer());
    }
    redraw();
  }

  async function updateLandSeaMask() {
    const choice = landSeaMaskChoice.value ?? LAND_SEA_MASK_MODES.OFF;
    const scene = getScene();
    if (landSeaMask) {
      scene?.remove(landSeaMask);
      if (landSeaMask instanceof THREE.Mesh) {
        landSeaMask.geometry?.dispose();
        const material = landSeaMask.material as THREE.ShaderMaterial;
        const tex = material.uniforms?.maskTexture?.value as
          | THREE.Texture
          | undefined;
        tex?.dispose();
        material?.dispose();
      }
      landSeaMask = undefined;
    }
    if (choice === LAND_SEA_MASK_MODES.OFF) {
      redraw();
      return;
    }

    const mask = await getLandSeaMask(
      landSeaMaskChoice.value!,
      landSeaMaskUseTexture.value!,
      projectionHelper.value
    );
    landSeaMask = mask;
    if (landSeaMask) {
      scene?.add(landSeaMask);
    }
    redraw();
  }

  function updateLandSeaMaskProjectionUniforms() {
    if (!landSeaMask) {
      return;
    }
    updateLandSeaMaskProjection(landSeaMask, projectionHelper.value);
    redraw();
  }

  return {
    updateCoastlines,
    updateGraticules,
    updateLandSeaMask,
    updateLandSeaMaskProjectionUniforms,
  };
}
