import * as THREE from "three";
import { expect, it, vi } from "vitest";
import { effectScope, watch } from "vue";

import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

const { beforeMount, scene, logError } = vi.hoisted(() => ({
  beforeMount: [] as (() => Promise<void>)[],
  scene: { current: undefined as THREE.Scene | undefined },
  logError: vi.fn(),
}));

vi.stubGlobal("localStorage", { getItem: () => null });
vi.mock("vue", async (original) => ({
  ...(await original<typeof import("vue")>()),
  onBeforeMount: (callback: () => Promise<void>) => beforeMount.push(callback),
  onBeforeUnmount: vi.fn(),
  useSSRContext: () => ({}),
}));
vi.mock("@/ui/common/useLog.ts", () => ({ useLog: () => ({ logError }) }));
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
    getDimensionNames: async () => ["time", "latitude", "longitude"],
    resolveVariablePath: (_variable: string, dimension: string) => dimension,
    getVariableData: async (_source: unknown, dimension: string) => ({
      data: new Float32Array(
        dimension === "latitude" ? [20.25, 20] : [-80, -79.75]
      ),
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

it("renders the first regional scalar frame when its bounds update the colormap", async () => {
  setActivePinia(createPinia());
  const store = useGlobeControlStore();
  store.varnameSelector = "surface_pressure";
  scene.current = new THREE.Scene();
  const source = { store: "regional.zarr", dataset: "" };
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
        isRotated: false,
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
  } finally {
    scope.stop();
  }
});
