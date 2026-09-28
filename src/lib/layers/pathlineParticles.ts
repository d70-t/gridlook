import * as THREE from "three";

import {
  PATHLINE_DISPLAY,
  packPathlinePreview,
  pathlinePreviewLayout,
  type TPathlineDisplay,
} from "./pathlinePreview.ts";

import { pathlineUnitVector } from "@/lib/data/pathlineIntegration.ts";
import {
  planPathlineTrajectories,
  type TPathlineConfig,
  type TPathlineTrajectories,
} from "@/lib/data/pathlineTrajectories.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import pathlineFragmentShader from "@/lib/shaders/glsl/pathline.frag.glsl";
import pathlineVertexShader from "@/lib/shaders/glsl/pathline.vert.glsl";
import { updateProjectionUniforms } from "@/lib/shaders/gridShaders.ts";

/** Worst-case allocations, including unused trajectory slots. */
export function pathlineRenderLayout(
  times: readonly number[],
  config: TPathlineConfig,
  maxTextureSize: number
) {
  const plan = planPathlineTrajectories(times, config);
  if (!Number.isSafeInteger(maxTextureSize) || maxTextureSize < 1) {
    throw new Error("The browser did not report a valid GPU texture size.");
  }
  // Near-square textures use both available dimensions and minimize padding.
  const width = Math.min(Math.ceil(Math.sqrt(plan.records)), maxTextureSize);
  const height = Math.ceil(plan.records / width);
  if (height > maxTextureSize) {
    throw new Error(
      `Pathlines need ${plan.records.toLocaleString()} stored samples. This browser allows ${maxTextureSize} × ${maxTextureSize} samples per texture (${(maxTextureSize ** 2).toLocaleString()}). This is a texture-dimension limit, not a measurement of free GPU memory. Use fewer particles or a longer sampling interval.`
    );
  }
  const pixels = width * height;
  const preview = pathlinePreviewLayout(
    config.particleCount,
    times.length,
    maxTextureSize
  );
  const gpuBytes =
    pixels * 20 + config.particleCount * 2 * 4 + (preview?.bytes ?? 0);
  return {
    width,
    height,
    pixels,
    preview,
    gpuBytes,
    cpuBytes: gpuBytes,
    workingBytes: 0,
  };
}

