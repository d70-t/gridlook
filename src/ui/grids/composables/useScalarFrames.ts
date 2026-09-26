import { onScopeDispose } from "vue";
import type * as zarr from "zarrita";

import type { useGridHoverLookup } from "./gridHoverUtils.ts";
import type {
  TPreparedScalarFrame,
  TScalarFrameInput,
  TScalarFrameRequest,
  TScalarFrameLayout,
} from "./scalarFrame.ts";
import { scalarFrameMemory } from "./scalarFrameMemory.ts";
import {
  compatibleScalarFrames,
  createScalarInterpolator,
  interpolateScalarSample,
  type TScalarObject,
} from "./scalarInterpolation.ts";
import { createGridHistogramSummary } from "./useGridHistogram.ts";
import type { useScalarFieldCache } from "./useScalarFieldCache.ts";

import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";

type TDataVar = zarr.Array<zarr.DataType, zarr.AsyncReadable>;
export type TScalarFramesOptions = {
  getDatasources: () => TSources | undefined;
  getScalarObjects?: () => (TScalarObject | undefined)[];
  setHoverLookup?: ReturnType<typeof useGridHoverLookup>["setHoverLookup"];
  getDataVar: (
    variable: string,
    sources: TSources
  ) => Promise<TDataVar | undefined>;
  prepareFrame: (
    datavar: TDataVar,
    request: TScalarFrameRequest
  ) => Promise<TPreparedScalarFrame | undefined>;
  scalarCache: Pick<
    ReturnType<typeof useScalarFieldCache>,
    "captureScalar" | "restoreScalar" | "clear"
  >;
};

