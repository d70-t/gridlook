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
const { effectScope } = await import("vue");
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
