<script lang="ts" setup>
import * as zarr from "zarrita";
import AboutView from "@/views/AboutView.vue";
import GridHealpix from "@/components/grids/Healpix.vue";
import GridRegular from "@/components/grids/Regular.vue";
import GridIrregular from "@/components/grids/Irregular.vue";
import GridTriangular from "@/components/grids/Triangular.vue";
import GridGaussianReduced from "@/components/grids/GaussianReduced.vue";
import GlobeControls from "@/components/GlobeControls.vue";
import { availableColormaps } from "@/components/utils/colormapShaders.js";
import { ref, computed, watch, onMounted, type Ref } from "vue";
import type { TColorMap, TSources } from "../types/GlobeTypes";
import { useGlobeControlStore } from "../components/store/store";
import Toast from "primevue/toast";
import { useLog } from "../components/utils/logging";
import { storeToRefs } from "pinia";
import { useUrlParameterStore } from "../components/store/paramStore";
import {
  getGridType,
  GRID_TYPES,
  type T_GRID_TYPES,
} from "../components/utils/gridTypeDetector";
import { useUrlSync } from "../components/store/useUrlSync";

const props = defineProps<{ src: string }>();

useUrlSync();
const { logError } = useLog();
const store = useGlobeControlStore();

const { varnameSelector, loading, colormap, invertColormap } =
  storeToRefs(store);

const isDev = import.meta.env.MODE === "development";
const urlParameterStore = useUrlParameterStore();
const { paramVarname } = storeToRefs(urlParameterStore);

const globe: Ref<typeof GridTriangular | null> = ref(null);
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
    return GridHealpix;
  } else if (
    gridType.value === GRID_TYPES.REGULAR_ROTATED ||
    gridType.value === GRID_TYPES.REGULAR
  ) {
    return GridRegular;
  } else if (gridType.value === GRID_TYPES.TRIANGULAR) {
    return GridTriangular;
  } else if (gridType.value === GRID_TYPES.GAUSSIAN_REDUCED) {
    return GridGaussianReduced;
  } else {
    // Irregular later
    return GridIrregular;
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
  console.log("getGridType", localGridType);
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
  // FIXME: Filter out all dimensions and coordinates
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
  if (!res.ok) {
    throw new Error(`Failed to fetch index from ${src}: ${res.statusText}`);
  } else if (res.status >= 400) {
    throw new Error(`Index not found at ${src}`);
  }
  return await res.json();
}

const updateSrc = async () => {
  const src = props.src;

  // FIXME: Trying zarr and json-index in parallel and picking the first that
  // works. If both fail, we log the last error which is from the json-index.
  // This leads to confusing error messages if the zarr source is supposed to
  // work but fails for some reason.
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
    <div v-if="isDev" class="dev-gridtype p-2 is-size-7">
      Grid Type: {{ gridType }}
    </div>
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

.dev-gridtype {
  position: fixed;
  border-radius: 0.375rem;
  background-color: #f3f4f6d8;
  bottom: 18px;
  left: 18px;
  z-index: 8;
}
</style>
