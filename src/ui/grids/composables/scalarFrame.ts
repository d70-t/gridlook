import type * as zarr from "zarrita";

import type {
  TScalarFrameMemory,
  TScalarGeometryCache,
} from "./scalarFrameMemory.ts";
import type { TScalarInterpolationData } from "./scalarInterpolation.ts";
import type { TScalarFrame } from "./useScalarFieldCache.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import type { TPathlineGridContext } from "@/lib/data/pathlineField.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { getGridVariableData } from "@/lib/grids/gridDataWorkerClient.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";

export type TScalarFrameInput = {
  /** Original source indices, including time; no wall-clock conversion. */
  dimensionIndices?: Readonly<Record<string, number>>;
  geometryCache?: TScalarGeometryCache;
  chunkConcurrency?: number;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
};

export type TScalarFrameRequest = {
  datasources: TSources;
  variable: string;
  dimensionIndices: Readonly<Record<string, number>>;
  sliderIndices: (number | null)[] | null;
  dimensionRanges?: TDimensionRange[];
  presetIndices: Record<string, string>;
  presetMinBounds: Record<string, string>;
  presetMaxBounds: Record<string, string>;
  timing: { fetchMs: number };
  geometryCache?: TScalarGeometryCache;
  chunkConcurrency?: number;
  signal?: AbortSignal;
  isCurrent: () => boolean;
};

export type TScalarFrameLayout = {
  shape: number[];
  chunks: number[];
  bytesPerValue: number;
};

export type TPreparedScalarFrame = TScalarFrame & {
  interpolation?: TScalarInterpolationData;
  pathlineGrid?: TPathlineGridContext;
  memory?: TScalarFrameMemory;
  timing?: { fetchMs: number; totalMs: number };
  name: string;
  isCurrent: () => boolean;
  /** Existing flow/volume synchronization runs only when the frame is committed. */
  updateLayers: () => Promise<void>;
};

export function getScalarFrameDimensions(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  dimensionNames: string[],
  spatialDimensions: number[],
  request: TScalarFrameRequest
) {
  const config = buildDimensionRangesAndIndices(
    datavar,
    dimensionNames,
    { ...request.presetIndices },
    request.presetMinBounds,
    request.presetMaxBounds,
    request.sliderIndices,
    spatialDimensions,
    request.dimensionRanges
  );
  for (const [name, index] of Object.entries(request.dimensionIndices)) {
    const dimension = dimensionNames.indexOf(name);
    if (
      dimension === -1 ||
      spatialDimensions.includes(dimension) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= datavar.shape[dimension]
    ) {
      throw new Error(`Invalid scalar frame index for ${name}: ${index}`);
    }
    config.indices[dimension] = index;
  }
  return config;
}

export async function fetchScalarFrameData(
  request: TScalarFrameRequest,
  selection: (number | null | zarr.Slice)[],
  variable = request.variable
) {
  if (!request.isCurrent()) {
    throw new DOMException("Scalar frame preparation cancelled", "AbortError");
  }
  const start = performance.now();
  const data = await getGridVariableData({
    source: ZarrDataManager.getDatasetSource(
      request.datasources,
      request.variable
    ),
    variable,
    format: request.datasources.zarr_format,
    selection,
    chunkConcurrency: request.chunkConcurrency,
  });
  request.timing.fetchMs += performance.now() - start;
  return data;
}
