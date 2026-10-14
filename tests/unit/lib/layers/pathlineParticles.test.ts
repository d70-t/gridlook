import { IntType, type BufferAttribute } from "three";
import { expect, it, vi } from "vitest";

import {
  integratePathlines,
  type TPathlineConfig,
} from "@/lib/data/pathlineTrajectories.ts";
import {
  PathlineParticleLayer,
  pathlineRenderLayout,
} from "@/lib/layers/pathlineParticles.ts";
import { PATHLINE_DISPLAY } from "@/lib/layers/pathlinePreview.ts";
import {
  ProjectionHelper,
  PROJECTION_TYPES,
} from "@/lib/projection/projectionUtils.ts";

const config: TPathlineConfig = {
  particleCount: 2,
  randomSeed: 1,
  sampleSeconds: 10,
  maxStepSeconds: 2,
  maxStepMetres: 100,
  errorToleranceMetres: 1,
};
const projection = new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
  lat: 0,
  lon: 0,
});
const trajectories = () =>
  integratePathlines(
    {
      sourceTimes: [0, 100],
      sample: () => ({ u: 10, v: 0, speed: 10 }),
      seedPosition: () => ({ latitude: 0, longitude: 0 }),
    },
    config
  );

it("uploads one point per trajectory and seeks by time without new buffers", async () => {
  const data = await trajectories();
  const layer = await PathlineParticleLayer.create(
    data,
    config,
    projection,
    2048,
    () => true
  );
  const { geometry, material } = layer.object;
  const vertices = geometry.getAttribute("pathRange") as BufferAttribute;
  const paths = material.uniforms.paths.value;
  const low = material.uniforms.timeLow.value;
  const preview = material.uniforms.previewPositions.value;
  const lifetimes = material.uniforms.previewLifetimes.value;
  const layout = pathlineRenderLayout([0, 100], config, 2048);
  expect(
    vertices.array.byteLength +
      paths.image.data.byteLength +
      low.image.data.byteLength +
      preview.image.data.byteLength +
      lifetimes.image.data.byteLength
  ).toBe(layout.gpuBytes);
  expect(vertices.count).toBe(config.particleCount);
  expect(vertices.array).toBeInstanceOf(Uint32Array);
  expect(vertices.gpuType).toBe(IntType);
  expect(geometry.drawRange.count).toBe(config.particleCount);
  for (let particle = 0; particle < config.particleCount; particle++) {
    expect(vertices.getX(particle)).toBe(particle * data.capacity);
    expect(vertices.getY(particle)).toBe(
      particle * data.capacity + data.counts[particle]
    );
  }
  layer.seek(95, 12, 4);
  expect(material.uniforms.fadeSeconds.value).toBe(12);
  const version = vertices.version;
  for (const seconds of [25, 80, 0, 25]) {
    layer.seek(seconds, 12, 8);
  }
  expect(material.uniforms.currentTime.value.toArray()).toEqual([25, 0]);
  expect(material.uniforms.particleSize.value).toBe(8);
  expect(vertices.version).toBe(version);
  expect(geometry.getAttribute("pathRange")).toBe(vertices);
  expect(paths.version).toBe(1);
  const dispose = [geometry, material, paths, low, preview, lifetimes].map(
    (object) => vi.spyOn(object, "dispose")
  );
  layer.dispose();
  dispose.forEach((spy) => expect(spy).toHaveBeenCalledOnce());
});

it("preserves fractional dataset seconds over long time ranges and updates map projections", async () => {
  const settings = {
    ...config,
    sampleSeconds: 1e9,
    maxStepSeconds: 1e9,
  };
  const data = await integratePathlines(
    {
      sourceTimes: [0, 1e9 + 0.123],
      sample: () => ({ u: 0, v: 0, speed: 0 }),
      seedPosition: () => ({ latitude: 20, longitude: 30 }),
    },
    settings
  );
  const layer = await PathlineParticleLayer.create(
    data,
    settings,
    projection,
    2048,
    () => true
  );
  const uniforms = layer.object.material.uniforms;
  const last = data.counts[0] - 1;
  expect(
    uniforms.paths.value.image.data[last * 4 + 3] +
      uniforms.timeLow.value.image.data[last]
  ).toBeCloseTo(1e9 + 0.123, 6);
  layer.seek(1e9 + 0.1, 20, 4);
  expect(
    uniforms.currentTime.value.x + uniforms.currentTime.value.y
  ).toBeCloseTo(1e9 + 0.1, 6);
  layer.updateProjection(
    new ProjectionHelper(PROJECTION_TYPES.EQUIRECTANGULAR, { lat: 0, lon: 45 })
  );
  expect(uniforms.centerLon.value).toBe(45);
  expect(uniforms.projectionCenter.value.x).toBeCloseTo(Math.SQRT1_2);
  layer.dispose();
});

