import { ref, watch, type Ref } from "vue";
import type * as zarr from "zarrita";

import type { TSources } from "@/lib/types/GlobeTypes.ts";
import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "@/store/store.ts";
import { useLog } from "@/utils/logging.ts";

type TDataVar = zarr.Array<zarr.DataType, zarr.AsyncReadable>;
type TGlobeControlStore = ReturnType<typeof useGlobeControlStore>;
type TLogError = (maybeError: unknown, context?: string) => void;

type TLoaderState = {
  pendingUpdate: Ref<boolean>;
  updatingData: Ref<boolean>;
};

type TGridDataLoaderOptions = {
  getDatasources: () => TSources | undefined;
  getDataVar: (
    varname: string,
    datasources: TSources
  ) => Promise<TDataVar | undefined>;
  fetchAndRenderData: (
    datavar: TDataVar,
    updateMode: TUpdateMode
  ) => Promise<void>;
  clearHoverLookup: () => void;
  updateLandSeaMask: () => void | Promise<void>;
  updateColormap: () => void;
  prepareDatasource?: () => void | Promise<void>;
  resetDataVars?: () => void;
  onVariableChange?: () => void;
  onDatasourceChange?: () => void;
};

function createGetData(
  options: TGridDataLoaderOptions,
  store: TGlobeControlStore,
  state: TLoaderState,
  logError: TLogError
) {
  return async function getData(
    updateMode: TUpdateMode = UPDATE_MODE.INITIAL_LOAD
  ) {
    const datasources = options.getDatasources();
    if (!datasources) {
      return;
    }

    store.startLoading();
    if (state.updatingData.value) {
      state.pendingUpdate.value = true;
      return;
    }

    state.updatingData.value = true;
    try {
      do {
        state.pendingUpdate.value = false;
        const datavar = await options.getDataVar(
          store.varnameSelector,
          datasources
        );
        if (datavar !== undefined) {
          await options.fetchAndRenderData(datavar, updateMode);
        }
      } while (state.pendingUpdate.value);
    } catch (error) {
      logError(error, "Could not fetch data");
    } finally {
      state.updatingData.value = false;
      store.stopLoading();
    }
  };
}

function createDatasourceUpdate(
  options: TGridDataLoaderOptions,
  getData: (updateMode?: TUpdateMode) => Promise<void>
) {
  return async function datasourceUpdate() {
    options.resetDataVars?.();
    options.clearHoverLookup();

    if (options.getDatasources() === undefined) {
      return;
    }

    await options.prepareDatasource?.();
    await getData();
    await options.updateLandSeaMask();
    options.updateColormap();
  };
}

function registerGridDataLoaderWatches(
  options: TGridDataLoaderOptions,
  store: TGlobeControlStore,
  getData: (updateMode?: TUpdateMode) => Promise<void>,
  datasourceUpdate: () => Promise<void>
) {
  watch(
    () => store.varnameSelector,
    () => {
      options.onVariableChange?.();
      void getData();
    }
  );

  watch(
    () => store.dimSlidersValues,
    async () => {
      if (store.isInitializingVariable) {
        store.isInitializingVariable = false;
        return;
      }
      await getData(UPDATE_MODE.SLIDER_TOGGLE);
      options.updateColormap();
    },
    { deep: true }
  );

  watch(options.getDatasources, () => {
    options.onDatasourceChange?.();
    void datasourceUpdate();
  });
}

export function useGridDataLoader(options: TGridDataLoaderOptions) {
  const store = useGlobeControlStore();
  const { logError } = useLog();
  const state: TLoaderState = {
    pendingUpdate: ref(false),
    updatingData: ref(false),
  };
  const getData = createGetData(options, store, state, logError);
  const datasourceUpdate = createDatasourceUpdate(options, getData);

  registerGridDataLoaderWatches(options, store, getData, datasourceUpdate);

  return {
    datasourceUpdate,
    getData,
  };
}
