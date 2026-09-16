import { beforeEach, expect, it, vi } from "vitest";

import type { TSources } from "@/lib/types/GlobeTypes.ts";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock("@/ui/common/useLog.ts", () => ({
  useLog: () => ({ logError }),
}));

vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
});

const { createPinia, setActivePinia } = await import("pinia");
const { effectScope, nextTick } = await import("vue");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useGridDataLoader } =
  await import("@/ui/grids/composables/useGridDataLoader.ts");

function deferred() {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  logError.mockReset();
});

it("retries the newest queued update when an older fetch fails", async () => {
  const sources = {} as TSources;
  const staleFetch = deferred();
  const fetchAndRenderData = vi
    .fn()
    .mockImplementationOnce(() => staleFetch.promise)
    .mockResolvedValueOnce(undefined);
  const scope = effectScope();
  const loader = scope.run(() =>
    useGridDataLoader({
      getDatasources: () => sources,
      getDataVar: vi.fn().mockResolvedValue({}),
      fetchAndRenderData,
      clearHoverLookup: vi.fn(),
      updateLandSeaMask: vi.fn(),
      updateColormap: vi.fn(),
    })
  )!;

  const initialUpdate = loader.getData();
  await vi.waitFor(() => expect(fetchAndRenderData).toHaveBeenCalledTimes(1));

  await loader.getData();
  staleFetch.reject(new Error("timestep is no longer available"));
  await initialUpdate;

  expect(fetchAndRenderData).toHaveBeenCalledTimes(2);
  expect(logError).not.toHaveBeenCalled();
  expect(useGlobeControlStore().loading).toBe(false);
  scope.stop();
});

it("reports a fetch failure when no newer update is queued", async () => {
  const sources = {} as TSources;
  const scope = effectScope();
  const loader = scope.run(() =>
    useGridDataLoader({
      getDatasources: () => sources,
      getDataVar: vi.fn().mockResolvedValue({}),
      fetchAndRenderData: vi.fn().mockRejectedValue(new Error("unavailable")),
      clearHoverLookup: vi.fn(),
      updateLandSeaMask: vi.fn(),
      updateColormap: vi.fn(),
    })
  )!;

  await loader.getData();

  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "unavailable" }),
    "Could not fetch data"
  );
  expect(useGlobeControlStore().loading).toBe(false);
  scope.stop();
});

// eslint-disable-next-line max-lines-per-function
it("commits only the latest complete timestep and preserves its derived variable name", async () => {
  const sources = {} as TSources;
  const store = useGlobeControlStore();
  store.varnameSelector = "temperature";
  store.varnameDisplay = "wind_speed";
  store.dimSlidersValues = [0];
  store.dimSlidersDisplay = [0];
  const firstFrame = deferred();
  const latestFrame = deferred();
  const rendered: number[] = [];
  const fetched: number[] = [];
  const scope = effectScope();
  const loader = scope.run(() =>
    useGridDataLoader({
      getDatasources: () => sources,
      getDataVar: vi.fn().mockResolvedValue({}),
      fetchAndRenderData: async (_data, isCurrent) => {
        const step = store.dimSlidersValues[0]!;
        fetched.push(step);
        await (step === 0 ? firstFrame.promise : latestFrame.promise);
        if (isCurrent()) {
          rendered.push(step);
          store.varnameDisplay = "wind_speed";
          store.dimSlidersDisplay = [step];
        }
      },
      clearHoverLookup: vi.fn(),
      updateLandSeaMask: vi.fn(),
      updateColormap: vi.fn(),
    })
  )!;
  try {
    const pending = loader.getData();
    await vi.waitFor(() => expect(fetched).toEqual([0]));
    store.dimSlidersValues = [1];
    await nextTick();
    store.dimSlidersValues = [2];
    await nextTick();
    firstFrame.resolve();
    await vi.waitFor(() => expect(fetched).toEqual([0, 2]));
    expect(rendered).toEqual([]);
    expect(store.loading).toBe(true);
    expect(store.dimSlidersDisplay).toEqual([0]);

    latestFrame.resolve();
    await pending;
    expect(rendered).toEqual([2]);
    expect(store.loading).toBe(false);
    expect(store.varnameDisplay).toBe("wind_speed");
    expect(store.dimSlidersDisplay).toEqual([2]);
  } finally {
    scope.stop();
  }
});

it("restores the selected scalar data when streamlines are disabled", async () => {
  const sources = {} as TSources;
  const store = useGlobeControlStore();
  const fetchAndRenderData = vi.fn().mockResolvedValue(undefined);
  const refreshStreamlines = vi.fn().mockResolvedValue(undefined);
  const suspendStreamlines = vi.fn();
  const updateColormap = vi.fn();
  const scope = effectScope();
  scope.run(() =>
    useGridDataLoader({
      getDatasources: () => sources,
      getDataVar: vi.fn().mockResolvedValue({}),
      fetchAndRenderData,
      clearHoverLookup: vi.fn(),
      updateLandSeaMask: vi.fn(),
      updateColormap,
      refreshStreamlines,
      suspendStreamlines,
    })
  );

  store.setStreamlineLayerEnabled(true);
  await vi.waitFor(() => expect(refreshStreamlines).toHaveBeenCalledWith(true));
  store.setStreamlineMagnitudeDisplayed(true);
  fetchAndRenderData.mockClear();
  updateColormap.mockClear();

  store.setStreamlineLayerEnabled(false);
  await vi.waitFor(() => expect(fetchAndRenderData).toHaveBeenCalledOnce());

  expect(suspendStreamlines).toHaveBeenCalledOnce();
  expect(updateColormap).toHaveBeenCalledOnce();
  scope.stop();
});

