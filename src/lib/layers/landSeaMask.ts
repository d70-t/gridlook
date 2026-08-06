// Built-in land/sea mask layer.
// Paints the mask texture (solid colours or earth photo with land/sea cutout)
// and delegates mesh creation/projection to the generic equirect layer module.

import * as d3 from "d3-geo";
import * as THREE from "three";

import {
  applyLandSeaCutout,
  configureEquirectangularTexture,
  copyAntimeridianEdge,
  createEquirectangularPath,
  createEquirectLayerMesh,
  createLayerCanvas,
  LAND_SEA_MASK_MODES,
  updateEquirectLayerProjection,
  type TLandSeaMaskMode,
} from "./equirectLayer.ts";
import { ResourceCache } from "./ResourceCache.ts";

import albedo from "@/assets/earth.jpg";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

export { LAND_SEA_MASK_MODES, type TLandSeaMaskMode };

type TMaskConfig = {
  showLand: boolean;
  showSea: boolean;
};

const MASK_COLORS = {
  sea: "#3c78c8",
  land: "#d3d3d3ff",
};

function getMaskConfig(mode: TLandSeaMaskMode): TMaskConfig {
  const isGlobeMode = mode === LAND_SEA_MASK_MODES.GLOBE;
  const isLandMode = mode === LAND_SEA_MASK_MODES.LAND;
  const isSeaMode = mode === LAND_SEA_MASK_MODES.SEA;

  return {
    showLand: isGlobeMode || isLandMode,
    showSea: isGlobeMode || isSeaMode,
  };
}

function isGlobeMaskMode(mode: TLandSeaMaskMode): boolean {
  return mode === LAND_SEA_MASK_MODES.GLOBE;
}

/**
 * Threshold all alpha values to be exactly 0 or 255.
 * Canvas2D anti-aliases path edges, creating semi-transparent fringe pixels.
 * Those fringe pixels are discarded by the shader's `a < 0.01` test, which
 * makes mask edges look blurry/recessed when zoomed in.  Hard-quantising the
 * alpha produces the same sharp coastline appearance as the globe mask.
 */
function thresholdAlpha(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 3; i < data.length; i += 4) {
    data[i] = data[i] > 127 ? 255 : 0;
  }
  ctx.putImageData(imageData, 0, 0);
}

class GpuProjectedMaskRenderer {
  /**
   * Create a mask mesh. Mesh construction is delegated to the generic
   * equirect layer module; render order and blending are applied afterwards
   * from the layer stack position.
   */
  static async render(
    mode: TLandSeaMaskMode,
    useTexture: boolean,
    projectionHelper: ProjectionHelper
  ): Promise<THREE.Mesh | undefined> {
    if (mode === LAND_SEA_MASK_MODES.OFF) {
      return undefined;
    }

    const config = getMaskConfig(mode);
    const texture = await this.createMaskTexture(mode, useTexture, config);
    const mesh = createEquirectLayerMesh(texture, projectionHelper, "mask");
    mesh.userData.maskMode = mode;
    return mesh;
  }

  private static async createGlobeTexture(): Promise<THREE.Texture> {
    const img = await ResourceCache.loadImage(albedo);
    const { canvas, ctx, width, height } = createLayerCanvas(
      img.naturalWidth,
      img.naturalHeight
    );
    ctx.drawImage(img, 0, 0, width, height);
    copyAntimeridianEdge(ctx, width);
    return configureEquirectangularTexture(new THREE.CanvasTexture(canvas));
  }

