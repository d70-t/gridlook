import { beforeEach, expect, it, vi } from "vitest";
import { effectScope } from "vue";
import type * as zarr from "zarrita";

import type { TSources } from "@/lib/types/GlobeTypes.ts";
import type { TPreparedVolumeFrame } from "@/lib/volume/volumeFrame.ts";
import { VOLUME_GRID_TYPES } from "@/lib/volume/volumeGrid.ts";
import {
  getScalarFrameDimensions,
  decodeScalarFrameData,
  type TScalarFrameRequest,
  type TPreparedScalarFrame,
} from "@/ui/grids/composables/scalarFrame.ts";
import type { TScalarFramesOptions } from "@/ui/grids/composables/useScalarFrames.ts";

vi.stubGlobal("localStorage", { getItem: () => null });
const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useUrlParameterStore } = await import("@/store/paramStore.ts");
const { useScalarFieldCache } =
  await import("@/ui/grids/composables/useScalarFieldCache.ts");
const { useScalarFrames } =
  await import("@/ui/grids/composables/useScalarFrames.ts");

beforeEach(() => setActivePinia(createPinia()));

function deferred() {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: finish };
}

// eslint-disable-next-line max-lines-per-function
function setup(volume?: TScalarFramesOptions["volume"]) {
  const store = useGlobeControlStore();
  const parameters = useUrlParameterStore();
  store.varnameSelector = "temperature";
  store.varnameDisplay = "previous";
  store.dimSlidersValues = [0];
  store.dimSlidersDisplay = [0];
  const datavar = { shape: [4, 2], attrs: {} } as zarr.Array<
    zarr.DataType,
    zarr.AsyncReadable
  >;
  const source = { current: {} as TSources };
  const metadata = deferred();
  const ready = deferred();
  const rendered: number[] = [];
  const updateLayers = vi.fn(async () => {});
  const getDataVar = vi.fn(async () => {
    await metadata.promise;
    return datavar;
  });
  const prepareFrame = vi.fn(
    async (
      array: typeof datavar,
      request: TScalarFrameRequest
    ): Promise<TPreparedScalarFrame> => {
      await ready.promise;
      const { indices, dimensionRanges } = getScalarFrameDimensions(
        array,
        ["time", "cell"],
        [1],
        request
      );
      const time = indices[0] as number;
      return {
        name: request.variable,
        volumeContext: volume
          ? {
              dimensionNames: ["time", "cell"],
              indices,
              grid: {
                kind: VOLUME_GRID_TYPES.HEALPIX,
                nside: 1,
                options: { level: 0, scheme: "nested" },
              },
            }
          : undefined,
        memory: { buffers: [], extraBytes: 0, gpuBytes: 0 },
        interpolation: { values: [], geometry: [], sample: () => null },
        indices: indices as number[],
        isCurrent: request.isCurrent,
        info: {
          attrs: array.attrs,
          dimRanges: dimensionRanges,
          bounds: { low: time, high: time + 1 },
          dimInfo: [
            {
              current: BigInt(time * 3),
              values: [0n, 3n, 6n, 9n],
              attrs: { units: "hours since 0001-01-01", calendar: "noleap" },
            },
            {},
          ],
        },
        data: new Float32Array([time, time + 1]),
        render: () => {
          rendered.push(time);
        },
        updateLayers,
      };
    }
  );
  const scope = effectScope();
  let cache!: ReturnType<typeof useScalarFieldCache>;
  const frames = scope.run(() =>
    useScalarFrames({
      volume,
      getDatasources: () => source.current,
      getScalarObjects: () => [],
      getDataVar,
      prepareFrame,
      scalarCache: (cache = useScalarFieldCache({
        updateHistogram: vi.fn(),
        updateColormap: vi.fn(),
        redraw: vi.fn(),
      })),
    })
  )!;
  return {
    ...frames,
    cache,
    store,
    parameters,
    source,
    scope,
    metadata,
    ready,
    getDataVar,
    prepareFrame,
    rendered,
    updateLayers,
  };
}

it("prepares captured source selections without changing display or consuming URL presets", async () => {
  const h = setup();
  try {
    h.parameters.paramDimIndices = { time: "1" };
    const selection = { time: 2 };
    const pending = h.prepareScalarFrame({ dimensionIndices: selection });
    selection.time = 3;
    h.metadata.resolve();
    h.ready.resolve();
    const frame = (await pending)!;
    expect(frame.indices).toEqual([2, null]);
    expect(frame.info.dimInfo[0]).toMatchObject({
      current: 6n,
      attrs: { calendar: "noleap" },
    });
    expect(frame.histogram?.min).toBe(2);
    expect(h.parameters.paramDimIndices).toEqual({ time: "1" });
    expect(h.store.dimSlidersValues).toEqual([0]);
    expect(h.store.dimSlidersDisplay).toEqual([0]);
    expect(h.store.varnameDisplay).toBe("previous");
    expect(h.store.loading).toBe(false);
    expect(h.rendered).toEqual([]);
    expect(h.updateLayers).not.toHaveBeenCalled();
    expect(await h.commitScalarFrame(frame)).toBe(true);
    expect(h.store.dimSlidersDisplay).toEqual([2, null]);
    expect(h.store.varnameDisplay).toBe("temperature");
    expect(h.rendered).toEqual([2]);
    expect(h.parameters.paramDimIndices).toEqual({});
    expect(h.getDataVar).toHaveBeenCalledOnce();
  } finally {
    h.scope.stop();
  }
});

