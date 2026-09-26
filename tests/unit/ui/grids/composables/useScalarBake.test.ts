import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectScope, shallowRef } from "vue";

import type { TSources } from "@/lib/types/GlobeTypes.ts";
import type { TPreparedScalarFrame } from "@/ui/grids/composables/scalarFrame.ts";
import { scalarFrameMemory } from "@/ui/grids/composables/scalarFrameMemory.ts";
import { SCALAR_INTERPOLATION } from "@/ui/grids/composables/scalarTimeline.ts";
import {
  SCALAR_BAKE_PHASE,
  useScalarBake,
  type TScalarBakeHandle,
} from "@/ui/grids/composables/useScalarBake.ts";

vi.stubGlobal("localStorage", { getItem: () => null });
const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16)
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});
afterEach(() => vi.unstubAllGlobals());

function deferred() {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

// eslint-disable-next-line max-lines-per-function
function setup() {
  const store = useGlobeControlStore();
  store.varnameSelector = "temperature";
  store.dimSlidersValues = [0, 0, null];
  store.varinfo = {
    attrs: {},
    bounds: { low: 0, high: 3 },
    dimInfo: [
      {
        current: 0,
        values: [0, 2, 5, 8],
        attrs: { units: "days since 2000-01-01" },
      },
    ],
    dimRanges: [
      { name: "time", minBound: 0, maxBound: 3, startPos: 0 },
      { name: "level", minBound: 0, maxBound: 2, startPos: 0 },
      null,
    ],
  };
  const rendered: number[] = [];
  const options = {
    gate: undefined as Promise<void> | undefined,
    extraBytes: 0,
  };
  const prepare = vi.fn<TScalarBakeHandle["prepareScalarFrame"]>(
    async (input) => {
      await options.gate;
      expect(input!.chunkConcurrency).toBeGreaterThan(0);
      const time = input!.dimensionIndices!.time;
      const data = new Float32Array([time, time + 1]);
      const frame: TPreparedScalarFrame = {
        name: "temperature",
        interpolation: { values: [data], geometry: [], sample: () => null },
        data,
        indices: [time, 0],
        info: store.varinfo!,
        isCurrent: () =>
          !input!.signal?.aborted && (input!.isCurrent?.() ?? true),
        updateLayers: async () => {},
        render: () => {
          rendered.push(time);
        },
        memory: { ...scalarFrameMemory(data), extraBytes: options.extraBytes },
        timing: { totalMs: 20, fetchMs: 10 },
      };
      return frame;
    }
  );
  const handle = shallowRef<TScalarBakeHandle | null>({
    prepareScalarFrame: prepare,
    commitScalarFrame: vi.fn(async (frame) => {
      if (!frame.isCurrent()) {
        return false;
      }
      frame.render();
      return true;
    }),
    getScalarFrameLayout: vi.fn(async () => ({
      shape: [4, 3, 2],
      chunks: [2, 1, 2],
      bytesPerValue: 4,
    })),
  });
  const source = shallowRef({} as TSources);
  const scope = effectScope();
  const bake = scope.run(() =>
    useScalarBake(
      () => handle.value,
      () => source.value
    )
  )!;
  return { bake, scope, store, handle, source, prepare, rendered, options };
}
const config = { start: 0, end: 2 };

it("reuses calibration, bakes sequentially, seeks without fetches, and releases/restarts", async () => {
  const h = setup();
  try {
    await h.bake.plan(config);
    expect(h.bake.phase).toBe(SCALAR_BAKE_PHASE.PLANNED);
    expect(h.rendered).toEqual([]);
    expect(h.prepare).toHaveBeenCalledOnce();
    await h.bake.bake();
    expect(h.bake.phase).toBe(SCALAR_BAKE_PHASE.READY);
    expect(h.prepare).toHaveBeenCalledTimes(3);
    for (const index of [2, 1, 0]) {
      await h.bake.seek(index);
    }
    expect(h.rendered).toEqual([0, 2, 1, 0]);
    expect(h.prepare).toHaveBeenCalledTimes(3);
    h.bake.clear();
    expect(h.bake.estimate).toBeUndefined();
    expect(h.bake.completed).toBe(0);
    await h.bake.plan(config);
    expect(h.prepare).toHaveBeenCalledTimes(4);
  } finally {
    h.scope.stop();
  }
});

it("cancels pending calibration and releases late geometry", async () => {
  const h = setup();
  const gate = deferred();
  h.options.gate = gate.promise;
  try {
    const pending = h.bake.plan(config);
    await vi.waitFor(() => expect(h.prepare).toHaveBeenCalledOnce());
    const cache = h.prepare.mock.lastCall![0]!.geometryCache!;
    h.bake.clear();
    expect(h.bake.phase).toBe(SCALAR_BAKE_PHASE.CANCELLING);
    cache.set("late", new Float32Array(3));
    gate.finish();
    await pending;
    expect(cache.size).toBe(0);
    expect(h.bake.phase).toBe(SCALAR_BAKE_PHASE.EMPTY);
    expect(h.rendered).toEqual([]);
  } finally {
    gate.finish();
    h.scope.stop();
  }
});

it.each(["variable", "level", "source", "dataset", "volume"])(
  "invalidates prepared frames when %s changes",
  async (change) => {
    const h = setup();
    try {
      await h.bake.plan(config);
      if (change === "variable") {
        h.store.varnameSelector = "pressure";
      }
      if (change === "level") {
        h.store.dimSlidersValues[1] = 1;
      }
      if (change === "dataset") {
        h.source.value = {} as TSources;
      }
      if (change === "source") {
        h.handle.value = null;
      }
      if (change === "volume") {
        h.store.setVolumeLayerEnabled(true);
      }
      expect(h.bake.estimate).toBeUndefined();
      await h.bake.bake();
      expect(h.rendered).toEqual([]);
    } finally {
      h.scope.stop();
    }
  }
);

it("retains larger-than-estimated frames without a memory cutoff", async () => {
  const h = setup();
  try {
    await h.bake.plan(config);
    // Report large allocations without allocating them in the test process.
    h.options.extraBytes = 10 * 1024 ** 3;
    await h.bake.bake();
    expect(h.bake.phase).toBe(SCALAR_BAKE_PHASE.READY);
    expect(h.bake.message).toBe("");
    expect(h.bake.completed).toBe(3);
    expect(h.bake.estimate!.retainedBytes).toBeGreaterThan(20 * 1024 ** 3);
    expect(h.bake.estimate!.peakBytes).toBeGreaterThan(
      h.bake.estimate!.retainedBytes
    );
    expect(h.rendered).toEqual([0]);
  } finally {
    h.scope.stop();
  }
});

it("rejects live sources and incompatible active layers before fetching", async () => {
  const h = setup();
  try {
    h.store.live = true;
    await h.bake.plan(config);
    expect(h.bake.message).toContain("Live");
    expect(h.prepare).not.toHaveBeenCalled();
  } finally {
    h.scope.stop();
  }
});

it("plays at the selected cadence, pauses, and stops at the last keyframe", async () => {
  const h = setup();
  try {
    await h.bake.plan(config);
    await h.bake.bake();
    vi.useFakeTimers();
    h.bake.fps = 5;
    await h.bake.play();
    await vi.advanceTimersByTimeAsync(208);
    expect(h.bake.current).toBe(1);
    h.bake.pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.bake.current).toBe(1);
    await h.bake.play();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.bake.current).toBe(2);
    expect(h.bake.playing).toBe(false);
    expect(h.prepare).toHaveBeenCalledTimes(3);
  } finally {
    h.scope.stop();
    vi.useRealTimers();
  }
});

