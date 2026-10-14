import type { WebGLRenderer } from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { TSources } from "@/lib/types/GlobeTypes.ts";
import type { TVolumeSource } from "@/lib/volume/volumeData.ts";
import { VOLUME_GRID_TYPES } from "@/lib/volume/volumeGrid.ts";
import { createVolumeInterpolation } from "@/lib/volume/volumeInterpolation.ts";
import type { TVolumeTextureBuildResult } from "@/lib/volume/volumeTexture.ts";

const { inspect, load, build, setData, setInterpolation, logError } =
  vi.hoisted(() => ({
    inspect: vi.fn(),
    load: vi.fn(),
    build: vi.fn(),
    setData: vi.fn(),
    setInterpolation: vi.fn(),
    logError: vi.fn(),
  }));
vi.mock("@/lib/volume/volumeData.ts", async (original) => ({
  ...(await original<typeof import("@/lib/volume/volumeData.ts")>()),
  inspectVolumeSources: inspect,
  inspectVolumeCoordinates: vi.fn(async () => ({ heights: [] })),
  loadVolumeData: load,
}));
vi.mock("@/lib/volume/volumeTextureWorkerClient.ts", () => ({
  buildVolumeTextureInWorker: build,
  terminateVolumeTextureWorker: vi.fn(),
}));
vi.mock("@/ui/common/useLog.ts", () => ({ useLog: () => ({ logError }) }));
vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: vi.fn(),
}));
vi.mock("@/lib/layers/volumeLayer.ts", async (original) => {
  const { Object3D } = await import("three");
  return {
    ...(await original<typeof import("@/lib/layers/volumeLayer.ts")>()),
    getMax3DTextureSize: () => 4,
    VolumeLayer: class {
      object = new Object3D();
      setData = setData;
      setInterpolation = setInterpolation;
      setAppearance = vi.fn();
      setOpacity = vi.fn();
      setQuality = vi.fn();
      setProjection = vi.fn();
      setRenderOrder = vi.fn();
      dispose = vi.fn();
    },
  };
});
vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { computed, effectScope, nextTick, ref, shallowRef } =
  await import("vue");
const { Scene } = await import("three");
const { ProjectionHelper, PROJECTION_TYPES } =
  await import("@/lib/projection/projectionUtils.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useVolume } = await import("@/ui/grids/composables/useVolume.ts");

const scopes: ReturnType<typeof effectScope>[] = [];
const projectionChanges: (() => void)[] = [];
const source = {
  name: "water",
  variable: { attrs: {} },
  selection: [0, null, null],
  sourceLevelCount: 2,
  sourceCellCount: 1,
  spatialShape: [1],
} as TVolumeSource;
const context = {
  dimensionNames: ["time", "level", "cell"],
  indices: [0, null, null],
  grid: {
    kind: VOLUME_GRID_TYPES.HEALPIX,
    nside: 2 ** 20,
    options: { level: 20, scheme: "nested" as const },
    cellCoordinates: new Float64Array([2 ** 40 + 3]),
  },
};
const result: TVolumeTextureBuildResult = {
  data: new Uint8Array(16),
  dimensions: { width: 4, height: 2, depth: 2, byteLength: 16 },
  valueScales: [1],
  channelCount: 1,
  storageChannelCount: 1,
  bounds: { west: -180, south: -90, east: 180, north: 90 },
};

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function setupVolume(
  projection = shallowRef(
    new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
      lat: 0,
      lon: 0,
    })
  )
) {
  const scope = effectScope();
  scopes.push(scope);
  const scene = new Scene();
  const datasources = {} as TSources;
  return scope.run(() =>
    useVolume({
      getDatasources: () => datasources,
      getScene: () => scene,
      getRenderer: () => ({}) as WebGLRenderer,
      redraw: vi.fn(),
      projectionHelper: computed(() => projection.value),
      isSceneInMotion: ref(false),
      onProjectionChange: (callback) => projectionChanges.push(callback),
      onMotionStateChange: vi.fn(),
    })
  )!;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  projectionChanges.length = 0;
  inspect.mockReset().mockResolvedValue([source]);
  load.mockReset().mockResolvedValue({ values: [new Float32Array([1, 2])] });
  build.mockReset().mockResolvedValue(result);
  const store = useGlobeControlStore();
  store.setVolumeLayerEnabled(true);
  store.setVolumeSelections([
    { variable: "water", color: "#ffffff", opacity: 1 },
  ]);
});

afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
});

