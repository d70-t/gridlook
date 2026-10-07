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
const { effectScope, nextTick, reactive } = await import("vue");
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

it("reloads a swapped level in place and stages its display", async () => {
  const sources = reactive({ selectedLevel: 0 }) as TSources;
  const prepareDatasource = vi.fn();
  const fetchAndRenderData = vi.fn().mockResolvedValue(undefined);
  const scope = effectScope();
  const loader = scope.run(() =>
    useGridDataLoader({
      getDatasources: () => sources,
      getDataVar: vi.fn().mockResolvedValue({}),
      fetchAndRenderData,
      clearHoverLookup: vi.fn(),
      prepareDatasource,
      updateLandSeaMask: vi.fn(),
      updateColormap: vi.fn(),
    })
  )!;

  sources.selectedLevel = 1;
  await vi.waitFor(() => expect(fetchAndRenderData).toHaveBeenCalledTimes(1));
  expect(prepareDatasource).toHaveBeenCalledTimes(1);
  expect(fetchAndRenderData.mock.calls[0][2]).toBe(true);

  // Once the level is on screen, a timestep change replaces it directly.
  await loader.getData();
  expect(prepareDatasource).toHaveBeenCalledTimes(1);
  expect(fetchAndRenderData.mock.calls[1][2]).toBe(false);
  scope.stop();
});

it("reloads the view window once it no longer covers the view", async () => {
  const sources = {} as TSources;
  const store = useGlobeControlStore();
  const prepareDatasource = vi.fn();
  const fetchAndRenderData = vi.fn().mockResolvedValue(undefined);
  const viewWindowStale = vi.fn().mockReturnValue(false);
  const scope = effectScope();
  const loader = scope.run(() =>
    useGridDataLoader({
      getDatasources: () => sources,
      getDataVar: vi.fn().mockResolvedValue({}),
      fetchAndRenderData,
      clearHoverLookup: vi.fn(),
      prepareDatasource,
      canLoadByView: () => true,
      viewWindowStale,
      updateLandSeaMask: vi.fn(),
      updateColormap: vi.fn(),
    })
  )!;
  await loader.datasourceUpdate();
  expect(store.viewLoading).toBe(true);
  expect(prepareDatasource).toHaveBeenCalledTimes(1);

  const centre = { centreLat: 0, centreLon: 0 };
  // a move inside the loaded window fetches nothing
  store.viewFootprint = {
    latMin: 0,
    latMax: 1,
    lonStart: 0,
    lonSpan: 1,
    ...centre,
  };
  await nextTick();
  expect(fetchAndRenderData).toHaveBeenCalledTimes(1);

  viewWindowStale.mockReturnValue(true);
  store.viewFootprint = {
    latMin: 5,
    latMax: 6,
    lonStart: 0,
    lonSpan: 1,
    ...centre,
  };
  await vi.waitFor(() => expect(fetchAndRenderData).toHaveBeenCalledTimes(2));
  expect(prepareDatasource).toHaveBeenCalledTimes(2);
  expect(fetchAndRenderData.mock.calls[1][2]).toBe(true);
  scope.stop();
});

it("lets a window in flight land before reloading for a newer view", async () => {
  const sources = {} as TSources;
  const store = useGlobeControlStore();
  const firstWindow = deferred();
  const fetchAndRenderData = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(() => firstWindow.promise)
    .mockResolvedValue(undefined);
  const scope = effectScope();
  const loader = scope.run(() =>
    useGridDataLoader({
      getDatasources: () => sources,
      getDataVar: vi.fn().mockResolvedValue({}),
      fetchAndRenderData,
      clearHoverLookup: vi.fn(),
      prepareDatasource: vi.fn(),
      viewWindowStale: () => true,
      updateLandSeaMask: vi.fn(),
      updateColormap: vi.fn(),
    })
  )!;
  await loader.datasourceUpdate();
  const view = { latMin: 0, latMax: 1, lonSpan: 1, centreLat: 0, centreLon: 0 };

  store.viewFootprint = { ...view, lonStart: 10 };
  await vi.waitFor(() => expect(fetchAndRenderData).toHaveBeenCalledTimes(2));
  // the camera keeps moving while that window loads: it is not superseded
  store.viewFootprint = { ...view, lonStart: 20 };
  store.viewFootprint = { ...view, lonStart: 30 };
  await nextTick();
  expect(fetchAndRenderData).toHaveBeenCalledTimes(2);

  // once it is on screen, the window for the newest view follows
  firstWindow.resolve();
  await vi.waitFor(() => expect(fetchAndRenderData).toHaveBeenCalledTimes(3));
  scope.stop();
});