it("cancels during baking without scheduling or retaining later keyframes", async () => {
  const h = setup();
  const gate = deferred();
  try {
    await h.bake.plan(config);
    h.options.gate = gate.promise;
    const pending = h.bake.bake();
    await vi.waitFor(() => expect(h.prepare).toHaveBeenCalledTimes(2));
    h.bake.clear();
    gate.finish();
    await pending;
    expect(h.bake.phase).toBe(SCALAR_BAKE_PHASE.EMPTY);
    expect(h.bake.completed).toBe(0);
    expect(h.prepare).toHaveBeenCalledTimes(2);
    expect(h.rendered).toEqual([]);
  } finally {
    gate.finish();
    h.scope.stop();
  }
});

it("allows calibration and baking above the former memory ceiling", async () => {
  const h = setup();
  try {
    vi.mocked(h.handle.value!.getScalarFrameLayout).mockResolvedValue({
      shape: [4, 3, 100000000],
      chunks: [4, 3, 100000000],
      bytesPerValue: 4,
    });
    await h.bake.plan(config);
    expect(h.bake.phase).toBe(SCALAR_BAKE_PHASE.PLANNED);
    expect(h.bake.estimate!.peakBytes).toBeGreaterThan(8 * 1024 ** 3);
    expect(h.prepare).toHaveBeenCalledOnce();
    await h.bake.bake();
    expect(h.bake.phase).toBe(SCALAR_BAKE_PHASE.READY);
    expect(h.prepare).toHaveBeenCalledTimes(3);
    expect(h.bake.message).toBe("");
  } finally {
    h.scope.stop();
  }
});

it("releases a failed job and allows another estimate", async () => {
  const h = setup();
  try {
    await h.bake.plan(config);
    h.prepare.mockRejectedValueOnce(new Error("missing timestep"));
    await h.bake.bake();
    expect(h.bake.phase).toBe(SCALAR_BAKE_PHASE.ERROR);
    expect(h.bake.completed).toBe(0);
    expect(h.bake.message).toBe("missing timestep");
    await h.bake.plan(config);
    expect(h.bake.phase).toBe(SCALAR_BAKE_PHASE.PLANNED);
  } finally {
    h.scope.stop();
  }
});

it("releases pending work when its scope is disposed", async () => {
  const h = setup();
  const gate = deferred();
  h.options.gate = gate.promise;
  const pending = h.bake.plan(config);
  await vi.waitFor(() => expect(h.prepare).toHaveBeenCalledOnce());
  h.scope.stop();
  gate.finish();
  await pending;
  expect(h.bake.completed).toBe(0);
  expect(h.rendered).toEqual([]);
});

