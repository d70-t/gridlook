import type * as zarr from "zarrita";

import { verticalCoordinateScore } from "@/lib/data/dimensionData.ts";
import { isTimeUnits } from "@/lib/data/timeHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import {
  getVariableGroup,
  type TStreamlineLevelInfo,
  type TVectorVariablePair,
} from "@/lib/data/vectorField.ts";
import { resolveVectorMagnitude } from "@/lib/data/vectorMagnitude.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { getGridVariableData } from "@/lib/grids/gridDataWorkerClient.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";

type TDataVar = zarr.Array<zarr.DataType, zarr.AsyncReadable>;

type TOptions = {
  pair: TVectorVariablePair;
  datasources: TSources;
  getDataVar: (
    varname: string,
    datasources: TSources
  ) => Promise<TDataVar | undefined>;
  currentDimensionNames: string[];
  currentIndices: (number | null | zarr.Slice)[];
  spatialDimensionNames: string[];
  expectedDataLength: number;
  selectedLevelIndex?: number;
};

type TCoordinateInfo = TStreamlineLevelInfo & {
  attrs: zarr.Attributes;
};

type TLevelDimension = {
  dimensionIndex: number;
  info: TCoordinateInfo;
};

const coordinateInfoCache = new WeakMap<
  TSources,
  Map<string, Promise<TCoordinateInfo>>
>();

function fallbackCoordinateInfo(
  dimensionName: string,
  size: number
): TCoordinateInfo {
  return {
    dimensionName,
    values: Array.from({ length: size }, (_, index) => index),
    attrs: {},
  };
}

async function loadCoordinateInfo(
  datasources: TSources,
  variable: string,
  dimensionName: string,
  size: number
) {
  let datasetCache = coordinateInfoCache.get(datasources);
  if (!datasetCache) {
    datasetCache = new Map();
    coordinateInfoCache.set(datasources, datasetCache);
  }
  const key = `${variable}\u0000${dimensionName}`;
  const cached = datasetCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = (async () => {
    try {
      const source = ZarrDataManager.getDatasetSource(datasources, variable);
      const path = ZarrDataManager.resolveVariablePath(variable, dimensionName);
      const coordinate = await ZarrDataManager.getVariableInfo(
        source,
        path,
        datasources.zarr_format
      );
      const rawValues = (
        await ZarrDataManager.getVariableDataFromArray(coordinate, [null])
      ).data as ArrayLike<number | bigint | string>;
      const attrs = coordinate.attrs;
      return {
        dimensionName,
        values: Array.from(rawValues),
        units: attrs.units as string | undefined,
        longName: (attrs.long_name ?? attrs.standard_name) as
          | string
          | undefined,
        attrs,
      };
    } catch {
      return fallbackCoordinateInfo(dimensionName, size);
    }
  })();
  datasetCache.set(key, pending);
  return pending;
}

function isTimeCoordinate(info: TCoordinateInfo) {
  const name = info.dimensionName.toLowerCase();
  return (
    name === "time" ||
    name.endsWith("_time") ||
    info.attrs.standard_name === "time" ||
    info.attrs.axis === "T" ||
    isTimeUnits(info.attrs.units)
  );
}

