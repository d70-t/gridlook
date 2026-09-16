import { describe, expect, it } from "vitest";

import {
  RegularVectorField,
  type TStreamlineVectorField,
} from "@/lib/data/vectorField.ts";
import {
  createCachedStreamlineSamples,
  StreamlineParticleLayer,
} from "@/lib/layers/streamlineParticles.ts";
import {
  ProjectionHelper,
  PROJECTION_TYPES,
} from "@/lib/projection/projectionUtils.ts";

it("reports completed path work through to 100 percent", async () => {
  const progress: number[] = [];
  const field = {
    randomPosition: () => ({ latitude: 0, longitude: 0 }),
    sample: () => ({ u: 1, v: 0, speed: 1 }),
    advance: () => undefined,
  } as unknown as TStreamlineVectorField;
  const layer = await StreamlineParticleLayer.create(
    field,
    new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
      lat: 0,
      lon: 0,
    }),
    () => false,
    (percentage) => progress.push(percentage)
  );
  try {
    expect(layer).toBeDefined();
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(100);
    expect(
      progress.every(
        (value, index) => index === 0 || value >= progress[index - 1]
      )
    ).toBe(true);
  } finally {
    layer?.dispose();
  }
});

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
  it("builds moving regional paths with 0–360 longitudes in both directions", () => {
    const field = new RegularVectorField(
      new Float32Array([45, 15]),
      new Float32Array([265, 320]),
      new Float32Array(4).fill(10),
      new Float32Array(4).fill(0)
    );

    for (const pathIndex of [0, 1]) {
      const textureData = new Float32Array(96 * 4);
      const pointCount = createCachedStreamlineSamples(
        field,
        textureData,
        0,
        pathIndex
      );

      expect(pointCount).toBeGreaterThan(1);
      expect(textureData.slice(0, 3)).not.toEqual(textureData.slice(4, 7));
    }
  });

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
