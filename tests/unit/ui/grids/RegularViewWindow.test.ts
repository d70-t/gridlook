import * as THREE from "three";
import { expect, it, vi } from "vitest";
import { effectScope, reactive, watch } from "vue";

import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import type { TGeoSampleIndex } from "@/ui/grids/composables/gridHoverUtils.ts";

type TSelection = (null | {
  start: number;
  stop: number;
  step: number | null;
})[];
type TSource = { dataset: string };
type TLevelSources = {
  levels: { datasources: Record<string, TSource>; grid: TSource }[];
  selectedLevel?: number;
};

// A fine level of 900 x 1800 cells (0.2 degrees, longitudes 0..360) over a
// coarse one of 9 x 18: the fine level is over the view budget.
const { beforeMount, scene, setHoverLookupFromIndex, fetches, axes } =
  vi.hoisted(() => ({
    beforeMount: [] as (() => Promise<void>)[],
    scene: { current: undefined as THREE.Scene | undefined },
    setHoverLookupFromIndex: vi.fn(),
    fetches: [] as { dataset: string; selection: TSelection }[],
    axes: {
      fine: {
        latitude: Float32Array.from({ length: 900 }, (_, i) => -89.9 + 0.2 * i),
        longitude: Float32Array.from({ length: 1800 }, (_, i) => 0.2 * i),
      },
      coarse: {
        latitude: Float32Array.from({ length: 9 }, (_, i) => -80 + 20 * i),
        longitude: Float32Array.from({ length: 18 }, (_, i) => 20 * i),
      },
    } as Record<string, Record<string, Float32Array>>,
  }));

const level = (sources: TLevelSources) =>
  sources.levels[sources.selectedLevel ?? 0];

