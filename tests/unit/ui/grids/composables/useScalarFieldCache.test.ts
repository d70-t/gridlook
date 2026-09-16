import { beforeEach, expect, it, vi } from "vitest";
import { effectScope, watch } from "vue";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useGridHistogram } =
  await import("@/ui/grids/composables/useGridHistogram.ts");
const { useScalarFieldCache } =
  await import("@/ui/grids/composables/useScalarFieldCache.ts");

beforeEach(() => setActivePinia(createPinia()));

function setupCache() {
  const store = useGlobeControlStore();
  store.varnameSelector = "temperature";
  store.varnameDisplay = "temperature";
  store.varinfo = {
    attrs: { units: "K" },
    bounds: { low: 270, high: 290 },
    dimInfo: [],
    dimRanges: [],
  };
  const scope = effectScope();
  const cache = scope.run(() => {
    const { updateHistogram } = useGridHistogram();
    updateHistogram(new Float32Array([270, 280, 290]), 270, 290);
    return useScalarFieldCache({
      updateHistogram,
      updateColormap: vi.fn(),
      redraw: vi.fn(),
    });
  })!;
  const renderScalar = vi.fn();
  const frame = {
    render: renderScalar,
    info: store.varinfo,
    indices: [] as number[],
    data: new Float32Array([270, 280, 290]),
  };
  cache.captureScalar(frame);
  const magnitude = {
    longName: "Wind speed",
    standardName: "wind_speed",
    units: "m s-1",
    data: new Float32Array([0, 5, 10]),
    min: 0,
    max: 10,
  };
  return { cache, store, scope, renderScalar, magnitude, frame };
}

it("reuses prepared backgrounds, hover callbacks and histogram summaries", async () => {
  const { cache, store, scope, renderScalar, magnitude } = setupCache();
  const scalarInfo = store.varinfo;
  const scalarHistogram = store.fullHistogram;
  const renderMagnitude = vi.fn();
  const prepare = vi.fn(() => renderMagnitude);
  try {
    for (let toggle = 0; toggle < 3; toggle++) {
      store.setStreamlineMagnitudeDisplayed(true);
      await cache.showMagnitude(magnitude, prepare);
      expect(store.varnameDisplay).toBe("wind_speed");
      expect(store.varinfo?.bounds).toEqual({ low: 0, high: 10 });
      expect(store.histogramSummary?.min).toBe(0);

      store.setStreamlineMagnitudeDisplayed(false);
      expect(await cache.restoreScalar()).toBe(true);
      expect(store.varnameDisplay).toBe("temperature");
      expect(store.varinfo).toEqual(scalarInfo);
      expect(store.fullHistogram).toEqual(scalarHistogram);
    }
    expect(prepare).toHaveBeenCalledOnce();
    expect(renderMagnitude).toHaveBeenCalledTimes(3);
    expect(renderScalar).toHaveBeenCalledTimes(4);
  } finally {
    scope.stop();
  }
});

it("finishes preparation once without showing magnitude after it was switched off", async () => {
  const { cache, store, scope, magnitude } = setupCache();
  const renderMagnitude = vi.fn();
  let finish!: (render: () => void) => void;
  const prepare = vi.fn(
    () => new Promise<() => void>((resolve) => (finish = resolve))
  );
  try {
    store.setStreamlineMagnitudeDisplayed(true);
    const first = cache.showMagnitude(magnitude, prepare);
    const second = cache.showMagnitude(magnitude, prepare);
    await Promise.resolve();
    store.setStreamlineMagnitudeDisplayed(false);
    await cache.restoreScalar();
    finish(renderMagnitude);
    await Promise.all([first, second]);
    expect(renderMagnitude).not.toHaveBeenCalled();
    expect(store.varnameDisplay).toBe("temperature");

    store.setStreamlineMagnitudeDisplayed(true);
    await cache.showMagnitude(magnitude, prepare);
    expect(prepare).toHaveBeenCalledOnce();
    expect(renderMagnitude).toHaveBeenCalledOnce();
  } finally {
    scope.stop();
  }
});

it("keeps the displayed magnitude and timestep while staging the next slice", async () => {
  const { cache, store, scope, magnitude, frame } = setupCache();
  const names: string[] = [];
  scope.run(() =>
    watch(
      () => store.varnameDisplay,
      (name) => names.push(name),
      { flush: "sync" }
    )
  );
  let finish!: (render: () => void) => void;
  try {
    store.setStreamlineMagnitudeDisplayed(true);
    await cache.showMagnitude(magnitude, () => vi.fn<() => void>());
    names.length = 0;
    const previousInfo = store.varinfo;
    const previousHistogram = store.histogramSummary;
    store.dimSlidersValues = [1];
    cache.captureScalar({
      ...frame,
      info: { ...frame.info, bounds: { low: 280, high: 300 } },
      indices: [1],
      data: new Float32Array([280, 300]),
    });
    const pending = cache.showMagnitude(
      { ...magnitude, data: new Float32Array([5, 20]), min: 5, max: 20 },
      () => new Promise<() => void>((resolve) => (finish = resolve))
    );
    await Promise.resolve();
    expect(store.varinfo).toBe(previousInfo);
    expect(store.histogramSummary).toBe(previousHistogram);
    expect(store.dimSlidersDisplay).toEqual([]);

    finish(vi.fn());
    await pending;
    expect(store.varnameDisplay).toBe("wind_speed");
    expect(store.varinfo?.bounds).toEqual({ low: 5, high: 20 });
    expect(store.dimSlidersDisplay).toEqual([1]);
    expect(names).not.toContain("temperature");
  } finally {
    scope.stop();
  }
});

it("discards pending displays when a new scalar slice is loaded", async () => {
  const { cache, store, scope, magnitude, frame } = setupCache();
  const staleRender = vi.fn();
  let finish!: (render: () => void) => void;
  try {
    store.setStreamlineMagnitudeDisplayed(true);
    const pending = cache.showMagnitude(
      magnitude,
      () => new Promise<() => void>((resolve) => (finish = resolve))
    );
    await Promise.resolve();
    cache.clear();
    expect(await cache.restoreScalar()).toBe(false);
    cache.captureScalar({ ...frame, render: vi.fn() });
    finish(staleRender);
    await pending;
    expect(staleRender).not.toHaveBeenCalled();

    const renderNext = vi.fn();
    const prepareNext = vi.fn(() => renderNext);
    await cache.showMagnitude({ ...magnitude }, prepareNext);
    expect(prepareNext).toHaveBeenCalledOnce();
    expect(renderNext).toHaveBeenCalledOnce();
  } finally {
    scope.stop();
  }
});
