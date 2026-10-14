import * as THREE from "three";

import type { TGeoBounds } from "./equirectLayer.ts";
import fragmentShader from "./glsl/volume.frag.glsl";
import vertexShader from "./glsl/volume.vert.glsl";

import { getProjectionTypeFromMode } from "@/lib/projection/projectionShaders.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import type { TVolumeInterpolation } from "@/lib/volume/volumeInterpolation.ts";
import type {
  TVolumeTextureData,
  TVolumeTextureDimensions,
} from "@/lib/volume/volumeTexture.ts";

const INNER_RADIUS = 1.002;
const OUTER_RADIUS = 1.09;
export const VOLUME_RENDER_QUALITY = {
  PREVIEW: 24,
  INTERACTIVE: 32,
  FULL: 72,
} as const;
export type TVolumeRenderQuality =
  (typeof VOLUME_RENDER_QUALITY)[keyof typeof VOLUME_RENDER_QUALITY];

export function getMax3DTextureSize(renderer: THREE.WebGLRenderer) {
  const context = renderer.getContext() as WebGL2RenderingContext;
  return Number(context.getParameter(context.MAX_3D_TEXTURE_SIZE));
}

function makeVolumeTexture(
  data: TVolumeTextureData,
  dimensions: TVolumeTextureDimensions,
  storageChannelCount: number,
  bounds: TGeoBounds
) {
  const texture = new THREE.Data3DTexture(
    data,
    dimensions.depth,
    dimensions.width,
    dimensions.height
  );
  texture.format =
    storageChannelCount === 1
      ? THREE.RedFormat
      : storageChannelCount === 2
        ? THREE.RGFormat
        : THREE.RGBAFormat;
  texture.type =
    data instanceof Uint16Array ? THREE.HalfFloatType : THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT =
    bounds.east - bounds.west >= 360 - 1e-6
      ? THREE.RepeatWrapping
      : THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export class VolumeLayer {
  readonly object: THREE.Mesh;

  private readonly material: THREE.ShaderMaterial;
  private readonly textures = new Map<
    TVolumeTextureData,
    THREE.Data3DTexture
  >();
  private flat = false;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        volumeData: { value: null },
        nextVolumeData: { value: null },
        interpolateValues: { value: false },
        volumeAlpha: { value: 0 },
        firstPhysicalScale: { value: new THREE.Vector4() },
        nextPhysicalScale: { value: new THREE.Vector4() },
        normalizationScale: { value: new THREE.Vector4(1, 1, 1, 1) },
        firstHeightTransform: { value: new THREE.Vector2(1, 0) },
        nextHeightTransform: { value: new THREE.Vector2(1, 0) },
        projectionType: { value: 0 },
        centerLon: { value: 0 },
        centerLat: { value: 0 },
        textureBounds: { value: new THREE.Vector4(-180, -90, 180, 90) },
        innerRadius: { value: INNER_RADIUS },
        outerRadius: { value: OUTER_RADIUS },
        opacity: { value: 1 },
        stepCount: { value: VOLUME_RENDER_QUALITY.FULL },
        channelCount: { value: 1 },
        channelColors: {
          value: [
            new THREE.Color("#ffffff"),
            new THREE.Color("#72b7ff"),
            new THREE.Color("#ffcc80"),
            new THREE.Color("#c4a7ff"),
          ],
        },
        channelOpacities: { value: [1, 1, 1, 1] },
      },
      side: THREE.FrontSide,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    this.object = new THREE.Mesh(
      new THREE.SphereGeometry(OUTER_RADIUS, 96, 64),
      this.material
    );
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.renderOrder = 12;
  }

  setData(
    data: TVolumeTextureData,
    dimensions: TVolumeTextureDimensions,
    channelCount: number,
    storageChannelCount: number,
    colors: string[],
    opacities: number[],
    bounds: TGeoBounds
  ) {
    this.clearTextures();
    const texture = makeVolumeTexture(
      data,
      dimensions,
      storageChannelCount,
      bounds
    );
    this.textures.set(data, texture);
    this.material.uniforms.interpolateValues.value = false;
    this.material.uniforms.nextVolumeData.value = texture;
    this.material.uniforms.textureBounds.value.set(
      bounds.west,
      bounds.south,
      bounds.east,
      bounds.north
    );
    this.material.uniforms.volumeData.value = texture;
    this.material.uniforms.channelCount.value = channelCount;
    this.setAppearance(colors, opacities);
    this.material.needsUpdate = true;
  }

  // Pair changes upload at most one new keyframe; intermediate frames change uniforms only.
  // eslint-disable-next-line max-lines-per-function
  setInterpolation(
    sequence: TVolumeInterpolation,
    firstIndex: number,
    nextIndex: number,
    alpha: number
  ) {
    const first = sequence.frames[firstIndex],
      next = sequence.frames[nextIndex];
    if (
      !first?.physical ||
      !next?.physical ||
      !Number.isFinite(alpha) ||
      alpha < 0 ||
      alpha > 1
    ) {
      throw new Error(
        "Choose valid volume keyframes and an interpolation fraction between zero and one."
      );
    }
    for (const [data, texture] of this.textures) {
      if (data !== first.data && data !== next.data) {
        texture.dispose();
        this.textures.delete(data);
      }
    }
    for (const frame of [first, next]) {
      if (!this.textures.has(frame.data)) {
        this.textures.set(
          frame.data,
          makeVolumeTexture(
            frame.data,
            frame.dimensions,
            frame.storageChannelCount,
            frame.bounds
          )
        );
      }
    }
    const uniforms = this.material.uniforms;
    uniforms.volumeData.value = this.textures.get(first.data);
    uniforms.nextVolumeData.value = this.textures.get(next.data);
    uniforms.interpolateValues.value = true;
    uniforms.volumeAlpha.value = alpha;
    uniforms.channelCount.value = first.channelCount;
    const bounds = first.bounds;
    uniforms.textureBounds.value.set(
      bounds.west,
      bounds.south,
      bounds.east,
      bounds.north
    );
    for (let channel = 0; channel < 4; channel++) {
      uniforms.firstPhysicalScale.value.setComponent(
        channel,
        first.physical.scales[channel] ?? 1
      );
      uniforms.nextPhysicalScale.value.setComponent(
        channel,
        next.physical.scales[channel] ?? 1
      );
      uniforms.normalizationScale.value.setComponent(
        channel,
        sequence.valueScales[channel] ?? 1
      );
    }
    for (const [frame, uniform] of [
      [first, uniforms.firstHeightTransform],
      [next, uniforms.nextHeightTransform],
    ] as const) {
      const range = frame.physical!.range;
      const span = range.max - range.min;
      uniform.value.set(
        span ? (sequence.range.max - sequence.range.min) / span : 0,
        span ? (sequence.range.min - range.min) / span : 0.5
      );
    }
  }

  private clearTextures() {
    for (const texture of this.textures.values()) {
      texture.dispose();
    }
    this.textures.clear();
    this.material.uniforms.volumeData.value = null;
    this.material.uniforms.nextVolumeData.value = null;
  }

  setProjection(projection: ProjectionHelper) {
    if (this.flat !== projection.isFlat) {
      this.object.geometry.dispose();
      this.object.geometry = projection.isFlat
        ? new THREE.PlaneGeometry(8, 8)
        : new THREE.SphereGeometry(OUTER_RADIUS, 96, 64);
      this.material.depthTest = !projection.isFlat;
      this.material.side = projection.isFlat
        ? THREE.DoubleSide
        : THREE.FrontSide;
      this.material.needsUpdate = true;
      this.flat = projection.isFlat;
    }
    this.material.uniforms.projectionType.value = getProjectionTypeFromMode(
      projection.type
    );
    this.material.uniforms.centerLon.value = projection.center.lon;
    this.material.uniforms.centerLat.value = projection.center.lat;
  }

  setAppearance(colors: string[], opacities: number[]) {
    const channelColors = this.material.uniforms.channelColors
      .value as THREE.Color[];
    const channelOpacities = this.material.uniforms.channelOpacities
      .value as number[];
    for (let index = 0; index < channelColors.length; index++) {
      channelColors[index].set(colors[index] ?? "#ffffff");
      channelOpacities[index] = opacities[index] ?? 1;
    }
  }

  setOpacity(opacity: number) {
    this.material.uniforms.opacity.value = opacity;
  }

  setQuality(quality: TVolumeRenderQuality) {
    this.material.uniforms.stepCount.value = quality;
  }

  setRenderOrder(renderOrder: number) {
    this.object.renderOrder = renderOrder;
  }

  dispose() {
    this.clearTextures();
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
