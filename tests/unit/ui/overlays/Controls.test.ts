import { beforeEach, expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";

import { GRID_TYPES } from "@/lib/data/gridTypeDetector.ts";
import type { TModelInfo } from "@/lib/types/GlobeTypes.ts";

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onBeforeMount: vi.fn(),
  useSSRContext: () => ({}),
}));
vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useUrlParameterStore } = await import("@/store/paramStore.ts");
const { default: Controls } = await import("@/ui/overlays/Controls.vue");
const { showVectorMagnitudeScalarInfo } =
  await import("@/ui/grids/composables/vectorMagnitudeScalar.ts");

beforeEach(() => setActivePinia(createPinia()));

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
  scope.run(() =>
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
  return { store, scope };
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
