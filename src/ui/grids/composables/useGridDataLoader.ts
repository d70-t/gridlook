import { onScopeDispose, ref, watch, type Ref } from "vue";
import type * as zarr from "zarrita";

import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";

type TDataVar = zarr.Array<zarr.DataType, zarr.AsyncReadable>;
type TGlobeControlStore = ReturnType<typeof useGlobeControlStore>;
type TLogError = (maybeError: unknown, context?: string) => void;

type TLoaderState = {
  disposed: boolean;
  pendingUpdate: Ref<boolean>;
  updatingData: Ref<boolean>;
};

type TGridDataLoaderOptions = {
  getDatasources: () => TSources | undefined;
  getDataVar: (
    varname: string,
    datasources: TSources
  ) => Promise<TDataVar | undefined>;
  fetchAndRenderData: (datavar: TDataVar) => Promise<void>;
  clearHoverLookup: () => void;
  updateLandSeaMask: () => void | Promise<void>;
  updateColormap: () => void;
  prepareDatasource?: () => void | Promise<void>;
  resetDataVars?: () => void;
  refreshStreamlines?: (reuseCached?: boolean) => void | Promise<void>;
  suspendStreamlines?: () => void;
};

function createGetData(
  options: TGridDataLoaderOptions,
  store: TGlobeControlStore,
  state: TLoaderState,
  logError: TLogError
) {
  return async function getData() {
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
    let shouldStopLoading = true;
    try {
      do {
        state.pendingUpdate.value = false;
        try {
          const requestVarname = store.varnameSelector;
          const datavar = await options.getDataVar(requestVarname, datasources);
          if (state.disposed || datasources !== options.getDatasources()) {
            shouldStopLoading = false;
            return;
          }
          if (requestVarname !== store.varnameSelector) {
            state.pendingUpdate.value = true;
            continue;
          }
          if (datavar !== undefined) {
            await options.fetchAndRenderData(datavar);
          }
        } catch (error) {
          // A live source may roll over while an older timestep is loading.
          // If a newer update is already queued, retry it instead of dropping
          // the only notification for the newly available timestep.
          if (!state.disposed && !state.pendingUpdate.value) {
            logError(error, "Could not fetch data");
          }
        }
      } while (!state.disposed && state.pendingUpdate.value);
    } finally {
      state.updatingData.value = false;
      if (!state.disposed && shouldStopLoading) {
        store.stopLoading();
      }
    }
  };
}

function createDatasourceUpdate(
  options: TGridDataLoaderOptions,
  getData: () => Promise<void>
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

// eslint-disable-next-line max-lines-per-function
function registerGridDataLoaderWatches(
  options: TGridDataLoaderOptions,
  store: TGlobeControlStore,
  getData: () => Promise<void>,
  logError: TLogError
) {
  watch(
    () => [...store.dimSlidersValues],
    async () => {
      if (store.isInitializingVariable) {
        // Variable changes remount the grid, so the initial dim write should
        // not trigger a second data request inside the fresh grid instance.
        store.isInitializingVariable = false;
        return;
      }
      await getData();
      options.updateColormap();
    }
  );
  watch(
    () => store.streamlineSelectionRevision,
    async () => {
      try {
        await options.refreshStreamlines?.();
      } catch (error) {
        logError(error, "Could not update vector components");
      }
    }
  );
  watch(
    () => store.streamlineScalarRevision,
    async () => {
      try {
        if (store.streamlineMagnitudeDisplayed) {
          await options.refreshStreamlines?.(true);
        } else {
          await getData();
          options.updateColormap();
        }
      } catch (error) {
        logError(error, "Could not change the displayed streamline scalar");
      }
    }
  );
  watch(
    () => store.isStreamlineLayerEnabled(),
    async (enabled) => {
      if (!enabled) {
        store.setStreamlineMagnitudeDisplayed(false);
        options.suspendStreamlines?.();
        await getData();
        options.updateColormap();
        return;
      }
      try {
        store.setStreamlineMagnitudeDisplayed(true);
        await options.refreshStreamlines?.(true);
      } catch (error) {
        logError(error, "Could not enable vector streamlines");
      }
    }
  );
}

export function useGridDataLoader(options: TGridDataLoaderOptions) {
  const store = useGlobeControlStore();
  const { logError } = useLog();
  const state: TLoaderState = {
    disposed: false,
    pendingUpdate: ref(false),
    updatingData: ref(false),
  };
  const getData = createGetData(options, store, state, logError);
  const datasourceUpdate = createDatasourceUpdate(options, getData);

  registerGridDataLoaderWatches(options, store, getData, logError);

  onScopeDispose(() => {
    state.disposed = true;
    state.pendingUpdate.value = false;
  });

  return {
    datasourceUpdate,
    getData,
  };
}
