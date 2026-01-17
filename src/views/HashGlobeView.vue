<script lang="ts" setup>
import { useEventListener } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { ref, onBeforeMount, type Ref } from "vue";

import GlobeView from "./GlobeView.vue";

import { STORE_PARAM_MAPPING, useUrlParameterStore } from "@/store/paramStore";
import { useGlobeControlStore } from "@/store/store";
import type { TURLParameterValues } from "@/utils/urlParams";

type TParams = Partial<Record<TURLParameterValues, string>>;

const defaultSrc = ref("static/index_mr_dpp0066.json");
const src = ref("static/index_mr_dpp0066.json");
const params: Ref<TParams> = ref({});

const store = useGlobeControlStore();
const { userBoundsLow, userBoundsHigh } = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();

const onHashChange = () => {
  if (location.hash.length > 1) {
    urlParameterStore.$reset();
    // The hash is of the form "#resource::param1=value1::param2=value2::..."
    // We split on "::" to separate the resource from the parameters
    // and then parse the parameters and set the store values accordingly
    const [resource, ...paramArray] = location.hash.substring(1).split("::");
    const paramString = paramArray.join("&");

    params.value = Object.fromEntries(new URLSearchParams(paramString));

    if (
      params.value.boundlow !== undefined &&
      params.value.boundhigh !== undefined
    ) {
      userBoundsLow.value = parseFloat(params.value.boundlow);
      userBoundsHigh.value = parseFloat(params.value.boundhigh);
    }
    for (const [key, value] of Object.entries(params.value) as [
      keyof typeof STORE_PARAM_MAPPING,
      string,
    ][]) {
      if (key.startsWith("dimIndices_")) {
        urlParameterStore[STORE_PARAM_MAPPING.dimIndices][
          key.substring("dimIndices_".length)
        ] = value;
      } else if (key.startsWith("dimMinBounds_")) {
        urlParameterStore[STORE_PARAM_MAPPING.dimMinBounds][
          key.substring("dimMinBounds_".length)
        ] = value;
      } else if (key.startsWith("dimMaxBounds_")) {
        urlParameterStore[STORE_PARAM_MAPPING.dimMaxBounds][
          key.substring("dimMaxBounds_".length)
        ] = value;
      } else if (STORE_PARAM_MAPPING[key] === undefined) {
        continue;
      }
      const paramProperty = STORE_PARAM_MAPPING[key];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      urlParameterStore[paramProperty] = value as any;
    }
    src.value = resource || defaultSrc.value;
  } else {
    src.value = defaultSrc.value;
  }
};

useEventListener(window, "hashchange", onHashChange);

onBeforeMount(() => {
  onHashChange();
});
</script>

<template>
  <GlobeView :src="src" />
</template>
