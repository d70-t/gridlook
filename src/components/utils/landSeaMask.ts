import * as d3 from "d3-geo";
import * as THREE from "three";

import { LAND_SEA_MASK_MODES, type TLandSeaMaskMode } from "../store/store";
import {
  MERCATOR_LAT_LIMIT,
  PROJECTION_TYPES,
  ProjectionHelper,
} from "./projectionUtils";
import {
  projectionShaderFunctions,
  getProjectionTypeFromMode,
} from "./projectionShaders";
import { ResourceCache } from "./ResourceCache";

// =============================================================================
// Types
// =============================================================================

type MaskConfig = {
  showLand: boolean;
  showSea: boolean;
  useTexture: boolean;
};

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

/**
 * Vertex shader for GPU-projected mask rendering (globe mode).
 * Projects lat/lon coordinates on the GPU.
 */
const gpuProjectedMaskVertexShader = `
${projectionShaderFunctions}

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;

attribute vec2 latLon;

varying vec2 vUv;
varying float vLat;

float clampLatForProjection(int projType, float lat) {
  if (projType == PROJ_MERCATOR) {
    return clamp(lat, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT);
  }
  return lat;
}

void main() {
  vUv = uv;
  float clampedLat = clampLatForProjection(projectionType, latLon.x);
  vLat = clampedLat;
  vec3 projected = projectLatLon(clampedLat, latLon.y, projectionType, centerLon, centerLat, projectionRadius);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(projected, 1.0);
}
`;

/**
 * Simple vertex shader for pre-projected flat mask geometry.
 */
const flatMaskVertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Fragment shader for mask rendering.
 */
const gpuProjectedMaskFragmentShader = `
uniform sampler2D maskTexture;
uniform float opacity;
uniform int projectionType;

varying vec2 vUv;
varying float vLat;

void main() {
  vec4 texColor = texture2D(maskTexture, vUv);
  if (texColor.a < 0.01) {
    discard;
  }
  gl_FragColor = vec4(texColor.rgb, texColor.a * opacity);
}
`;

/**
 * Fragment shader for flat mask rendering (no latitude check needed).
 */
const flatMaskFragmentShader = `
#define PROJ_MERCATOR 2
#define MERCATOR_LAT_LIMIT 89.0

uniform sampler2D maskTexture;
uniform float opacity;
uniform int projectionType;

varying vec2 vUv;

void main() {
  // Clip Mercator masks to the valid latitude band to avoid spilling past data
  if (projectionType == PROJ_MERCATOR) {
    float lat = (vUv.y - 0.5) * 180.0;
    if (abs(lat) > MERCATOR_LAT_LIMIT) {
      discard;
    }
  }

  vec4 texColor = texture2D(maskTexture, vUv);
  if (texColor.a < 0.01) {
    discard;
  }
  gl_FragColor = vec4(texColor.rgb, texColor.a * opacity);
}
`;

class GpuProjectedMaskRenderer {
  private static readonly COLORS = {
    sea: "#3c78c8",
    land: "#888888",
  };

  private static readonly GRID_RESOLUTION = {
    latSegments: 180,
    lonSegments: 360,
  };

