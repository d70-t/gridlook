import { beforeEach, expect, it, vi } from "vitest";

import type { TStreamlineVectorField } from "@/lib/data/vectorField.ts";
import type { StreamlineParticleLayer } from "@/lib/layers/streamlineParticles.ts";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/layers/streamlineParticles.ts", () => ({
  StreamlineParticleLayer: { create },
}));
vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { computed, effectScope } = await import("vue");
const { Object3D, Scene } = await import("three");
const { ProjectionHelper, PROJECTION_TYPES } =
  await import("@/lib/projection/projectionUtils.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useStreamlineLayer } =
  await import("@/ui/grids/composables/useStreamlineLayer.ts");

beforeEach(() => {
  setActivePinia(createPinia());
  create.mockReset();
});

it.each([false, true])(
  "only installs the current request (current: %s)",
  async (isCurrent) => {
    const store = useGlobeControlStore();
    store.setStreamlineLayerEnabled(true);
    let finish!: (layer: StreamlineParticleLayer) => void;
    create.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const scope = effectScope();
    const scene = new Scene();
    const layer = scope.run(() =>
      useStreamlineLayer({
        getScene: () => scene,
        redraw: vi.fn(),
        projectionHelper: computed(
          () =>
            new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
              lat: 0,
              lon: 0,
            })
        ),
        onProjectionChange: vi.fn(),
        registerAnimationCallback: vi.fn(),
      })
    )!;
    let currentRequest = true;
    const pending = layer.setField(
      {} as TStreamlineVectorField,
      { u: "u", v: "v", kind: "u/v" },
      () => currentRequest
    );

    currentRequest = isCurrent;
    expect(create.mock.calls[0][2]()).toBe(!isCurrent);
    const dispose = vi.fn();
    finish({
      dispose,
      object: new Object3D(),
      updateProjection: vi.fn(),
      setRenderOrder: vi.fn(),
      setOpacity: vi.fn(),
    } as unknown as StreamlineParticleLayer);

    expect(await pending).toBe(isCurrent);
    expect(dispose).toHaveBeenCalledTimes(isCurrent ? 0 : 1);
    expect(scene.children).toHaveLength(isCurrent ? 1 : 0);
    expect(store.streamlineLoading).toBe(!isCurrent);
    scope.stop();
  }
);
