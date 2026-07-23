import * as THREE from "three";

import type { TStreamlineVectorField } from "@/lib/data/vectorField.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import streamlineVertexShader from "@/lib/shaders/glsl/streamline.vert.glsl";
import { updateProjectionUniforms } from "@/lib/shaders/gridShaders.ts";

type TGeoPoint = { latitude: number; longitude: number };

type TCachedStreamline = {
  latLons: Float32Array;
  speedAlphas: Float32Array;
  pointCount: number;
};

type TParticle = {
  path: TCachedStreamline;
  headIndex: number;
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
const LINE_VERTEX_COUNT = PARTICLE_COUNT * (TRAIL_LENGTH - 1) * 2;

function makeLineMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(0xc7f6ff) },
      opacity: { value: 0.55 },
      projectionType: { value: 0 },
      centerLon: { value: 0 },
      centerLat: { value: 0 },
      projectionRadius: { value: 1 },
      layerDepth: { value: 0 },
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

  private readonly cachedStreamlines: TCachedStreamline[] = [];
  private readonly particles: TParticle[] = [];
  private readonly lineLatLons = new Float32Array(LINE_VERTEX_COUNT * 2);
  private readonly lineOtherEndpoints = new Float32Array(LINE_VERTEX_COUNT * 3);
  private readonly lineAlphas = new Float32Array(LINE_VERTEX_COUNT);
  private readonly lines: THREE.LineSegments;
  private projectionHelper: ProjectionHelper;
  private renderOrder = 11;
  private trailAccumulator = 0;

  constructor(
    private readonly field: TStreamlineVectorField,
    projectionHelper: ProjectionHelper
  ) {
    this.projectionHelper = projectionHelper;
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.lineOtherEndpoints, 3)
    );
    lineGeometry.setAttribute(
      "latLon",
      new THREE.BufferAttribute(this.lineLatLons, 2)
    );
    lineGeometry.setAttribute(
      "trailAlpha",
      new THREE.BufferAttribute(this.lineAlphas, 1)
    );
    this.lines = new THREE.LineSegments(lineGeometry, makeLineMaterial());
    this.lines.frustumCulled = false;
    this.object.add(this.lines);
    this.updateMaterialProjection();

    for (let i = 0; i < CACHED_PATH_COUNT; i++) {
      this.cachedStreamlines.push(this.createCachedStreamline());
    }
    const initialPathPhases = Float32Array.from(
      { length: CACHED_PATH_COUNT },
      () => Math.random()
    );
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const pathIndex = i % CACHED_PATH_COUNT;
      const path = this.cachedStreamlines[pathIndex];
      const instanceIndex = Math.floor(i / CACHED_PATH_COUNT);
      const phase =
        (initialPathPhases[pathIndex] + instanceIndex / PARTICLES_PER_PATH) % 1;
      this.particles.push({
        path,
        headIndex: Math.min(
          path.pointCount - 1,
          Math.floor(phase * path.pointCount)
        ),
      });
    }
    this.updateGeometry();
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

  private createCachedStreamline(): TCachedStreamline {
    const seed = this.findSeed();
    const latLons = new Float32Array(CACHED_PATH_LENGTH * 2);
    const speedAlphas = new Float32Array(CACHED_PATH_LENGTH);
    let pointCount = 1;
    let cursor = seed;
    latLons[0] = seed.latitude;
    latLons[1] = seed.longitude;
    speedAlphas[0] = this.speedAlphaAt(seed);
    for (let i = 1; i < CACHED_PATH_LENGTH; i++) {
      const next = this.field.advance(
        cursor.latitude,
        cursor.longitude,
        TRAIL_SAMPLE_SECONDS
      );
      if (!next) {
        break;
      }
      latLons[i * 2] = next.latitude;
      latLons[i * 2 + 1] = next.longitude;
      speedAlphas[i] = this.speedAlphaAt(next);
      cursor = next;
      pointCount++;
    }
    return {
      latLons,
      speedAlphas,
      pointCount,
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
    this.trailAccumulator += Math.min(deltaSeconds, 0.25);
    const steps = Math.floor(this.trailAccumulator / TRAIL_SAMPLE_SECONDS);
    if (steps === 0) {
      return;
    }
    this.trailAccumulator %= TRAIL_SAMPLE_SECONDS;
    for (const particle of this.particles) {
      particle.headIndex =
        (particle.headIndex + steps) % particle.path.pointCount;
    }
    this.updateGeometry();
  }

  updateProjection(projectionHelper: ProjectionHelper) {
    this.projectionHelper = projectionHelper;
    this.updateMaterialProjection();
  }

  private writeSegment(
    particle: TParticle,
    trailIndex: number,
    vertexOffset: number,
    lifeAlpha: number
  ) {
    const startIndex = particle.headIndex - (TRAIL_LENGTH - 1) + trailIndex;
    const endIndex = startIndex + 1;
    if (startIndex < 0 || endIndex >= particle.path.pointCount) {
      this.lineAlphas[vertexOffset] = 0;
      this.lineAlphas[vertexOffset + 1] = 0;
      return;
    }
    const startOffset = startIndex * 2;
    const endOffset = endIndex * 2;
    const startLatitude = particle.path.latLons[startOffset];
    const startLongitude = particle.path.latLons[startOffset + 1];
    const endLatitude = particle.path.latLons[endOffset];
    const endLongitude = particle.path.latLons[endOffset + 1];
    const outputOffset = vertexOffset * 2;
    this.lineLatLons[outputOffset] = startLatitude;
    this.lineLatLons[outputOffset + 1] = startLongitude;
    this.lineLatLons[outputOffset + 2] = endLatitude;
    this.lineLatLons[outputOffset + 3] = endLongitude;

    // LineSegments supplies no opposite endpoint to its vertex shader. Keep
    // it in the otherwise unused position attribute so the shader can hide
    // segments crossing the seam of the current rotated projection.
    const otherEndpointOffset = vertexOffset * 3;
    this.lineOtherEndpoints[otherEndpointOffset] = endLatitude;
    this.lineOtherEndpoints[otherEndpointOffset + 1] = endLongitude;
    this.lineOtherEndpoints[otherEndpointOffset + 3] = startLatitude;
    this.lineOtherEndpoints[otherEndpointOffset + 4] = startLongitude;
    const fadeStart = trailIndex / (TRAIL_LENGTH - 1);
    const fadeEnd = (trailIndex + 1) / (TRAIL_LENGTH - 1);
    this.lineAlphas[vertexOffset] =
      fadeStart ** TRAIL_FADE_EXPONENT *
      lifeAlpha *
      particle.path.speedAlphas[startIndex];
    this.lineAlphas[vertexOffset + 1] =
      fadeEnd ** TRAIL_FADE_EXPONENT *
      lifeAlpha *
      particle.path.speedAlphas[endIndex];
  }

  private writeParticle(particle: TParticle, initialVertexOffset: number) {
    const remainingSeconds =
      (particle.path.pointCount - 1 - particle.headIndex) *
      TRAIL_SAMPLE_SECONDS;
    const lifeAlpha = Math.min(
      1,
      (particle.headIndex * TRAIL_SAMPLE_SECONDS) / FADE_IN_SECONDS,
      remainingSeconds / FADE_OUT_SECONDS
    );
    let vertexOffset = initialVertexOffset;
    for (let i = 0; i < TRAIL_LENGTH - 1; i++) {
      this.writeSegment(particle, i, vertexOffset, lifeAlpha);
      vertexOffset += 2;
    }
    return vertexOffset;
  }

  private updateGeometry() {
    let vertexOffset = 0;
    for (
      let particleIndex = 0;
      particleIndex < PARTICLE_COUNT;
      particleIndex++
    ) {
      vertexOffset = this.writeParticle(
        this.particles[particleIndex],
        vertexOffset
      );
    }
    this.lines.geometry.getAttribute("latLon").needsUpdate = true;
    this.lines.geometry.getAttribute("position").needsUpdate = true;
    this.lines.geometry.getAttribute("trailAlpha").needsUpdate = true;
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
    material.uniforms.layerDepth.value = this.projectionHelper.isFlat
      ? aboveGrid
        ? 0.025
        : -0.025
      : 0;
  }

  dispose() {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.object.clear();
  }
}
