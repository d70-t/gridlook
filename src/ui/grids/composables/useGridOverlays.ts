import { storeToRefs } from "pinia";
import * as THREE from "three";
import { watch, type ComputedRef, type Ref } from "vue";

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
import { useGlobeControlStore } from "@/store/store";

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

const coastStyle: TOverlayLineStyle = {
  color: "#ffffff",
  radius: 1.002,
  zOffset: 0.01,
} as const;

const graticuleStyle: TOverlayLineStyle = {
  color: "#888888",
  radius: 1.002,
  zOffset: 0.01,
} as const;

/* eslint-disable-next-line max-lines-per-function */
export function useGridOverlays(options: UseGridOverlaysOptions) {
  const store = useGlobeControlStore();
  const { showCoastLines, showGraticules } = storeToRefs(store);

  const {
    projectionHelper,
    landSeaMaskChoice,
    landSeaMaskUseTexture,
    getScene,
    redraw,
  } = options;

  let coast: THREE.LineSegments | undefined = undefined;
  let graticules: THREE.LineSegments | undefined = undefined;
  let landSeaMask: THREE.Object3D | undefined = undefined;

  watch(
    () => showCoastLines.value,
    () => {
      updateCoastlines();
    }
  );

  watch(
    () => showGraticules.value,
    () => {
      updateGraticules();
    }
  );

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
    if (!coast) {
      coast = await createLineSegments(
        "static/ne_50m_coastline.geojson",
        coastStyle,
        "coastlines"
      );
    }
    updateLineProjection(coast, coastStyle);
    return coast;
  }

  async function getGraticulesLayer() {
    if (!graticules) {
      graticules = await createLineSegments(
        "static/ne_50m_graticules_30.geojson",
        graticuleStyle,
        "graticules"
      );
    }
    updateLineProjection(graticules, graticuleStyle);
    return graticules;
  }

  async function createLineSegments(
    geojsonPath: string,
    style: TOverlayLineStyle,
    name: string
  ) {
    const coastlineData = await ResourceCache.loadGeoJSON(geojsonPath);
    const geometry = geojson2gpuLineSegmentsGeometry(
      coastlineData,
      projectionHelper.value,
      getLineProjectionOptions(style)
    );
    const material = makeGpuProjectedLineMaterial({
      color: style.color,
      ...getLineProjectionOptions(style),
    });
    const lineSegments = new THREE.LineSegments(geometry, material);
    lineSegments.name = name;
    lineSegments.renderOrder = 20;
    lineSegments.frustumCulled = false;
    updateLineProjection(lineSegments, style);
    return lineSegments;
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
