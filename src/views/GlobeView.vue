<script lang="ts" setup>
import * as zarr from "zarrita";
import AboutView from "@/views/AboutView.vue";
import GlobeHealpix from "@/components/GlobeHealpix.vue";
import GlobeRegular from "@/components/GlobeRegular.vue";
import GlobeIrregular from "@/components/GlobeIrregular.vue";
import Globe from "@/components/Globe.vue";
import GlobeControls from "@/components/GlobeControls.vue";
import { availableColormaps } from "@/components/utils/colormapShaders.js";
import { ref, computed, watch, onMounted, type Ref } from "vue";
import type { TColorMap, TSources } from "../types/GlobeTypes";
import { useGlobeControlStore } from "../components/store/store";
import Toast from "primevue/toast";
import { useLog } from "../components/utils/logging";
import { storeToRefs } from "pinia";
import StoreUrlListener from "../components/store/storeUrlListener.vue";
import { useUrlParameterStore } from "../components/store/paramStore";
import {
  getGridType,
  GRID_TYPES,
  type T_GRID_TYPES,
} from "../components/utils/gridTypeDetector";

const props = defineProps<{ src: string }>();

const { logError } = useLog();
const store = useGlobeControlStore();
const { varnameSelector, loading, colormap, invertColormap } =
  storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramVarname } = storeToRefs(urlParameterStore);

const globe: Ref<typeof Globe | null> = ref(null);
const globeKey = ref(0);
const globeControlKey = ref(0);
const isLoading = ref(false);
const isInitialized = ref(false);
const sourceValid = ref(false);
const datasources: Ref<TSources | undefined> = ref(undefined);
const gridType: Ref<T_GRID_TYPES | undefined> = ref(undefined);

const modelInfo = computed(() => {
  if (datasources.value === undefined) {
    return undefined;
  } else {
    return {
      title: datasources.value.name,
      vars: datasources.value.levels[0].datasources,
      defaultVar: datasources.value.default_var,
      colormaps: Object.keys(availableColormaps) as TColorMap[],
    };
  }
});

const currentGlobeComponent = computed(() => {
  if (gridType.value === GRID_TYPES.HEALPIX) {
    return GlobeHealpix;
  } else if (
    gridType.value === GRID_TYPES.REGULAR_ROTATED ||
    gridType.value === GRID_TYPES.REGULAR
  ) {
    return GlobeRegular;
  } else if (gridType.value === GRID_TYPES.TRIANGULAR) {
    return Globe;
  } else {
    // Irregular later
    return GlobeIrregular;
  }
});

async function setGridType() {
  if (!isInitialized.value) {
    return;
  }
  const localGridType = await getGridType(
    sourceValid.value,
    varnameSelector.value,
    datasources.value,
    logError
  );
  gridType.value = localGridType;
}

watch(
  () => props.src,
  async () => {
    // Rerender controls and globe and reset store
    // if new data is provided
    isLoading.value = true;
    gridType.value = undefined;
    globeKey.value += 1;
    globeControlKey.value += 1;
    store.$reset();
    await updateSrc();

    isLoading.value = false;
  }
);

watch(
  () => varnameSelector.value,
  async () => {
    if (!varnameSelector.value || varnameSelector.value === "-") {
      return;
    }
    await setGridType();
  }
);

async function indexFromZarr(src: string) {
  const store = await zarr.withConsolidated(new zarr.FetchStore(src));
  const root = await zarr.open(store, { kind: "group" });

  const candidates = await Promise.allSettled(
    store.contents().map(async ({ path, kind }) => {
      const varname = path.slice(1);
      if (kind !== "array") {
        return {};
      }
      let variable = await zarr.open(root.resolve(path), { kind: "array" });
      if (
        variable.shape.length >= 2 &&
        variable.attrs?._ARRAY_DIMENSIONS &&
        variable.attrs?._ARRAY_DIMENSIONS instanceof Array &&
        !varname.includes("bnds") &&
        variable.attrs?._ARRAY_DIMENSIONS[0] === "time"
      ) {
        return {
          [varname]: {
            store: src,
            dataset: "",
            attrs: {
              ...variable.attrs,
            },
          },
        };
      } else {
        return {};
      }
    })
  );
  const datasources = candidates
    .filter((promise) => promise.status === "fulfilled")
    .map((promise) => promise.value)
    .reduce((a, b) => {
      return { ...a, ...b };
    }, {});

  return {
    name: root.attrs?.title,
    levels: [
      {
        time: {
          store: src,
          dataset: "",
        },
        grid: {
          store: src,
          dataset: "",
        },
        datasources,
      },
    ],
  };
}

