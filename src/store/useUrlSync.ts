import debounce from "lodash.debounce";
import { storeToRefs } from "pinia";
import { watch } from "vue";

import { URL_PARAMETERS, type TURLParameterValues } from "../utils/urlParams";

import { useUrlParameterStore } from "./paramStore";
import { useGlobeControlStore } from "./store";

/* eslint-disable-next-line max-lines-per-function */
export function useUrlSync() {
  const store = useGlobeControlStore();
  const {
    userBoundsHigh,
    userBoundsLow,
    varnameSelector,
    colormap,
    invertColormap,
    posterizeLevels,
    dimSlidersDisplay,
    projectionCenter,
  } = storeToRefs(store);

  const urlParameterStore = useUrlParameterStore();
  const { paramCameraState, paramGridType } = storeToRefs(urlParameterStore);

  function changeURLHash(
    entries: Partial<Record<TURLParameterValues, string | number>>
  ) {
    // usage of history.replaceState to avoid triggering hashchange event which is
    // handled in the HashGlobeView component and is used for initial loading of
    // the resource and parameters. Otherwise it would trigger an infinite loop
    const [resource, ...paramArray] = location.hash.substring(1).split("::");
    const paramString = paramArray.join("&");
    const params = new URLSearchParams(paramString);

    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined || value === "") {
        params.delete(key);
        continue;
      }

      params.set(key, value as string);
    }

    history.replaceState(
      null,
      "",
      document.location.pathname +
        "#" +
        resource +
        "::" +
        Object.entries(Object.fromEntries(params))
          .map(([k, v]) => `${k}=${v}`)
          .join("::")
    );
  }

  function handleUserBounds() {
    if (
      (userBoundsLow.value !== undefined &&
        userBoundsHigh.value !== undefined) ||
      (userBoundsLow.value === undefined && userBoundsHigh.value === undefined)
    ) {
      changeURLHash({
        [URL_PARAMETERS.USER_BOUNDS_LOW]: userBoundsLow.value as number,
        [URL_PARAMETERS.USER_BOUNDS_HIGH]: userBoundsHigh.value as number,
      });
    }
  }

  const debouncedUserBoundsSync = debounce(() => {
    handleUserBounds();
  }, 200);

  watch(
    () => varnameSelector.value,
    () => {
      if (!varnameSelector.value || varnameSelector.value === "-") {
        return;
      }
      changeURLHash({ [URL_PARAMETERS.VARNAME]: varnameSelector.value });
    }
  );

  watch(
    () => userBoundsLow.value,
    () => {
      debouncedUserBoundsSync();
    }
  );

  watch(
    () => userBoundsHigh.value,
    () => {
      debouncedUserBoundsSync();
    }
  );

  watch(
    () => invertColormap.value,
    () => {
      changeURLHash({
        [URL_PARAMETERS.INVERT_COLORMAP]: String(invertColormap.value),
      });
    }
  );

  watch(
    () => colormap.value,
    () => {
      changeURLHash({ [URL_PARAMETERS.COLORMAP]: colormap.value });
    }
  );

  watch(
    () => posterizeLevels.value,
    () => {
      changeURLHash({
        [URL_PARAMETERS.POSTERIZE_LEVELS]: String(posterizeLevels.value),
      });
    }
  );

  watch(
    () => store.landSeaMaskChoice,
    () => {
      changeURLHash({ [URL_PARAMETERS.MASK_MODE]: store.landSeaMaskChoice });
    }
  );

  watch(
    () => store.landSeaMaskUseTexture,
    () => {
      changeURLHash({
        [URL_PARAMETERS.MASK_USE_TEXTURE]: String(store.landSeaMaskUseTexture),
      });
    }
  );

  watch(
    () => dimSlidersDisplay.value,
    () => {
      const dimension = store.varinfo?.dimRanges;
      if (!dimension) {
        return;
      }
      const dimensionValues = {} as Record<string, number | null>;
      for (let i = 0; i < dimension?.length; i++) {
        if (dimension[i] === null) {
          continue;
        }
        dimensionValues[`dimIndices_${dimension[i]?.name}` as string] =
          store.dimSlidersDisplay[i];
      }
      changeURLHash(dimensionValues);
    },
    { deep: true }
  );

  watch(
    () => paramCameraState.value,
    () => {
      if (paramCameraState.value) {
        changeURLHash({
          [URL_PARAMETERS.CAMERA_STATE]: paramCameraState.value,
        });
      }
    }
  );

  watch(
    () => store.projectionMode,
    () => {
      changeURLHash({
        [URL_PARAMETERS.PROJECTION]: store.projectionMode,
      });
    }
  );

  const debouncedProjectionCenterSync = debounce((lat: number, lon: number) => {
    changeURLHash({
      [URL_PARAMETERS.PROJECTION_CENTER_LAT]: lat,
      [URL_PARAMETERS.PROJECTION_CENTER_LON]: lon,
    });
  }, 200);

  watch(
    () => [projectionCenter.value?.lat, projectionCenter.value?.lon],
    () => {
      const center = projectionCenter.value;
      if (!center) {
        return;
      }
      debouncedProjectionCenterSync(center.lat, center.lon);
    }
  );

  watch(
    () => paramGridType.value,
    () => {
      const gridType = paramGridType.value;
      changeURLHash({
        [URL_PARAMETERS.GRID_TYPE]: gridType === undefined ? "" : gridType,
      });
    }
  );
}
