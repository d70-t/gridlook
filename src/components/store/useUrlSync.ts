import { storeToRefs } from "pinia";
import { watch } from "vue";
import { useGlobeControlStore } from "./store";
import { URL_PARAMETERS, type TURLParameterValues } from "../utils/urlParams";
import { useUrlParameterStore } from "./paramStore";

export function useUrlSync() {
  const store = useGlobeControlStore();
  const {
    userBoundsHigh,
    userBoundsLow,
    varnameSelector,
    colormap,
    invertColormap,
    dimSlidersDisplay,
    projectionCenter,
  } = storeToRefs(store);

  const urlParameterStore = useUrlParameterStore();
  const { paramCameraState } = storeToRefs(urlParameterStore);

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
        (userBoundsLow.value as unknown as string) !== "" &&
        userBoundsHigh.value !== undefined &&
        (userBoundsHigh.value as unknown as string) !== "") ||
      ((userBoundsLow.value as unknown as string) === "" &&
        (userBoundsHigh.value as unknown as string) === "")
    ) {
      changeURLHash({
        [URL_PARAMETERS.USER_BOUNDS_LOW]: userBoundsLow.value as number,
        [URL_PARAMETERS.USER_BOUNDS_HIGH]: userBoundsHigh.value as number,
      });
    }
  }

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
      handleUserBounds();
    }
  );

  watch(
    () => userBoundsHigh.value,
    () => {
      handleUserBounds();
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

  watch(
    () => [projectionCenter.value?.lat, projectionCenter.value?.lon],
    () => {
      const center = projectionCenter.value;
      if (!center) return;
      changeURLHash({
        [URL_PARAMETERS.PROJECTION_CENTER_LAT]: center.lat,
        [URL_PARAMETERS.PROJECTION_CENTER_LON]: center.lon,
      });
    }
  );
}
