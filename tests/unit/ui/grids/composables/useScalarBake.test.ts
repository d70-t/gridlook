import { beforeEach, expect, it, vi } from "vitest";
import { effectScope, shallowRef } from "vue";

import type { TSources } from "@/lib/types/GlobeTypes.ts";
import type { TPreparedScalarFrame } from "@/ui/grids/composables/scalarFrame.ts";
import { scalarFrameMemory } from "@/ui/grids/composables/scalarFrameMemory.ts";
import {
  SCALAR_BAKE_PHASE,
  useScalarBake,
  type TScalarBakeHandle,
} from "@/ui/grids/composables/useScalarBake.ts";

vi.stubGlobal("localStorage", { getItem: () => null });
const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
beforeEach(() => setActivePinia(createPinia()));

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
    dimInfo: [],
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
    await vi.advanceTimersByTimeAsync(200);
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
