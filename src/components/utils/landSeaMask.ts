import * as d3 from "d3-geo";
import * as THREE from "three";

import { LAND_SEA_MASK_MODES, type TLandSeaMaskMode } from "../store/store";
import { ProjectionHelper } from "./projectionUtils";
import { ResourceCache } from "./ResourceCache";

// =============================================================================
// Types
// =============================================================================

export type TProjectedBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

type MaskConfig = {
  showLand: boolean;
  showSea: boolean;
  useTexture: boolean;
};

type GeoJSONData = GeoJSON.FeatureCollection<
  GeoJSON.Geometry,
  GeoJSON.GeoJsonProperties
>;

// =============================================================================
// Mask Configuration
// =============================================================================

function getMaskConfig(
  mode: TLandSeaMaskMode,
  useTexture: boolean
): MaskConfig {
  const isGlobeMode =
    mode === LAND_SEA_MASK_MODES.GLOBE ||
    mode === LAND_SEA_MASK_MODES.GLOBE_COLORED;
  const isLandMode =
    mode === LAND_SEA_MASK_MODES.LAND || mode === LAND_SEA_MASK_MODES.LAND_GREY;
  const isSeaMode =
    mode === LAND_SEA_MASK_MODES.SEA || mode === LAND_SEA_MASK_MODES.SEA_GREY;

  return {
    showLand: isGlobeMode || isLandMode,
    showSea: isGlobeMode || isSeaMode,
    useTexture,
  };
}

function resolveEffectiveMode(
  choice: TLandSeaMaskMode,
  useTexture: boolean
): TLandSeaMaskMode {
  if (choice === LAND_SEA_MASK_MODES.OFF) return LAND_SEA_MASK_MODES.OFF;

  const modeMapping: Partial<
    Record<
      TLandSeaMaskMode,
      { textured: TLandSeaMaskMode; plain: TLandSeaMaskMode }
    >
  > = {
    [LAND_SEA_MASK_MODES.SEA]: {
      textured: LAND_SEA_MASK_MODES.SEA,
      plain: LAND_SEA_MASK_MODES.SEA_GREY,
    },
    [LAND_SEA_MASK_MODES.LAND]: {
      textured: LAND_SEA_MASK_MODES.LAND,
      plain: LAND_SEA_MASK_MODES.LAND_GREY,
    },
    [LAND_SEA_MASK_MODES.GLOBE]: {
      textured: LAND_SEA_MASK_MODES.GLOBE,
      plain: LAND_SEA_MASK_MODES.GLOBE_COLORED,
    },
  };

  const mapping = modeMapping[choice];
  return mapping ? (useTexture ? mapping.textured : mapping.plain) : choice;
}

function isGlobeMaskMode(mode: TLandSeaMaskMode): boolean {
  return (
    mode === LAND_SEA_MASK_MODES.GLOBE ||
    mode === LAND_SEA_MASK_MODES.GLOBE_COLORED
  );
}

// =============================================================================
// D3 Projection Factory
// =============================================================================

class D3ProjectionFactory {
  static create(helper: ProjectionHelper): d3.GeoProjection {
    const projection: d3.GeoProjection | null =
      helper.createD3ProjectionInstance();
    if (!projection) {
      throw new Error(`Unsupported projection type: ${helper.type}`);
    }
    return projection;
  }

  static createEquirectangular(
    width: number,
    height: number
  ): d3.GeoProjection {
    return d3
      .geoEquirectangular()
      .translate([width / 2, height / 2])
      .scale(width / (2 * Math.PI));
  }

  static createCanvasMapped(
    helper: ProjectionHelper,
    bounds: TProjectedBounds,
    canvasWidth: number,
    canvasHeight: number
  ): d3.GeoProjection {
    const projection = this.create(helper);
    projection.precision(0.01);

    const scaleX = canvasWidth / bounds.width;
    const scaleY = canvasHeight / bounds.height;
    const translateX = -bounds.minX * scaleX;
    const translateY = bounds.maxY * scaleY;

    const originalStream = projection.stream.bind(projection);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (projection as any).stream = (s: d3.GeoStream) => {
      return originalStream({
        point(x: number, y: number) {
          s.point(x * scaleX + translateX, y * scaleY + translateY);
        },
        lineStart: () => s.lineStart(),
        lineEnd: () => s.lineEnd(),
        polygonStart: () => s.polygonStart(),
        polygonEnd: () => s.polygonEnd(),
        sphere: () => s.sphere?.(),
      });
    };

    return projection;
  }

