import type { FeatureCollection } from "geojson";
import * as THREE from "three";
import type { ComputedRef, Ref } from "vue";

import { geojson2gpuLineSegmentsGeometry } from "@/lib/layers/geojson.ts";
import {
  makeGpuProjectedLineMaterial,
  updateGpuProjectedLineMaterial,
} from "@/lib/layers/gpuProjectedLines.ts";
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

type TOverlayLineStyle = {
  color: string;
  radius: number;
  zOffset: number;
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

  const coastStyle: TOverlayLineStyle = {
    color: "#ffffff",
    radius: 1.002,
    zOffset: 0.01,
  };
  const graticuleStyle: TOverlayLineStyle = {
    color: "#888888",
    radius: 1.002,
    zOffset: 0.01,
  };

  function getLineProjectionOptions(style: TOverlayLineStyle) {
    return {
      radius: projectionHelper.value.isFlat ? 1 : style.radius,
      zOffset: projectionHelper.value.isFlat ? style.zOffset : 0,
    };
  }

  function updateLineProjection(
    line: THREE.LineSegments | undefined,
    style: TOverlayLineStyle
  ) {
    if (!line) {
      return;
    }

    updateGpuProjectedLineMaterial(
      line.material as THREE.ShaderMaterial,
      projectionHelper.value,
      getLineProjectionOptions(style)
    );
  }

  async function getCoastlines() {
    if (!coastlineData) {
      coastlineData = await ResourceCache.loadGeoJSON(
        "static/ne_50m_coastline.geojson"
      );
    }

    if (!coast) {
      const geometry = geojson2gpuLineSegmentsGeometry(
        coastlineData,
        projectionHelper.value,
        getLineProjectionOptions(coastStyle)
      );
      const material = makeGpuProjectedLineMaterial({
        color: coastStyle.color,
        ...getLineProjectionOptions(coastStyle),
      });
      coast = new THREE.LineSegments(geometry, material);
      coast.name = "coastlines";
      coast.renderOrder = 1;
      coast.frustumCulled = false;
    }
    updateLineProjection(coast, coastStyle);
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
      const geometry = geojson2gpuLineSegmentsGeometry(
        graticulesData,
        projectionHelper.value,
        getLineProjectionOptions(graticuleStyle)
      );
      const material = makeGpuProjectedLineMaterial({
        color: graticuleStyle.color,
        ...getLineProjectionOptions(graticuleStyle),
      });
      graticules = new THREE.LineSegments(geometry, material);
      graticules.name = "graticules";
      graticules.renderOrder = 1;
      graticules.frustumCulled = false;
    }
    updateLineProjection(graticules, graticuleStyle);
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

  async function updateOverlayProjectionUniforms(forceRebuild = false) {
    if (forceRebuild) {
      await Promise.all([updateCoastlines(), updateGraticules()]);
      return;
    }
    updateLineProjection(coast, coastStyle);
    updateLineProjection(graticules, graticuleStyle);
    redraw();
  }

  return {
    updateCoastlines,
    updateGraticules,
    updateLandSeaMask,
    updateLandSeaMaskProjectionUniforms,
    updateOverlayProjectionUniforms,
  };
}
