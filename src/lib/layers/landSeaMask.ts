import * as d3 from "d3-geo";
import * as THREE from "three";

import { ResourceCache } from "./ResourceCache.ts";

import albedo from "@/assets/earth.jpg";
import flatInverseFragmentShader from "@/lib/layers/glsl/flatInverse.frag.glsl";
import flatInverseVertexShader from "@/lib/layers/glsl/flatInverse.vert.glsl";
import gpuProjectedMaskFragmentShader from "@/lib/layers/glsl/gpuProjectedMask.frag.glsl";
import gpuProjectedMaskVertexShader from "@/lib/layers/glsl/gpuProjectedMask.vert.glsl";
import { getProjectionTypeFromMode } from "@/lib/projection/projectionShaders.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

export const LAND_SEA_MASK_MODES = {
  OFF: "off",
  SEA: "sea",
  LAND: "land",
  GLOBE: "globe",
} as const;

// =============================================================================
// Types
// =============================================================================

export type TLandSeaMaskMode =
  (typeof LAND_SEA_MASK_MODES)[keyof typeof LAND_SEA_MASK_MODES];

type TMaskConfig = {
  showLand: boolean;
  showSea: boolean;
};

const MASK_COLORS = {
  sea: "#3c78c8",
  land: "#d3d3d3ff",
};

// =============================================================================
// Mask Configuration
// =============================================================================

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

// =============================================================================
// D3 Projection Factory
// =============================================================================

class D3ProjectionFactory {
  static createEquirectangular(
    width: number,
    height: number
  ): d3.GeoProjection {
    return d3
      .geoEquirectangular()
      .translate([width / 2, height / 2])
      .scale(width / (2 * Math.PI));
  }
}

// =============================================================================
// Canvas Utilities
// =============================================================================

class CanvasFactory {
  static create(
    width = 4096,
    height = 2048
  ): {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    width: number;
    height: number;
  } {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);
    return { canvas, ctx, width, height };
  }
}