it.each(["before metadata", "during preparation", "after preparation"])(
  "cancels %s without rendering",
  async (stage) => {
    const h = setup();
    const controller = new AbortController();
    try {
      const pending = h.prepareScalarFrame({
        dimensionIndices: { time: 1 },
        signal: controller.signal,
      });
      if (stage === "before metadata") {
        controller.abort();
      }
      h.metadata.resolve();
      if (stage !== "before metadata") {
        await vi.waitFor(() => expect(h.prepareFrame).toHaveBeenCalledOnce());
      }
      if (stage === "during preparation") {
        controller.abort();
      }
      h.ready.resolve();
      const frame = await pending;
      if (stage === "after preparation") {
        controller.abort();
        expect(await h.commitScalarFrame(frame!)).toBe(false);
      } else {
        expect(frame).toBeUndefined();
      }
      expect(h.rendered).toEqual([]);
      expect(h.updateLayers).not.toHaveBeenCalled();
      expect(h.store.varnameDisplay).toBe("previous");
      expect(h.store.dimSlidersDisplay).toEqual([0]);
    } finally {
      h.scope.stop();
    }
  }
);

it.each(["dispose", "source", "variable"])(
  "rejects a prepared frame after %s changes",
  async (change) => {
    const h = setup();
    try {
      h.metadata.resolve();
      h.ready.resolve();
      const frame = (await h.prepareScalarFrame({
        dimensionIndices: { time: 1 },
      }))!;
      if (change === "dispose") {
        h.scope.stop();
      }
      if (change === "source") {
        h.source.current = {} as TSources;
      }
      if (change === "variable") {
        h.store.varnameSelector = "pressure";
      }
      expect(await h.commitScalarFrame(frame)).toBe(false);
      expect(h.rendered).toEqual([]);
      expect(h.updateLayers).not.toHaveBeenCalled();
    } finally {
      h.scope.stop();
    }
  }
);

it.each<Record<string, number>>([
  { time: -1 },
  { time: 4 },
  { time: 0.5 },
  { cell: 1 },
  { missing: 0 },
])(
  "rejects invalid or spatial frame selection %j",
  async (dimensionIndices) => {
    const h = setup();
    try {
      h.metadata.resolve();
      h.ready.resolve();
      await expect(h.prepareScalarFrame({ dimensionIndices })).rejects.toThrow(
        "Invalid scalar frame index"
      );
      expect(h.rendered).toEqual([]);
    } finally {
      h.scope.stop();
    }
  }
);

it("keeps the newest commit when older layer synchronization finishes later", async () => {
  const h = setup();
  const olderLayers = deferred();
  try {
    h.metadata.resolve();
    h.ready.resolve();
    const first = (await h.prepareScalarFrame({
      dimensionIndices: { time: 1 },
    }))!;
    const second = (await h.prepareScalarFrame({
      dimensionIndices: { time: 2 },
    }))!;
    h.updateLayers.mockImplementationOnce(() => olderLayers.promise);
    const pending = h.commitScalarFrame(first);
    expect(await h.commitScalarFrame(second)).toBe(true);
    olderLayers.resolve();
    expect(await pending).toBe(false);
    expect(h.rendered).toEqual([2]);
    expect(h.store.dimSlidersDisplay).toEqual([2, null]);
    expect(h.store.varinfo?.bounds).toEqual({ low: 2, high: 3 });
  } finally {
    olderLayers.resolve();
    h.scope.stop();
  }
});

it("keeps the committed background usable after releasing its bake", async () => {
  const h = setup();
  const controller = new AbortController();
  try {
    h.metadata.resolve();
    h.ready.resolve();
    const frame = (await h.prepareScalarFrame({
      dimensionIndices: { time: 2 },
      signal: controller.signal,
    }))!;
    expect(await h.commitScalarFrame(frame)).toBe(true);
    controller.abort();
    expect(await h.commitScalarFrame(frame)).toBe(false);
    expect(await h.cache.restoreScalar()).toBe(true);
    expect(h.store.dimSlidersDisplay).toEqual([2, null]);
  } finally {
    h.scope.stop();
  }
});

