import * as THREE from "three";
import { expect, it, vi } from "vitest";
import { effectScope, watch } from "vue";

import { checkScalarInterpolation } from "./scalarInterpolationAssertions.ts";

import type { TGridDataRequest } from "@/lib/grids/gridDataWorkerClient.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import type { TGeoSampleIndex } from "@/ui/grids/composables/gridHoverUtils.ts";
import {
  useScalarBake,
  SCALAR_BAKE_PHASE,
} from "@/ui/grids/composables/useScalarBake.ts";
import type { useScalarFrames } from "@/ui/grids/composables/useScalarFrames.ts";

const { beforeMount, scene, logError, grid, setHoverLookupFromIndex } =
  vi.hoisted(() => ({
    beforeMount: [] as (() => Promise<void>)[],
    scene: { current: undefined as THREE.Scene | undefined },
    logError: vi.fn(),
    grid: { rotated: false, projected: false, latitudeOnly: false },
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
vi.mock("@/ui/grids/composables/gridHoverUtils.ts", async (original) => ({
  ...(await original<
    typeof import("@/ui/grids/composables/gridHoverUtils.ts")
  >()),
  useGridHoverLookup: () => ({
    clearHoverLookup: vi.fn(),
    setHoverLookup: vi.fn(),
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
      grid.projected
        ? ["time", "y", "x"]
        : grid.latitudeOnly
          ? ["time", "latitude"]
          : grid.rotated
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
        grid.projected
          ? dimension === "y"
            ? [111325.1428663851, 0]
            : [0, 111319.49079327357]
          : grid.rotated
            ? dimension === "rlat"
              ? [-23.375, 21.835]
              : [-28.375, 18.155]
            : dimension === "latitude"
              ? [20.25, 20]
              : [-80, -79.75]
      ),
    }),
    getVariableData: async () => ({ data: new Float32Array([20.25, 20]) }),
    getCRSInfo: async () => ({
      attrs: grid.projected
        ? { ["spatial_ref"]: "EPSG:3857" }
        : {
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
    shape: grid.latitudeOnly ? [96, 2] : [96, 2, 2],
    chunks: grid.latitudeOnly ? [1, 2] : [1, 2, 2],
    dtype: "float32",
    attrs: { units: "Pa" },
  }),
}));
vi.mock("@/lib/data/dimensionData.ts", () => ({
  fetchDimensionDetails: async () => [
    {
      current: 0,
      values: [0, 2, 5, 8],
      attrs: { units: "days since 2000-01-01" },
    },
  ],
}));
vi.mock("@/lib/grids/gridDataWorkerClient.ts", () => ({
  getGridVariableData: vi.fn(async ({ selection }: TGridDataRequest) =>
    Float32Array.from(
      { length: grid.latitudeOnly ? 2 : 4 },
      (_, index) => 98000 + index * 1000 + Number(selection[0]) * 100
    )
  ),
  terminateGridDataWorker: vi.fn(),
}));

const { getGridVariableData } =
  await import("@/lib/grids/gridDataWorkerClient.ts");
const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: Regular } = await import("@/ui/grids/Regular.vue");
const source = { store: "regional.zarr", dataset: "" };

it.each([
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [false, false, true],
])(
  "renders scalar timesteps (rotated: %s, projected: %s, latitude-only: %s)",
  // eslint-disable-next-line max-lines-per-function
  async (rotated, projected, latitudeOnly) => {
    Object.assign(grid, { rotated, projected, latitudeOnly });
    beforeMount.length = 0;
    logError.mockClear();
    setActivePinia(createPinia());
    const store = useGlobeControlStore();
    store.varnameSelector = "surface_pressure";
    scene.current = new THREE.Scene();
    const scope = effectScope();
    const expose = vi.fn();
    scope.run(() => {
      // The bounds controls react before the staged frame's nextTick completes.
      watch(
        () => store.varinfo?.bounds,
        (bounds) =>
          bounds && store.updateBounds(store.scalarAnimationBounds ?? bounds)
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
        { expose, attrs: {}, slots: {}, emit: vi.fn() }
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
      if (rotated) {
        expectRotatedCoordinates(mesh.geometry);
      }
      if (projected) {
        expectProjectedCoordinates(mesh.geometry);
      }
      await expectScalarTimesteps(store, mesh, latitudeOnly);
      const api = expose.mock.lastCall![0];
      await expectPreparedFrames(api, store, mesh);
      const bake = scope.run(() => useScalarBake(() => api))!;
      await expectBakedFrames(bake, store, mesh);
    } finally {
      scope.stop();
    }
  }
);

async function expectScalarTimesteps(
  store: ReturnType<typeof useGlobeControlStore>,
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>,
  latitudeOnly: boolean
) {
  const expected = latitudeOnly
    ? new Float32Array(720).fill(98000, 0, 360).fill(99000, 360)
    : new Float32Array([98000, 99000, 100000, 101000]);
  expect(store.loading).toBe(false);
  const firstData = mesh.material.uniforms.data.value.image.data;
  expect(firstData).toEqual(expected);
  expect(mesh.material.uniforms.data.value.image.width).toBe(
    latitudeOnly ? 360 : 2
  );
  expect(mesh.material.uniforms.data.value.image.height).toBe(2);
  for (const time of [1, 0]) {
    store.dimSlidersValues[0] = time;
    await vi.waitFor(() => {
      expect(store.dimSlidersDisplay[0]).toBe(time);
      expect(mesh.material.uniforms.data.value.image.data).toEqual(
        Float32Array.from(expected, (value) => value + time * 100)
      );
      expect(store.loading).toBe(false);
    });
    expect(logError).not.toHaveBeenCalled();
    expect(firstData).toEqual(expected);
  }
}

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

function expectProjectedCoordinates(geometry: THREE.BufferGeometry) {
  const coordinates = geometry.getAttribute("latLon");
  const hover = setHoverLookupFromIndex.mock.lastCall![0] as TGeoSampleIndex;
  // Geographic corners of the 0..1 degree Web Mercator square, south first.
  const expected = [
    [0, 0, 100000],
    [0, 1, 101000],
    [1, 0, 98000],
    [1, 1, 99000],
  ];
  expected.forEach(([lat, lon, value], index) => {
    expect(coordinates.getX(index)).toBeCloseTo(lat, 4);
    expect(coordinates.getY(index)).toBeCloseTo(lon, 4);
    expect(hover.findNearest(lat, lon)?.value).toBe(value);
  });
}

async function expectPreparedFrames(
  api: ReturnType<typeof useScalarFrames>,
  store: ReturnType<typeof useGlobeControlStore>,
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
) {
  const data = mesh.material.uniforms.data.value.image.data as Float32Array;
  const info = store.varinfo;
  const indices = store.dimSlidersValues.slice();
  setHoverLookupFromIndex.mockClear();
  const cancelled = new AbortController();
  const first = (await api.prepareScalarFrame({
    dimensionIndices: { time: 2 },
    signal: cancelled.signal,
  }))!;
  const second = (await api.prepareScalarFrame({
    dimensionIndices: { time: 3 },
  }))!;
  expect(mesh.material.uniforms.data.value.image.data).toBe(data);
  expect(store.varinfo).toBe(info);
  expect(store.dimSlidersValues).toEqual(indices);
  expect(setHoverLookupFromIndex).not.toHaveBeenCalled();
  const reads = vi.mocked(getGridVariableData).mock.calls.length;
  for (const [frame, time] of [
    [first, 2],
    [second, 3],
    [first, 2],
  ] as const) {
    expect(await api.commitScalarFrame(frame)).toBe(true);
    expect(mesh.material.uniforms.data.value.image.data).toEqual(
      Float32Array.from(data, (value) => value + time * 100)
    );
    expect(store.dimSlidersDisplay[0]).toBe(time);
  }
  expect(getGridVariableData).toHaveBeenCalledTimes(reads);
  cancelled.abort();
  expect(await api.commitScalarFrame(first)).toBe(false);
}

async function expectBakedFrames(
  bake: ReturnType<typeof useScalarBake>,
  store: ReturnType<typeof useGlobeControlStore>,
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
) {
  const before = mesh.material.uniforms.data.value.image.data as Float32Array;
  const originalTime = store.dimSlidersDisplay[0]!;
  const base = Float32Array.from(before, (value) => value - originalTime * 100);
  await bake.plan({ start: 0, end: 2 });
  expect(bake.message).toBe("");
  expect(bake.phase).toBe(SCALAR_BAKE_PHASE.PLANNED);
  expect(mesh.material.uniforms.data.value.image.data).toBe(before);
  await bake.bake();
  expect(bake.message).toBe("");
  expect(bake.phase).toBe(SCALAR_BAKE_PHASE.READY);
  const reads = vi.mocked(getGridVariableData).mock.calls.length;
  const material = mesh.material;
  const texture = material.uniforms.data.value as THREE.DataTexture;
  const geometry = mesh.geometry;
  const materialVersion = material.version;
  const disposeMaterial = vi.fn();
  const disposeTexture = vi.fn();
  material.addEventListener("dispose", disposeMaterial);
  texture.addEventListener("dispose", disposeTexture);
  for (const time of [2, 1, 0]) {
    await bake.seek(time);
    expect(mesh.material.uniforms.data.value.image.data).toEqual(
      Float32Array.from(base, (value) => value + time * 100)
    );
    expect(store.dimSlidersDisplay[0]).toBe(time);
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
    expect(mesh.material.version).toBe(materialVersion);
    expect(mesh.material.uniforms.data.value).toBe(texture);
  }
  expect(disposeMaterial).not.toHaveBeenCalled();
  expect(disposeTexture).not.toHaveBeenCalled();
  await checkScalarInterpolation(bake, store, [mesh], 100);
  expect(getGridVariableData).toHaveBeenCalledTimes(reads);
  bake.clear();
  expect(bake.completed).toBe(0);
}
