<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { watch } from "vue";
import { useGlobeControlStore } from "./store";
import { URL_PARAMETERS, type TURLParameterValues } from "../utils/urlParams";

const store = useGlobeControlStore();
const { userBoundsHigh, userBoundsLow, varnameSelector } = storeToRefs(store);

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
</script>
