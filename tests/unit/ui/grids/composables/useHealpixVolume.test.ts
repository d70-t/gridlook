import type { WebGLRenderer } from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { TSources } from "@/lib/types/GlobeTypes.ts";
import type { THealpixVolumeSource } from "@/lib/volume/healpixVolumeData.ts";
import type { TVolumeTextureBuildResult } from "@/lib/volume/volumeTexture.ts";

const { inspect, load, build, setData, logError } = vi.hoisted(() => ({
  inspect: vi.fn(),
  load: vi.fn(),
  build: vi.fn(),
  setData: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/volume/healpixVolumeData.ts", () => ({
  inspectHealpixVolumeSources: inspect,
  loadHealpixVolumeData: load,
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
vi.mock("@/lib/layers/volumeLayer.ts", async () => {
  const { Object3D } = await import("three");
  return {
    getMax3DTextureSize: () => 4,
    SphericalVolumeLayer: class {
      object = new Object3D();
      setData = setData;
      setAppearance = vi.fn();
      setOpacity = vi.fn();
      setRenderOrder = vi.fn();
      dispose = vi.fn();
    },
  };
});
vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { computed, effectScope, nextTick, ref } = await import("vue");
const { Scene } = await import("three");
const { ProjectionHelper, PROJECTION_TYPES } =
  await import("@/lib/projection/projectionUtils.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useHealpixVolume } =
  await import("@/ui/grids/composables/useHealpixVolume.ts");

const scopes: ReturnType<typeof effectScope>[] = [];
const source = {
  name: "water",
  selection: [0, null, null],
  sourceLevelCount: 2,
  sourceCellCount: 1,
} as THealpixVolumeSource;
const context = {
  dimensionNames: ["time", "level", "cell"],
  indices: [0, null, null],
  nside: 2 ** 20,
  grid: { level: 20, scheme: "nested" as const },
  cellCoordinates: [2 ** 40 + 3],
};
const result: TVolumeTextureBuildResult = {
  data: new Uint8Array(16),
  dimensions: { width: 4, height: 2, depth: 2, byteLength: 16 },
  valueScales: [1],
  channelCount: 1,
  storageChannelCount: 1,
};

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function setupVolume() {
  const scope = effectScope();
  scopes.push(scope);
  const scene = new Scene();
  const datasources = {} as TSources;
  return scope.run(() =>
    useHealpixVolume({
      getDatasources: () => datasources,
      getScene: () => scene,
      getRenderer: () => ({}) as WebGLRenderer,
      redraw: vi.fn(),
      projectionHelper: computed(
        () =>
          new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
            lat: 0,
            lon: 0,
          })
      ),
      isSceneInMotion: ref(false),
      onProjectionChange: vi.fn(),
      onMotionStateChange: vi.fn(),
    })
  )!;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
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

  expect(Array.from(build.mock.calls[0][0].cellCoordinates)).toEqual(
    context.cellCoordinates
  );
  expect(build.mock.calls[0][0].grid).toEqual(context.grid);

  volume.setContext({
    ...context,
    cellCoordinates: [context.cellCoordinates[0] + 2 ** 32],
  });
  await vi.waitFor(() => expect(setData).toHaveBeenCalledTimes(2));
});

it("does not download stale metadata after a newer request completes", async () => {
  const stale = deferred<THealpixVolumeSource[]>();
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

it("does not start downloads after disposal during metadata loading", async () => {
  const stale = deferred<THealpixVolumeSource[]>();
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
  volume.setContext(context);
  await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
  useGlobeControlStore().setVolumeSelections([
    { variable: "water", color: "#abcdef", opacity: 0.5 },
  ]);
  await nextTick();
  pending.resolve(result);
  await pending.promise;

  expect(setData.mock.calls[0].slice(-2)).toEqual([["#abcdef"], [0.5]]);
});
