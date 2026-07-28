import { describe, expect, it } from "vitest";

import { StreamlineParticleLayer } from "@/lib/layers/streamlineParticles.ts";

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
    expect(animationPhase.value).toBeCloseTo(0.6);
  });
});