vi.stubGlobal("localStorage", { getItem: () => null });
vi.mock("vue", async (original) => ({
  ...(await original<typeof import("vue")>()),
  onBeforeMount: (callback: () => Promise<void>) => beforeMount.push(callback),
  onBeforeUnmount: vi.fn(),
  useSSRContext: () => ({}),
}));
vi.mock("@/ui/common/useLog.ts", () => ({
  useLog: () => ({ logError: vi.fn() }),
}));
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
    getDimensionNames: async () => ["time", "latitude", "longitude"],
    resolveVariablePath: (_variable: string, dimension: string) => dimension,
    getVariableInfo: async (source: TSource, dimension: string) => ({
      shape: [axes[source.dataset][dimension].length],
      attrs: {},
      dimension,
      source,
    }),
    getVariableDataFromArray: async (array: {
      dimension: string;
      source: TSource;
    }) => ({ data: axes[array.source.dataset][array.dimension].slice() }),
    getDatasetSource: (sources: TLevelSources, variable: string) =>
      level(sources).datasources[variable],
  },
}));
vi.mock("@/lib/data/variableData.ts", () => ({
  getVariableDatasource: (sources: TLevelSources, variable: string) =>
    level(sources).datasources[variable],
  fetchDataVariable: async (_variable: string, sources: TLevelSources) => {
    const { latitude, longitude } = axes[level(sources).grid.dataset];
    return { shape: [3, latitude.length, longitude.length], attrs: {} };
  },
}));
vi.mock("@/lib/data/dimensionData.ts", () => ({
  fetchDimensionDetails: async () => [],
}));
// A cell's value names its row and column; the coarse level is negative.
vi.mock("@/lib/grids/gridDataWorkerClient.ts", () => ({
  getGridVariableData: async (request: {
    source: TSource;
    selection: TSelection;
  }) => {
    const { dataset } = request.source;
    fetches.push({ dataset, selection: request.selection });
    const indices = (entry: TSelection[number], count: number) => {
      const picked: number[] = [];
      const stop = entry?.stop ?? count;
      for (let i = entry?.start ?? 0; i < stop; i += entry?.step ?? 1) {
        picked.push(i);
      }
      return picked;
    };
    const rows = indices(
      request.selection.at(-2)!,
      axes[dataset].latitude.length
    );
    const columns = indices(
      request.selection.at(-1)!,
      axes[dataset].longitude.length
    );
    const values = new Float32Array(rows.length * columns.length);
    for (const [i, row] of rows.entries()) {
      for (const [j, column] of columns.entries()) {
        values[i * columns.length + j] =
          (dataset === "fine" ? 1 : -1) * (row * 10000 + column + 1);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    return values;
  },
  terminateGridDataWorker: vi.fn(),
}));

const { createPinia, setActivePinia } = await import("pinia");
const { DEFAULT_MAX_VIEW_CELLS } = await import("@/lib/data/levels.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: Regular } = await import("@/ui/grids/Regular.vue");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const centre = { centreLat: 0, centreLon: 0 };

async function mount(footprint: {
  latMin: number;
  latMax: number;
  lonStart: number;
  lonSpan: number;
}) {
  beforeMount.length = 0;
  fetches.length = 0;
  setHoverLookupFromIndex.mockClear();
  setActivePinia(createPinia());
  const store = useGlobeControlStore();
  store.varnameSelector = "t";
  store.viewFootprint = { ...footprint, ...centre };
  scene.current = new THREE.Scene();
  const source = (dataset: string) => ({ store: "s.zarr", dataset });
  const sources = reactive({
    zarr_format: ZARR_FORMAT.V3, // eslint-disable-line camelcase
    selectedLevel: 0,
    levels: ["fine", "coarse"].map((name) => ({
      grid: source(name),
      time: source(name),
      datasources: { t: source(name) },
      resolution: name === "fine" ? 22_000 : 2_200_000,
    })),
  }) as unknown as TSources;
  const scope = effectScope();
  scope.run(() => {
    watch(
      () => store.varinfo?.bounds,
      (bounds) => bounds && store.updateBounds(bounds)
    );
    Regular.setup!(
      { datasources: sources, isRotated: false },
      { expose: vi.fn(), attrs: {}, slots: {}, emit: vi.fn() }
    );
  });
  await beforeMount[0]();
  return { store, sources, scope };
}

function meshes() {
  return scene.current!.children as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.ShaderMaterial
  >[];
}

function fetched(dataset: string) {
  return fetches.filter((fetch) => fetch.dataset === dataset);
}

function hover() {
  return setHoverLookupFromIndex.mock.lastCall![0] as TGeoSampleIndex;
}

it("loads the view window of a large level over the whole coarsest level", async () => {
  const { store, sources, scope } = await mount({
    latMin: 10,
    latMax: 20,
    lonStart: 30,
    lonSpan: 10,
  });

  // one slice of the fine level, within the budget, and the coarse level whole
  expect(fetched("fine")).toHaveLength(1);
  const [, rows, columns] = fetched("fine")[0].selection;
  expect(rows!.start).toBeGreaterThan(0);
  expect(columns!.start).toBeGreaterThan(0);
  expect(
    (rows!.stop - rows!.start) * (columns!.stop - columns!.start)
  ).toBeLessThanOrEqual(DEFAULT_MAX_VIEW_CELLS);
  expect(fetched("coarse")).toHaveLength(1);
  expect(fetched("coarse")[0].selection.slice(-2)).toEqual([null, null]);

  // the coarse level is drawn first and supplies the colour range
  const backdrop = meshes().filter((mesh) => mesh.renderOrder === -0.5);
  const level = meshes().filter((mesh) => mesh.renderOrder === 0);
  expect(backdrop).toHaveLength(1);
  expect(level.length).toBeGreaterThan(0);
  expect(level[0].material.depthFunc).toBe(THREE.AlwaysDepth);
  expect(store.varinfo!.bounds.high).toBeLessThan(0);

  // hover reads the fine cell inside the window and nothing outside it
  const inside = hover().findNearest(15, 35)!;
  expect(inside.lat).toBeCloseTo(15.1, 1);
  expect(inside.lon).toBeCloseTo(35, 1);
  expect(inside.value).toBe(525 * 10000 + 175 + 1);
  expect(hover().findNearest(-60, 200)).toBeNull();

  // a move inside the window fetches nothing, a move out of it one window
  store.viewFootprint = { ...store.viewFootprint!, lonStart: 31 };
  await wait(40);
  expect(fetched("fine")).toHaveLength(1);
  store.viewFootprint = { ...store.viewFootprint!, lonStart: 100 };
  await wait(40);
  expect(fetched("fine")).toHaveLength(2);
  expect(fetched("coarse")).toHaveLength(1);
  expect(hover().findNearest(15, 105)!.value).toBe(525 * 10000 + 525 + 1);

  // the coarsest level itself is loaded whole, with nothing beneath it
  sources.selectedLevel = 1;
  await wait(40);
  expect(meshes().every((mesh) => mesh.renderOrder === 0)).toBe(true);
  expect(meshes()[0].material.depthFunc).toBe(THREE.LessEqualDepth);
  expect(hover().findNearest(-60, 200)!.value).toBe(-(1 * 10000 + 10 + 1));
  scope.stop();
});

it("stitches a window across the seam of the longitude axis", async () => {
  const { scope } = await mount({
    latMin: 0,
    latMax: 5,
    lonStart: -5,
    lonSpan: 10,
  });
  // two slices: the west part ends at the seam, the east part starts there
  expect(fetched("fine")).toHaveLength(2);
  const [west, east] = fetched("fine").map((fetch) => fetch.selection.at(-1)!);
  expect(west.stop).toBe(1800);
  expect(east.start).toBe(0);
  // either side of the seam reads its own column
  const row = 450;
  expect(hover().findNearest(0.1, 359)!.value).toBe(row * 10000 + 1795 + 1);
  expect(hover().findNearest(0.1, 1)!.value).toBe(row * 10000 + 5 + 1);
  scope.stop();
});
