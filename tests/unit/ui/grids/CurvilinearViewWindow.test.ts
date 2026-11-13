import proj4 from "proj4";
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

// A south polar stereographic pyramid over a 6 000 km square: a fine level
// of 1500 x 1500 cells of 4 km (over the view budget) over a coarse one of
// 100 x 100 cells of 60 km, x ascending and y descending.
const CRS =
  "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs";
const { beforeMount, scene, setHoverLookupFromIndex, fetches, axes } =
  vi.hoisted(() => {
    const axis = (count: number, step: number, descending: boolean) =>
      Float32Array.from({ length: count }, (_, i) =>
        descending ? 3_000_000 - i * step : -3_000_000 + i * step
      );
    return {
      beforeMount: [] as (() => Promise<void>)[],
      scene: { current: undefined as THREE.Scene | undefined },
      setHoverLookupFromIndex: vi.fn(),
      fetches: [] as { dataset: string; selection: TSelection }[],
      axes: {
        fine: { x: axis(1500, 4000, false), y: axis(1500, 4000, true) },
        coarse: { x: axis(100, 60_000, false), y: axis(100, 60_000, true) },
      } as Record<string, Record<string, Float32Array>>,
    };
  });

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
    updateTextureLayers: vi.fn(),
  }),
}));
vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getDimensionNames: async () => ["time", "y", "x"],
    resolveVariablePath: (_variable: string, dimension: string) => dimension,
    getVariableInfo: async (source: TSource, name: string) => {
      const values = axes[source.dataset][name];
      if (!values) {
        throw new Error(`${name} is not in the store`);
      }
      return { shape: [values.length], attrs: {}, dimension: name, source };
    },
    getVariableDataFromArray: async (array: {
      dimension: string;
      source: TSource;
    }) => ({ data: axes[array.source.dataset][array.dimension].slice() }),
    getCRSInfo: async () => ({ attrs: { crs_wkt: CRS } }), // eslint-disable-line camelcase
    getDatasetSource: (sources: TLevelSources, variable: string) =>
      level(sources).datasources[variable],
  },
}));
vi.mock("@/lib/data/variableData.ts", () => ({
  getVariableDatasource: (sources: TLevelSources, variable: string) =>
    level(sources).datasources[variable],
  fetchDataVariable: async (_variable: string, sources: TLevelSources) => {
    const { x, y } = axes[level(sources).grid.dataset];
    return { shape: [3, y.length, x.length], attrs: {} };
  },
}));
vi.mock("@/lib/data/dimensionData.ts", () => ({
  fetchDimensionDetails: async () => [],
}));
vi.mock("@/lib/volume/volumeData.ts", () => ({
  loadProjectedVolumeGrid: async () => undefined,
}));
vi.mock("@/lib/grids/curvilinearWorkerClient.ts", async () => {
  const { buildCurvilinearHoverIndexData } =
    await import("@/lib/grids/curvilinearCalculations.ts");
  return {
    buildCurvilinearHoverIndex: async (
      latitudes: Float32Array,
      longitudes: Float32Array
    ) => buildCurvilinearHoverIndexData(latitudes, longitudes),
    terminateCurvilinearWorker: vi.fn(),
  };
});
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
    const rows = indices(request.selection.at(-2)!, axes[dataset].y.length);
    const columns = indices(request.selection.at(-1)!, axes[dataset].x.length);
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
const { projectedExtent, projectedWindow } =
  await import("@/lib/data/projectedWindow.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: Curvilinear } = await import("@/ui/grids/Curvilinear.vue");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const converter = proj4("EPSG:4326", CRS);
const projection = {
  forward: (lonLat: [number, number]) => converter.forward(lonLat),
  inverse: (xy: [number, number]) => converter.inverse(xy),
};
// The Antarctic Peninsula, seen from above it.
const peninsula = {
  latMin: -70,
  latMax: -65,
  lonStart: -70,
  lonSpan: 10,
  centreLat: -67.5,
  centreLon: -65,
};

function expectedWindow(footprint = peninsula) {
  const { x, y } = axes.fine;
  return projectedWindow(
    { x, y, projection, extent: projectedExtent(x, y, projection) },
    footprint,
    { margin: 0.5, maxCells: DEFAULT_MAX_VIEW_CELLS }
  )!;
}

/** The row and column of the fine cell nearest a lon/lat. */
function fineCell(lon: number, lat: number) {
  const [px, py] = projection.forward([lon, lat]);
  const nearest = (values: Float32Array, value: number) => {
    let best = 0;
    for (let i = 1; i < values.length; i++) {
      if (Math.abs(values[i] - value) < Math.abs(values[best] - value)) {
        best = i;
      }
    }
    return best;
  };
  return { row: nearest(axes.fine.y, py), column: nearest(axes.fine.x, px) };
}

async function mount(footprint = peninsula) {
  beforeMount.length = 0;
  fetches.length = 0;
  setHoverLookupFromIndex.mockClear();
  setActivePinia(createPinia());
  const store = useGlobeControlStore();
  store.varnameSelector = "t";
  store.viewFootprint = { ...footprint };
  scene.current = new THREE.Scene();
  const source = (dataset: string) => ({ store: "s.zarr", dataset });
  const sources = reactive({
    zarr_format: ZARR_FORMAT.V3, // eslint-disable-line camelcase
    selectedLevel: 0,
    levels: ["fine", "coarse"].map((name) => ({
      grid: source(name),
      time: source(name),
      datasources: { t: source(name) },
      resolution: name === "fine" ? 4000 : 40_000,
    })),
  }) as unknown as TSources;
  const scope = effectScope();
  scope.run(() => {
    watch(
      () => store.varinfo?.bounds,
      (bounds) => bounds && store.updateBounds(bounds)
    );
    Curvilinear.setup!(
      { datasources: sources },
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

function textureSize(
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
) {
  const { width, height } = mesh.material.uniforms.data.value.image;
  return { width, height };
}

// eslint-disable-next-line max-lines-per-function
it("loads the window of a large level over the whole coarsest level", async () => {
  const { store, sources, scope } = await mount();

  // one slice of the fine level, the window of the view, and the coarse
  // level whole
  const window = expectedWindow();
  expect(fetched("fine")).toHaveLength(1);
  const [, rows, columns] = fetched("fine")[0].selection;
  expect(rows).toEqual({
    start: window.y.start,
    stop: window.y.end,
    step: null,
  });
  expect(columns).toEqual({
    start: window.x.start,
    stop: window.x.end,
    step: null,
  });
  expect(fetched("coarse")).toHaveLength(1);
  expect(fetched("coarse")[0].selection.slice(-2)).toEqual([null, null]);

  // the level's texture is the window; the coarse level is drawn after it,
  // only where the level left no stencil mark, and supplies the colour range
  const backdrop = meshes().filter((mesh) => mesh.renderOrder > 0);
  const level = meshes().filter((mesh) => mesh.renderOrder === 0);
  expect(backdrop).toHaveLength(1);
  expect(level).toHaveLength(1);
  expect(textureSize(level[0])).toEqual({
    width: window.x.end - window.x.start,
    height: window.y.end - window.y.start,
  });
  expect(textureSize(backdrop[0])).toEqual({ width: 100, height: 100 });
  expect(backdrop[0].material.stencilFunc).toBe(THREE.NotEqualStencilFunc);
  expect(backdrop[0].material.stencilWriteMask).toBe(0);
  expect(level[0].material.stencilZPass).toBe(THREE.ReplaceStencilOp);
  expect(level[0].material.stencilRef).toBe(backdrop[0].material.stencilRef);
  expect(store.varinfo!.bounds.high).toBeLessThan(0);

  // hover reads the fine cell inside the window and nothing outside it,
  // where only the coarse level is on screen
  const { row, column } = fineCell(-65, -67.5);
  expect(hover().findNearest(-67.5, -65)!.value).toBe(row * 10000 + column + 1);
  expect(hover().findNearest(-75, 0)).toBeNull();

  // a move inside the window fetches nothing, a move out of it one window,
  // whose mesh replaces the previous one
  const geometry = level[0].geometry;
  const dispose = vi.spyOn(geometry, "dispose");
  store.viewFootprint = { ...peninsula, lonStart: -69 };
  await wait(40);
  expect(fetched("fine")).toHaveLength(1);
  const moved = { ...peninsula, lonStart: -40, centreLon: -35 };
  store.viewFootprint = moved;
  await wait(40);
  expect(fetched("fine")).toHaveLength(2);
  expect(fetched("fine")[1].selection.at(-1)).toEqual({
    start: expectedWindow(moved).x.start,
    stop: expectedWindow(moved).x.end,
    step: null,
  });
  expect(fetched("coarse")).toHaveLength(1);
  expect(dispose).toHaveBeenCalled();
  expect(meshes().filter((mesh) => mesh.renderOrder === 0)).toHaveLength(1);
  expect(meshes()).not.toContain(level[0]);
  expect(meshes()).toContain(backdrop[0]);

  // a time step reads the coarse data again but keeps its mesh
  store.dimSlidersValues = [1, null, null];
  await wait(60);
  expect(fetched("coarse")).toHaveLength(2);
  expect(fetched("coarse")[1].selection[0]).toBe(1);
  expect(meshes()).toContain(backdrop[0]);
  expect(meshes().filter((mesh) => mesh.renderOrder > 0)).toHaveLength(1);

  // the coarsest level itself is loaded whole, with nothing beneath it
  sources.selectedLevel = 1;
  await wait(40);
  expect(meshes().every((mesh) => mesh.renderOrder === 0)).toBe(true);
  expect(meshes()).toHaveLength(1);
  expect(textureSize(meshes()[0])).toEqual({ width: 100, height: 100 });
  expect(hover().findNearest(-75, 0)!.value).toBeLessThan(0);
  scope.stop();
});

it("loads nothing of a level the view misses, and shows the backdrop", async () => {
  const arctic = {
    latMin: 80,
    latMax: 90,
    lonStart: -180,
    lonSpan: 360,
    centreLat: 85,
    centreLon: 0,
  };
  const { scope } = await mount(arctic);
  expect(fetched("fine")).toHaveLength(0);
  expect(fetched("coarse")).toHaveLength(1);
  expect(meshes()).toHaveLength(1);
  expect(meshes()[0].renderOrder).toBeGreaterThan(0);
  scope.stop();
});
