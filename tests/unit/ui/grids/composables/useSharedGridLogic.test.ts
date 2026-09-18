import { beforeEach, expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";

const { updateLandSeaMask } = vi.hoisted(() => ({
  updateLandSeaMask: vi.fn(),
}));

vi.mock("@/ui/grids/composables/useGridScene.ts", () => ({
  useGridScene: () => ({}),
}));

vi.mock("@/ui/grids/composables/useGridOverlays.ts", () => ({
  useGridOverlays: () => ({
    updateLandSeaMask,
    updateTextureLayers: vi.fn(),
  }),
}));

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { LAND_SEA_MASK_MODES } = await import("@/lib/layers/landSeaMask.ts");
const { BUILTIN_LAYER_IDS, LAYER_KINDS, useGlobeControlStore } =
  await import("@/store/store.ts");
const { useSharedGridLogic } =
  await import("@/ui/grids/composables/useSharedGridLogic.ts");

beforeEach(() => {
  setActivePinia(createPinia());
  updateLandSeaMask.mockClear();
});

it.each([0, 2])(
  "preserves mask position %i when initializing a grid in Globe mode",
  (position) => {
    const store = useGlobeControlStore();
    store.restoreBuiltinLayer(LAYER_KINDS.MASK);
    store.moveLayer(BUILTIN_LAYER_IDS.MASK, position);
    store.landSeaMaskChoice = LAND_SEA_MASK_MODES.GLOBE;
    const order = store.layerStack.map((layer) => layer.id);
    const scope = effectScope();
    try {
      scope.run(() => useSharedGridLogic());
      expect(store.layerStack.map((layer) => layer.id)).toEqual(order);
    } finally {
      scope.stop();
    }
  }
);

it.each([0, 2])(
  "updates the mask without changing layer position %i",
  async (position) => {
    const store = useGlobeControlStore();
    const scope = effectScope();
    try {
      scope.run(() => useSharedGridLogic());
      store.restoreBuiltinLayer(LAYER_KINDS.MASK);
      store.moveLayer(BUILTIN_LAYER_IDS.MASK, position);
      const order = store.layerStack.map((layer) => layer.id);

      for (const mode of [
        LAND_SEA_MASK_MODES.GLOBE,
        LAND_SEA_MASK_MODES.LAND,
        LAND_SEA_MASK_MODES.SEA,
        LAND_SEA_MASK_MODES.OFF,
        LAND_SEA_MASK_MODES.GLOBE,
      ]) {
        updateLandSeaMask.mockClear();
        store.landSeaMaskChoice = mode;
        await nextTick();
        expect(updateLandSeaMask).toHaveBeenCalledOnce();
        expect(store.layerStack.map((layer) => layer.id)).toEqual(order);
      }

      updateLandSeaMask.mockClear();
      store.landSeaMaskUseTexture = !store.landSeaMaskUseTexture;
      await nextTick();
      expect(updateLandSeaMask).toHaveBeenCalledOnce();
      expect(store.layerStack.map((layer) => layer.id)).toEqual(order);
    } finally {
      scope.stop();
    }
  }
);