async function indexFromIndex(src: string) {
  const res = await fetch(src);
  return await res.json();
}

const updateSrc = async () => {
  const src = props.src;

  const indices = await Promise.allSettled([
    indexFromZarr(src),
    indexFromIndex(src),
  ]);
  let lastError = null;
  store.isInitializingVariable = true;
  sourceValid.value = false;
  for (const index of indices) {
    if (index.status === "fulfilled") {
      sourceValid.value = true;
      if (src === props.src) {
        datasources.value = index.value;
      }
      varnameSelector.value =
        paramVarname.value ??
        modelInfo.value!.defaultVar ??
        Object.keys(modelInfo.value!.vars)[0];

      if (
        datasources.value &&
        varnameSelector.value in datasources.value.levels[0].datasources
      ) {
        const variableDefaults =
          datasources.value.levels[0].datasources[varnameSelector.value];
        if (variableDefaults.default_colormap) {
          colormap.value = variableDefaults.default_colormap.name;
          if (
            Object.prototype.hasOwnProperty.call(
              variableDefaults.default_colormap,
              "inverted"
            )
          ) {
            invertColormap.value = variableDefaults.default_colormap.inverted;
          }
        }
        if (variableDefaults.default_range) {
          store.updateBounds(variableDefaults.default_range);
        }
      }
      break;
    } else {
      lastError = index.reason;
    }
  }
  if (!sourceValid.value && lastError) {
    logError(lastError, "Failed to fetch data");
  }
};

const makeSnapshot = () => {
  if (globe.value) {
    globe.value.makeSnapshot();
  }
};

const makeExample = () => {
  if (globe.value) {
    globe.value.copyPythonExample();
  }
};

const toggleRotate = () => {
  if (globe.value) {
    globe.value.toggleRotate();
  }
};

onMounted(async () => {
  isLoading.value = true;
  await updateSrc();
  isInitialized.value = true;
  await setGridType();

  isLoading.value = false;
});
</script>

<template>
  <main>
    <StoreUrlListener />
    <Toast unstyled>
      <template #container="{ message, closeCallback }">
        <div class="message is-danger" style="max-width: 400px">
          <div class="message-body is-flex">
            <p class="mr-2 text-wrap">
              {{ message.detail }}
            </p>
            <button
              class="delete"
              type="button"
              @click="closeCallback"
            ></button>
          </div>
        </div>
      </template>
    </Toast>
    <GlobeControls
      v-if="sourceValid"
      :key="globeControlKey"
      :model-info="modelInfo"
      @on-snapshot="makeSnapshot"
      @on-example="makeExample"
      @on-rotate="toggleRotate"
    />
    <div v-if="isLoading" class="mx-auto loader"></div>
    <section
      v-else-if="gridType === GRID_TYPES.ERROR"
      class="hero is-fullheight is-flex is-align-items-center is-justify-content-center"
    >
      <div
        class="notification is-danger is-light has-text-centered mx-auto"
        style="max-width: 400px"
      >
        An error occurred. Possibly missing or not supported data.
      </div>
    </section>
    <currentGlobeComponent
      v-else-if="gridType !== undefined"
      ref="globe"
      :key="globeKey"
      :datasources="datasources"
      :is-rotated="gridType === GRID_TYPES.REGULAR_ROTATED"
    />
    <div v-if="isLoading || loading" class="top-right-loader loader" />
    <AboutView />
  </main>
</template>

<style>
main {
  overflow: hidden;
}
div.top-right-loader {
  position: absolute;
  top: 4px;
  right: 4px;
  height: 40px;
  width: 40px;
  z-index: 1000;
}
</style>