it.each([false, true])(
  "keeps the latest seek when an older commit finishes later (throws: %s)",
  async (throws) => {
    const h = setup();
    const gate = deferred();
    try {
      await h.bake.plan(config);
      await h.bake.bake();
      vi.mocked(h.handle.value!.commitScalarFrame).mockImplementationOnce(
        async () => {
          await gate.promise;
          if (throws) {
            throw new Error("obsolete commit failed");
          }
          return false;
        }
      );
      const pending = h.bake.seek(1);
      await h.bake.seek(2);
      gate.finish();
      await pending;
      expect(h.bake.phase).toBe(SCALAR_BAKE_PHASE.READY);
      expect(h.bake.current).toBe(2);
    } finally {
      gate.finish();
      h.scope.stop();
    }
  }
);

it("plays subdivisions through the final keyframe without preparing extra fields", async () => {
  const h = setup();
  try {
    await h.bake.plan(config);
    await h.bake.bake();
    const retained = h.bake.estimate!.retainedBytes;
    expect(h.bake.interpolationUnavailable).toBe("");
    expect(h.bake.unequalTimeGaps).toBe(true);
    h.bake.interpolationMode = SCALAR_INTERPOLATION.LINEAR;
    h.bake.intermediateFrames = 1;
    await h.bake.resetPlayback();
    expect(h.bake.frameCount).toBe(5);
    h.bake.fps = 2;
    vi.useFakeTimers();
    await h.bake.play();
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.bake.current).toBe(4);
    expect(h.bake.playing).toBe(false);
    const blends = vi
      .mocked(h.handle.value!.commitScalarFrame)
      .mock.calls.map((call) => call[1])
      .filter((blend) => !!blend);
    expect(blends.map((blend) => blend.alpha)).toEqual([0, 0.5, 0, 0.5, 1]);
    expect(blends[3].label).toBe("04 Jan 2000 • 12:00:00.000");
    expect(h.prepare).toHaveBeenCalledTimes(3);
    expect(h.bake.completed).toBe(3);
    expect(h.bake.estimate!.retainedBytes).toBe(retained);
    h.bake.intermediateFrames = 0.5;
    await h.bake.resetPlayback();
    await h.bake.play();
    expect(h.bake.frameCount).toBe(0);
    expect(h.bake.playing).toBe(false);
  } finally {
    h.scope.stop();
    vi.useRealTimers();
  }
});

it("keeps 30 fps deadlines across late display callbacks and avoids catch-up bursts", async () => {
  const h = setup();
  let callback: FrameRequestCallback | undefined;
  try {
    await h.bake.plan(config);
    await h.bake.bake();
    h.bake.interpolationMode = SCALAR_INTERPOLATION.LINEAR;
    h.bake.intermediateFrames = 10;
    await h.bake.resetPlayback();
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      callback = undefined;
    });
    h.bake.fps = 30;
    await h.bake.play();
    let previous = 0;
    for (const [time, expected] of [
      [16, 0],
      [34, 1],
      [50, 1],
      [68, 2],
      [84, 2],
      [102, 3],
      [1000, 4],
    ]) {
      await vi.advanceTimersByTimeAsync(time - previous);
      previous = time;
      const pending = callback;
      callback = undefined;
      await pending!(performance.now());
      expect(h.bake.current).toBe(expected);
    }
    expect(h.prepare).toHaveBeenCalledTimes(3);
    h.bake.pause();
    expect(callback).toBeUndefined();
    await h.bake.play();
    h.scope.stop();
    expect(callback).toBeUndefined();
  } finally {
    h.scope.stop();
    vi.useRealTimers();
  }
});

it("eases scalar values without easing timestamps or rebaking", async () => {
  const h = setup();
  try {
    await h.bake.plan(config);
    await h.bake.bake();
    h.bake.interpolationMode = SCALAR_INTERPOLATION.SMOOTHSTEP;
    h.bake.intermediateFrames = 3;
    await h.bake.resetPlayback();
    await h.bake.seek(1);
    expect(h.bake.frameCount).toBe(9);
    expect(
      vi.mocked(h.handle.value!.commitScalarFrame).mock.lastCall![1]
    ).toMatchObject({
      alpha: 5 / 32,
      label: "01 Jan 2000 • 12:00:00.000",
    });
    h.bake.interpolationMode = SCALAR_INTERPOLATION.LINEAR;
    await h.bake.seek(1);
    expect(
      vi.mocked(h.handle.value!.commitScalarFrame).mock.lastCall![1]
    ).toMatchObject({
      alpha: 0.25,
      label: "01 Jan 2000 • 12:00:00.000",
    });
    h.bake.interpolationMode = SCALAR_INTERPOLATION.SMOOTHSTEP;
    h.bake.interpolationUnavailable = "Source timestamps are incompatible.";
    await h.bake.play();
    expect(h.bake.playing).toBe(false);
    expect(h.prepare).toHaveBeenCalledTimes(3);
  } finally {
    h.scope.stop();
  }
});