async function findLevelDimension(
  options: TOptions,
  dimensionNames: string[],
  shape: number[]
): Promise<TLevelDimension | undefined> {
  const candidates = await Promise.all(
    dimensionNames.map(async (dimensionName, dimensionIndex) => {
      const normalizedName = dimensionName.toLowerCase();
      if (
        options.spatialDimensionNames.includes(dimensionName) ||
        normalizedName === "time" ||
        normalizedName.endsWith("_time")
      ) {
        return undefined;
      }
      const info = await loadCoordinateInfo(
        options.datasources,
        options.pair.u,
        dimensionName,
        shape[dimensionIndex]
      );
      return isTimeCoordinate(info) ? undefined : { dimensionIndex, info };
    })
  );
  const remaining = candidates.filter(
    (candidate): candidate is TLevelDimension => candidate !== undefined
  );
  if (remaining.length === 1) {
    return remaining[0];
  }
  return remaining
    .map((candidate) => ({
      candidate,
      score: verticalCoordinateScore(
        candidate.info.dimensionName,
        candidate.info.attrs
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)[0]?.candidate;
}

function componentSelection(
  dimensionNames: string[],
  currentDimensionNames: string[],
  currentIndices: (number | null | zarr.Slice)[],
  spatialDimensionNames: string[],
  levelDimension?: TLevelDimension,
  selectedLevelIndex = 0
) {
  return dimensionNames.map((dimensionName, dimensionIndex) => {
    if (spatialDimensionNames.includes(dimensionName)) {
      return null;
    }
    if (dimensionIndex === levelDimension?.dimensionIndex) {
      return Math.min(
        Math.max(0, Math.trunc(selectedLevelIndex)),
        levelDimension.info.values.length - 1
      );
    }
    const selectedIndex = currentDimensionNames.indexOf(dimensionName);
    const selectedValue = currentIndices[selectedIndex];
    return typeof selectedValue === "number" ? selectedValue : 0;
  });
}

function componentsAreCompatible(
  uVariable: TDataVar,
  vVariable: TDataVar,
  uDimensions: string[],
  vDimensions: string[]
) {
  return (
    uDimensions.length === vDimensions.length &&
    uDimensions.every((name, index) => name === vDimensions[index]) &&
    uVariable.shape.length === vVariable.shape.length &&
    uVariable.shape.every((size, index) => size === vVariable.shape[index])
  );
}

function loadComponentValues(
  options: TOptions,
  selection: (number | null | zarr.Slice)[]
) {
  const { pair, datasources } = options;
  return Promise.all([
    getGridVariableData({
      source: ZarrDataManager.getDatasetSource(datasources, pair.u),
      variable: pair.u,
      format: datasources.zarr_format,
      selection,
    }),
    getGridVariableData({
      source: ZarrDataManager.getDatasetSource(datasources, pair.v),
      variable: pair.v,
      format: datasources.zarr_format,
      selection,
    }),
  ]);
}

function magnitudeAlreadyExists(
  datasources: TSources,
  pair: TVectorVariablePair,
  standardName: string
) {
  const group = getVariableGroup(pair.u);
  return Object.entries(datasources.levels[0].datasources).some(
    ([name, source]) =>
      getVariableGroup(name) === group &&
      source.attrs?.standard_name === standardName
  );
}

/** Load and decode two compatible vector components for the current slice. */
// eslint-disable-next-line max-lines-per-function
export async function loadVectorComponents(options: TOptions) {
  const { pair, datasources, getDataVar } = options;
  const [uVariable, vVariable, uDimensions, vDimensions] = await Promise.all([
    getDataVar(pair.u, datasources),
    getDataVar(pair.v, datasources),
    ZarrDataManager.getDimensionNames(datasources, pair.u),
    ZarrDataManager.getDimensionNames(datasources, pair.v),
  ]);
  if (
    !uVariable ||
    !vVariable ||
    !componentsAreCompatible(uVariable, vVariable, uDimensions, vDimensions)
  ) {
    return undefined;
  }
  const levelDimension = await findLevelDimension(
    options,
    uDimensions,
    uVariable.shape
  );
  const selection = componentSelection(
    uDimensions,
    options.currentDimensionNames,
    options.currentIndices,
    options.spatialDimensionNames,
    levelDimension,
    options.selectedLevelIndex
  );
  const [uValues, vValues] = await loadComponentValues(options, selection);
  const uData = castDataVarToFloat32(uValues);
  const vData = castDataVarToFloat32(vValues);
  decodeVariableDataAndGetBounds(uVariable, uData);
  decodeVariableDataAndGetBounds(vVariable, vData);
  if (
    uData.length !== options.expectedDataLength ||
    vData.length !== options.expectedDataLength
  ) {
    return undefined;
  }
  const levelInfo = levelDimension
    ? {
        dimensionName: levelDimension.info.dimensionName,
        values: levelDimension.info.values,
        units: levelDimension.info.units,
        longName: levelDimension.info.longName,
      }
    : undefined;
  const resolvedMagnitude = resolveVectorMagnitude(
    uVariable.attrs,
    vVariable.attrs
  );
  const magnitudeExists = resolvedMagnitude?.standardName
    ? magnitudeAlreadyExists(datasources, pair, resolvedMagnitude.standardName)
    : false;
  const canDeriveMagnitude = Boolean(resolvedMagnitude && !magnitudeExists);
  return {
    uData,
    vData,
    levelInfo,
    magnitudeInfo: resolvedMagnitude,
    canDeriveMagnitude,
  };
}
