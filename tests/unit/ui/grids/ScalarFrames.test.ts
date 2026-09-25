import * as THREE from "three";
import { expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";

import type { TGridDataRequest } from "@/lib/grids/gridDataWorkerClient.ts";
import type { TGridGeometryBatch } from "@/lib/grids/gridWorkerTypes.ts";
import { TriangularWorkerOperation } from "@/lib/grids/triangularWorkerProtocol.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import {
  useScalarBake,
  SCALAR_BAKE_PHASE,
} from "@/ui/grids/composables/useScalarBake.ts";
import type { useScalarFrames } from "@/ui/grids/composables/useScalarFrames.ts";

type TFrameAPI = ReturnType<typeof useScalarFrames>;
const h = vi.hoisted(() => ({
  beforeMount: [] as (() => Promise<void>)[],
  scene: undefined as THREE.Scene | undefined,
  dimensions: ["time", "cell"],
  shape: [4, 4],
  gate: undefined as Promise<void> | undefined,
  rebuildNext: false,
  batchSent: vi.fn(),
  getData: vi.fn(),
  logError: vi.fn(),
  setContext: vi.fn(async () => {}),
  setHover: vi.fn(),
}));
vi.stubGlobal("localStorage", { getItem: () => null });
vi.mock("vue", async (original) => ({
  ...(await original<typeof import("vue")>()),
  onBeforeMount: (callback: () => Promise<void>) =>
    h.beforeMount.push(callback),
  onBeforeUnmount: vi.fn(),
  useSSRContext: () => ({}),
}));
vi.mock("@/ui/common/useLog.ts", () => ({
  useLog: () => ({ logError: h.logError }),
}));
vi.mock("@/ui/grids/composables/gridHoverUtils.ts", () => ({
  useGridHoverLookup: () => ({
    clearHoverLookup: vi.fn(),
    setHoverLookup: h.setHover,
    setHoverLookupFromIndex: h.setHover,
  }),
}));
vi.mock("@/ui/grids/composables/useVolume.ts", () => ({
  useVolume: () => ({ setContext: h.setContext }),
}));
vi.mock("@/lib/volume/volumeData.ts", () => ({
  loadProjectedVolumeGrid: async () => undefined,
}));
vi.mock("@/ui/grids/composables/useStreamlineLayer.ts", () => ({
  useStreamlineLayer: () => ({ clear: vi.fn() }),
}));
vi.mock("@/ui/grids/composables/useIrregularStreamlines.ts", () => ({
  useIrregularStreamlines: () => ({
    setContext: h.setContext,
    refresh: vi.fn(),
    suspend: vi.fn(),
  }),
}));
vi.mock("@/ui/grids/composables/useSharedGridLogic.ts", () => ({
  useSharedGridLogic: () => ({
    getScene: () => h.scene,
    getCamera: () => undefined,
    getRenderer: () => undefined,
    redraw: vi.fn(),
    makeSnapshot: vi.fn(),
    toggleRotate: vi.fn(),
    applyCameraPreset: vi.fn(),
    fitCameraToDataset: vi.fn(),
    getDataVar: async () => ({
      shape: h.shape,
      chunks: [1, ...h.shape.slice(1)],
      dtype: "float32",
      attrs: { units: "K" },
    }),
    fetchDimensionDetails: async () => [],
    updateLandSeaMask: vi.fn(),
    updateColormap: vi.fn(),
    updateHistogram: vi.fn(),
    projectionHelper: ref(
      new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
        lat: 0,
        lon: 0,
      })
    ),
    isSceneInMotion: ref(false),
    canvas: ref<HTMLCanvasElement>(),
    box: ref<HTMLElement>(),
    hoveredGeoPoint: ref<null>(null),
    onProjectionChange: vi.fn(),
    onMotionStateChange: vi.fn(),
    onColormapChange: vi.fn(),
    registerAnimationCallback: vi.fn(),
    registerUpdateLOD: vi.fn(),
  }),
}));
vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getDatasetSource: (sources: TSources, variable: string) =>
      sources.levels[0].datasources[variable],
    getDimensionNames: async () => [...h.dimensions],
    resolveVariablePath: (_variable: string, name: string) => name,
    getCRSInfo: async () => ({
      attrs: { ["healpix_nside"]: 2, ["healpix_order"]: "nest" },
    }),
    getDggsMetadata: async () => null,
  },
}));
vi.mock("@/lib/data/coordinateVariables.ts", () => ({
  getLatLonData: async () => {
    const shape = h.shape.slice(1);
    return {
      latitudes: { data: new Float32Array([0, 0, 1, 1]), shape },
      longitudes: { data: new Float32Array([0, 1, 0, 1]), shape },
      latitudesAttrs: { dimensionNames: h.dimensions.slice(1) },
      longitudesAttrs: { dimensionNames: h.dimensions.slice(1) },
    };
  },
}));
vi.mock("@/lib/data/triangularMesh.ts", () => ({
  getTriangularMesh: async () => null,
}));
vi.mock("@/lib/grids/gridDataWorkerClient.ts", () => ({
  getGridVariableData: (request: TGridDataRequest) => h.getData(request),
  terminateGridDataWorker: vi.fn(),
}));

