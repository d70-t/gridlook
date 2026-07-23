import type * as THREE from "three";
import type { ComputedRef } from "vue";
import type * as zarr from "zarrita";

import { loadVectorComponents } from "./streamlineData.ts";
import { useStreamlineLayer } from "./useStreamlineLayer.ts";

import {
  IrregularVectorField,
  resolveVectorVariablePair,
  type TVectorVariablePair,
} from "@/lib/data/vectorField.ts";
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
};

async function createVectorField(
  options: TOptions,
  datasources: TSources,
  context: TIrregularStreamlineContext,
  pair: TVectorVariablePair
) {
  const components = await loadVectorComponents({
    pair,
    datasources,
    getDataVar: options.getDataVar,
    currentDimensionNames: context.dimensionNames,
    currentIndices: context.indices,
    spatialDimensionNames: context.spatialDimensionNames,
    expectedDataLength: context.latitudes.length,
  });
  return components
    ? new IrregularVectorField(
        context.latitudes,
        context.longitudes,
        components.uData,
        components.vData
      )
    : undefined;
}

// eslint-disable-next-line max-lines-per-function
export function useIrregularStreamlines(options: TOptions) {
  const store = useGlobeControlStore();
  const { logError } = useLog();
  const layer = useStreamlineLayer(options);
  let currentContext: TIrregularStreamlineContext | undefined;
  let requestRevision = 0;

  async function refresh() {
    const revision = ++requestRevision;
    const datasources = options.getDatasources();
    const context = currentContext;
    const pair = resolveVectorVariablePair(
      Object.keys(datasources?.levels[0]?.datasources ?? {}),
      options.getPreferredVariable(),
      store.streamlineSelection
    );
    if (!datasources || !context || !pair) {
      layer.clear();
      return;
    }
    if (!store.isStreamlineLayerEnabled()) {
      layer.setAvailablePair(pair);
      return;
    }
    try {
      const field = await createVectorField(
        options,
        datasources,
        context,
        pair
      );
      if (revision !== requestRevision) {
        return;
      }
      if (!field) {
        layer.clear();
        return;
      }
      layer.setField(field, pair);
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

  return { clear: layer.clear, refresh, setContext };
}