function configureEquirectangularTexture(texture: THREE.Texture) {
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 16;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function copyAntimeridianEdge(ctx: CanvasRenderingContext2D, width: number) {
  const edge = ctx.getImageData(0, 0, 1, ctx.canvas.height);
  ctx.putImageData(edge, width - 1, 0);
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
  private static readonly GRID_RESOLUTION = {
    latSegments: 180,
    lonSegments: 360,
  };

  /**
   * Create a mask mesh.
   * Globe: uses CPU-built sphere geometry rendered directly in globe space.
   * Flat:  uses a quad with inverse-projection fragment shader.
   * Both paths support instant center changes via uniform updates only.
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

    let geometry: THREE.BufferGeometry;
    let material: THREE.ShaderMaterial;

    if (projectionHelper.isFlat) {
      geometry = this.createFlatQuadGeometry();
      material = this.createFlatInverseMaterial(
        texture,
        getProjectionTypeFromMode(projectionHelper.type),
        projectionHelper.center
      );
      material.transparent = !isGlobeMaskMode(mode);
    } else {
      geometry = this.createGlobeGeometry();
      material = this.createGlobeMaterial(texture);
      material.transparent = !isGlobeMaskMode(mode);
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "mask";
    mesh.userData.maskMode = mode;

    mesh.frustumCulled = false;
    const globeMode = isGlobeMaskMode(mode);
    mesh.renderOrder = globeMode ? -1 : 10;

    return mesh;
  }

  /**
   * Update projection on an existing mask mesh.
   * For both globe and flat projections, this only updates uniforms (fast).
   */
  static updateProjection(
    mesh: THREE.Mesh,
    projectionHelper: ProjectionHelper
  ): void {
    const material = mesh.material as THREE.ShaderMaterial;
    this.applyProjectionUniforms(material, projectionHelper);
    material.needsUpdate = true;
  }

  private static applyProjectionUniforms(
    material: THREE.ShaderMaterial,
    projectionHelper: ProjectionHelper
  ) {
    if (!material.uniforms) {
      return;
    }

    const projType = getProjectionTypeFromMode(projectionHelper.type);
    const center = projectionHelper.center;

    if (material.uniforms.projectionType) {
      material.uniforms.projectionType.value = projType;
    }
    if (material.uniforms.centerLon) {
      material.uniforms.centerLon.value = center.lon;
    }
    if (material.uniforms.centerLat) {
      material.uniforms.centerLat.value = center.lat;
    }
  }

  /**
   * Create a quad covering the flat projection's coordinate space.
   * The fragment shader handles clipping to the actual projection boundary.
   */
  private static createFlatQuadGeometry(): THREE.BufferGeometry {
    // All flat mask quads sit at z=0.  depthTest is disabled on the material
    // so depth has no effect on layering; renderOrder handles that exclusively.
    // Using different z offsets per mode caused perspective-camera scaling
    // differences: the land/sea quads (z=+0.01) appeared ~1% larger than the
    // globe quad (z=-0.01), making land shapes look "more zoomed in".
    const zOffset = 0;
    const extent = 4.0; // generous extent covering all projection types

    const vertices = new Float32Array([
      -extent,
      -extent,
      zOffset,
      extent,
      -extent,
      zOffset,
      extent,
      extent,
      zOffset,
      -extent,
      extent,
      zOffset,
    ]);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3)
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    return geometry;
  }

  /**
   * Create globe geometry with wrapped indices and no duplicated antimeridian
   * vertex column. The fragment shader derives UVs from sphere position, so it
   * does not need a UV or lat/lon attribute seam.
   */
  private static createGlobeGeometry(): THREE.BufferGeometry {
    const { latSegments, lonSegments } = this.GRID_RESOLUTION;
    const geometry = new THREE.BufferGeometry();

    const vertices: number[] = [];
    const indices: number[] = [];

    for (let latIdx = 0; latIdx <= latSegments; latIdx++) {
      const lat = 90 - (latIdx / latSegments) * 180;
      const latRad = THREE.MathUtils.degToRad(lat);
      const cosLat = Math.cos(latRad);
      const sinLat = Math.sin(latRad);

      for (let lonIdx = 0; lonIdx < lonSegments; lonIdx++) {
        const lon = (lonIdx / lonSegments) * 360 - 180;
        const lonRad = THREE.MathUtils.degToRad(lon);

        vertices.push(
          cosLat * Math.cos(lonRad),
          cosLat * Math.sin(lonRad),
          sinLat
        );
      }
    }

    for (let latIdx = 0; latIdx < latSegments; latIdx++) {
      for (let lonIdx = 0; lonIdx < lonSegments; lonIdx++) {
        const nextLonIdx = (lonIdx + 1) % lonSegments;
        const a = latIdx * lonSegments + lonIdx;
        const b = (latIdx + 1) * lonSegments + lonIdx;
        const c = latIdx * lonSegments + nextLonIdx;
        const d = (latIdx + 1) * lonSegments + nextLonIdx;

        indices.push(a, b, c);
        indices.push(c, b, d);
      }
    }

    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3)
    );
    geometry.setIndex(indices);

    return geometry;
  }

  /**
   * Create the shader material for GPU-projected globe mask.
   */
  private static createGlobeMaterial(
    texture: THREE.Texture
  ): THREE.ShaderMaterial {
    // All masks sit at radius 1.003, matching the coastline layer, so there is no
    // parallax drift when the camera orbits. Layering is handled purely via renderOrder:
    //   globe mask = -1 (background, depthWrite: false)
    //   land/sea masks = 10 (above data)
    //   coastlines/graticules = 20 (always on top)
    const radius = 1.003;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        maskTexture: { value: texture },
        projectionRadius: { value: radius },
        opacity: { value: 1.0 },
      },
      vertexShader: gpuProjectedMaskVertexShader,
      fragmentShader: gpuProjectedMaskFragmentShader,
      transparent: false,
      side: THREE.FrontSide,
      depthWrite: false,
      // depthTest: false so rendering order is controlled solely by renderOrder.
      // The globe mask (renderOrder = -1) always paints first as a background;
      // relying on the depth buffer here is unnecessary and was preventing proper
      // layering at non-standard camera angles.
      depthTest: false,
    });

    return material;
  }

  /**
   * Create the shader material for flat mask with inverse projection.
   */
  private static createFlatInverseMaterial(
    texture: THREE.Texture,
    projectionType: number,
    center: { lat: number; lon: number }
  ): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        maskTexture: { value: texture },
        opacity: { value: 1.0 },
        projectionType: { value: projectionType },
        centerLon: { value: center.lon },
        centerLat: { value: center.lat },
      },
      vertexShader: flatInverseVertexShader,
      fragmentShader: flatInverseFragmentShader,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });

    return material;
  }

  private static async createGlobeTexture(): Promise<THREE.Texture> {
    const img = await ResourceCache.loadImage(albedo);
    const { canvas, ctx, width, height } = CanvasFactory.create(
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

      ctx.beginPath();
      path(land);
      ctx.globalCompositeOperation = config.showLand
        ? "destination-in"
        : "destination-out";
      ctx.fill();
      // Restore composite mode before the alpha threshold pass
      ctx.globalCompositeOperation = "source-over";
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

    const { canvas, ctx, width, height } = CanvasFactory.create(
      canvasWidth,
      canvasHeight
    );
    const land = await ResourceCache.loadLandGeoJSON();
    const projection = D3ProjectionFactory.createEquirectangular(width, height);
    const path = d3.geoPath(projection, ctx);

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
  if (!mask || !(mask instanceof THREE.Mesh)) {
    return;
  }

  GpuProjectedMaskRenderer.updateProjection(mask, projectionHelper);
}