function batch(data: Float32Array): TGridGeometryBatch {
  return {
    batchIndex: 0,
    positionValues: new Float32Array([1, 0, 0, 1, 0.01, 0, 1, 0, 0.01]),
    latLonValues: new Float32Array([0, 0, 0, 1, 1, 0]),
    dataValues: data.slice(0, 3),
    indices: new Uint32Array([0, 1, 2]),
  };
}
async function finishBatch() {
  h.batchSent();
  await h.gate;
}
// Transport doubles deliberately yield after a batch, before worker completion.
// Numerical builders are covered separately by scalarFrameBaselines.test.ts.
vi.mock("@/lib/grids/curvilinearWorkerClient.ts", () => ({
  buildCurvilinearGrid: async (
    ...[request, callbacks]: Parameters<
      typeof import("@/lib/grids/curvilinearWorkerClient.ts").buildCurvilinearGrid
    >
  ) => {
    callbacks.onMetadata({ totalBatches: 1, shouldFlipLongitude: false });
    callbacks.onBatch(batch(request.data));
    await finishBatch();
    return { hoverIndexData: hover(request.data) };
  },
  terminateCurvilinearWorker: vi.fn(),
}));
vi.mock("@/lib/grids/gaussianReducedWorkerClient.ts", () => ({
  buildGaussianReducedGrid: async (
    ...[request, callbacks]: Parameters<
      typeof import("@/lib/grids/gaussianReducedWorkerClient.ts").buildGaussianReducedGrid
    >
  ) => {
    callbacks.onMetadata(1);
    callbacks.onBatch(batch(request.data));
    await finishBatch();
    return hover(request.data);
  },
  terminateGaussianReducedWorker: vi.fn(),
}));
vi.mock("@/lib/grids/irregularWorkerClient.ts", () => ({
  buildIrregularGrid: async (
    ...[request, callbacks]: Parameters<
      typeof import("@/lib/grids/irregularWorkerClient.ts").buildIrregularGrid
    >
  ) => {
    callbacks.onMetadata({ totalBatches: 1, estimatedSpacing: 1 });
    callbacks.onBatch(batch(request.data));
    await finishBatch();
    return { hoverIndexData: hover(request.data) };
  },
  terminateIrregularWorker: vi.fn(),
}));
vi.mock("@/lib/grids/irregularDelaunayWorkerClient.ts", () => ({
  buildIrregularDelaunayGrid: async (
    ...[request, callbacks]: Parameters<
      typeof import("@/lib/grids/irregularDelaunayWorkerClient.ts").buildIrregularDelaunayGrid
    >
  ) => {
    const rebuildGeometry = request.forceGeometryRebuild || h.rebuildNext;
    h.rebuildNext = false;
    callbacks.onMetadata({ totalBatches: 1, rebuildGeometry });
    const prepared = batch(request.data);
    callbacks.onBatch(
      rebuildGeometry
        ? prepared
        : { batchIndex: 0, dataValues: prepared.dataValues }
    );
    await finishBatch();
    return { hoverIndexData: hover(request.data) };
  },
  terminateIrregularDelaunayWorker: vi.fn(),
}));
vi.mock("@/lib/grids/triangularWorkerClient.ts", () => ({
  buildTriangularGeometry: async (
    ...[, callbacks]: Parameters<
      typeof import("@/lib/grids/triangularWorkerClient.ts").buildTriangularGeometry
    >
  ) => {
    callbacks.onMetadata({
      totalBatches: 1,
      operation: TriangularWorkerOperation.GEOMETRY,
    });
    callbacks.onBatch(batch(new Float32Array(3)));
  },
  buildTriangularData: async (
    ...[request, callbacks]: Parameters<
      typeof import("@/lib/grids/triangularWorkerClient.ts").buildTriangularData
    >
  ) => {
    callbacks.onMetadata({
      totalBatches: 1,
      operation: TriangularWorkerOperation.DATA,
    });
    callbacks.onBatch({
      batchIndex: 0,
      dataValues: new Float32Array(3).fill(request.data[0]),
    });
    await finishBatch();
    return { hoverIndexData: hover(request.data) };
  },
  terminateTriangularWorker: vi.fn(),
}));
vi.mock("@/lib/grids/healpixWorkerClient.ts", () => ({
  buildHealpixFace: async (
    request: import("@/lib/grids/healpixWorkerProtocol.ts").THealpixBuildRequest
  ) => {
    const { Grid } = await import("healpix-geo");
    const { buildHealpixGeometry, buildHealpixTexture } =
      await import("@/lib/grids/healpixCalculations.ts");
    using geometryGrid = new Grid({ scheme: "nested", level: 0 });
    const prepared = {
      batchIndex: request.faceIndex,
      ...buildHealpixGeometry(
        geometryGrid,
        BigInt(request.faceIndex),
        3,
        new ProjectionHelper(request.projectionType, request.projectionCenter)
      ),
      ...buildHealpixTexture(request.data, request.faceIndex, 2),
    };
    await finishBatch();
    return prepared;
  },
  terminateHealpixWorker: vi.fn(),
}));

