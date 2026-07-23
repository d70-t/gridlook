import { beforeEach, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
});

const { createPinia, setActivePinia } = await import("pinia");
const { BUILTIN_LAYER_IDS, LAYER_OPACITY, useGlobeControlStore } =
  await import("@/store/store.ts");

beforeEach(() => {
  setActivePinia(createPinia());
});

it("defaults layer opacity to opaque and clamps updates", () => {
  const store = useGlobeControlStore();
  const maskLayer = store.layerStack.find(
    (layer) => layer.id === BUILTIN_LAYER_IDS.MASK
  );

  expect(maskLayer?.opacity).toBe(LAYER_OPACITY.MAX);

  store.updateLayerOpacity(BUILTIN_LAYER_IDS.MASK, 0.35);
  expect(maskLayer?.opacity).toBe(0.35);

  store.updateLayerOpacity(BUILTIN_LAYER_IDS.MASK, -0.25);
  expect(maskLayer?.opacity).toBe(LAYER_OPACITY.MIN);

  store.updateLayerOpacity(BUILTIN_LAYER_IDS.MASK, 1.25);
  expect(maskLayer?.opacity).toBe(LAYER_OPACITY.MAX);

  store.addTextureLayer("texture-layer", "Texture layer");
  const textureLayer = store.layerStack.find(
    (layer) => layer.id === "texture-layer"
  );
  expect(textureLayer?.opacity).toBe(LAYER_OPACITY.MAX);

  store.updateLayerOpacity("texture-layer", 0.5);
  expect(textureLayer?.opacity).toBe(0.5);
});

it("sets streamline layer visibility explicitly", () => {
  const store = useGlobeControlStore();

  expect(store.isStreamlineLayerEnabled()).toBe(false);
  store.setStreamlineLayerEnabled(true);
  expect(store.isStreamlineLayerEnabled()).toBe(true);
  store.setStreamlineLayerEnabled(false);
  expect(store.isStreamlineLayerEnabled()).toBe(false);
});
