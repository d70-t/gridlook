import type { ShallowRef } from "vue";
import { shallowRef } from "vue";
import type * as zarr from "zarrita";

import { decodeTime } from "@/lib/data/timeHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import type {
  TDimensionRange,
  TSources,
  TTimeInfo,
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
  ): Promise<TTimeInfo> {
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

  return {
    resetDataVars,
    getDataVar,
    getTimeInfo,
  };
}