it("restarts an in-flight timestep when streamlines are disabled and enabled again", async () => {
  const sources = {} as TSources;
  const store = useGlobeControlStore();
  store.setStreamlineLayerEnabled(true);
  const pendingFrame = deferred();
  const rendered: boolean[] = [];
  const fetchAndRenderData = vi.fn(async (_data, isCurrent: () => boolean) => {
    await pendingFrame.promise;
    if (isCurrent()) {
      rendered.push(store.isStreamlineLayerEnabled());
    }
  });
  const refreshStreamlines = vi.fn();
  const scope = effectScope();
  const loader = scope.run(() =>
    useGridDataLoader({
      getDatasources: () => sources,
      getDataVar: vi.fn().mockResolvedValue({}),
      fetchAndRenderData,
      clearHoverLookup: vi.fn(),
      updateLandSeaMask: vi.fn(),
      updateColormap: vi.fn(),
      suspendStreamlines: vi.fn(),
      refreshStreamlines,
    })
  )!;
  try {
    const pending = loader.getData();
    await vi.waitFor(() => expect(fetchAndRenderData).toHaveBeenCalledOnce());
    store.setStreamlineLayerEnabled(false);
    await nextTick();
    store.setStreamlineLayerEnabled(true);
    await nextTick();
    pendingFrame.resolve();
    await pending;

    expect(fetchAndRenderData).toHaveBeenCalledTimes(2);
    expect(rendered).toEqual([true]);
    expect(refreshStreamlines).not.toHaveBeenCalled();
    expect(store.loading).toBe(false);
  } finally {
    scope.stop();
  }
});

// eslint-disable-next-line max-lines-per-function
it("switches cached scalar backgrounds without reloading data or streamlines", async () => {
  const sources = {} as TSources;
  const store = useGlobeControlStore();
  store.varnameSelector = "temperature";
  store.varnameDisplay = "temperature";
  const getDataVar = vi.fn().mockResolvedValue({});
  const fetchAndRenderData = vi.fn().mockResolvedValue(undefined);
  const scalarCache = {
    clear: vi.fn(),
    restoreScalar: vi.fn().mockResolvedValue(true),
  };
  const refreshStreamlines = vi.fn(async () => {
    store.setStreamlineMagnitudeInfo(
      { longName: "Wind speed", units: "m s-1" },
      true
    );
  });
  const scope = effectScope();
  scope.run(() =>
    useGridDataLoader({
      getDatasources: () => sources,
      getDataVar,
      fetchAndRenderData,
      scalarCache,
      clearHoverLookup: vi.fn(),
      updateLandSeaMask: vi.fn(),
      updateColormap: vi.fn(),
      refreshStreamlines,
    })
  );

  try {
    store.setStreamlineLayerEnabled(true);
    await vi.waitFor(() => expect(refreshStreamlines).toHaveBeenCalledOnce());
    expect(store.streamlineMagnitudeRequested).toBe(false);
    expect(store.streamlineMagnitudeDisplayed).toBe(false);
    expect(store.varnameDisplay).toBe("temperature");
    expect(fetchAndRenderData).not.toHaveBeenCalled();

    refreshStreamlines.mockClear();
    store.setStreamlineMagnitudeDisplayed(true, true);
    await vi.waitFor(() =>
      expect(refreshStreamlines).toHaveBeenCalledWith(true)
    );
    expect(store.streamlineMagnitudeDisplayed).toBe(true);
    expect(fetchAndRenderData).not.toHaveBeenCalled();

    store.setStreamlineMagnitudeDisplayed(false, true);
    await vi.waitFor(() =>
      expect(scalarCache.restoreScalar).toHaveBeenCalledOnce()
    );
    expect(fetchAndRenderData).not.toHaveBeenCalled();
    expect(getDataVar).not.toHaveBeenCalled();
    expect(refreshStreamlines).toHaveBeenCalledOnce();
    expect(scalarCache.clear).not.toHaveBeenCalled();
    expect(store.streamlineMagnitudeRequested).toBe(false);
    expect(store.streamlineMagnitudeDisplayed).toBe(false);
    expect(store.isStreamlineLayerEnabled()).toBe(true);

    store.streamlineLoading = true;
    store.setStreamlineMagnitudeDisplayed(true, true);
    await nextTick();
    expect(store.streamlineMagnitudeRequested).toBe(true);
    expect(refreshStreamlines).toHaveBeenCalledOnce();
    expect(logError).not.toHaveBeenCalled();
  } finally {
    scope.stop();
  }
});