it("preserves high-resolution regional cell IDs in worker requests", async () => {
  const volume = setupVolume();
  volume.setContext(context);
  await vi.waitFor(() => expect(setData).toHaveBeenCalledOnce());

  expect(build.mock.calls[0][0].grid.cellCoordinates).toEqual(
    context.grid.cellCoordinates
  );
  expect(build.mock.calls[0][0].grid).toEqual(context.grid);

  volume.setContext({
    ...context,
    grid: {
      ...context.grid,
      cellCoordinates: new Float64Array([
        context.grid.cellCoordinates[0] + 2 ** 32,
      ]),
    },
  });
  await vi.waitFor(() => expect(setData).toHaveBeenCalledTimes(2));
});

it("does not download stale metadata after a newer request completes", async () => {
  const stale = deferred<TVolumeSource[]>();
  inspect.mockImplementationOnce(() => stale.promise);
  const volume = setupVolume();
  volume.setContext(context);
  await volume.refresh();
  expect(load).toHaveBeenCalledOnce();

  stale.resolve([{ ...source, selection: [1, null, null] }]);
  await stale.promise;

  expect(load).toHaveBeenCalledOnce();
  expect(setData).toHaveBeenCalledOnce();
  expect(logError).not.toHaveBeenCalled();
});

it("cancels a pending volume when the selected grid is unsupported", async () => {
  const pending = deferred<TVolumeTextureBuildResult>();
  build.mockReturnValueOnce(pending.promise);
  const volume = setupVolume();
  volume.setContext(context);
  await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
  volume.setContext(undefined);
  pending.resolve(result);
  await pending.promise;
  expect(setData).not.toHaveBeenCalled();
  expect(useGlobeControlStore().volumeLoading).toBe(false);
  expect(logError).not.toHaveBeenCalled();
});

it("copies projected axes for the worker and rebuilds when their CRS changes", async () => {
  inspect.mockResolvedValue([
    { ...source, sourceCellCount: 4, spatialShape: [2, 2] },
  ]);
  const volume = setupVolume();
  const projected = {
    dimensionNames: ["time", "y", "x"],
    indices: [0, null, null],
    grid: {
      kind: VOLUME_GRID_TYPES.PROJECTED,
      x: new Float32Array([0, 1000]),
      y: new Float32Array([0, 1000]),
      crs: "EPSG:3857",
    },
  };
  volume.setContext(projected);
  await vi.waitFor(() => expect(setData).toHaveBeenCalledOnce());
  expect(build.mock.calls[0][0].grid).toEqual(projected.grid);
  expect(build.mock.calls[0][0].grid.x).not.toBe(projected.grid.x);
  projected.grid.crs =
    "+proj=lcc +lat_1=56.7 +lat_0=56.7 +lon_0=25 +datum=WGS84";
  volume.setContext(projected);
  await vi.waitFor(() => expect(setData).toHaveBeenCalledTimes(2));
  expect(load).toHaveBeenCalledTimes(2);
});

it("does not start downloads after disposal during metadata loading", async () => {
  const stale = deferred<TVolumeSource[]>();
  inspect.mockImplementationOnce(() => stale.promise);
  const volume = setupVolume();
  volume.setContext(context);
  scopes[0].stop();
  stale.resolve([source]);
  await stale.promise;

  expect(load).not.toHaveBeenCalled();
  expect(build).not.toHaveBeenCalled();
  expect(logError).not.toHaveBeenCalled();
});

it("keeps appearance changes made while the worker is building", async () => {
  const pending = deferred<TVolumeTextureBuildResult>();
  build.mockReturnValueOnce(pending.promise);
  const volume = setupVolume();
  const loading = volume.setContext(context);
  await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
  useGlobeControlStore().setVolumeSelections([
    { variable: "water", color: "#abcdef", opacity: 0.5 },
  ]);
  await nextTick();
  pending.resolve(result);
  await loading;

  expect(setData.mock.calls[0].slice(4, 6)).toEqual([["#abcdef"], [0.5]]);
});

it("loads regular volumes in a flat projection and reuses them when switching views", async () => {
  const projection = shallowRef(
    new ProjectionHelper(PROJECTION_TYPES.MERCATOR, { lat: 0, lon: 0 })
  );
  const volume = setupVolume(projection);
  inspect.mockResolvedValue([
    { ...source, sourceCellCount: 4, spatialShape: [2, 2] },
  ]);
  const grid = {
    kind: VOLUME_GRID_TYPES.REGULAR,
    latitudes: new Float32Array([21, 20]),
    longitudes: new Float32Array([170, 171]),
  };
  volume.setContext({
    dimensionNames: ["time", "lat", "lon"],
    indices: [0, null, null],
    grid,
  });
  await vi.waitFor(() => expect(setData).toHaveBeenCalledOnce());
  expect(build.mock.calls[0][0].grid).toEqual(grid);
  expect(build.mock.calls[0][0].grid.latitudes).not.toBe(grid.latitudes);
  for (const type of Object.values(PROJECTION_TYPES)) {
    projection.value = new ProjectionHelper(type, { lat: 30, lon: 170 });
    projectionChanges.forEach((callback) => callback());
  }
  await nextTick();
  expect(load).toHaveBeenCalledOnce();
  expect(build).toHaveBeenCalledOnce();
});

