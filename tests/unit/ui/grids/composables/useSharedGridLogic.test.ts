import * as THREE from "three";
import { beforeEach, expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";

const { updateLandSeaMask } = vi.hoisted(() => ({
  updateLandSeaMask: vi.fn(),
}));

vi.mock("@/ui/grids/composables/useGridScene.ts", () => ({
  useGridScene: () => ({ redraw: vi.fn() }),
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

it("updates scalar appearance uniforms without invalidating the shader program", () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      colormap: { value: 0 },
      addOffset: { value: 0 },
      scaleFactor: { value: 1 },
      posterizeLevels: { value: 0 },
      hideBelowValue: { value: 0 },
      hideAboveValue: { value: 0 },
    },
  });
  try {
    const logic = scope.run(() => useSharedGridLogic())!;
    store.selection = { low: -5, high: 5 };
    store.posterizeLevels = 4;
    store.hideLowerBound = true;
    store.hideUpperBound = true;
    const version = material.version;
    logic.updateColormap([
      new THREE.Mesh(new THREE.BufferGeometry(), material),
    ]);
    expect(material.uniforms.addOffset.value).toBe(0.5);
    expect(material.uniforms.scaleFactor.value).toBe(0.1);
    expect(material.uniforms.posterizeLevels.value).toBe(4);
    expect(material.uniforms.hideBelowValue.value).toBe(-5);
    expect(material.uniforms.hideAboveValue.value).toBe(5);
    expect(material.version).toBe(version);
  } finally {
    scope.stop();
  }
});
