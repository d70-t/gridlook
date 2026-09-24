import { onScopeDispose } from "vue";
import type * as zarr from "zarrita";

import type {
  TPreparedScalarFrame,
  TScalarFrameInput,
  TScalarFrameRequest,
} from "./scalarFrame.ts";
import { createGridHistogramSummary } from "./useGridHistogram.ts";
import type { useScalarFieldCache } from "./useScalarFieldCache.ts";

import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";

type TDataVar = zarr.Array<zarr.DataType, zarr.AsyncReadable>;
export type TScalarFramesOptions = {
  getDatasources: () => TSources | undefined;
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
  let disposed = false;
  let displayRevision = 0;
  onScopeDispose(() => {
    disposed = true;
    displayRevision++;
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
      isCurrent: () =>
        !disposed &&
        !signal?.aborted &&
        (isCurrent?.() ?? true) &&
        datasources === options.getDatasources() &&
        variable === store.varnameSelector,
    } satisfies TScalarFrameRequest;
  }

  async function prepareScalarFrame(input: TScalarFrameInput = {}) {
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
    // Worker-level abort belongs with the bounded bake executor.
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
    return {
      ...frame,
      histogram: createGridHistogramSummary(
        frame.data,
        frame.info.bounds.low ?? NaN,
        frame.info.bounds.high ?? NaN,
        frame.missingValue,
        frame.fillValue
      ),
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

  async function commitScalarFrame(frame: TPreparedScalarFrame) {
    if (disposed || !frame.isCurrent()) {
      return false;
    }
    const revision = ++displayRevision;
    const isCurrent = () =>
      !disposed && revision === displayRevision && frame.isCurrent();
    options.scalarCache.captureScalar({ ...frame, isCurrent });
    await frame.updateLayers();
    if (!isCurrent()) {
      return false;
    }
    if (!store.streamlineMagnitudeDisplayed) {
      await options.scalarCache.restoreScalar();
    }
    return isCurrent();
  }

  return { prepareScalarFrame, commitScalarFrame };
}
