import { describe, expect, it } from "vitest";

import type { TStreamlineVectorField } from "@/lib/data/vectorField.ts";
import {
  createCachedStreamlineSamples,
  StreamlineParticleLayer,
} from "@/lib/layers/streamlineParticles.ts";

describe("StreamlineParticleLayer", () => {
  it("advances using the fixed animation speed", () => {
    const animationPhase = { value: 0 };
    const layer = Object.create(
      StreamlineParticleLayer.prototype
    ) as StreamlineParticleLayer;

    Object.assign(layer, {
      animationPhase: 0,
      lines: {
        material: {
          uniforms: { animationPhase },
        },
      },
    });

    layer.update(0.03);
    expect(animationPhase.value).toBeCloseTo(0.3);
  });
});

describe("streamline path cache", () => {
  it("stores backward-integrated paths in forward-flow order", () => {
    const integrationSteps: number[] = [];
    let advanceCount = 0;
    const field = {
      randomPosition: () => ({ latitude: 0, longitude: 0 }),
      sample: () => ({ u: 1, v: 0, speed: 1 }),
      advance: (latitude: number, longitude: number, seconds: number) => {
        integrationSteps.push(seconds);
        advanceCount++;
        return advanceCount === 1
          ? { latitude, longitude: longitude + seconds }
          : undefined;
      },
    } as unknown as TStreamlineVectorField;
    const textureData = new Float32Array(96 * 4);

    const pointCount = createCachedStreamlineSamples(field, textureData, 0, 1);

    expect(pointCount).toBe(2);
    expect(integrationSteps).toEqual([-0.025, -0.025]);
    expect(textureData[1]).toBeLessThan(0);
    expect(textureData[5]).toBeCloseTo(0);
  });
});