const { buildSerializedGeoSampleIndexData } =
  await import("@/lib/grids/gridWorkerCalculations.ts");
function hover(data: Float32Array) {
  return buildSerializedGeoSampleIndexData(
    new Float64Array(data.length),
    Float64Array.from(data, (_, i) => i),
    data
  );
}
const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: Curvilinear } = await import("@/ui/grids/Curvilinear.vue");
const { default: GaussianReduced } =
  await import("@/ui/grids/GaussianReduced.vue");
const { default: Irregular } = await import("@/ui/grids/Irregular.vue");
const { default: IrregularDelaunay } =
  await import("@/ui/grids/IrregularDelaunay.vue");
const { default: Triangular } = await import("@/ui/grids/Triangular.vue");
const { default: Healpix } = await import("@/ui/grids/Healpix.vue");
const cases = [
  {
    name: "curvilinear",
    component: Curvilinear,
    dimensions: ["time", "y", "x"],
    shape: [4, 2, 2],
  },
  {
    name: "Gaussian reduced",
    component: GaussianReduced,
    dimensions: ["time", "cell"],
    shape: [4, 4],
  },
  {
    name: "irregular points",
    component: Irregular,
    dimensions: ["time", "cell"],
    shape: [4, 4],
  },
  {
    name: "irregular Delaunay",
    component: IrregularDelaunay,
    dimensions: ["time", "cell"],
    shape: [4, 4],
  },
  {
    name: "triangular",
    component: Triangular,
    dimensions: ["time", "cell"],
    shape: [4, 1],
  },
  {
    name: "HEALPix",
    component: Healpix,
    dimensions: ["time", "cell"],
    shape: [4, 48],
  },
];
function snapshot() {
  return h
    .scene!.children.filter((child) => !child.userData.testOverlay)
    .map((child) => {
      const mesh = child as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.ShaderMaterial
      >;
      const data =
        mesh.geometry.getAttribute("data_value")?.array ??
        mesh.material.uniforms.data.value.image.data;
      return {
        geometry: mesh.geometry.uuid,
        material: mesh.material.uuid,
        materialVersion: mesh.material.version,
        texture: mesh.material.uniforms.data?.value.uuid,
        data: Array.from(data as Float32Array),
      };
    });
}
function reset(test: (typeof cases)[number]) {
  setActivePinia(createPinia());
  const store = useGlobeControlStore();
  store.varnameSelector = "temperature";
  store.selection = { low: 0, high: 100 };
  h.beforeMount.length = 0;
  h.scene = new THREE.Scene();
  h.gate = undefined;
  h.rebuildNext = false;
  h.dimensions = test.dimensions;
  h.shape = test.shape;
  vi.clearAllMocks();
  h.getData.mockImplementation(
    async ({ variable, selection }: TGridDataRequest) => {
      if (variable === "cell") {
        throw new Error("no explicit cell coordinate");
      }
      if (variable !== "temperature") {
        return new Float32Array([1, 2, 3]);
      }
      const last = selection.at(-1);
      const count =
        typeof last === "object" && last
          ? 4
          : test.shape.slice(1).reduce((a, b) => a * b, 1);
      return Float32Array.from(
        { length: count },
        (_, i) => Number(selection[0]) * 10 + i + 1
      );
    }
  );
  return store;
}

it.each(cases)(
  "prepares, commits and replays $name without progressive scene changes",
  async (test) => {
    const store = reset(test);
    const scope = effectScope();
    const expose = vi.fn();
    const source = { store: "scalar.zarr", dataset: "" };
    scope.run(() =>
      test.component.setup!(
        {
          datasources: {
            ["zarr_format"]: ZARR_FORMAT.V3,
            levels: [
              {
                grid: source,
                time: source,
                datasources: { temperature: source },
              },
            ],
          },
        },
        { expose, attrs: {}, slots: {}, emit: vi.fn() }
      )
    );
    try {
      await h.beforeMount[0]();
      expect(h.logError).not.toHaveBeenCalled();
      expect(snapshot().length).toBeGreaterThan(0);
      const api = expose.mock.lastCall![0] as TFrameAPI;
      await checkPreparation(api, store);
      const bake = scope.run(() => useScalarBake(() => api))!;
      await checkBake(bake, store);
    } finally {
      scope.stop();
    }
  }
);

