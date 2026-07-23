import * as THREE from "three";

import type { TStreamlineVectorField } from "@/lib/data/vectorField.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import streamlineVertexShader from "@/lib/shaders/glsl/streamline.vert.glsl";
import { updateProjectionUniforms } from "@/lib/shaders/gridShaders.ts";

type TGeoPoint = { latitude: number; longitude: number };

type TPathCache = {
  texture: THREE.DataTexture;
  textureSize: THREE.Vector2;
  pointCounts: Float32Array;
};

// A dense set of short traces reads as a continuous flow field without
// obscuring the scalar layer below it.
const PARTICLE_COUNT = 18_000;
const PARTICLES_PER_PATH = 2;
const CACHED_PATH_COUNT = PARTICLE_COUNT / PARTICLES_PER_PATH;
const CACHED_PATH_LENGTH = 96;
const TRAIL_LENGTH = 20;
const TRAIL_SAMPLE_SECONDS = 0.04;
const FADE_IN_SECONDS = 0.25;
const FADE_OUT_SECONDS = 0.7;
const MIN_SPEED_ALPHA = 0.12;
const TRAIL_FADE_EXPONENT = 1.35;
const PATH_TEXTURE_WIDTH = 1024;

function writePathSample(
  point: TGeoPoint,
  speedAlpha: number,
  target: Float32Array,
  sampleIndex: number
) {
  const latitude = THREE.MathUtils.degToRad(point.latitude);
  const longitude = THREE.MathUtils.degToRad(point.longitude);
  const cosLatitude = Math.cos(latitude);
  const offset = sampleIndex * 4;
  target[offset] = cosLatitude * Math.cos(longitude);
  target[offset + 1] = cosLatitude * Math.sin(longitude);
  target[offset + 2] = Math.sin(latitude);
  target[offset + 3] = speedAlpha;
}

function addTrailAttributes(geometry: THREE.InstancedBufferGeometry) {
  const vertexCount = (TRAIL_LENGTH - 1) * 2;
  const positions = new Float32Array(vertexCount * 3);
  const trailOffsets = new Float32Array(vertexCount);
  const otherTrailOffsets = new Float32Array(vertexCount);
  const trailAlphas = new Float32Array(vertexCount);

  for (let segment = 0; segment < TRAIL_LENGTH - 1; segment++) {
    const vertex = segment * 2;
    const startOffset = segment - (TRAIL_LENGTH - 1);
    const endOffset = startOffset + 1;
    trailOffsets[vertex] = startOffset;
    trailOffsets[vertex + 1] = endOffset;
    otherTrailOffsets[vertex] = endOffset;
    otherTrailOffsets[vertex + 1] = startOffset;
    trailAlphas[vertex] = (segment / (TRAIL_LENGTH - 1)) ** TRAIL_FADE_EXPONENT;
    trailAlphas[vertex + 1] =
      ((segment + 1) / (TRAIL_LENGTH - 1)) ** TRAIL_FADE_EXPONENT;
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute(
    "trailOffset",
    new THREE.BufferAttribute(trailOffsets, 1)
  );
  geometry.setAttribute(
    "otherTrailOffset",
    new THREE.BufferAttribute(otherTrailOffsets, 1)
  );
  geometry.setAttribute(
    "trailAlpha",
    new THREE.BufferAttribute(trailAlphas, 1)
  );
}

function makeParticlePathInfos(pointCounts: Float32Array) {
  const pathInfos = new Float32Array(PARTICLE_COUNT * 3);
  const initialPathPhases = Float32Array.from(
    { length: CACHED_PATH_COUNT },
    () => Math.random()
  );
  for (let particle = 0; particle < PARTICLE_COUNT; particle++) {
    const pathIndex = particle % CACHED_PATH_COUNT;
    const instanceIndex = Math.floor(particle / CACHED_PATH_COUNT);
    const phase =
      (initialPathPhases[pathIndex] + instanceIndex / PARTICLES_PER_PATH) % 1;
    const pointCount = pointCounts[pathIndex];
    const offset = particle * 3;
    pathInfos[offset] = pathIndex * CACHED_PATH_LENGTH;
    pathInfos[offset + 1] = pointCount;
    pathInfos[offset + 2] = Math.min(
      pointCount - 1,
      Math.floor(phase * pointCount)
    );
  }
  return pathInfos;
}

function makeParticleGeometry(pointCounts: Float32Array) {
  const geometry = new THREE.InstancedBufferGeometry();
  addTrailAttributes(geometry);
  geometry.setAttribute(
    "pathInfo",
    new THREE.InstancedBufferAttribute(makeParticlePathInfos(pointCounts), 3)
  );
  geometry.instanceCount = PARTICLE_COUNT;
  return geometry;
}

function makeLineMaterial(cache: TPathCache) {
  return new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(0xc7f6ff) },
      opacity: { value: 0.55 },
      projectionType: { value: 0 },
      centerLonSin: { value: 0 },
      centerLonCos: { value: 1 },
      centerLatSin: { value: 0 },
      centerLatCos: { value: 1 },
      projectionRadius: { value: 1 },
      layerDepth: { value: 0 },
      pathTexture: { value: cache.texture },
      pathTextureSize: { value: cache.textureSize },
      animationPhase: { value: 0 },
      trailSampleSeconds: { value: TRAIL_SAMPLE_SECONDS },
      fadeInSeconds: { value: FADE_IN_SECONDS },
      fadeOutSeconds: { value: FADE_OUT_SECONDS },
    },
    vertexShader: streamlineVertexShader,
    fragmentShader: `
      uniform vec3 color;
      uniform float opacity;
      varying float vTrailAlpha;
      void main() {
        gl_FragColor = vec4(color, opacity * vTrailAlpha);
      }
    `,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Animated particles following cached streamlines through a frozen field. */