// eslint-disable-next-line max-lines-per-function
export function useScalarFrames(options: TScalarFramesOptions) {
  const store = useGlobeControlStore();
  const parameters = useUrlParameterStore();
  const interpolation = createScalarInterpolator(
    options.getScalarObjects ?? (() => [])
  );
  let disposed = false;
  let displayRevision = 0;
  let layerFrame: TPreparedScalarFrame | undefined;
  onScopeDispose(() => {
    disposed = true;
    displayRevision++;
    interpolation.clear();
  });

  function createRequest(input: TScalarFrameInput) {
    const datasources = options.getDatasources();
    const variable = store.varnameSelector;
    const { signal, isCurrent } = input;
    if (!datasources) {
      return;
    }
    return {
      datasources,
      variable,
      dimensionIndices: { ...input.dimensionIndices },
      sliderIndices: store.dimSlidersValues.length
        ? [...store.dimSlidersValues]
        : null,
      dimensionRanges: store.varinfo?.dimRanges.map(
        (range) => range && { ...range }
      ),
      presetIndices: { ...parameters.paramDimIndices },
      presetMinBounds: { ...parameters.paramDimMinBounds },
      presetMaxBounds: { ...parameters.paramDimMaxBounds },
      signal,
      geometryCache: input.geometryCache,
      chunkConcurrency: input.chunkConcurrency,
      timing: { fetchMs: 0 },
      isCurrent: () =>
        !disposed &&
        !signal?.aborted &&
        (isCurrent?.() ?? true) &&
        datasources === options.getDatasources() &&
        variable === store.varnameSelector,
    } satisfies TScalarFrameRequest;
  }

  // eslint-disable-next-line max-lines-per-function
  async function prepareScalarFrame(
    input: TScalarFrameInput = {}
  ): Promise<TPreparedScalarFrame | undefined> {
    const start = performance.now();
    const request = createRequest(input);
    if (!request?.isCurrent()) {
      return;
    }
    const datavar = await options.getDataVar(
      request.variable,
      request.datasources
    );
    if (!datavar || !request.isCurrent()) {
      return;
    }
    // ponytail: in-flight worker work finishes; cancellation discards its result.
    // The bake executor waits for this work before accepting another job.
    let frame: TPreparedScalarFrame | undefined;
    try {
      frame = await options.prepareFrame(datavar, request);
    } catch (error) {
      if (!request.isCurrent()) {
        return;
      }
      throw error;
    }
    if (!frame || !request.isCurrent()) {
      return;
    }
    const histogram = createGridHistogramSummary(
      frame.data,
      frame.info.bounds.low ?? NaN,
      frame.info.bounds.high ?? NaN,
      frame.missingValue,
      frame.fillValue
    );
    if (frame.memory) {
      const histogramMemory = scalarFrameMemory(undefined, histogram);
      frame.memory = {
        ...frame.memory,
        buffers: [...frame.memory.buffers, ...histogramMemory.buffers],
        extraBytes: frame.memory.extraBytes + histogramMemory.extraBytes,
      };
    }
    return {
      ...frame,
      timing: {
        fetchMs: request.timing.fetchMs,
        totalMs: performance.now() - start,
      },
      histogram,
      updateLayers: async () => {
        for (const [name, value] of Object.entries(request.presetIndices)) {
          if (parameters.paramDimIndices[name] === value) {
            delete parameters.paramDimIndices[name];
          }
        }
        await frame.updateLayers();
      },
    };
  }

  // eslint-disable-next-line max-lines-per-function
  async function commitScalarFrame(
    frame: TPreparedScalarFrame,
    blend?: {
      next: TPreparedScalarFrame;
      alpha: number;
      timeIndex: number;
      label: string;
    }
  ) {
    if (disposed || !frame.isCurrent()) {
      return false;
    }
    if (blend) {
      if (
        !options.getScalarObjects ||
        !compatibleScalarFrames(frame, blend.next) ||
        !Number.isFinite(blend.alpha) ||
        blend.alpha < 0 ||
        blend.alpha > 1 ||
        !blend.next.isCurrent()
      ) {
        throw new Error(
          "These scalar frames cannot be interpolated on the same grid."
        );
      }
      const first = frame;
      const { next, alpha } = blend;
      const endpoint = alpha === 1 ? next : first;
      frame = {
        ...endpoint,
        histogram: alpha === 0 || alpha === 1 ? endpoint.histogram : undefined,
        isCurrent: () => first.isCurrent() && next.isCurrent(),
        updateLayers: async () => {
          if (layerFrame !== endpoint) {
            await endpoint.updateLayers();
            layerFrame = endpoint;
          }
        },
        render: () => {
          interpolation.render(first, next, alpha);
          options.setHoverLookup?.((lat, lon) =>
            interpolateScalarSample(
              first.interpolation!,
              next.interpolation!,
              alpha,
              lat,
              lon
            )
          );
        },
      };
    } else {
      interpolation.clear();
      layerFrame = undefined;
      store.scalarAnimationBounds = undefined;
    }
    const revision = ++displayRevision;
    const displayedRequest = createRequest({})!;
    let committed = false;
    // A completed frame becomes the ordinary scalar background. Releasing the
    // bake must not invalidate later colormap or vector-background interactions.
    const isCurrent = () =>
      !disposed &&
      revision === displayRevision &&
      (committed ? displayedRequest.isCurrent() : frame.isCurrent());
    options.scalarCache.captureScalar({ ...frame, isCurrent });
    await frame.updateLayers();
    if (!isCurrent()) {
      return false;
    }
    if (!store.streamlineMagnitudeDisplayed) {
      await options.scalarCache.restoreScalar();
    }
    if (!isCurrent()) {
      return false;
    }
    committed = true;
    store.scalarAnimationTime = blend
      ? { index: blend.timeIndex, label: blend.label }
      : undefined;
    return true;
  }

  async function getScalarFrameLayout(): Promise<
    TScalarFrameLayout | undefined
  > {
    const request = createRequest({});
    if (!request) {
      return;
    }
    const array = await options.getDataVar(
      request.variable,
      request.datasources
    );
    if (!array || !request.isCurrent()) {
      return;
    }
    const bits = /^(?:u?int|float)(8|16|32|64)$/.exec(array.dtype)?.[1];
    if (!bits) {
      throw new Error("Baking requires a numeric scalar variable.");
    }
    return {
      shape: [...array.shape],
      chunks: [...array.chunks],
      bytesPerValue: Number(bits) / 8,
    };
  }

  return { prepareScalarFrame, commitScalarFrame, getScalarFrameLayout };
}