/** Persistent GPU trajectories; seeking changes only time and fade uniforms. */
export class PathlineParticleLayer {
  readonly object: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  // eslint-disable-next-line max-lines-per-function
  private constructor(
    geometry: THREE.BufferGeometry,
    private readonly paths: THREE.DataTexture,
    private readonly timeLow: THREE.DataTexture,
    private readonly start: number,
    private readonly end: number,
    sampleSeconds: number,
    projection: ProjectionHelper,
    private readonly keyframeTimes: readonly number[],
    private readonly preview?: {
      positions: THREE.DataTexture;
      lifetimes: THREE.DataTexture;
    }
  ) {
    this.object = new THREE.Points(
      geometry,
      new THREE.ShaderMaterial({
        defines: preview ? { PATHLINE_PREVIEW: 1 } : {},
        uniforms: {
          paths: { value: paths },
          timeLow: { value: timeLow },
          previewPositions: { value: preview?.positions },
          previewLifetimes: { value: preview?.lifetimes },
          previewFrames: { value: new THREE.Vector2() },
          previewStart: { value: new THREE.Vector2() },
          previewEnd: { value: new THREE.Vector2() },
          particleCount: { value: geometry.drawRange.count },
          currentTime: { value: new THREE.Vector2() },
          fadeSeconds: { value: sampleSeconds },
          particleSize: { value: 4 },
          color: { value: new THREE.Color(0xc7f6ff) },
          opacity: { value: 0.55 },
          projectionType: { value: 0 },
          centerLon: { value: 0 },
          centerLat: { value: 0 },
          projectionCenter: { value: new THREE.Vector3(1, 0, 0) },
          projectionRadius: { value: 1 },
          edgeQuality: { value: 1 },
        },
        vertexShader: pathlineVertexShader,
        fragmentShader: pathlineFragmentShader,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.object.frustumCulled = false;
    this.updateProjection(projection);
    this.seek(start, sampleSeconds, 4);
  }

  // eslint-disable-next-line max-lines-per-function
  static async create(
    data: TPathlineTrajectories,
    config: TPathlineConfig,
    projection: ProjectionHelper,
    maxTextureSize: number,
    isCurrent: () => boolean,
    keyframeTimes: readonly number[] = [data.start, data.end]
  ) {
    if (keyframeTimes[0] !== data.start || keyframeTimes.at(-1) !== data.end) {
      throw new Error(
        "Pathline preview times must cover the prepared trajectories."
      );
    }
    const layout = pathlineRenderLayout(keyframeTimes, config, maxTextureSize);
    let deadline = performance.now() + 8;
    const check = async () => {
      if (performance.now() >= deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        deadline = performance.now() + 8;
      }
      if (!isCurrent()) {
        throw new DOMException(
          "Pathline display preparation cancelled",
          "AbortError"
        );
      }
    };
    await check();
    const packed = new Float32Array(layout.pixels * 4);
    const low = new Float32Array(layout.pixels);
    const ranges = new Uint32Array(config.particleCount * 2);
    for (let particle = 0; particle < data.counts.length; particle++) {
      const first = particle * data.capacity;
      const end = first + data.counts[particle];
      ranges.set([first, end], particle * 2);
      await check();
      for (let i = first; i < end; i++) {
        if (i % 2048 === 0) {
          await check();
        }
        packed[i * 4] = data.positions[i * 3];
        packed[i * 4 + 1] = data.positions[i * 3 + 1];
        packed[i * 4 + 2] = data.positions[i * 3 + 2];
        const time = data.times[i] - data.start;
        packed[i * 4 + 3] = time;
        low[i] = time - packed[i * 4 + 3];
      }
    }
    await check();
    const preview = layout.preview
      ? await packPathlinePreview(data, keyframeTimes, layout.preview, check)
      : undefined;
    const texture = (
      array: Float32Array,
      format: THREE.PixelFormat,
      shape: { width: number; height: number } = layout
    ) => {
      const result = new THREE.DataTexture(
        array,
        shape.width,
        shape.height,
        format,
        THREE.FloatType
      );
      result.minFilter = result.magFilter = THREE.NearestFilter;
      result.generateMipmaps = false;
      result.needsUpdate = true;
      return result;
    };
    const geometry = new THREE.BufferGeometry();
    const rangeAttribute = new THREE.BufferAttribute(ranges, 2);
    rangeAttribute.gpuType = THREE.IntType;
    geometry.setAttribute("pathRange", rangeAttribute);
    geometry.setDrawRange(0, config.particleCount);
    return new PathlineParticleLayer(
      geometry,
      texture(packed, THREE.RGBAFormat),
      texture(low, THREE.RedFormat),
      data.start,
      data.end,
      config.sampleSeconds,
      projection,
      [...keyframeTimes],
      preview && layout.preview
        ? {
            positions: texture(
              preview.positions,
              THREE.RGBAFormat,
              layout.preview.positions
            ),
            lifetimes: texture(
              preview.lifetimes,
              THREE.RGBAFormat,
              layout.preview.lifetimes
            ),
          }
        : undefined
    );
  }

  // eslint-disable-next-line max-lines-per-function
  seek(
    seconds: number,
    fadeSeconds: number,
    particleSize: number,
    mode: TPathlineDisplay = PATHLINE_DISPLAY.PREVIEW
  ) {
    if (
      !Number.isFinite(seconds) ||
      seconds < this.start ||
      seconds > this.end ||
      !Number.isFinite(fadeSeconds) ||
      fadeSeconds <= 0 ||
      !Number.isFinite(particleSize) ||
      particleSize <= 0
    ) {
      throw new Error(
        "Choose a valid pathline time and positive fade duration and particle size."
      );
    }
    const material = this.object.material;
    const preview = mode === PATHLINE_DISPLAY.PREVIEW && !!this.preview;
    if (preview !== !!material.defines.PATHLINE_PREVIEW) {
      material.defines = preview ? { PATHLINE_PREVIEW: 1 } : {};
      material.needsUpdate = true;
    }
    if (preview) {
      let low = 0,
        high = this.keyframeTimes.length - 1;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (this.keyframeTimes[middle] <= seconds) {
          low = middle;
        } else {
          high = middle;
        }
      }
      material.uniforms.previewFrames.value.set(low, high);
      for (const [name, time] of [
        ["previewStart", this.keyframeTimes[low]],
        ["previewEnd", this.keyframeTimes[high]],
      ] as const) {
        const elapsed = time - this.start,
          high = Math.fround(elapsed);
        material.uniforms[name].value.set(high, elapsed - high);
      }
    }
    const elapsed = seconds - this.start;
    const high = Math.fround(elapsed);
    this.object.material.uniforms.currentTime.value.set(high, elapsed - high);
    this.object.material.uniforms.fadeSeconds.value = fadeSeconds;
    this.object.material.uniforms.particleSize.value = particleSize;
  }

  updateProjection(projection: ProjectionHelper) {
    const material = this.object.material;
    updateProjectionUniforms(material, projection);
    // The layer stack controls surface order; the fragment shader hides the far side.
    material.depthTest = false;
    material.uniforms.centerLon.value = projection.center.lon;
    material.uniforms.centerLat.value = projection.center.lat;
    material.uniforms.projectionCenter.value.set(
      ...pathlineUnitVector({
        latitude: projection.center.lat,
        longitude: projection.center.lon,
      })
    );
  }

  dispose() {
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.paths.dispose();
    this.timeLow.dispose();
    this.preview?.positions.dispose();
    this.preview?.lifetimes.dispose();
  }
}
