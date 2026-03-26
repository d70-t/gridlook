import { useBroadcastChannel, useEventListener } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { ref, watch, computed, type Ref } from "vue";

import {
  PRESENTER_CHANNEL,
  PresenterRole,
  type TPresenterMessage,
  type TPresenterRole,
  type TPresenterStatePayload,
} from "@/lib/types/presenterSync";
import { useUrlParameterStore } from "@/store/paramStore";
import { useGlobeControlStore } from "@/store/store";

const presenterRole: Ref<TPresenterRole | null> = ref(null);

/** Whether the current window is in "display" mode (no controls, receives state). */
export const isDisplayMode = computed(
  () => presenterRole.value === PresenterRole.DISPLAY
);

/**
 * Activate presenter sync. Call once from a top-level component (e.g. GlobeView).
 *
 * - "controller": watches store changes and broadcasts them.
 * - "display":    listens for incoming state and patches the stores.
 */
/* eslint-disable-next-line max-lines-per-function */
export function usePresenterSync() {
  const store = useGlobeControlStore();
  const urlParameterStore = useUrlParameterStore();

  const {
    varnameSelector,
    colormap,
    invertColormap,
    posterizeLevels,
    userBoundsLow,
    userBoundsHigh,
    landSeaMaskChoice,
    landSeaMaskUseTexture,
    projectionMode,
    projectionCenter,
    isRotating,
    showCoastLines,
    showGraticules,
    dimSlidersValues,
    selection,
  } = storeToRefs(store);

  const { paramCameraState, paramGridType } = storeToRefs(urlParameterStore);

  const { data, post } = useBroadcastChannel<
    TPresenterMessage,
    TPresenterMessage
  >({
    name: PRESENTER_CHANNEL,
  });

  /** Gather the full current state for broadcasting. */
  function gatherState(opts?: {
    skipProjectionCenter?: boolean;
  }): TPresenterStatePayload {
    return {
      varnameSelector: varnameSelector.value,
      colormap: colormap.value,
      invertColormap: invertColormap.value,
      posterizeLevels: posterizeLevels.value,
      userBoundsLow: userBoundsLow.value,
      userBoundsHigh: userBoundsHigh.value,
      landSeaMaskChoice: landSeaMaskChoice.value,
      landSeaMaskUseTexture: landSeaMaskUseTexture.value,
      projectionMode: projectionMode.value,
      // During rotation the display runs its own animation loop, so skip
      // projectionCenter to avoid flooding the channel at 60fps.
      projectionCenter: opts?.skipProjectionCenter
        ? undefined
        : projectionCenter.value
          ? { ...projectionCenter.value }
          : { lat: 0, lon: 0 },
      isRotating: isRotating.value,
      showCoastLines: showCoastLines.value,
      showGraticules: showGraticules.value,
      dimSlidersValues: [...dimSlidersValues.value],
      selection:
        selection.value && "low" in selection.value
          ? { low: selection.value.low, high: selection.value.high }
          : undefined,
      paramCameraState: paramCameraState.value,
      paramGridType: paramGridType.value,
    };
  }

  /** Apply incoming globe-control fields to the local store. */
  function applyGlobeState(payload: TPresenterStatePayload) {
    if (payload.varnameSelector !== undefined) {
      varnameSelector.value = payload.varnameSelector;
    }
    if (payload.colormap !== undefined) {
      colormap.value = payload.colormap as typeof colormap.value;
    }
    if (payload.invertColormap !== undefined) {
      invertColormap.value = payload.invertColormap;
    }
    if (payload.posterizeLevels !== undefined) {
      posterizeLevels.value = payload.posterizeLevels;
    }
    if (payload.userBoundsLow !== undefined) {
      userBoundsLow.value = payload.userBoundsLow;
    }
    if (payload.userBoundsHigh !== undefined) {
      userBoundsHigh.value = payload.userBoundsHigh;
    }
    if (payload.landSeaMaskChoice !== undefined) {
      landSeaMaskChoice.value =
        payload.landSeaMaskChoice as typeof landSeaMaskChoice.value;
    }
    if (payload.landSeaMaskUseTexture !== undefined) {
      landSeaMaskUseTexture.value = payload.landSeaMaskUseTexture;
    }
    if (payload.projectionMode !== undefined) {
      projectionMode.value =
        payload.projectionMode as typeof projectionMode.value;
    }
    // Skip projectionCenter while rotating — the display runs its own loop.
    if (payload.projectionCenter !== undefined && !store.isRotating) {
      projectionCenter.value = payload.projectionCenter;
    }
    if (payload.isRotating !== undefined) {
      isRotating.value = payload.isRotating;
    }
    if (payload.showCoastLines !== undefined) {
      showCoastLines.value = payload.showCoastLines;
    }
    if (payload.showGraticules !== undefined) {
      showGraticules.value = payload.showGraticules;
    }
    if (payload.dimSlidersValues !== undefined) {
      dimSlidersValues.value = payload.dimSlidersValues;
    }
    if (payload.selection !== undefined) {
      selection.value = payload.selection;
    }
  }

  /** Apply incoming URL-parameter fields to the local store. */
  function applyUrlParams(payload: TPresenterStatePayload) {
    if (payload.paramCameraState !== undefined) {
      paramCameraState.value = payload.paramCameraState;
    }
    if (payload.paramGridType !== undefined) {
      paramGridType.value = payload.paramGridType || undefined;
    }
  }

  /** Apply an incoming state payload to the local stores. */
  function applyState(payload: TPresenterStatePayload) {
    applyGlobeState(payload);
    applyUrlParams(payload);
  }

  // ── Display side: react to incoming messages ──────────────────────────
  // When the display window is navigating to a new dataset, we must
  // ignore state-update messages until the dataset has finished loading.
  // Otherwise the controller's intermediate store changes (e.g. new varname)
  // arrive before datasources are available, causing crashes.
  let navigating = false;

  watch(
    () => store.loading,
    (loading) => {
      if (!loading && navigating) {
        navigating = false;
      }
    }
  );

  watch(data, (msg) => {
    if (!msg || presenterRole.value !== PresenterRole.DISPLAY) {
      return;
    }
    if (msg.type === "navigate") {
      // Only set the navigation guard if the hash actually differs.
      // If the hash is the same (e.g. initial open), no hashchange fires
      // and loading never cycles, so we must not block state updates.
      if (location.hash !== msg.hash) {
        navigating = true;
        location.hash = msg.hash;
      }
    } else if (
      (msg.type === "state-update" || msg.type === "full-state") &&
      !navigating
    ) {
      applyState(msg.payload);
    }
  });

  // ── Controller side: broadcast hash changes (new dataset) ─────────────
  useEventListener(window, "hashchange", () => {
    if (presenterRole.value !== PresenterRole.CONTROLLER) {
      return;
    }
    post({ type: "navigate", hash: location.hash });
  });

  // ── Controller side: broadcast on store changes ───────────────────────
  let broadcasting = false;

  function broadcastState(payload: TPresenterStatePayload) {
    if (presenterRole.value !== PresenterRole.CONTROLLER || broadcasting) {
      return;
    }
    broadcasting = true;
    post({ type: "state-update", payload });
    broadcasting = false;
  }

  // Watch every field that should be synced.
  const fieldsToWatch = [
    () => varnameSelector.value,
    () => colormap.value,
    () => invertColormap.value,
    () => posterizeLevels.value,
    () => userBoundsLow.value,
    () => userBoundsHigh.value,
    () => landSeaMaskChoice.value,
    () => landSeaMaskUseTexture.value,
    () => projectionMode.value,
    // projectionCenter is watched separately to avoid 60fps floods during rotation
    () => isRotating.value,
    () => showCoastLines.value,
    () => showGraticules.value,
    () => JSON.stringify(dimSlidersValues.value),
    () => JSON.stringify(selection.value),
    () => paramCameraState.value,
    () => paramGridType.value,
  ];

  watch(fieldsToWatch, () => {
    if (presenterRole.value === PresenterRole.CONTROLLER) {
      broadcastState(gatherState({ skipProjectionCenter: isRotating.value }));
    }
  });

  // Sync projectionCenter only when NOT rotating (user-driven drag/shift).
  watch(
    () => JSON.stringify(projectionCenter.value),
    () => {
      if (
        presenterRole.value === PresenterRole.CONTROLLER &&
        !isRotating.value
      ) {
        broadcastState(gatherState());
      }
    }
  );

  // When rotation stops, send one final sync so both windows align.
  watch(
    () => isRotating.value,
    (rotating) => {
      if (!rotating && presenterRole.value === PresenterRole.CONTROLLER) {
        broadcastState(gatherState());
      }
    }
  );

  /** Open a new browser window in display mode with the same dataset. */
  function openDisplayWindow() {
    presenterRole.value = PresenterRole.CONTROLLER;
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "display");
    const width = Math.round(screen.width * 0.8);
    const height = Math.round(screen.height * 0.8);
    const left = Math.round((screen.width - width) / 2);
    const top = Math.round((screen.height - height) / 2);
    const features = `popup,width=${width},height=${height},left=${left},top=${top}`;
    window.open(url.toString(), "gridlook-display", features);
    // Send full state so the display window starts in sync
    setTimeout(() => {
      post({ type: "navigate", hash: location.hash });
      post({ type: "full-state", payload: gatherState() });
    }, 1500);
  }

  /** Activate display mode (called when ?mode=display is detected). */
  function enterDisplayMode() {
    presenterRole.value = PresenterRole.DISPLAY;
  }

  /** Deactivate presenter mode entirely. */
  function stopPresenter() {
    presenterRole.value = null;
  }

  return {
    openDisplayWindow,
    enterDisplayMode,
    stopPresenter,
  };
}
