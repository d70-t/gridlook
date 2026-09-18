import * as THREE from "three";
import { expect, it, vi } from "vitest";
import { effectScope, watch } from "vue";

import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import type { TGeoSampleIndex } from "@/ui/grids/composables/gridHoverUtils.ts";

const { beforeMount, scene, logError, grid, setHoverLookupFromIndex } =
  vi.hoisted(() => ({
    beforeMount: [] as (() => Promise<void>)[],
    scene: { current: undefined as THREE.Scene | undefined },
    logError: vi.fn(),
    grid: { rotated: false },
    setHoverLookupFromIndex: vi.fn(),
  }));

vi.stubGlobal("localStorage", { getItem: () => null });
vi.mock("vue", async (original) => ({
  ...(await original<typeof import("vue")>()),
  onBeforeMount: (callback: () => Promise<void>) => beforeMount.push(callback),
  onBeforeUnmount: vi.fn(),
  useSSRContext: () => ({}),
}));
vi.mock("@/ui/common/useLog.ts", () => ({ useLog: () => ({ logError }) }));
vi.mock("@/ui/grids/composables/gridHoverUtils.ts", () => ({
  useGridHoverLookup: () => ({
    clearHoverLookup: vi.fn(),
    setHoverLookupFromIndex,
  }),
}));
vi.mock("@/ui/grids/composables/useGridCameraState.ts", () => ({
  useGridCameraState: vi.fn(),
}));
vi.mock("@/ui/grids/composables/useGridScene.ts", async () => {
  const { ref } = await import("vue");
  return {
    useGridScene: () => ({
      getScene: () => scene.current,
      getRenderer: () => undefined,
      redraw: vi.fn(),
      fitCameraToDataset: vi.fn(),
      hoveredGeoPoint: ref(null),
    }),
  };
});
vi.mock("@/ui/grids/composables/useGridOverlays.ts", () => ({
  getLayerRenderOrder: () => 0,
  useGridOverlays: () => ({
    updateLandSeaMask: vi.fn(),
    updateTextureLayers: vi.fn(),
  }),
}));
vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getDimensionNames: async () =>
      grid.rotated
        ? ["time", "rlat", "rlon"]
        : ["time", "latitude", "longitude"],
    resolveVariablePath: (_variable: string, dimension: string) => dimension,
    getVariableInfo: async (_source: unknown, dimension: string) => ({
      shape: [2],
      attrs: {},
      dimension,
    }),
    getVariableDataFromArray: async ({ dimension }: { dimension: string }) => ({
      data: new Float32Array(
        grid.rotated
          ? dimension === "rlat"
            ? [-23.375, 21.835]
            : [-28.375, 18.155]
          : dimension === "latitude"
            ? [20.25, 20]
            : [-80, -79.75]
      ),
    }),
    getCRSInfo: async () => ({
      attrs: {
        ["grid_mapping_name"]: "rotated_latitude_longitude",
        ["grid_north_pole_latitude"]: "39.25",
        ["grid_north_pole_longitude"]: "-162.0",
      },
    }),
    getDatasetSource: (sources: TSources, variable: string) =>
      sources.levels[0].datasources[variable],
  },
}));
vi.mock("@/lib/data/variableData.ts", () => ({
  getVariableDatasource: (sources: TSources, variable: string) =>
    sources.levels[0].datasources[variable],
  fetchDataVariable: async () => ({
    shape: [96, 2, 2],
    attrs: { units: "Pa" },
  }),
}));
vi.mock("@/lib/data/dimensionData.ts", () => ({
  fetchDimensionDetails: async () => [],
}));
vi.mock("@/lib/grids/gridDataWorkerClient.ts", () => ({
  getGridVariableData: async () =>
    new Float32Array([98000, 99000, 100000, 101000]),
  terminateGridDataWorker: vi.fn(),
}));

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: Regular } = await import("@/ui/grids/Regular.vue");
const source = { store: "regional.zarr", dataset: "" };

it.each([false, true])(
  "renders a regional scalar frame (rotated: %s) when its bounds update the colormap",
  async (rotated) => {
    grid.rotated = rotated;
    beforeMount.length = 0;
    logError.mockClear();
    setActivePinia(createPinia());
    const store = useGlobeControlStore();
    store.varnameSelector = "surface_pressure";
    scene.current = new THREE.Scene();
    const scope = effectScope();
    scope.run(() => {
      // The bounds controls react before the staged frame's nextTick completes.
      watch(
        () => store.varinfo?.bounds,
        (bounds) => bounds && store.updateBounds(bounds)
      );
      Regular.setup!(
        {
          datasources: {
            ["zarr_format"]: ZARR_FORMAT.V3,
            levels: [
              {
                grid: source,
                time: source,
                datasources: { ["surface_pressure"]: source },
              },
            ],
          },
          isRotated: rotated,
        },
        { expose: vi.fn(), attrs: {}, slots: {}, emit: vi.fn() }
      );
    });
    try {
      await beforeMount[0]();
      expect(logError).not.toHaveBeenCalled();
      const mesh = scene.current.children[0] as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.ShaderMaterial
      >;
      expect(mesh.visible).toBe(true);
      expect(mesh.material.uniforms.data.value.image.data).toEqual(
        new Float32Array([98000, 99000, 100000, 101000])
      );
      expect(store.loading).toBe(false);
      if (rotated) {
        expectRotatedCoordinates(mesh.geometry);
      }
    } finally {
      scope.stop();
    }
  }
);

function expectRotatedCoordinates(geometry: THREE.BufferGeometry) {
  const coordinates = geometry.getAttribute("latLon");
  const hover = setHoverLookupFromIndex.mock.lastCall![0] as TGeoSampleIndex;
  // Geographic corners stored in the local PIK-STARS3 dataset.
  const expected = [
    [21.98782875683831, -10.063879662216031],
    [25.1142623886123, 36.41382968450823],
    [60.203763369090005, -44.59386389190011],
    [66.68983654206978, 64.96437666717895],
  ];
  expected.forEach(([lat, lon], index) => {
    expect(coordinates.getX(index)).toBeCloseTo(lat, 4);
    expect(coordinates.getY(index)).toBeCloseTo(lon, 4);
    expect(hover.findNearest(lat, lon)?.value).toBe(98000 + index * 1000);
  });
}