  private static async renderMaskedMode(
    ctx: CanvasRenderingContext2D,
    path: d3.GeoPath,
    land: GeoJSON.FeatureCollection,
    useTexture: boolean,
    config: TMaskConfig,
    width: number,
    height: number
  ) {
    if (useTexture) {
      const img = await ResourceCache.loadImage(albedo);
      ctx.drawImage(img, 0, 0, width, height);
      await applyLandSeaCutout(
        ctx,
        width,
        height,
        config.showLand ? LAND_SEA_MASK_MODES.LAND : LAND_SEA_MASK_MODES.SEA
      );
      thresholdAlpha(ctx, width, height);
      return;
    }

    if (config.showSea) {
      ctx.fillStyle = MASK_COLORS.sea;
      ctx.fillRect(0, 0, width, height);
      if (!config.showLand) {
        ctx.beginPath();
        path(land);
        ctx.globalCompositeOperation = "destination-out";
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
    }

    if (config.showLand) {
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      path(land);
      ctx.fillStyle = MASK_COLORS.land;
      ctx.fill();
    }
  }

  private static async renderGlobeMode(
    ctx: CanvasRenderingContext2D,
    path: d3.GeoPath,
    land: GeoJSON.FeatureCollection,
    useTexture: boolean,
    width: number,
    height: number
  ) {
    if (useTexture) {
      const img = await ResourceCache.loadImage(albedo);
      ctx.drawImage(img, 0, 0, width, height);
      return;
    }

    // Fill with sea colour, then paint land on top.
    ctx.fillStyle = MASK_COLORS.sea;
    ctx.fillRect(0, 0, width, height);

    ctx.beginPath();
    path(land);
    ctx.fillStyle = MASK_COLORS.land;
    ctx.fill();
  }

  /**
   * Create the mask texture based on mode and settings.
   * This is rendered once and reused across projection changes.
   */
  private static async createMaskTexture(
    mode: TLandSeaMaskMode,
    useTexture: boolean,
    config: TMaskConfig
  ): Promise<THREE.Texture> {
    // Globe texture also goes through a canvas so its antimeridian columns match.
    if (isGlobeMaskMode(mode) && useTexture) {
      return this.createGlobeTexture();
    }

    // When textures are enabled, create the canvas at the earth image's native
    // resolution so the mask cutout matches the photo pixel-for-pixel.
    // For solid-colour masks we stay at 4096×2048 because complex d3 polygon
    // fills can exceed browser canvas path limits at higher resolutions.
    let canvasWidth = 4096;
    let canvasHeight = 2048;
    if (useTexture) {
      const img = await ResourceCache.loadImage(albedo);
      canvasWidth = img.naturalWidth;
      canvasHeight = img.naturalHeight;
    }

    const { canvas, ctx, width, height } = createLayerCanvas(
      canvasWidth,
      canvasHeight
    );
    const land = await ResourceCache.loadLandGeoJSON();
    const path = createEquirectangularPath(ctx, width, height);

    if (isGlobeMaskMode(mode)) {
      await this.renderGlobeMode(ctx, path, land, useTexture, width, height);
    } else {
      await this.renderMaskedMode(
        ctx,
        path,
        land,
        useTexture,
        config,
        width,
        height
      );
    }

    copyAntimeridianEdge(ctx, width);

    return configureEquirectangularTexture(new THREE.CanvasTexture(canvas));
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Create a land/sea mask mesh for the given projection.
 * Globe mode uses GPU-projected rendering; flat projections use d3 geometry.
 *
 * @param landSeaMaskChoice - The mask mode to use
 * @param landSeaMaskUseTexture - Whether to use textured or solid colors
 * @param projectionHelper - The projection helper (required for GPU projection)
 */
export async function getLandSeaMask(
  landSeaMaskChoice: TLandSeaMaskMode,
  landSeaMaskUseTexture: boolean,
  projectionHelper?: ProjectionHelper
): Promise<THREE.Object3D | undefined> {
  if (landSeaMaskChoice === LAND_SEA_MASK_MODES.OFF) {
    return undefined;
  }

  if (!projectionHelper) {
    return undefined;
  }

  try {
    // Use GPU-projected renderer for all projections.
    // Projection center changes only update uniforms — no geometry rebuild needed.
    return await GpuProjectedMaskRenderer.render(
      landSeaMaskChoice,
      landSeaMaskUseTexture,
      projectionHelper
    );
  } catch {
    return undefined;
  }
}

/**
 * Update the projection uniforms on an existing land/sea mask mesh.
 * This is the fast path for projection center changes - no geometry rebuild needed.
 */
export function updateLandSeaMaskProjection(
  mask: THREE.Object3D | undefined,
  projectionHelper: ProjectionHelper
): void {
  updateEquirectLayerProjection(mask, projectionHelper);
}
