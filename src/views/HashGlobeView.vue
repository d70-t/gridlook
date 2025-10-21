<script lang="ts" setup>
import { ref, onMounted, onBeforeMount, type Ref } from "vue";
import GlobeView from "./GlobeView.vue";
import { useGlobeControlStore } from "../components/store/store";
import { storeToRefs } from "pinia";
import {
  URL_PARAMETERS,
  type TURLParameterValues,
} from "../components/utils/urlParams";
import {
  STORE_PARAM_MAPPING,
  useUrlParameterStore,
} from "../components/store/paramStore";

type TParams = Partial<Record<TURLParameterValues, string>>;

const defaultSrc = ref("static/index_mr_dpp0066.json");
const src = ref("static/index_mr_dpp0066.json");
const params: Ref<TParams> = ref({});

const store = useGlobeControlStore();
const { userBoundsLow, userBoundsHigh } = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();

const onHashChange = () => {
  if (location.hash.length > 1) {
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
      TURLParameterValues,
      string,
    ][]) {
      if (STORE_PARAM_MAPPING[key] === undefined) {
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      urlParameterStore[STORE_PARAM_MAPPING[key]] = value as any;
    }
    src.value = resource || defaultSrc.value;
  } else {
    src.value = defaultSrc.value;
  }
};

onMounted(() => {
  window.addEventListener("hashchange", onHashChange);
});

onBeforeMount(() => {
  onHashChange();
});
</script>

<template>
  <GlobeView :src="src" />
</template>