it("updates dependent layer context only at source boundaries during interpolation", async () => {
  const h = setup();
  try {
    h.metadata.resolve();
    h.ready.resolve();
    const first = (await h.prepareScalarFrame({
      dimensionIndices: { time: 0 },
    }))!;
    const next = (await h.prepareScalarFrame({
      dimensionIndices: { time: 1 },
    }))!;
    for (const alpha of [0.25, 0.5, 0.75]) {
      expect(
        await h.commitScalarFrame(first, {
          next,
          alpha,
          timeIndex: 0,
          label: "intermediate",
        })
      ).toBe(true);
    }
    expect(h.updateLayers).toHaveBeenCalledOnce();
    expect(h.rendered).toEqual([0]);
    expect(h.store.scalarAnimationTime?.label).toBe("intermediate");
    await h.commitScalarFrame(first, {
      next,
      alpha: 1,
      timeIndex: 0,
      label: "endpoint",
    });
    expect(h.updateLayers).toHaveBeenCalledTimes(2);
    expect(h.store.dimSlidersDisplay[0]).toBe(1);
    await h.commitScalarFrame(first);
    expect(h.updateLayers).toHaveBeenCalledTimes(3);
    expect(h.store.scalarAnimationTime).toBeUndefined();
  } finally {
    h.scope.stop();
  }
});

it("does not apply source packing or missing values to prepared magnitude", () => {
  const data = new Float32Array([0, 5, NaN, 10]);
  const result = decodeScalarFrameData(
    {
      attrs: { ["scale_factor"]: 2, ["add_offset"]: 100, ["_FillValue"]: 0 },
    } as never,
    data,
    {
      magnitude: {
        data,
        min: 0,
        max: 10,
        units: "m s-1",
        longName: "Wind speed",
      },
    } as TScalarFrameRequest
  );
  expect(result).toEqual({
    min: 0,
    max: 10,
    missingValue: NaN,
    fillValue: NaN,
  });
  expect([...data]).toEqual([0, 5, NaN, 10]);
});

// eslint-disable-next-line max-lines-per-function
it("awaits original-time volumes before exposing prepared frames and reuses them at commit", async () => {
  const gate = deferred();
  const volume = {
    prepareFrame: vi.fn(async () => {
      await gate.promise;
      return {
        data: new Uint8Array([2, 3]),
        timing: { fetchMs: 4, totalMs: 5 },
        plan: { context: { grid: {} } },
      } as TPreparedVolumeFrame;
    }),
    commitInterpolation: vi.fn(() => true),
    setContext: vi.fn(async () => {}),
  };
  const h = setup(volume);
  try {
    h.store.setVolumeLayerEnabled(true);
    h.metadata.resolve();
    h.ready.resolve();
    let prepared = false;
    const pending = h
      .prepareScalarFrame({
        dimensionIndices: { time: 2 },
        prepareVolume: true,
      })
      .then((frame) => {
        prepared = true;
        return frame!;
      });
    await vi.waitFor(() => expect(volume.prepareFrame).toHaveBeenCalledOnce());
    expect(prepared).toBe(false);
    expect(h.rendered).toEqual([]);
    expect(volume.setContext).not.toHaveBeenCalled();
    gate.resolve();
    const frame = await pending;
    expect(volume.prepareFrame).toHaveBeenCalledWith(
      frame.volumeContext,
      expect.objectContaining({ isCurrent: expect.any(Function) })
    );
    expect(frame.volumeContext!.indices[0]).toBe(2);
    expect(frame.memory!.buffers).toContain(frame.volume!.data.buffer);
    expect(frame.memory!.gpuBytes).toBe(2);
    expect(await h.commitScalarFrame(frame)).toBe(true);
    expect(volume.setContext).toHaveBeenLastCalledWith(
      frame.volumeContext,
      frame.volume,
      expect.any(Function)
    );
    expect(h.rendered).toEqual([2]);
    expect(await h.commitScalarFrame(frame)).toBe(true);
    expect(volume.prepareFrame).toHaveBeenCalledOnce();
    await expect(
      h.commitScalarFrame(frame, {
        next: frame,
        alpha: 0.5,
        timeIndex: 2,
        label: "2",
      })
    ).rejects.toThrow(/prepared time range/);
  } finally {
    h.scope.stop();
  }
});

it("waits for live volume commit and discards cancellation during volume preparation", async () => {
  const gate = deferred();
  const volume = {
    prepareFrame: vi.fn(),
    commitInterpolation: vi.fn(() => true),
    setContext: vi.fn(() => gate.promise),
  };
  const h = setup(volume);
  try {
    h.metadata.resolve();
    h.ready.resolve();
    const frame = (await h.prepareScalarFrame())!;
    const committing = h.commitScalarFrame(frame);
    await vi.waitFor(() => expect(volume.setContext).toHaveBeenCalledOnce());
    expect(h.rendered).toEqual([]);
    gate.resolve();
    expect(await committing).toBe(true);
    expect(h.rendered).toEqual([0]);
    h.store.setVolumeLayerEnabled(true);
    const controller = new AbortController();
    volume.prepareFrame.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException("Cancelled", "AbortError");
    });
    expect(
      await h.prepareScalarFrame({
        prepareVolume: true,
        signal: controller.signal,
      })
    ).toBeUndefined();
    expect(h.rendered).toEqual([0]);
  } finally {
    h.scope.stop();
  }
});
