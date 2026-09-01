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
  expect(store.streamlineMagnitudeDisplayed).toBe(false);
  store.setStreamlineLayerEnabled(true);
  expect(store.isStreamlineLayerEnabled()).toBe(true);
  expect(store.streamlineMagnitudeDisplayed).toBe(true);
  store.setStreamlineLayerEnabled(false);
  expect(store.isStreamlineLayerEnabled()).toBe(false);
  expect(store.streamlineMagnitudeDisplayed).toBe(false);
});

it("switches between the derived vector magnitude and selected scalar", () => {
  const store = useGlobeControlStore();
  store.setStreamlineLayerEnabled(true);

  store.setStreamlineMagnitudeDisplayed(false, true);
  expect(store.streamlineMagnitudeDisplayed).toBe(false);
  expect(store.streamlineScalarRevision).toBe(1);

  store.setStreamlineMagnitudeDisplayed(true, true);
  expect(store.streamlineMagnitudeDisplayed).toBe(true);
  expect(store.streamlineScalarRevision).toBe(2);
});

it("restores a requested magnitude after a transient incompatible pair", () => {
  const store = useGlobeControlStore();
  store.setStreamlineLayerEnabled(true);
  store.varnameSelector = "temperature";
  store.varnameDisplay = "vector_magnitude";

  store.setStreamlineMagnitudeInfo(undefined);
  expect(store.streamlineMagnitudeRequested).toBe(true);
  expect(store.streamlineMagnitudeDisplayed).toBe(false);
  expect(store.streamlineScalarRevision).toBe(1);

  store.setStreamlineMagnitudeInfo(
    { longName: "Vector magnitude", units: "m s-1" },
    true
  );
  expect(store.streamlineMagnitudeDisplayed).toBe(true);
});

it("selects a streamline level and resets it with the vector components", () => {
  const store = useGlobeControlStore();
  store.setStreamlineLevelInfo({
    dimensionName: "level",
    values: [1000, 850, 700],
    units: "hPa",
  });

  store.setStreamlineLevelIndex(2);
  expect(store.streamlineLevelIndex).toBe(2);
  expect(store.streamlineSelectionRevision).toBe(1);

  store.setStreamlineLevelIndex(1, false);
  expect(store.streamlineLevelIndex).toBe(1);
  expect(store.streamlineSelectionRevision).toBe(1);

  store.setStreamlineSelection({ automatic: false, u: "ua", v: "va" });
  expect(store.streamlineLevelIndex).toBe(0);
  expect(store.streamlineLevelInfo).toBeUndefined();
});
