import { onScopeDispose, watch, type Ref } from "vue";

import {
  LiveTimestepController,
  liveStoreBaseUrl,
} from "@/lib/data/liveTimestep.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

type TGlobeControlStore = ReturnType<typeof useGlobeControlStore>;

function timeDimensionIndex(store: TGlobeControlStore): number {
  const ranges = store.varinfo?.dimRanges;
  if (!ranges) {
    return -1;
  }
  return ranges.findIndex((range) => range?.name === "time");
}

function makeController(
  store: TGlobeControlStore,
  baseUrl: string,
  index: number
): LiveTimestepController {
  return new LiveTimestepController({
    baseUrl,
    onTimestep: (timestep) => {
      store.setLiveTimestep(timestep);
      // Writing the time slider triggers the grid data loader to refetch and
      // re-render at the (now available) timestep.
      if (store.dimSlidersValues[index] !== timestep) {
        store.dimSlidersValues[index] = timestep;
      }
    },
    onConnectedChange: (connected) => store.setLiveConnected(connected),
    onError: (error) =>
      console.warn("Live timestep polling failed; retrying.", error),
  });
}

/**
 * Auto-follows the newest available timestep of a live dataset.
 *
 * When {@link useGlobeControlStore().live} is set and not paused, this starts a
 * {@link LiveTimestepController} for the current store. Each new timestep index
 * is written into the time slider (`dimSlidersValues`), which the grid data
 * loader already watches, so the grid refetches and re-renders the newly
 * available data. Pausing tears the controller down; resuming spins up a fresh
 * one that jumps straight to the current timestep.
 */
export function useLiveTimestep(datasources: Ref<TSources | undefined>) {
  const store = useGlobeControlStore();
  let controller: LiveTimestepController | null = null;
  let activeIndex = -1;
  let activeBaseUrl: string | undefined;

  function stopController() {
    controller?.stop();
    controller = null;
    activeIndex = -1;
    activeBaseUrl = undefined;
    store.setLiveConnected(false);
  }

  function sync() {
    const sources = datasources.value;
    const index = timeDimensionIndex(store);
    const baseUrl = sources ? liveStoreBaseUrl(sources) : undefined;
    // Not live, paused, not a live-capable store, or time dimension unknown yet.
    if (!store.live || store.livePaused || !baseUrl || index === -1) {
      stopController();
      return;
    }
    if (controller && activeIndex === index && activeBaseUrl === baseUrl) {
      return; // already following this store/dimension
    }
    stopController();
    activeIndex = index;
    activeBaseUrl = baseUrl;
    controller = makeController(store, baseUrl, index);
    controller.start();
  }

  watch(
    () => [
      store.live,
      store.livePaused,
      datasources.value,
      timeDimensionIndex(store),
    ],
    sync,
    { immediate: true }
  );

  onScopeDispose(stopController);
}
