import { beforeEach, expect, it, vi } from "vitest";
import { createSSRApp, effectScope } from "vue";
import { renderToString } from "vue/server-renderer";

import { GRID_TYPES } from "@/lib/data/gridTypeDetector.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

vi.stubGlobal("localStorage", { getItem: () => null });
vi.mock("@/lib/data/variableQuery.ts", () => ({
  default: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/ui/common/useLog.ts", () => ({
  useLog: () => ({ logError: vi.fn() }),
}));
vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getGroup: vi.fn().mockResolvedValue({ attrs: {} }),
    getVariableInfo: vi.fn().mockResolvedValue({
      attrs: { units: "m s-1" },
      dtype: "float32",
      chunks: [3],
      shape: [3],
    }),
    getDimensionNames: vi.fn().mockResolvedValue(["cell"]),
  },
}));

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useScalarFieldCache } =
  await import("@/ui/grids/composables/useScalarFieldCache.ts");
const { ZarrDataManager } = await import("@/lib/data/ZarrDataManager.ts");
const { default: InfoPanel } = await import("@/ui/overlays/InfoPanel.vue");

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

const source = { store: "https://example.test/data.zarr", dataset: "" };
const datasources: TSources = {
  ["zarr_format"]: ZARR_FORMAT.V3,
  levels: [
    {
      grid: source,
      time: source,
      datasources: { temperature: source, u: source, v: source },
    },
  ],
};

function renderInfo() {
  return renderToString(
    createSSRApp(InfoPanel, {
      datasources,
      gridType: GRID_TYPES.TRIANGULAR,
      isOpen: true,
    })
  );
}

it.each([
  { standardName: "wind_speed", longName: "Wind speed" },
  { standardName: undefined, longName: "Vector magnitude" },
])(
  "describes displayed $longName and restores the scalar details",
  // eslint-disable-next-line max-lines-per-function
  async (names) => {
    const store = useGlobeControlStore();
    store.varnameSelector = "temperature";
    store.varnameDisplay = "temperature";
    store.setStreamlinePair({ u: "u", v: "v", kind: "u/v" });
    const scope = effectScope();
    const cache = scope.run(() =>
      useScalarFieldCache({
        updateHistogram: vi.fn(),
        updateColormap: vi.fn(),
        redraw: vi.fn(),
      })
    )!;
    cache.captureScalar({
      render: vi.fn(),
      info: {
        attrs: { ["long_name"]: "Air temperature", units: "K" },
        bounds: { low: 280, high: 290 },
        dimInfo: [],
        dimRanges: [],
      },
      indices: [],
      data: new Float32Array([280, 290]),
    });
    try {
      store.setStreamlineMagnitudeDisplayed(true);
      await cache.showMagnitude(
        {
          ...names,
          units: "m s-1",
          data: new Float32Array([5]),
          min: 5,
          max: 5,
        },
        () => vi.fn<() => void>()
      );
      // Pending UI choices must not relabel the frame that is still on screen.
      store.setStreamlinePair({ u: "other_u", v: "other_v", kind: "custom" });
      store.setStreamlineMagnitudeDisplayed(false);
      const magnitudeHtml = await renderInfo();
      expect(magnitudeHtml).toContain(
        `<code>${names.standardName ?? "vector_magnitude"}</code>`
      );
      expect(magnitudeHtml).toContain(names.longName);
      expect(magnitudeHtml).toContain("Derived</span>");
      expect(magnitudeHtml).toContain("√(u² + v²)");
      expect(magnitudeHtml).toContain("<code>u</code> (u)");
      expect(magnitudeHtml).toContain("<code>v</code> (v)");
      expect(magnitudeHtml).toContain("<code>m s-1</code>");
      expect(magnitudeHtml).not.toContain("Air temperature");
      expect(magnitudeHtml).not.toContain("is-selected-variable");
      expect(magnitudeHtml).not.toContain('aria-pressed="true"');
      await vi.waitFor(() =>
        expect(ZarrDataManager.getVariableInfo).toHaveBeenCalledWith(
          source,
          "u"
        )
      );
      expect(ZarrDataManager.getVariableInfo).toHaveBeenCalledOnce();

      await cache.restoreScalar();
      const scalarHtml = await renderInfo();
      expect(scalarHtml).toContain("<code>temperature</code>");
      expect(scalarHtml).toContain("Air temperature");
      expect(scalarHtml).toContain("<code>K</code>");
      expect(scalarHtml).not.toContain("Derived</span>");
      expect(scalarHtml).toContain("is-selected-variable");
      expect(scalarHtml).toContain('aria-label="Visualize temperature"');
    } finally {
      scope.stop();
    }
  }
);