  static createCanvasPath(
    projection: d3.GeoProjection,
    ctx: CanvasRenderingContext2D,
    bounds: TProjectedBounds,
    canvasWidth: number,
    canvasHeight: number
  ): d3.GeoPath {
    const transform = d3.geoTransform({
      point: function (lon: number, lat: number) {
        const projected = projection([lon, lat]);
        if (projected) {
          const canvasX =
            ((projected[0] - bounds.minX) / bounds.width) * canvasWidth;
          const canvasY =
            ((bounds.maxY + projected[1]) / bounds.height) * canvasHeight;
          this.stream.point(canvasX, canvasY);
        }
      },
    });

    return d3.geoPath(transform, ctx);
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

  static computeCanvasDimensions(
    bounds: TProjectedBounds,
    baseResolution = 2048
  ): { width: number; height: number } {
    const aspectRatio = (bounds.width || 1) / (bounds.height || 1);

    if (aspectRatio >= 1) {
      return {
        width: baseResolution,
        height: Math.round(baseResolution / aspectRatio),
      };
    }
    return {
      width: Math.round(baseResolution * aspectRatio),
      height: baseResolution,
    };
  }
}

// =============================================================================
// Bounds Computation
// =============================================================================

function computeProjectedGeoBounds(
  helper: ProjectionHelper
): TProjectedBounds | undefined {
  const projection = D3ProjectionFactory.create(helper);
  const path = d3.geoPath(projection);

  // Compute bounds of the entire sphere in projected coordinates
  const [[minX, minY], [maxX, maxY]] = path.bounds({ type: "Sphere" });

  if (![minX, maxX, minY, maxY].every(Number.isFinite)) return undefined;

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

// =============================================================================
// Globe Mask Renderer (3D sphere)
// =============================================================================

class GlobeMaskRenderer {
  private static readonly COLORS = {
    sea: "#3c78c8",
    land: "#888",
  };

  static async render(mode: TLandSeaMaskMode): Promise<THREE.Mesh | undefined> {
    let mesh: THREE.Mesh | undefined;

    switch (mode) {
      case LAND_SEA_MASK_MODES.GLOBE:
        mesh = await this.createTexturedGlobe();
        break;
      case LAND_SEA_MASK_MODES.GLOBE_COLORED:
        mesh = await this.createColoredGlobe();
        break;
      case LAND_SEA_MASK_MODES.SEA:
      case LAND_SEA_MASK_MODES.LAND:
        mesh = await this.createMaskedTexture(
          mode === LAND_SEA_MASK_MODES.LAND
        );
        break;
      case LAND_SEA_MASK_MODES.SEA_GREY:
      case LAND_SEA_MASK_MODES.LAND_GREY:
        mesh = await this.createMaskedSolid(
          mode === LAND_SEA_MASK_MODES.LAND_GREY
        );
        break;
      default:
        mesh = undefined;
    }

    if (mesh && isGlobeMaskMode(mode)) {
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.depthWrite = false;
      material.depthTest = true;
    }

    return mesh;
  }

  private static async createTexturedGlobe(): Promise<THREE.Mesh> {
    const img = await ResourceCache.loadEarthTexture();
    const texture = new THREE.Texture(img);
    texture.needsUpdate = true;

    return this.createSphereMesh(texture, 0.999, false);
  }

  private static async createColoredGlobe(): Promise<THREE.Mesh> {
    const { canvas, ctx, width, height } = CanvasFactory.create();
    const land = await ResourceCache.loadLandGeoJSON();
    const projection = D3ProjectionFactory.createEquirectangular(width, height);
    const path = d3.geoPath(projection, ctx);

    // Draw ocean background
    ctx.fillStyle = this.COLORS.sea;
    ctx.fillRect(0, 0, width, height);

    // Draw land
    ctx.beginPath();
    path(land);
    ctx.fillStyle = this.COLORS.land;
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 16;
    texture.needsUpdate = true;

    return this.createSphereMesh(texture, 0.999, false);
  }

  private static async createMaskedTexture(
    showLandOnly: boolean
  ): Promise<THREE.Mesh> {
    const { canvas, ctx, width, height } = CanvasFactory.create();
    const [land, img] = await Promise.all([
      ResourceCache.loadLandGeoJSON(),
      ResourceCache.loadEarthTexture(),
    ]);

    // Draw earth texture
    ctx.drawImage(img, 0, 0, width, height);

    // Create projection and path
    const projection = D3ProjectionFactory.createEquirectangular(width, height);
    const path = d3.geoPath(projection, ctx);

    // Mask out unwanted area
    ctx.beginPath();
    path(land);
    ctx.globalCompositeOperation = showLandOnly
      ? "destination-in"
      : "destination-out";
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    return this.createSphereMesh(texture, 1.002);
  }

  private static async createMaskedSolid(
    showLandOnly: boolean
  ): Promise<THREE.Mesh> {
    const { canvas, ctx, width, height } = CanvasFactory.create();
    const land = await ResourceCache.loadLandGeoJSON();
    const projection = D3ProjectionFactory.createEquirectangular(width, height);
    const path = d3.geoPath(projection, ctx);

    if (!showLandOnly) {
      // Fill with sea color, then cut out land
      ctx.fillStyle = this.COLORS.sea;
      ctx.fillRect(0, 0, width, height);
      ctx.beginPath();
      path(land);
      ctx.globalCompositeOperation = "destination-out";
      ctx.fill();
    } else {
      // Just draw land
      ctx.beginPath();
      path(land);
      ctx.fillStyle = this.COLORS.land;
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 16;
    texture.needsUpdate = true;

    return this.createSphereMesh(texture, 1.002);
  }

  private static createSphereMesh(
    texture: THREE.Texture,
    radius: number,
    transparent = true
  ): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(radius, 64, 64);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "mask";
    mesh.renderOrder = 1;
    mesh.rotation.x = Math.PI / 2;
    return mesh;
  }
}

// =============================================================================
// Flat Mask Renderer (2D projections)
// =============================================================================

class FlatMaskRenderer {
  private static readonly COLORS = {
    sea: "rgb(60, 120, 200)",
    landTextured: "rgb(196, 196, 196)",
    landSolid: "rgb(136, 136, 136)",
  };

  static async render(
    helper: ProjectionHelper,
    bounds: TProjectedBounds,
    mode: TLandSeaMaskMode,
    useTexture: boolean
  ): Promise<THREE.Mesh | undefined> {
    if (mode === LAND_SEA_MASK_MODES.OFF) return undefined;

    // Compute effective bounds from land geometry
    const land = await ResourceCache.loadLandGeoJSON();
    const landBounds = computeProjectedGeoBounds(helper);
    const effectiveBounds = landBounds ?? bounds;

    const config = getMaskConfig(mode, useTexture);
    const { width: canvasWidth, height: canvasHeight } =
      CanvasFactory.computeCanvasDimensions(effectiveBounds);

    const canvas = config.useTexture
      ? await this.renderTextured(
          helper,
          effectiveBounds,
          canvasWidth,
          canvasHeight,
          config,
          land
        )
      : await this.renderSolid(
          helper,
          effectiveBounds,
          canvasWidth,
          canvasHeight,
          config,
          land
        );

    const mesh = this.createPlaneMesh(canvas, effectiveBounds, mode);
    return mesh;
  }

  private static async renderSolid(
    helper: ProjectionHelper,
    bounds: TProjectedBounds,
    canvasWidth: number,
    canvasHeight: number,
    config: MaskConfig,
    land: GeoJSONData
  ): Promise<HTMLCanvasElement> {
    const { canvas, ctx } = CanvasFactory.create(canvasWidth, canvasHeight);

    const projection = D3ProjectionFactory.create(helper);
    const path = D3ProjectionFactory.createCanvasPath(
      projection,
      ctx,
      bounds,
      canvasWidth,
      canvasHeight
    );

    const canvasProjection = D3ProjectionFactory.createCanvasMapped(
      helper,
      bounds,
      canvasWidth,
      canvasHeight
    );
    const spherePath = d3.geoPath(canvasProjection, ctx);

    // Clip to projection sphere
    ctx.save();
    ctx.beginPath();
    spherePath({ type: "Sphere" });
    ctx.clip();

    // Draw sea background if needed
    if (config.showSea) {
      ctx.fillStyle = this.COLORS.sea;
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      if (!config.showLand) {
        // Cut out land
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        path(land);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
    }

    // Draw land if needed
    if (config.showLand) {
      ctx.beginPath();
      path(land);
      ctx.fillStyle = config.useTexture
        ? this.COLORS.landTextured
        : this.COLORS.landSolid;
      ctx.fill();
    }

    ctx.restore();
    return canvas;
  }

  private static async renderTextured(
    helper: ProjectionHelper,
    bounds: TProjectedBounds,
    canvasWidth: number,
    canvasHeight: number,
    config: MaskConfig,
    land: GeoJSONData
  ): Promise<HTMLCanvasElement> {
    const { canvas, ctx } = CanvasFactory.create(canvasWidth, canvasHeight);
    const img = await ResourceCache.loadEarthTexture();

    // Create texture source
    const texWidth = 4096;
    const texHeight = 2048;
    const { ctx: texCtx } = CanvasFactory.create(texWidth, texHeight);
    texCtx.drawImage(img, 0, 0, texWidth, texHeight);
    const textureData = texCtx.getImageData(0, 0, texWidth, texHeight);

    // Create projection and masks
    const projection = D3ProjectionFactory.create(helper);
    const canvasProjection = D3ProjectionFactory.createCanvasMapped(
      helper,
      bounds,
      canvasWidth,
      canvasHeight
    );

    // The sphere mask is a solid one-colored layer with the bounds of the
    // projection which ensures we only draw within the projection area
    const sphereMask = this.createMaskCanvas(
      canvasWidth,
      canvasHeight,
      (maskCtx) => {
        const spherePath = d3.geoPath(canvasProjection, maskCtx);
        maskCtx.beginPath();
        spherePath({ type: "Sphere" });
        maskCtx.fillStyle = "white";
        maskCtx.fill();
      }
    );

    // Create land mask
    const landMask = this.createMaskCanvas(
      canvasWidth,
      canvasHeight,
      (maskCtx) => {
        const landPath = D3ProjectionFactory.createCanvasPath(
          projection,
          maskCtx,
          bounds,
          canvasWidth,
          canvasHeight
        );
        maskCtx.beginPath();
        landPath(land);
        maskCtx.fillStyle = "white";
        maskCtx.fill();
      }
    );

    // Rasterize
    const imageData = ctx.createImageData(canvasWidth, canvasHeight);

    for (let cy = 0; cy < canvasHeight; cy++) {
      for (let cx = 0; cx < canvasWidth; cx++) {
        const idx = (cy * canvasWidth + cx) * 4;

        // Check sphere mask
        if (sphereMask.data[idx + 3] <= 128) continue;

        // Invert projection to get lon/lat
        const projX = (cx / canvasWidth) * bounds.width + bounds.minX;
        const projY = (cy / canvasHeight) * bounds.height - bounds.maxY;
        const coords = projection.invert?.([projX, projY]);

        if (!coords) {
          continue;
        }
        const [lon, lat] = coords;
        if (!isFinite(lon) || !isFinite(lat)) {
          continue;
        }
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          continue;
        }

        // Check land/sea
        const isLand = landMask.data[idx + 3] > 128;
        const shouldShow =
          (isLand && config.showLand) || (!isLand && config.showSea);
        if (!shouldShow) continue;

        // Sample texture
        const texX = Math.floor(((lon + 180) / 360) * texWidth);
        const texY = Math.floor(((90 - lat) / 180) * texHeight);
        const texIdx = (texY * texWidth + texX) * 4;

        imageData.data[idx] = textureData.data[texIdx];
        imageData.data[idx + 1] = textureData.data[texIdx + 1];
        imageData.data[idx + 2] = textureData.data[texIdx + 2];
        imageData.data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  private static createMaskCanvas(
    width: number,
    height: number,
    draw: (ctx: CanvasRenderingContext2D) => void
  ): ImageData {
    const { ctx } = CanvasFactory.create(width, height);
    draw(ctx);
    return ctx.getImageData(0, 0, width, height);
  }

  private static createPlaneMesh(
    canvas: HTMLCanvasElement,
    bounds: TProjectedBounds,
    mode: TLandSeaMaskMode
  ): THREE.Mesh {
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const geometry = new THREE.PlaneGeometry(bounds.width, bounds.height);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "mask";
    const globeMode = isGlobeMaskMode(mode);
    mesh.position.set(bounds.centerX, bounds.centerY, globeMode ? -0.01 : 0.01);
    mesh.renderOrder = globeMode ? -1 : 10;
    if (globeMode) {
      material.depthTest = true;
    }

    return mesh;
  }
}

// =============================================================================
// Public API
// =============================================================================

export async function getLandSeaMask(
  landSeaMaskChoice: TLandSeaMaskMode,
  landSeaMaskUseTexture: boolean,
  projectionHelper?: ProjectionHelper,
  bounds?: TProjectedBounds
): Promise<THREE.Object3D | undefined> {
  const choice = landSeaMaskChoice ?? LAND_SEA_MASK_MODES.OFF;
  const useTexture = landSeaMaskUseTexture ?? true;

  if (choice === LAND_SEA_MASK_MODES.OFF) return undefined;

  const mode = resolveEffectiveMode(choice, useTexture);

  try {
    if (projectionHelper?.isFlat) {
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        console.warn("Missing or invalid bounds for flat mask rendering");
        return undefined;
      }
      return await FlatMaskRenderer.render(
        projectionHelper,
        bounds,
        mode,
        useTexture
      );
    }

    return await GlobeMaskRenderer.render(mode);
  } catch (e) {
    console.error("Failed to create land/sea mask:", e);
    return undefined;
  }
}
