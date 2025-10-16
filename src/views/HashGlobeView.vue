<script lang="ts" setup>
import { ref, onMounted, onBeforeMount, watch, type Ref } from "vue";
import GlobeView from "./GlobeView.vue";
import { useGlobeControlStore } from "../components/store/store";
import { storeToRefs } from "pinia";
import {
  URL_PARAMETERS,
  type TURLParameterValues,
} from "../components/utils/urlParams";

type TParams = Partial<Record<TURLParameterValues, string>>;

const defaultSrc = ref("static/index_mr_dpp0066.json");
const src = ref("static/index_mr_dpp0066.json");
const params: Ref<TParams> = ref({
  [URL_PARAMETERS.VARNAME]: undefined,
  [URL_PARAMETERS.USER_BOUNDS_LOW]: undefined,
  [URL_PARAMETERS.USER_BOUNDS_HIGH]: undefined,
});

const store = useGlobeControlStore();
const { userBoundsLow, userBoundsHigh } = storeToRefs(store);

const onHashChange = () => {
  if (location.hash.length > 1) {
    const [resource, ...paramArray] = location.hash.substring(1).split("::");
    const paramString = paramArray.join("&");

    console.log(new URLSearchParams(paramString));
    params.value = Object.fromEntries(new URLSearchParams(paramString));

    console.log("params", params.value);
    if (
      params.value.boundlow !== undefined &&
      params.value.boundhigh !== undefined
    ) {
      console.log(parseFloat(params.value.boundlow));
      console.log(parseFloat(params.value.boundhigh));
      userBoundsLow.value = parseFloat(params.value.boundlow);
      userBoundsHigh.value = parseFloat(params.value.boundhigh);
    }
    src.value = resource || defaultSrc.value;
  } else {
    src.value = defaultSrc.value;
  }
};

onMounted(() => {
  window.addEventListener("hashchange", onHashChange);
  // onHashChange();
});

onBeforeMount(() => {
  onHashChange();
});
</script>

<template>
  <GlobeView :src="src" :param-varname="params.varname" />
</template>
