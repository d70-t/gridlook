import * as zarr from "zarrita";

import { decodeTime } from "./timeHandling.ts";
import { ZarrDataManager } from "./ZarrDataManager.ts";

import type {
  TDataSource,
  TDimensionRange,
  TDimInfo,
  TSources,
} from "@/lib/types/GlobeTypes.ts";

async function getTimeInfo(
  datasources: TSources,
  dimensionRanges: TDimensionRange[],
  dimensionIndex: number,
  index: number,
  variable: string
): Promise<TDimInfo> {
  if (dimensionRanges[dimensionIndex]?.name !== "time") {
    return {};
  }
  try {
    const myDatasource = datasources.levels[0].time;
    const timevalues = (
      await ZarrDataManager.getVariableData(
        myDatasource,
        ZarrDataManager.resolveVariablePath(variable, "time"),
        [null]
      )
    ).data as Int32Array;

    const timevar = await ZarrDataManager.getVariableInfo(
      myDatasource,
      ZarrDataManager.resolveVariablePath(variable, "time")
    );
    return {
      values: timevalues,
      current: decodeTime(timevalues[index], timevar.attrs),
      attrs: timevar.attrs,
    };
  } catch {
    return {};
  }
}

async function getDimensionInfo(
  datasource: TDataSource,
  dimension: TDimensionRange,
  index: number,
  variable: string
): Promise<TDimInfo> {
  try {
    const dimensionName = dimension?.name;
    if (!dimensionName) {
      return {};
    }

    const dimArray = await ZarrDataManager.getVariableData(
      datasource,
      ZarrDataManager.resolveVariablePath(variable, dimensionName),
      [null]
    );

    type TCoordinateValue = number | bigint | string;

    const rawValues = dimArray.data;
    let dimValues: ArrayLike<TCoordinateValue>;
    let current: TCoordinateValue;

    if (
      rawValues instanceof zarr.UnicodeStringArray ||
      rawValues instanceof zarr.ByteStringArray
    ) {
      const stringValues = [...rawValues];
      dimValues = stringValues;
      current = stringValues[index] as TCoordinateValue;
    } else {
      const numericValues = rawValues as ArrayLike<TCoordinateValue>;
      dimValues = numericValues;
      current = numericValues[index] as TCoordinateValue;
    }

    const dimvar = await ZarrDataManager.getVariableInfo(
      datasource,
      ZarrDataManager.resolveVariablePath(variable, dimensionName)
    );
    return {
      values: dimValues,
      current,
      attrs: dimvar.attrs,
      units: dimvar.attrs.units as string,
      longName: (dimvar.attrs.long_name ??
        dimvar.attrs.standard_name) as string,
    };
  } catch {
    return {};
  }
}

export async function fetchDimensionDetails(
  currentVariable: string,
  datasources: TSources,
  dimensionRanges: TDimensionRange[],
  dimSlidersValues: (number | zarr.Slice | null)[]
): Promise<TDimInfo[]> {
  return await Promise.all(
    dimensionRanges.map((dim, i) => {
      if (dim?.name === "time") {
        return getTimeInfo(
          datasources,
          dimensionRanges,
          i,
          dimSlidersValues[i] as number,
          currentVariable
        );
      }
      return getDimensionInfo(
        datasources.levels[0].datasources[currentVariable],
        dim!,
        dimSlidersValues[i] as number,
        currentVariable
      );
    })
  );
}
