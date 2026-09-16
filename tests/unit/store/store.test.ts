import { beforeEach, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
});

const { createPinia, setActivePinia } = await import("pinia");
const {
  BUILTIN_LAYER_IDS,
  BUILTIN_LAYER_NAMES,
  LAYER_KINDS,
  LAYER_OPACITY,
  useGlobeControlStore,
} = await import("@/store/store.ts");

beforeEach(() => {
  setActivePinia(createPinia());
});

it("starts with only coastlines and the active data grid", () => {
  const store = useGlobeControlStore();

  expect(store.layerStack.map((layer) => layer.id)).toEqual([
    BUILTIN_LAYER_IDS.COASTLINES,
    BUILTIN_LAYER_IDS.GRID,
  ]);
});

it("defaults layer opacity to opaque and clamps updates", () => {
  const store = useGlobeControlStore();
  store.restoreBuiltinLayer(LAYER_KINDS.MASK);
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

it("stores active data layer visibility and opacity", () => {
  const store = useGlobeControlStore();
  const gridLayer = store.layerStack.find(
    (layer) => layer.id === BUILTIN_LAYER_IDS.GRID
  );

  expect(gridLayer?.visible).toBe(true);
  store.toggleLayerVisibility(BUILTIN_LAYER_IDS.GRID);
  store.updateLayerOpacity(BUILTIN_LAYER_IDS.GRID, 0.4);

  expect(gridLayer?.visible).toBe(false);
  expect(gridLayer?.opacity).toBe(0.4);
});

it("removes and restores built-in layers", () => {
  const store = useGlobeControlStore();

  expect(
    store.layerStack.some((layer) => layer.id === BUILTIN_LAYER_IDS.MASK)
  ).toBe(false);

  store.restoreBuiltinLayer(LAYER_KINDS.MASK);
  expect(store.layerStack[0]?.id).toBe(BUILTIN_LAYER_IDS.MASK);
  expect(store.layerStack[0]?.name).toBe(BUILTIN_LAYER_NAMES[LAYER_KINDS.MASK]);
  expect(store.layerStack[0]?.visible).toBe(true);
  expect(store.layerStack[0]?.opacity).toBe(LAYER_OPACITY.MAX);

  store.restoreBuiltinLayer(LAYER_KINDS.MASK);
  expect(
    store.layerStack.filter((layer) => layer.id === BUILTIN_LAYER_IDS.MASK)
  ).toHaveLength(1);
});
