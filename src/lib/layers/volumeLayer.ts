import * as THREE from "three";

import type { TGeoBounds } from "./equirectLayer.ts";
import fragmentShader from "./glsl/volume.frag.glsl";
import vertexShader from "./glsl/volume.vert.glsl";

import { getProjectionTypeFromMode } from "@/lib/projection/projectionShaders.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import type { TVolumeTextureDimensions } from "@/lib/volume/volumeTexture.ts";

const INNER_RADIUS = 1.002;
const OUTER_RADIUS = 1.09;
const INTERACTIVE_STEP_COUNT = 32;
const SETTLED_STEP_COUNT = 72;

export function getMax3DTextureSize(renderer: THREE.WebGLRenderer) {
  const context = renderer.getContext() as WebGL2RenderingContext;
  return Number(context.getParameter(context.MAX_3D_TEXTURE_SIZE));
}

function makeVolumeTexture(
  data: Uint8Array,
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
  texture.type = THREE.UnsignedByteType;
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
  private texture?: THREE.Data3DTexture;
  private flat = false;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        volumeData: { value: null },
        projectionType: { value: 0 },
        centerLon: { value: 0 },
        centerLat: { value: 0 },
        textureBounds: { value: new THREE.Vector4(-180, -90, 180, 90) },
        innerRadius: { value: INNER_RADIUS },
        outerRadius: { value: OUTER_RADIUS },
        opacity: { value: 1 },
        stepCount: { value: SETTLED_STEP_COUNT },
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
    data: Uint8Array,
    dimensions: TVolumeTextureDimensions,
    channelCount: number,
    storageChannelCount: number,
    colors: string[],
    opacities: number[],
    bounds: TGeoBounds
  ) {
    this.texture?.dispose();
    this.texture = makeVolumeTexture(
      data,
      dimensions,
      storageChannelCount,
      bounds
    );
    this.material.uniforms.textureBounds.value.set(
      bounds.west,
      bounds.south,
      bounds.east,
      bounds.north
    );
    this.material.uniforms.volumeData.value = this.texture;
    this.material.uniforms.channelCount.value = channelCount;
    this.setAppearance(colors, opacities);
    this.material.needsUpdate = true;
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

  setInteractive(interactive: boolean) {
    this.material.uniforms.stepCount.value = interactive
      ? INTERACTIVE_STEP_COUNT
      : SETTLED_STEP_COUNT;
  }

  setRenderOrder(renderOrder: number) {
    this.object.renderOrder = renderOrder;
  }

  dispose() {
    this.texture?.dispose();
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
