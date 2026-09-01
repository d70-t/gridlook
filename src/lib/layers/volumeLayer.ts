import * as THREE from "three";

import type { TVolumeTextureDimensions } from "@/lib/volume/volumeTexture.ts";

const INNER_RADIUS = 1.002;
const OUTER_RADIUS = 1.09;
const INTERACTIVE_STEP_COUNT = 32;
const SETTLED_STEP_COUNT = 72;

const vertexShader = `
  out vec3 volumeWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    volumeWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const fragmentShader = `
  precision highp float;
  precision highp sampler3D;

  uniform sampler3D volumeData;
  uniform float innerRadius;
  uniform float outerRadius;
  uniform float opacity;
  uniform int stepCount;
  uniform int channelCount;
  uniform vec3 channelColors[4];
  uniform float channelOpacities[4];

  in vec3 volumeWorldPosition;
  out vec4 outputColor;

  const float PI = 3.141592653589793;
  const int MAX_STEP_COUNT = 72;

  vec2 intersectSphere(vec3 origin, vec3 direction, float radius) {
    float b = dot(origin, direction);
    float c = dot(origin, origin) - radius * radius;
    float discriminant = b * b - c;
    if (discriminant < 0.0) {
      return vec2(1.0, -1.0);
    }
    float root = sqrt(discriminant);
    return vec2(-b - root, -b + root);
  }

  float screenNoise(vec2 point) {
    return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
  }

  vec3 sphericalTextureCoordinate(vec3 position) {
    float radius = length(position);
    float longitude = atan(position.y, position.x);
    float latitude = asin(clamp(position.z / radius, -1.0, 1.0));
    return vec3(
      fract(longitude / (2.0 * PI) + 0.5),
      latitude / PI + 0.5,
      clamp((radius - innerRadius) / (outerRadius - innerRadius), 0.0, 1.0)
    );
  }

  void main() {
    vec3 rayOrigin = cameraPosition;
    vec3 rayDirection = normalize(volumeWorldPosition - cameraPosition);
    vec2 outerHit = intersectSphere(rayOrigin, rayDirection, outerRadius);
    if (outerHit.y <= 0.0) {
      discard;
    }

    float rayStart = max(outerHit.x, 0.0);
    float rayEnd = outerHit.y;
    vec2 innerHit = intersectSphere(rayOrigin, rayDirection, innerRadius);
    if (innerHit.x > rayStart && innerHit.x < rayEnd) {
      rayEnd = innerHit.x;
    }
    if (rayEnd <= rayStart) {
      discard;
    }

    float stepLength = (rayEnd - rayStart) / float(stepCount);
    float jitter = screenNoise(gl_FragCoord.xy);
    vec4 accumulated = vec4(0.0);

    for (int stepIndex = 0; stepIndex < MAX_STEP_COUNT; stepIndex++) {
      if (stepIndex >= stepCount) {
        break;
      }
      float distanceAlongRay =
        rayStart + (float(stepIndex) + jitter) * stepLength;
      vec3 samplePosition = rayOrigin + rayDirection * distanceAlongRay;
      vec3 textureCoordinate = sphericalTextureCoordinate(samplePosition);
      // The CPU stores complete vertical columns contiguously: texture X is
      // altitude, Y is longitude, and Z is latitude.
      vec4 channelDensities = texture(
        volumeData,
        vec3(textureCoordinate.z, textureCoordinate.x, textureCoordinate.y)
      );
      float combinedDensity = 0.0;
      vec3 weightedColor = vec3(0.0);
      for (int channel = 0; channel < 4; channel++) {
        if (channel >= channelCount) {
          break;
        }
        float channelDensity =
          channelDensities[channel] * channelOpacities[channel];
        combinedDensity += channelDensity;
        weightedColor += channelDensity * channelColors[channel];
      }
      float density = smoothstep(0.015, 0.75, min(combinedDensity, 1.0));

      float relativeStep = stepLength / (outerRadius - innerRadius);
      float sampleAlpha =
        (1.0 - exp(-density * 5.0 * relativeStep)) * opacity;
      vec3 cloudColor = weightedColor / max(combinedDensity, 0.0001);
      accumulated.rgb +=
        (1.0 - accumulated.a) * sampleAlpha * cloudColor;
      accumulated.a += (1.0 - accumulated.a) * sampleAlpha;

      if (accumulated.a > 0.985) {
        break;
      }
    }

    if (accumulated.a <= 0.001) {
      discard;
    }
    outputColor = vec4(
      accumulated.rgb / max(accumulated.a, 0.0001),
      accumulated.a
    );
  }
`;

export function getMax3DTextureSize(renderer: THREE.WebGLRenderer) {
  const context = renderer.getContext() as WebGL2RenderingContext;
  return Number(context.getParameter(context.MAX_3D_TEXTURE_SIZE));
}

function makeVolumeTexture(
  data: Uint8Array,
  dimensions: TVolumeTextureDimensions,
  storageChannelCount: number
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
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export class SphericalVolumeLayer {
  readonly object: THREE.Mesh;

  private readonly material: THREE.ShaderMaterial;
  private texture?: THREE.Data3DTexture;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        volumeData: { value: new THREE.Data3DTexture() },
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
    opacities: number[]
  ) {
    this.texture?.dispose();
    this.texture = makeVolumeTexture(data, dimensions, storageChannelCount);
    this.material.uniforms.volumeData.value = this.texture;
    this.material.uniforms.channelCount.value = channelCount;
    this.setAppearance(colors, opacities);
    this.material.needsUpdate = true;
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
