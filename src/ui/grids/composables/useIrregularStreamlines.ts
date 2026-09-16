import type * as THREE from "three";
import { onScopeDispose, type ComputedRef } from "vue";
import type * as zarr from "zarrita";

import { loadVectorComponents } from "./streamlineData.ts";
import { useStreamlineLayer } from "./useStreamlineLayer.ts";

import {
  IrregularVectorField,
  resolveVectorVariablePair,
  type TVectorVariablePair,
  type TVectorFieldBuildOptions,
} from "@/lib/data/vectorField.ts";
import {
  createVectorMagnitudeData,
  type TVectorMagnitudeData,
} from "@/lib/data/vectorMagnitude.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";

type TDataVar = zarr.Array<zarr.DataType, zarr.AsyncReadable>;

export type TIrregularStreamlineContext = {
  latitudes: Float32Array;
  longitudes: Float32Array;
  dimensionNames: string[];
  indices: (number | null | zarr.Slice)[];
  spatialDimensionNames: string[];
};

type TOptions = {
  getDatasources: () => TSources | undefined;
  getPreferredVariable: () => string;
  getDataVar: (
    varname: string,
    datasources: TSources
  ) => Promise<TDataVar | undefined>;
  getScene: () => THREE.Scene | undefined;
  redraw: () => void;
  projectionHelper: ComputedRef<ProjectionHelper>;
  onProjectionChange: (callback: () => void) => void;
  registerAnimationCallback: (
    callback: (deltaSeconds: number) => void
  ) => () => void;
  showMagnitude: (result: TVectorMagnitudeData) => void | Promise<void>;
};

function requestKey(
  context: TIrregularStreamlineContext,
  pair: TVectorVariablePair,
  levelIndex: number
) {
  return JSON.stringify({
    indices: context.indices,
    spatialDimensions: context.spatialDimensionNames,
    pair: [pair.u, pair.v],
    levelIndex,
  });
}

async function createVectorField(
  options: TOptions,
  datasources: TSources,
  context: TIrregularStreamlineContext,
  pair: TVectorVariablePair,
  selectedLevelIndex: number,
  prepareField: () => Promise<boolean>,
  buildOptions: TVectorFieldBuildOptions
) {
  const components = await loadVectorComponents({
    pair,
    datasources,
    getDataVar: options.getDataVar,
    currentDimensionNames: context.dimensionNames,
    currentIndices: context.indices,
    spatialDimensionNames: context.spatialDimensionNames,
    expectedDataLength: context.latitudes.length,
    selectedLevelIndex,
  });
  if (!components || !(await prepareField())) {
    return undefined;
  }
  const field = await IrregularVectorField.create(
    context.latitudes,
    context.longitudes,
    components.uData,
    components.vData,
    buildOptions
  );
  if (!field) {
    return undefined;
  }
  return {
    field,
    levelInfo: components.levelInfo,
    magnitudeInfo: components.magnitudeInfo,
    magnitude:
      components.magnitudeInfo && components.canDeriveMagnitude
        ? createVectorMagnitudeData(
            components.uData,
            components.vData,
            components.magnitudeInfo
          )
        : undefined,
  };
}

// eslint-disable-next-line max-lines-per-function
export function useIrregularStreamlines(options: TOptions) {
  const store = useGlobeControlStore();
  const { logError } = useLog();
  const layer = useStreamlineLayer(options);
  let currentContext: TIrregularStreamlineContext | undefined;
  let requestRevision = 0;
  let cachedMagnitude: TVectorMagnitudeData | undefined;
  let cachedRequestKey: string | undefined;

  // eslint-disable-next-line max-lines-per-function
  async function refresh(reuseCached = false) {
    const revision = ++requestRevision;
    const datasources = options.getDatasources();
    const context = currentContext;
    const pair = resolveVectorVariablePair(
      Object.keys(datasources?.levels[0]?.datasources ?? {}),
      options.getPreferredVariable(),
      store.streamlineSelection,
      store.isStreamlineLayerEnabled() ? store.streamlinePair : undefined
    );
    const key =
      context && pair
        ? requestKey(context, pair, store.streamlineLevelIndex)
        : undefined;
    if (reuseCached && key === cachedRequestKey && layer.showCached()) {
      if (store.streamlineMagnitudeDisplayed && cachedMagnitude) {
        await options.showMagnitude(cachedMagnitude);
      }
      return;
    }
    if (!datasources || !context || !pair) {
      cachedMagnitude = undefined;
      cachedRequestKey = undefined;
      store.setStreamlineMagnitudeInfo(undefined);
      layer.clear();
      return;
    }
    if (!store.isStreamlineLayerEnabled()) {
      if (key === cachedRequestKey) {
        store.setStreamlinePair(pair);
      } else {
        cachedMagnitude = undefined;
        cachedRequestKey = undefined;
        store.setStreamlineMagnitudeInfo(undefined);
        layer.setAvailablePair(pair);
      }
      return;
    }
    layer.startLoading();
    try {
      const result = await createVectorField(
        options,
        datasources,
        context,
        pair,
        store.streamlineLevelIndex,
        () => layer.prepareField(() => revision === requestRevision),
        {
          isCancelled: () =>
            revision !== requestRevision || !store.isStreamlineLayerEnabled(),
          onProgress: (progress) => {
            if (
              revision === requestRevision &&
              store.isStreamlineLayerEnabled()
            ) {
              store.streamlineProgress = progress;
            }
          },
        }
      );
      if (revision !== requestRevision) {
        return;
      }
      store.setStreamlineLevelInfo(result?.levelInfo);
      if (!result) {
        cachedMagnitude = undefined;
        cachedRequestKey = undefined;
        store.setStreamlineMagnitudeInfo(undefined);
        layer.clear();
        return;
      }
      const rendered = await layer.setField(
        result.field,
        pair,
        () => revision === requestRevision
      );
      if (!rendered || revision !== requestRevision) {
        return;
      }
      store.setStreamlineMagnitudeInfo(
        result.magnitudeInfo,
        Boolean(result.magnitude)
      );
      cachedMagnitude = result.magnitude;
      cachedRequestKey = key;
      if (store.streamlineMagnitudeDisplayed && result.magnitude) {
        await options.showMagnitude(result.magnitude);
      }
    } catch (error) {
      if (revision === requestRevision) {
        layer.clear();
        logError(error, "Could not render vector streamlines");
      }
    }
  }

  async function setContext(context: TIrregularStreamlineContext) {
    currentContext = context;
    await refresh();
  }

  onScopeDispose(() => {
    currentContext = undefined;
    cachedMagnitude = undefined;
    requestRevision++;
    store.streamlineLoading = false;
    store.streamlineProgress = undefined;
  });

  function suspend() {
    requestRevision++;
    store.streamlineLoading = false;
    store.streamlineProgress = undefined;
  }

  return { clear: layer.clear, refresh, setContext, suspend };
}
