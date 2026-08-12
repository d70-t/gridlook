import { beforeEach, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
});

const { createPinia, setActivePinia } = await import("pinia");
const { LAND_SEA_MASK_MODES } = await import("@/lib/layers/landSeaMask.ts");
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

it("sets volume layer visibility and selection", () => {
  const store = useGlobeControlStore();

  expect(store.isVolumeLayerEnabled()).toBe(false);
  store.setVolumeSelections([
    { variable: "clw", color: "#ffffff", opacity: 0.8 },
  ]);
  store.setVolumeLayerEnabled(true);
  expect(store.isVolumeLayerEnabled()).toBe(true);
  expect(store.volumeSelections).toEqual([
    { variable: "clw", color: "#ffffff", opacity: 0.8 },
  ]);
  store.setVolumeLayerEnabled(false);
  expect(store.isVolumeLayerEnabled()).toBe(false);
});

it("positions the full land-and-sea mask above the scalar grid", () => {
  const store = useGlobeControlStore();

  store.positionMaskLayerForMode(LAND_SEA_MASK_MODES.LAND_AND_SEA);

  const maskIndex = store.layerStack.findIndex(
    (layer) => layer.id === BUILTIN_LAYER_IDS.MASK
  );
  const gridIndex = store.layerStack.findIndex(
    (layer) => layer.id === BUILTIN_LAYER_IDS.GRID
  );
  expect(maskIndex).toBeLessThan(gridIndex);
});
