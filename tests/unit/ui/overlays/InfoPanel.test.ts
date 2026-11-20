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
    resolveVariablePath: (_variable: string, dimension: string) => dimension,
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

it("shows the attributes of every group from the root to the level", async () => {
  const store = useGlobeControlStore();
  store.varnameSelector = "multiscales/zoom_0/pr";
  store.varnameDisplay = "multiscales/zoom_0/pr";
  const pyramid: TSources = {
    ["zarr_format"]: ZARR_FORMAT.V2,
    levels: [
      {
        path: "multiscales/zoom_0",
        grid: source,
        time: source,
        datasources: { "multiscales/zoom_0/pr": source },
      },
    ],
  };
  const render = () =>
    renderToString(
      createSSRApp(InfoPanel, {
        datasources: pyramid,
        gridType: GRID_TYPES.HEALPIX,
        isOpen: true,
      })
    );
  await render();
  await vi.waitFor(() =>
    expect(ZarrDataManager.getGroup).toHaveBeenCalledTimes(3)
  );
  expect(
    vi.mocked(ZarrDataManager.getGroup).mock.calls.map(([, path]) => path)
  ).toEqual(["", "multiscales", "multiscales/zoom_0"]);
});

const browseHtml = (html: string) =>
  html.slice(html.indexOf("Variables <span"));

it("lists every level of a pyramid and greys out the levels not shown", async () => {
  const store = useGlobeControlStore();
  store.varnameSelector = "8000m/acabf";
  store.varnameDisplay = "8000m/acabf";
  const level = (path: string, resolution: number, cellCount: number) => ({
    name: path,
    path,
    grid: source,
    time: source,
    resolution,
    cellCount,
    datasources: {
      [`${path}/acabf`]: { ...source, dtype: "float32", attrs: { units: "m" } },
      [`${path}/time`]: { ...source, hidden: true },
      // an array next to the pyramid is in every level's list
      mask: source,
    },
  });
  const pyramid: TSources = {
    ["zarr_format"]: ZARR_FORMAT.V3,
    levels: [level("2000m", 2000, 1_250_000), level("8000m", 8000, 78_125)],
    selectedLevel: 1,
  };
  const html = browseHtml(
    await renderToString(
      createSSRApp(InfoPanel, {
        datasources: pyramid,
        gridType: GRID_TYPES.REGULAR_ROTATED,
        isOpen: true,
      })
    )
  );
  // one group per level, the level shown first and open, the others closed
  // and sorted by name as groups are
  const groups = [...html.matchAll(/class="group-name"[^>]*>([^<]+)</g)].map(
    (match) => match[1].trim()
  );
  expect(groups).toEqual(["8000m", "/", "2000m"]);
  expect(html).toContain("(5)");
  expect(html).toContain("8 km · 78.1K cells");
  expect(html).toContain("2 km · 1.25M cells");
  expect(html.match(/current level/g)).toHaveLength(1);
  expect(html).toMatch(/8000m[\s\S]*current level[\s\S]*2000m/);
  expect(html).toMatch(/aria-label="Visualize 8000m\/acabf"(?![^>]*disabled)/);
  expect(html).not.toContain('title="2000m/acabf"');
  expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?2000m/);
});

it("shows a single-level dataset without level groups", async () => {
  const store = useGlobeControlStore();
  store.varnameSelector = "temperature";
  store.varnameDisplay = "temperature";
  const loaded = { ...source, dtype: "float32", attrs: {} };
  const single: TSources = {
    ["zarr_format"]: ZARR_FORMAT.V3,
    levels: [
      {
        grid: source,
        time: source,
        datasources: { temperature: loaded, u: loaded, v: loaded },
      },
    ],
  };
  const html = browseHtml(
    await renderToString(
      createSSRApp(InfoPanel, {
        datasources: single,
        gridType: GRID_TYPES.TRIANGULAR,
        isOpen: true,
      })
    )
  );
  expect(html).toContain("(3)");
  expect(html).not.toContain("variable-group-toggle");
  expect(html).not.toContain("current level");
  expect(html).not.toContain("cells");
  expect(html).toMatch(/aria-label="Visualize temperature"(?![^>]*disabled)/);
  expect(html).toMatch(/aria-label="Visualize u"(?![^>]*disabled)/);
});