it("rejects GPU capacity overflow before allocation and discards stale display preparation", async () => {
  expect(() => pathlineRenderLayout([0, 100], config, 2)).toThrow(
    /texture-dimension limit/
  );
  const data = await trajectories();
  let calls = 0;
  await expect(
    PathlineParticleLayer.create(
      data,
      config,
      projection,
      2048,
      () => ++calls < 3
    )
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("fits 48k particles above the old 2^24 limit using the available texture dimensions", () => {
  const times = [0, 50 * 3 * 3600];
  const settings = { ...config, particleCount: 48000, sampleSeconds: 1500 };
  const layout = pathlineRenderLayout(times, settings, 16384);
  expect(48000 * (360 + 2)).toBeGreaterThan(2 ** 24);
  expect(layout.width).toBeGreaterThan(2048);
  expect(layout.height).toBeLessThanOrEqual(16384);
  expect(layout.pixels).toBeGreaterThanOrEqual(48000 * 362);
  expect(layout.gpuBytes).toBe(
    layout.pixels * 20 + 48000 * 8 + layout.preview!.bytes
  );
  expect(() => pathlineRenderLayout(times, settings, 4096)).toThrow(
    /4096 × 4096/
  );
});

it("seeks the shared keyframe interval once, including irregular times and reverse seeks", async () => {
  const data = await trajectories();
  const layer = await PathlineParticleLayer.create(
    data,
    config,
    projection,
    2048,
    () => true,
    [0, 15, 100]
  );
  const uniforms = layer.object.material.uniforms;
  for (const [time, first, last] of [
    [10, 0, 1],
    [15, 1, 2],
    [100, 1, 2],
    [0, 0, 1],
  ]) {
    layer.seek(time, 12, 4);
    expect(uniforms.previewFrames.value.toArray()).toEqual([first, last]);
  }
  layer.dispose();
});

it("keeps full trajectories available when only the optional preview exceeds texture dimensions", async () => {
  const data = await trajectories();
  const times = Array.from({ length: 100 }, (_, i) => (i * 100) / 99);
  const layout = pathlineRenderLayout(times, config, 8);
  expect(layout.preview).toBeUndefined();
  const layer = await PathlineParticleLayer.create(
    data,
    config,
    projection,
    8,
    () => true,
    times
  );
  layer.seek(10, 12, 4, PATHLINE_DISPLAY.PREVIEW);
  expect(layer.object.material.defines.PATHLINE_PREVIEW).toBeUndefined();
  layer.dispose();
});

it("switches preview mode without replacing buffers or recompiling on each seek", async () => {
  const layer = await PathlineParticleLayer.create(
    await trajectories(),
    config,
    projection,
    2048,
    () => true
  );
  const material = layer.object.material;
  const preview = material.uniforms.previewPositions.value;
  const paths = material.uniforms.paths.value;
  const previewVersion = preview.version,
    pathVersion = paths.version,
    version = material.version;
  layer.seek(25, 12, 8, PATHLINE_DISPLAY.PREVIEW);
  expect(material.version).toBe(version);
  layer.seek(25, 12, 8, PATHLINE_DISPLAY.TRAJECTORY);
  expect(material.defines.PATHLINE_PREVIEW).toBeUndefined();
  expect(material.version).toBe(version + 1);
  layer.seek(30, 12, 8, PATHLINE_DISPLAY.TRAJECTORY);
  expect(material.version).toBe(version + 1);
  layer.seek(25, 12, 8, PATHLINE_DISPLAY.PREVIEW);
  expect(material.defines.PATHLINE_PREVIEW).toBe(1);
  expect(preview.version).toBe(previewVersion);
  expect(paths.version).toBe(pathVersion);
  layer.dispose();
});
