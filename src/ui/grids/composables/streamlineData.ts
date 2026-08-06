import type * as zarr from "zarrita";

import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import type { TVectorVariablePair } from "@/lib/data/vectorField.ts";
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
};

function componentSelection(
  dimensionNames: string[],
  currentDimensionNames: string[],
  currentIndices: (number | null | zarr.Slice)[],
  spatialDimensionNames: string[]
) {
  return dimensionNames.map((dimensionName) => {
    if (spatialDimensionNames.includes(dimensionName)) {
      return null;
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

/** Load and decode two compatible vector components for the current slice. */
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
  const selection = componentSelection(
    uDimensions,
    options.currentDimensionNames,
    options.currentIndices,
    options.spatialDimensionNames
  );
  const [uValues, vValues] = await Promise.all([
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
  return { uData, vData };
}