it("prepares again for a level that supersedes one still loading", async () => {
  const sources = reactive({ selectedLevel: 0 }) as TSources;
  const firstLevel = deferred();
  const prepareDatasource = vi.fn();
  const fetchAndRenderData = vi
    .fn()
    .mockImplementationOnce(() => firstLevel.promise)
    .mockResolvedValue(undefined);
  const scope = effectScope();
  const loader = scope.run(() =>
    useGridDataLoader({
      getDatasources: () => sources,
      getDataVar: vi.fn().mockResolvedValue({}),
      fetchAndRenderData,
      clearHoverLookup: vi.fn(),
      prepareDatasource,
      updateLandSeaMask: vi.fn(),
      updateColormap: vi.fn(),
    })
  )!;

  sources.selectedLevel = 1;
  await vi.waitFor(() => expect(fetchAndRenderData).toHaveBeenCalledTimes(1));
  sources.selectedLevel = 2;
  await nextTick();
  firstLevel.resolve();
  await vi.waitFor(() => expect(fetchAndRenderData).toHaveBeenCalledTimes(2));
  expect(prepareDatasource).toHaveBeenCalledTimes(2);
  // the superseded load did not count as showing the level: still staged
  expect(fetchAndRenderData.mock.calls[1][2]).toBe(true);
  await loader.getData();
  expect(fetchAndRenderData.mock.calls[2][2]).toBe(false);
  scope.stop();
});

it("reloads a view window as a whole level when streamlines are switched on", async () => {
  const sources = {} as TSources;
  const store = useGlobeControlStore();
  // the grid holds a window until it is prepared again with streamlines on
  let windowed = true;
  const prepareDatasource = vi.fn(() => {
    windowed = !store.isStreamlineLayerEnabled();
  });
  const fetchAndRenderData = vi.fn().mockResolvedValue(undefined);
  const refreshStreamlines = vi.fn();
  const scope = effectScope();
  const loader = scope.run(() =>
    useGridDataLoader({
      getDatasources: () => sources,
      getDataVar: vi.fn().mockResolvedValue({}),
      fetchAndRenderData,
      clearHoverLookup: vi.fn(),
      prepareDatasource,
      viewWindowStale: () => windowed && store.isStreamlineLayerEnabled(),
      refreshStreamlines,
      updateLandSeaMask: vi.fn(),
      updateColormap: vi.fn(),
    })
  )!;
  await loader.datasourceUpdate();

  store.setStreamlineLayerEnabled(true);
  await vi.waitFor(() => expect(prepareDatasource).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(store.loading).toBe(false));
  // the level was fetched again staged, not refreshed from the window's data
  expect(fetchAndRenderData.mock.calls[1][2]).toBe(true);
  expect(refreshStreamlines).not.toHaveBeenCalled();
  scope.stop();
});

it("remembers a level that has to be loaded whole", async () => {
  const sources = reactive({ selectedLevel: 0 }) as TSources;
  const store = useGlobeControlStore();
  const fetchAndRenderData = vi.fn().mockResolvedValue(undefined);
  const scope = effectScope();
  const loader = scope.run(() =>
    useGridDataLoader({
      getDatasources: () => sources,
      getDataVar: vi.fn().mockResolvedValue({}),
      fetchAndRenderData,
      clearHoverLookup: vi.fn(),
      prepareDatasource: vi.fn(),
      // level 1 cannot be loaded by view, the others can
      canLoadByView: () => sources.selectedLevel !== 1,
      updateLandSeaMask: vi.fn(),
      updateColormap: vi.fn(),
    })
  )!;
  await loader.datasourceUpdate();
  expect(store.loadsLevelByView(1)).toBe(true);

  sources.selectedLevel = 1;
  await vi.waitFor(() => expect(fetchAndRenderData).toHaveBeenCalledTimes(2));
  // the capability stays; only that level is held to the whole-level cap
  expect(store.viewLoading).toBe(true);
  expect(store.loadsLevelByView(0)).toBe(true);
  expect(store.loadsLevelByView(1)).toBe(false);
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