// eslint-disable-next-line max-lines-per-function
async function checkPreparation(
  api: TFrameAPI,
  store: ReturnType<typeof useGlobeControlStore>
) {
  const before = snapshot();
  const info = store.varinfo;
  const indices = store.dimSlidersValues.slice();
  let release!: () => void;
  h.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.batchSent.mockClear();
  h.setContext.mockClear();
  h.setHover.mockClear();
  h.rebuildNext = true;
  const cancelled = new AbortController();
  const pending = api.prepareScalarFrame({
    dimensionIndices: { time: 1 },
    signal: cancelled.signal,
  });
  try {
    await vi.waitFor(() => expect(h.batchSent).toHaveBeenCalled());
    expect(snapshot()).toEqual(before);
    expect(store.varinfo).toBe(info);
    expect(store.loading).toBe(false);
    expect(h.setContext).not.toHaveBeenCalled();
    expect(h.setHover).not.toHaveBeenCalled();
  } finally {
    release();
  }
  const first = (await pending)!;
  const second = (await api.prepareScalarFrame({
    dimensionIndices: { time: 2 },
  }))!;
  expect(snapshot()).toEqual(before);
  expect(store.dimSlidersValues).toEqual(indices);
  const reads = h.getData.mock.calls.length;
  for (const [frame, offset] of [
    [first, 10],
    [second, 20],
    [first, 10],
  ] as const) {
    expect(await api.commitScalarFrame(frame)).toBe(true);
    expect(snapshot().map((entry) => entry.data)).toEqual(
      before.map((entry) => entry.data.map((value) => value + offset))
    );
    expect(store.dimSlidersDisplay[0]).toBe(offset / 10);
  }
  expect(h.getData).toHaveBeenCalledTimes(reads);
  cancelled.abort();
  expect(await api.commitScalarFrame(first)).toBe(false);
  expect(h.logError).not.toHaveBeenCalled();
  await checkCancelledPreparation(api);
  store.dimSlidersValues[0] = 0;
  await vi.waitFor(() => {
    expect(store.dimSlidersDisplay[0]).toBe(0);
    expect(snapshot().map((entry) => entry.data)).toEqual(
      before.map((entry) => entry.data)
    );
    expect(store.loading).toBe(false);
  });
}

async function checkCancelledPreparation(api: TFrameAPI) {
  const before = snapshot();
  const controller = new AbortController();
  let release!: () => void;
  h.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.batchSent.mockClear();
  const pending = api.prepareScalarFrame({
    dimensionIndices: { time: 3 },
    signal: controller.signal,
  });
  try {
    await vi.waitFor(() => expect(h.batchSent).toHaveBeenCalled());
    controller.abort();
  } finally {
    release();
  }
  expect(await pending).toBeUndefined();
  expect(snapshot()).toEqual(before);
}

async function checkBake(
  bake: ReturnType<typeof useScalarBake>,
  store: ReturnType<typeof useGlobeControlStore>
) {
  const before = snapshot();
  const overlay = new THREE.Object3D();
  overlay.userData.testOverlay = true;
  h.scene!.add(overlay);
  await bake.plan({ start: 0, end: 2 });
  expect(bake.message).toBe("");
  expect(bake.phase).toBe(SCALAR_BAKE_PHASE.PLANNED);
  expect(snapshot()).toEqual(before);
  expect(bake.estimate!.retainedBytes).toBeGreaterThan(0);
  await bake.bake();
  expect(bake.message).toBe("");
  expect(bake.phase).toBe(SCALAR_BAKE_PHASE.READY);
  const reads = h.getData.mock.calls.length;
  const resourcesBefore = snapshot().map(
    ({ geometry, material, materialVersion, texture }) => [
      geometry,
      material,
      materialVersion,
      texture,
    ]
  );
  for (const time of [2, 1, 0]) {
    await bake.seek(time);
    expect(snapshot().map((entry) => entry.data)).toEqual(
      before.map((entry) => entry.data.map((value) => value + time * 10))
    );
    expect(store.dimSlidersDisplay[0]).toBe(time);
    expect(h.scene!.children).toContain(overlay);
    expect(
      snapshot().map(({ geometry, material, materialVersion, texture }) => [
        geometry,
        material,
        materialVersion,
        texture,
      ])
    ).toEqual(resourcesBefore);
  }
  expect(h.getData).toHaveBeenCalledTimes(reads);
  bake.clear();
  expect(bake.completed).toBe(0);
  expect(bake.estimate).toBeUndefined();
  h.scene!.remove(overlay);
}