  /**
   * Create a mask mesh.
   * For globe mode: GPU-projected geometry for instant center changes.
   * For flat projections: d3-projected geometry with proper clipping.
   */
  static async render(
    mode: TLandSeaMaskMode,
    useTexture: boolean,
    projectionHelper: ProjectionHelper
  ): Promise<THREE.Mesh | undefined> {
    if (mode === LAND_SEA_MASK_MODES.OFF) return undefined;

    const config = getMaskConfig(mode, useTexture);
    const texture = await this.createMaskTexture(mode, useTexture, config);

    let geometry: THREE.BufferGeometry;
    let material: THREE.ShaderMaterial;

    if (projectionHelper.isFlat) {
      // For flat projections, use d3 to project geometry with proper clipping
      geometry = this.createD3ProjectedGeometry(projectionHelper, mode);
      material = this.createFlatMaterial(
        texture,
        mode,
        getProjectionTypeFromMode(projectionHelper.type)
      );
    } else {
      // For globe, use GPU projection
      geometry = this.createGlobeGeometry();
      material = this.createGlobeMaterial(texture, mode, projectionHelper);
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "mask";
    mesh.userData.maskMode = mode; // Store mode for updateProjection

    const globeMode = isGlobeMaskMode(mode);
    mesh.renderOrder = globeMode ? -1 : 10;

    return mesh;
  }

  /**
   * Update projection on an existing mask mesh.
   * For globe: updates uniforms (fast).
   * For flat: rebuilds geometry (required for proper clipping).
   */
  static updateProjection(
    mesh: THREE.Mesh,
    projectionHelper: ProjectionHelper
  ): void {
    const material = mesh.material as THREE.ShaderMaterial;

    if (projectionHelper.isFlat) {
      // For flat projections, rebuild geometry with new projection
      const oldGeometry = mesh.geometry;
      const mode = mesh.userData.maskMode as TLandSeaMaskMode;
      const newGeometry = this.createD3ProjectedGeometry(
        projectionHelper,
        mode
      );
      mesh.geometry = newGeometry;
      if (material.uniforms?.projectionType) {
        material.uniforms.projectionType.value = getProjectionTypeFromMode(
          projectionHelper.type
        );
      }
      // Signal Three.js that the geometry has changed
      mesh.geometry.computeBoundingSphere();
      mesh.geometry.computeBoundingBox();
      oldGeometry.dispose();
    } else {
      if (!material.uniforms) return;
      // For globe, just update uniforms
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
      material.needsUpdate = true;
    }
  }

  /**
   * Create geometry projected by d3 with proper antimeridian clipping.
   */
  private static createD3ProjectedGeometry(
    projectionHelper: ProjectionHelper,
    mode?: TLandSeaMaskMode
  ): THREE.BufferGeometry {
    const { latSegments, lonSegments } = this.GRID_RESOLUTION;
    const latExtent =
      projectionHelper.type === PROJECTION_TYPES.MERCATOR
        ? MERCATOR_LAT_LIMIT
        : 90;

    const geometry = new THREE.BufferGeometry();

    const vertices: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const isBackground = mode ? isGlobeMaskMode(mode) : true;
    const zOffset = isBackground ? -0.01 : 0.01;

    // Generate vertices using the helper projection (matches data orientation)
    for (let latIdx = 0; latIdx <= latSegments; latIdx++) {
      // Sweep full [-90, 90] for UVs, but clamp projection to Mercator valid band
      const latRaw = 90 - (latIdx / latSegments) * 180;
      const latProjected = Math.max(-latExtent, Math.min(latExtent, latRaw));
      const v = (90 - latRaw) / 180; // top (90) -> 0, bottom (-90) -> 1

      for (let lonIdx = 0; lonIdx <= lonSegments; lonIdx++) {
        const lon = (lonIdx / lonSegments) * 360 - 180;
        const u = lonIdx / lonSegments;

        const [x, y, z] = projectionHelper.project(latProjected, lon, 1);
        vertices.push(x, y, z + zOffset);
        uvs.push(u, 1 - v);
      }
    }

    // Generate indices, but skip triangles that span the projection cut
    const width = this.getProjectionWidth(projectionHelper);
    const threshold = width * 0.4; // Triangles spanning more than 40% of width are cut

    for (let latIdx = 0; latIdx < latSegments; latIdx++) {
      for (let lonIdx = 0; lonIdx < lonSegments; lonIdx++) {
        const a = latIdx * (lonSegments + 1) + lonIdx;
        const b = a + lonSegments + 1;
        const c = a + 1;
        const d = b + 1;

        // Get vertex positions
        const ax = vertices[a * 3],
          ay = vertices[a * 3 + 1];
        const bx = vertices[b * 3],
          by = vertices[b * 3 + 1];
        const cx = vertices[c * 3],
          cy = vertices[c * 3 + 1];
        const dx = vertices[d * 3],
          dy = vertices[d * 3 + 1];

        // Check if triangle ABC spans the cut
        const maxDxABC = Math.max(
          Math.abs(ax - bx),
          Math.abs(ax - cx),
          Math.abs(bx - cx)
        );
        const maxDyABC = Math.max(
          Math.abs(ay - by),
          Math.abs(ay - cy),
          Math.abs(by - cy)
        );

        if (maxDxABC < threshold && maxDyABC < threshold) {
          indices.push(a, b, c);
        }

        // Check if triangle CBD spans the cut
        const maxDxCBD = Math.max(
          Math.abs(cx - bx),
          Math.abs(cx - dx),
          Math.abs(bx - dx)
        );
        const maxDyCBD = Math.max(
          Math.abs(cy - by),
          Math.abs(cy - dy),
          Math.abs(by - dy)
        );

        if (maxDxCBD < threshold && maxDyCBD < threshold) {
          indices.push(c, b, d);
        }
      }
    }

    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3)
    );
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);

    return geometry;
  }

  /**
   * Get the approximate width of the projection in projected coordinates.
   */
  private static getProjectionWidth(
    projectionHelper: ProjectionHelper
  ): number {
    const d3Proj = projectionHelper.getD3Projection();
    if (d3Proj) {
      const path = d3.geoPath(d3Proj);
      const bounds = path.bounds({ type: "Sphere" });
      if (bounds && bounds[0] && bounds[1]) {
        return Math.abs(bounds[1][0] - bounds[0][0]);
      }
    }
    return Math.PI * 2; // Fallback
  }

  /**
   * Create geometry for globe projection (closed mesh that wraps around).
   */
  private static createGlobeGeometry(): THREE.BufferGeometry {
    const { latSegments, lonSegments } = this.GRID_RESOLUTION;
    const geometry = new THREE.BufferGeometry();

    const vertices: number[] = [];
    const uvs: number[] = [];
    const latLonCoords: number[] = [];
    const indices: number[] = [];

    // Generate vertices - for globe we need to include lon=180 for proper UV mapping
    for (let latIdx = 0; latIdx <= latSegments; latIdx++) {
      const lat = 90 - (latIdx / latSegments) * 180; // 90 to -90
      const v = latIdx / latSegments;

      for (let lonIdx = 0; lonIdx <= lonSegments; lonIdx++) {
        const lon = (lonIdx / lonSegments) * 360 - 180; // -180 to 180
        const u = lonIdx / lonSegments;

        // Store lat/lon for GPU projection
        latLonCoords.push(lat, lon);

        // Placeholder vertex positions (will be computed on GPU)
        vertices.push(0, 0, 0);

        // UV coordinates for texture sampling
        uvs.push(u, 1 - v);
      }
    }

    // Generate indices - for globe, create all triangles
    for (let latIdx = 0; latIdx < latSegments; latIdx++) {
      for (let lonIdx = 0; lonIdx < lonSegments; lonIdx++) {
        const a = latIdx * (lonSegments + 1) + lonIdx;
        const b = a + lonSegments + 1;
        const c = a + 1;
        const d = b + 1;

        indices.push(a, b, c);
        indices.push(c, b, d);
      }
    }

    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3)
    );
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute(
      "latLon",
      new THREE.Float32BufferAttribute(latLonCoords, 2)
    );
    geometry.setIndex(indices);

    return geometry;
  }

  /**
   * Create the shader material for GPU-projected globe mask.
   */
  private static createGlobeMaterial(
    texture: THREE.Texture,
    mode: TLandSeaMaskMode,
    projectionHelper: ProjectionHelper
  ): THREE.ShaderMaterial {
    const projType = getProjectionTypeFromMode(projectionHelper.type);
    const center = projectionHelper.center;
    const globeMode = isGlobeMaskMode(mode);

    // For globe mode (full earth background), use smaller radius so it's behind data
    // For overlay masks (land-only or sea-only), use larger radius so they're in front of data
    const radius = globeMode ? 0.998 : 1.003;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        maskTexture: { value: texture },
        projectionType: { value: projType },
        centerLon: { value: center.lon },
        centerLat: { value: center.lat },
        projectionRadius: { value: radius },
        opacity: { value: 1.0 },
      },
      vertexShader: gpuProjectedMaskVertexShader,
      fragmentShader: gpuProjectedMaskFragmentShader,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
    });

    return material;
  }

  /**
   * Create the shader material for d3-projected flat mask.
   */
  private static createFlatMaterial(
    texture: THREE.Texture,
    mode: TLandSeaMaskMode,
    projectionType: number
  ): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        maskTexture: { value: texture },
        opacity: { value: 1.0 },
        projectionType: { value: projectionType },
      },
      vertexShader: flatMaskVertexShader,
      fragmentShader: flatMaskFragmentShader,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
    });

    // Use polygon offset to prevent z-fighting
    material.polygonOffset = true;
    material.polygonOffsetFactor = isGlobeMaskMode(mode) ? 1 : -1;
    material.polygonOffsetUnits = isGlobeMaskMode(mode) ? 1 : -1;

    return material;
  }

  /**
   * Create the mask texture based on mode and settings.
   * This is rendered once and reused across projection changes.
   */
  private static async createMaskTexture(
    mode: TLandSeaMaskMode,
    useTexture: boolean,
    config: MaskConfig
  ): Promise<THREE.Texture> {
    const { canvas, ctx, width, height } = CanvasFactory.create(4096, 2048);
    const land = await ResourceCache.loadLandGeoJSON();

    // Create equirectangular projection for texture rendering
    const projection = D3ProjectionFactory.createEquirectangular(width, height);
    const path = d3.geoPath(projection, ctx);

    if (isGlobeMaskMode(mode)) {
      // Globe modes: full earth texture or colored land/sea
      if (useTexture) {
        const img = await ResourceCache.loadEarthTexture();
        ctx.drawImage(img, 0, 0, width, height);
      } else {
        // Draw sea background
        ctx.fillStyle = this.COLORS.sea;
        ctx.fillRect(0, 0, width, height);

        // Draw land
        ctx.beginPath();
        path(land);
        ctx.fillStyle = this.COLORS.land;
        ctx.fill();
      }
    } else {
      // Masked modes: show only land or sea
      if (useTexture) {
        const img = await ResourceCache.loadEarthTexture();
        ctx.drawImage(img, 0, 0, width, height);

        // Mask out unwanted area
        ctx.beginPath();
        path(land);
        ctx.globalCompositeOperation = config.showLand
          ? "destination-in"
          : "destination-out";
        ctx.fill();
      } else {
        if (config.showSea) {
          ctx.fillStyle = this.COLORS.sea;
          ctx.fillRect(0, 0, width, height);
          if (!config.showLand) {
            // Cut out land
            ctx.beginPath();
            path(land);
            ctx.globalCompositeOperation = "destination-out";
            ctx.fill();
          }
        }
        if (config.showLand) {
          ctx.globalCompositeOperation = "source-over";
          ctx.beginPath();
          path(land);
          ctx.fillStyle = this.COLORS.land;
          ctx.fill();
        }
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;

    return texture;
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Create a land/sea mask mesh for the given projection.
 * Uses GPU-projected rendering for instant projection center changes.
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
  const choice = landSeaMaskChoice ?? LAND_SEA_MASK_MODES.OFF;
  const useTexture = landSeaMaskUseTexture ?? true;

  if (choice === LAND_SEA_MASK_MODES.OFF) return undefined;

  const mode = resolveEffectiveMode(choice, useTexture);

  try {
    // Use GPU-projected renderer for all projections
    // This allows instant projection center changes without rebuilding
    if (projectionHelper) {
      return await GpuProjectedMaskRenderer.render(
        mode,
        useTexture,
        projectionHelper
      );
    }

    // Fallback to globe renderer if no projection helper
    return await GlobeMaskRenderer.render(mode);
  } catch (e) {
    console.error("Failed to create land/sea mask:", e);
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
  if (!mask || !(mask instanceof THREE.Mesh)) return;

  GpuProjectedMaskRenderer.updateProjection(mask, projectionHelper);
}
