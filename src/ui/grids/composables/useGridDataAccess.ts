import type { ShallowRef } from "vue";
import { shallowRef } from "vue";
import type * as zarr from "zarrita";

import { decodeTime } from "@/lib/data/timeHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import type {
  TDataSource,
  TDimensionRange,
  TSources,
  TDimInfo,
} from "@/lib/types/GlobeTypes";
import { useLog } from "@/utils/logging.ts";

/* eslint-disable-next-line max-lines-per-function */
export function useGridDataAccess() {
  const { logError } = useLog();
  const datavars: ShallowRef<
    Record<string, zarr.Array<zarr.DataType, zarr.FetchStore>>
  > = shallowRef({});

  function resetDataVars() {
    datavars.value = {};
  }

  async function getDataVar(myVarname: string, datasources: TSources) {
    const myDatasource = datasources!.levels[0].datasources[myVarname];
    try {
      const datavar = await ZarrDataManager.getVariableInfoByDatasetSources(
        datasources!,
        myVarname
      );
      return datavar;
    } catch (error) {
      logError(
        error,
        `Couldn't fetch variable ${myVarname} from store: ${myDatasource.store} and dataset: ${myDatasource.dataset}`
      );
      return undefined;
    }
  }

  async function getTimeInfo(
    datasources: TSources,
    dimensionRanges: TDimensionRange[],
    index: number
  ): Promise<TDimInfo> {
    if (dimensionRanges[0]?.name !== "time") {
      return {};
    }
    try {
      const myDatasource = datasources!.levels[0].time;

      const timevalues = (
        await ZarrDataManager.getVariableData(myDatasource, "time", [null])
      ).data as Int32Array;

      const timevar = await ZarrDataManager.getVariableInfo(
        myDatasource,
        "time"
      );
      return {
        values: timevalues,
        current: decodeTime(timevalues[index], timevar.attrs),
      };
    } catch {
      return {};
    }
  }

  async function getDimensionInfo(
    datasource: TDataSource,
    dimension: TDimensionRange,
    index: number
  ): Promise<TDimInfo> {
    try {
      const dimensionName = dimension?.name;
      if (!dimensionName) {
        return {};
      }

      const dimValues = (
        await ZarrDataManager.getVariableData(datasource, dimensionName, [null])
      ).data as Int32Array;

      const dimvar = await ZarrDataManager.getVariableInfo(
        datasource,
        dimensionName
      );
      console.log(dimvar.attrs);
      console.log("value", dimValues[index]);
      return {
        values: dimValues,
        current: dimValues[index],
        units: dimvar.attrs.units as string,
        longName: (dimvar.attrs.long_name ??
          dimvar.attrs.standard_name) as string,
      };
    } catch (error) {
      console.error("Error fetching dimension info", error);
      return {};
    }
  }

  return {
    resetDataVars,
    getDataVar,
    getTimeInfo,
    getDimensionInfo,
  };
}
