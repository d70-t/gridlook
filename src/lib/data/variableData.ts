import * as zarr from "zarrita";

import { ZarrDataManager } from "./ZarrDataManager.ts";

import type { TDataSource, TSources } from "@/lib/types/GlobeTypes.ts";

export function getVariableDatasource(
  datasources: TSources,
  varname: string
): TDataSource | undefined {
  return datasources.levels[0]?.datasources[varname];
}

export async function fetchDataVariable(
  varname: string,
  datasources: TSources
): Promise<zarr.Array<zarr.DataType, zarr.AsyncReadable> | undefined> {
  if (!getVariableDatasource(datasources, varname)) {
    return undefined;
  }
  return await ZarrDataManager.getVariableInfoByDatasetSources(
    datasources,
    varname
  );
}
