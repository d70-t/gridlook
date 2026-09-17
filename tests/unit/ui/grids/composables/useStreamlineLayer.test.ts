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
const { useGlobeControlStore, STREAMLINE_LOADING_STAGES } =
  await import("@/store/store.ts");
const { useStreamlineLayer } =
  await import("@/ui/grids/composables/useStreamlineLayer.ts");

beforeEach(() => {
  setActivePinia(createPinia());
  create.mockReset();
});

function setupLayer() {
  const store = useGlobeControlStore();
  store.setStreamlineLayerEnabled(true);
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
  return { store, scope, scene, layer };
}

it.each([false, true])(
  "only installs the current request (current: %s)",
  async (isCurrent) => {
    const { store, scope, scene, layer } = setupLayer();
    let finish!: (layer: StreamlineParticleLayer) => void;
    create.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    let currentRequest = true;
    layer.startLoading();
    expect(store.streamlineProgress).toBeUndefined();
    expect(store.streamlineLoadingStage).toBe(STREAMLINE_LOADING_STAGES.DATA);
    expect(await layer.prepareField(() => currentRequest)).toBe(true);
    expect(store.streamlineLoadingStage).toBe(STREAMLINE_LOADING_STAGES.FIELD);
    const pending = layer.setField(
      {} as TStreamlineVectorField,
      { u: "u", v: "v", kind: "u/v" },
      () => currentRequest
    );

    expect(store.streamlineLoadingStage).toBe(STREAMLINE_LOADING_STAGES.PATHS);
    const reportProgress = create.mock.calls[0][3];
    reportProgress(25);
    expect(store.streamlineProgress).toBe(25);

    currentRequest = isCurrent;
    reportProgress(75);
    expect(store.streamlineProgress).toBe(isCurrent ? 75 : 25);
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
    expect(store.streamlineProgress).toBe(isCurrent ? undefined : 25);
    scope.stop();
    expect(store.streamlineProgress).toBeUndefined();
  }
);

it("skips field preparation when the request is superseded while yielding", async () => {
  const { store, scope, layer } = setupLayer();
  let current = true;
  layer.startLoading();
  const pending = layer.prepareField(() => current);
  current = false;
  layer.startLoading();
  expect(await pending).toBe(false);
  expect(store.streamlineLoadingStage).toBe(STREAMLINE_LOADING_STAGES.DATA);
  expect(store.streamlineProgress).toBeUndefined();
  expect(create).not.toHaveBeenCalled();
  scope.stop();
});

it("clears an incompatibility message when the selection is retried or changed", () => {
  const { store, scope, layer } = setupLayer();
  try {
    layer.clear("U and V have different dimensions.");
    expect(store.streamlineAvailable).toBe(false);
    expect(store.streamlineIncompatibility).toContain("different dimensions");

    layer.startLoading();
    expect(store.streamlineIncompatibility).toBeUndefined();

    layer.clear("U and V have different dimensions.");
    store.setStreamlineSelection({ automatic: false, u: "ua", v: "va" });
    expect(store.streamlineIncompatibility).toBeUndefined();
  } finally {
    scope.stop();
  }
});

it.each([false, true])(
  "keeps the old timestep until its replacement background is ready (current: %s)",
  async (current) => {
    const { store, scope, scene, layer } = setupLayer();
    const makeLayer = () => ({
      dispose: vi.fn(),
      object: new Object3D(),
      updateProjection: vi.fn(),
      setRenderOrder: vi.fn(),
      setOpacity: vi.fn(),
    });
    const oldLayer = makeLayer();
    const nextLayer = makeLayer();
    const field = {} as TStreamlineVectorField;
    const pair = { u: "u", v: "v", kind: "u/v" } as const;
    let finish!: () => void;
    let isCurrent = true;
    const prepareBackground = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    try {
      create.mockResolvedValueOnce(oldLayer).mockResolvedValueOnce(nextLayer);
      await layer.setField(field, pair, () => true);
      const pending = layer.setField(
        field,
        pair,
        () => isCurrent,
        prepareBackground
      );
      await vi.waitFor(() => expect(prepareBackground).toHaveBeenCalledOnce());
      expect(scene.children).toEqual([oldLayer.object]);
      expect(oldLayer.dispose).not.toHaveBeenCalled();
      expect(store.streamlineLoading).toBe(true);

      isCurrent = current;
      finish();
      expect(await pending).toBe(current);
      expect(scene.children).toEqual([
        current ? nextLayer.object : oldLayer.object,
      ]);
      expect(oldLayer.dispose).toHaveBeenCalledTimes(current ? 1 : 0);
      expect(nextLayer.dispose).toHaveBeenCalledTimes(current ? 0 : 1);
    } finally {
      scope.stop();
    }
  }
);