it("awaits live volume readiness and prepares other timesteps without changing the scene", async () => {
  const pending = deferred<TVolumeTextureBuildResult>();
  build.mockReturnValueOnce(pending.promise);
  const volume = setupVolume();
  let ready = false;
  const loading = volume.setContext(context).then(() => (ready = true));
  await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
  expect(ready).toBe(false);
  pending.resolve(result);
  await loading;
  expect(ready).toBe(true);
  inspect.mockResolvedValueOnce([{ ...source, selection: [1, null, null] }]);
  const frame = await volume.prepareFrame({
    ...context,
    indices: [1, null, null],
  });
  expect(setData).toHaveBeenCalledOnce();
  expect(frame.plan.context.indices[0]).toBe(1);
  const reads = load.mock.calls.length;
  await volume.setContext(frame.plan.context, frame);
  expect(setData).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(reads);
  expect(build).toHaveBeenCalledTimes(2);
});

it("discards cancelled preparation and accepts a fresh job without keeping its data", async () => {
  const pending = deferred<TVolumeTextureBuildResult>();
  build.mockReturnValueOnce(pending.promise);
  const volume = setupVolume();
  const controller = new AbortController();
  const preparing = volume.prepareFrame(context, { signal: controller.signal });
  await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
  controller.abort();
  pending.resolve(result);
  await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
  expect(setData).not.toHaveBeenCalled();
  const frame = await volume.prepareFrame(context);
  expect(volume.commitFrame(frame)).toBe(true);
  expect(setData).toHaveBeenCalledOnce();
  scopes[0].stop();
  expect(volume.commitFrame(frame)).toBe(false);
});

it("propagates preparation failures and rejects frames after changing variables", async () => {
  const volume = setupVolume();
  build.mockRejectedValueOnce(new Error("Build failed"));
  await expect(volume.prepareFrame(context)).rejects.toThrow("Build failed");
  expect(setData).not.toHaveBeenCalled();
  const frame = await volume.prepareFrame(context);
  useGlobeControlStore().setVolumeSelections([
    { variable: "ice", color: "#ffffff", opacity: 1 },
  ]);
  expect(volume.commitFrame(frame)).toBe(false);
  expect(setData).not.toHaveBeenCalled();
});

it("stops live volume work when its scalar frame is superseded", async () => {
  const pending = deferred<{ values: Float32Array[] }>();
  load.mockReturnValueOnce(pending.promise);
  const volume = setupVolume();
  let current = true;
  const loading = volume.setContext(context, undefined, () => current);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  current = false;
  pending.resolve({ values: [new Float32Array([1, 2])] });
  await loading;
  expect(build).not.toHaveBeenCalled();
  expect(setData).not.toHaveBeenCalled();
  expect(logError).not.toHaveBeenCalled();
});

it("commits interpolation without reads and rejects cancelled or disposed endpoints", async () => {
  build.mockResolvedValue({
    ...result,
    data: new Uint16Array(16),
    physical: { scales: [2], vertical: "level", range: { min: 0, max: 1 } },
  });
  const volume = setupVolume();
  const controller = new AbortController();
  const first = await volume.prepareFrame(context);
  const next = await volume.prepareFrame(context, {
    signal: controller.signal,
  });
  expect(build.mock.calls[0][0].interpolatable).toBe(true);
  expect(setInterpolation).not.toHaveBeenCalled();
  const sequence = createVolumeInterpolation([first, next]);
  const reads = load.mock.calls.length;
  for (const alpha of [0, 0.25, 0.5, 1]) {
    expect(volume.commitInterpolation(sequence, 0, 1, alpha)).toBe(true);
  }
  expect(load).toHaveBeenCalledTimes(reads);
  expect(setInterpolation).toHaveBeenCalledTimes(4);
  controller.abort();
  expect(volume.commitInterpolation(sequence, 0, 1, 0.5)).toBe(false);
  expect(volume.commitFrame(first)).toBe(true);
  expect(setInterpolation).toHaveBeenCalledTimes(5);
  scopes[0].stop();
  expect(volume.commitInterpolation(sequence, 0, 0, 0)).toBe(false);
  expect(setInterpolation).toHaveBeenCalledTimes(5);
});
