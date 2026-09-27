import { beforeEach, expect, it, vi } from "vitest";
import { effectScope, inject, nextTick, reactive } from "vue";

import { GRID_TYPES } from "@/lib/data/gridTypeDetector.ts";
import type { TModelInfo } from "@/lib/types/GlobeTypes.ts";
import { SCALAR_BAKE_PHASE } from "@/ui/grids/composables/useScalarBake.ts";

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onBeforeMount: vi.fn(),
  inject: vi.fn(),
  useSSRContext: () => ({}),
}));
vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useUrlParameterStore } = await import("@/store/paramStore.ts");
const { default: Controls } = await import("@/ui/overlays/Controls.vue");
const { showVectorMagnitudeScalarInfo } =
  await import("@/ui/grids/composables/vectorMagnitudeScalar.ts");

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(inject).mockReset();
});

function setupControls() {
  const store = useGlobeControlStore();
  store.varnameSelector = "rlds";
  store.varnameDisplay = "rlds";
  store.varinfo = {
    attrs: { units: "W m-2" },
    bounds: { low: 100, high: 500 },
    dimInfo: [],
    dimRanges: [],
  };
  const params = useUrlParameterStore();
  params.paramBoundLow = "0";
  params.paramBoundHigh = "600";
  const expose = vi.fn();
  const scope = effectScope();
  const controls = scope.run(() =>
    Controls.setup!(
      {
        modelInfo: {
          vars: { rlds: { ["default_range"]: { low: 0, high: 600 } } },
        } as unknown as TModelInfo,
        gridType: GRID_TYPES.TRIANGULAR,
        currentSource: "triangular",
        infoPanelOpen: false,
        onOnSnapshot: undefined,
        onOnRotate: undefined,
        onToggleDisplay: undefined,
        onToggleInfoPanel: undefined,
      },
      { expose, attrs: {}, slots: {}, emit: vi.fn() }
    )
  );
  expose.mock.calls[0][0].initForDataset();
  return {
    store,
    scope,
    controls: controls as unknown as {
      onPickedBoundsModeChange: (mode: string) => void;
    },
  };
}

it("uses magnitude bounds and restores the scalar's custom bounds", async () => {
  const { store, scope } = setupControls();
  try {
    await nextTick();
    expect(store.selection).toEqual({ low: 0, high: 600 });
    store.setStreamlineLayerEnabled(true);
    const magnitude = {
      longName: "Vector magnitude",
      units: "m s-1",
      data: new Float32Array([0.016, 30.074]),
      min: 0.016,
      max: 30.074,
    };
    store.setStreamlineMagnitudeInfo(magnitude, true);
    store.setStreamlineMagnitudeDisplayed(true);
    showVectorMagnitudeScalarInfo(store, magnitude);
    await nextTick();
    expect(store.selection).toEqual({ low: 0.016, high: 30.074 });

    store.setStreamlineMagnitudeDisplayed(false);
    store.varnameDisplay = "rlds";
    store.varinfo!.bounds = { low: 100, high: 500 };
    await nextTick();
    expect(store.selection).toEqual({ low: 0, high: 600 });
  } finally {
    scope.stop();
  }
});

it("applies completed animation bounds only on selection and preserves custom bounds", async () => {
  const bake = reactive({
    phase: SCALAR_BAKE_PHASE.PLANNED as string,
    bounds: { low: -10, high: 900 },
  });
  vi.mocked(inject).mockReturnValue(bake);
  const { store, scope, controls } = setupControls();
  try {
    await nextTick();
    bake.phase = SCALAR_BAKE_PHASE.READY;
    await nextTick();
    expect(store.selection).toEqual({ low: 0, high: 600 });
    controls.onPickedBoundsModeChange("animation");
    await nextTick();
    expect(store.selection).toEqual(bake.bounds);
    store.varinfo!.bounds = { low: 200, high: 400 };
    store.scalarAnimationBounds = { low: 100, high: 500 };
    await nextTick();
    expect(store.selection).toEqual(bake.bounds);
    controls.onPickedBoundsModeChange("user");
    await nextTick();
    expect(store.selection).toEqual({ low: 0, high: 600 });
    controls.onPickedBoundsModeChange("data");
    await nextTick();
    expect(store.selection).toEqual({ low: 200, high: 400 });
    expect(store.scalarAnimationBounds).toBeUndefined();
  } finally {
    scope.stop();
  }
});

it("returns to current data bounds when the bake is cleared and does not apply the next bake automatically", async () => {
  const bake = reactive({
    phase: SCALAR_BAKE_PHASE.READY as string,
    bounds: { low: -10, high: 900 },
  });
  vi.mocked(inject).mockReturnValue(bake);
  const { store, scope, controls } = setupControls();
  try {
    controls.onPickedBoundsModeChange("animation");
    await nextTick();
    expect(store.selection).toEqual(bake.bounds);
    store.scalarAnimationBounds = { ...bake.bounds };
    bake.phase = SCALAR_BAKE_PHASE.EMPTY;
    await nextTick();
    expect(store.selection).toEqual({ low: 100, high: 500 });
    expect(store.scalarAnimationBounds).toBeUndefined();
    bake.bounds = { low: -50, high: 1000 };
    bake.phase = SCALAR_BAKE_PHASE.READY;
    await nextTick();
    expect(store.selection).toEqual({ low: 100, high: 500 });
  } finally {
    scope.stop();
  }
});