export class StreamlineParticleLayer {
  readonly object = new THREE.Group();

  private readonly lines: THREE.LineSegments;
  private readonly pathTexture: THREE.DataTexture;
  private projectionHelper: ProjectionHelper;
  private renderOrder = 11;
  private animationPhase = 0;

  constructor(
    private readonly field: TStreamlineVectorField,
    projectionHelper: ProjectionHelper
  ) {
    this.projectionHelper = projectionHelper;
    const cache = this.createPathCache();
    this.pathTexture = cache.texture;
    this.lines = new THREE.LineSegments(
      makeParticleGeometry(cache.pointCounts),
      makeLineMaterial(cache)
    );
    this.lines.frustumCulled = false;
    this.object.add(this.lines);
    this.updateMaterialProjection();
  }

  private findSeed() {
    for (let attempt = 0; attempt < 80; attempt++) {
      const position = this.field.randomPosition();
      const sample = this.field.sample(position.latitude, position.longitude);
      if (sample && sample.speed > this.field.referenceSpeed * 0.01) {
        return position;
      }
    }
    return this.field.randomPosition();
  }

  private createCachedStreamline(
    textureData: Float32Array,
    firstSampleIndex: number
  ) {
    const seed = this.findSeed();
    let pointCount = 1;
    let cursor = seed;
    writePathSample(
      seed,
      this.speedAlphaAt(seed),
      textureData,
      firstSampleIndex
    );
    for (let i = 1; i < CACHED_PATH_LENGTH; i++) {
      const next = this.field.advance(
        cursor.latitude,
        cursor.longitude,
        TRAIL_SAMPLE_SECONDS
      );
      if (!next) {
        break;
      }
      writePathSample(
        next,
        this.speedAlphaAt(next),
        textureData,
        firstSampleIndex + i
      );
      cursor = next;
      pointCount++;
    }
    return pointCount;
  }

  private createPathCache(): TPathCache {
    const texturePointCount = CACHED_PATH_COUNT * CACHED_PATH_LENGTH;
    const textureHeight = Math.ceil(texturePointCount / PATH_TEXTURE_WIDTH);
    const textureData = new Float32Array(
      PATH_TEXTURE_WIDTH * textureHeight * 4
    );
    const pointCounts = new Float32Array(CACHED_PATH_COUNT);
    for (let path = 0; path < CACHED_PATH_COUNT; path++) {
      pointCounts[path] = this.createCachedStreamline(
        textureData,
        path * CACHED_PATH_LENGTH
      );
    }
    const texture = new THREE.DataTexture(
      textureData,
      PATH_TEXTURE_WIDTH,
      textureHeight,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return {
      texture,
      textureSize: new THREE.Vector2(PATH_TEXTURE_WIDTH, textureHeight),
      pointCounts,
    };
  }

  private speedAlphaAt(point: TGeoPoint) {
    const speed = this.field.sample(point.latitude, point.longitude)?.speed;
    const fraction = Math.min(
      1,
      Math.max(0, (speed ?? 0) / this.field.referenceSpeed)
    );
    return MIN_SPEED_ALPHA + (1 - MIN_SPEED_ALPHA) * fraction;
  }

  update(deltaSeconds: number) {
    if (deltaSeconds <= 0) {
      return;
    }
    this.animationPhase += Math.min(deltaSeconds, 0.25) / TRAIL_SAMPLE_SECONDS;
    const material = this.lines.material as THREE.ShaderMaterial;
    material.uniforms.animationPhase.value = this.animationPhase;
  }

  updateProjection(projectionHelper: ProjectionHelper) {
    this.projectionHelper = projectionHelper;
    this.updateMaterialProjection();
  }

  setOpacity(opacity: number) {
    (this.lines.material as THREE.ShaderMaterial).uniforms.opacity.value =
      opacity;
  }

  setRenderOrder(renderOrder: number) {
    if (this.renderOrder !== renderOrder) {
      this.renderOrder = renderOrder;
      this.updateMaterialProjection();
    }
    this.lines.renderOrder = renderOrder;
  }

  private updateMaterialProjection() {
    const aboveGrid = this.renderOrder > 0;
    const radius = this.projectionHelper.isFlat ? 1 : aboveGrid ? 1.006 : 0.994;
    const material = this.lines.material as THREE.ShaderMaterial;
    updateProjectionUniforms(material, this.projectionHelper, radius);
    const centerLon = THREE.MathUtils.degToRad(
      this.projectionHelper.center.lon
    );
    const centerLat = THREE.MathUtils.degToRad(
      this.projectionHelper.center.lat
    );
    material.uniforms.centerLonSin.value = Math.sin(centerLon);
    material.uniforms.centerLonCos.value = Math.cos(centerLon);
    material.uniforms.centerLatSin.value = Math.sin(centerLat);
    material.uniforms.centerLatCos.value = Math.cos(centerLat);
    material.uniforms.layerDepth.value = this.projectionHelper.isFlat
      ? aboveGrid
        ? 0.025
        : -0.025
      : 0;
  }

  dispose() {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.pathTexture.dispose();
    this.object.clear();
  }
}
