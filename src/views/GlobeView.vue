<script lang="ts" setup>
import * as zarr from "zarrita";
import AboutView from "@/views/AboutView.vue";
import GridHealpix from "@/components/grids/Healpix.vue";
import GridRegular from "@/components/grids/Regular.vue";
import GridIrregular from "@/components/grids/Irregular.vue";
import GridTriangular from "@/components/grids/Triangular.vue";
import GridGaussianReduced from "@/components/grids/GaussianReduced.vue";
import GridCurvilinear from "@/components/grids/Curvilinear.vue";
import GlobeControls from "@/components/GlobeControls.vue";
import DebugPanel from "@/components/DebugPanel.vue";
import { availableColormaps } from "@/components/utils/colormapShaders.js";
import { ref, computed, watch, onMounted, type Ref } from "vue";
import type { TColorMap, TSources } from "../types/GlobeTypes";
import { useGlobeControlStore } from "../components/store/store";
import { useLog } from "../components/utils/logging";
import { storeToRefs } from "pinia";
import { useUrlParameterStore } from "../components/store/paramStore";
import {
  getGridType,
  GRID_TYPES,
  type T_GRID_TYPES,
} from "../components/utils/gridTypeDetector";
import { useUrlSync } from "../components/store/useUrlSync";
import { ZarrDataManager } from "@/components/utils/ZarrDataManager";
import Toast from "@/components/Toast.vue";
import type { TProjectionType } from "@/components/utils/projectionUtils";

const props = defineProps<{ src: string }>();

useUrlSync();
const { logError } = useLog();
const store = useGlobeControlStore();
const urlParameterStore = useUrlParameterStore();

// Apply projection parameters from URL BEFORE grid components render
// This ensures the initial render uses the correct projection
if (urlParameterStore.paramProjection) {
  store.projectionMode = urlParameterStore.paramProjection as TProjectionType;
}
if (
  urlParameterStore.paramProjectionCenterLat ||
  urlParameterStore.paramProjectionCenterLon
) {
  const lat = parseFloat(urlParameterStore.paramProjectionCenterLat ?? "0");
  const lon = parseFloat(urlParameterStore.paramProjectionCenterLon ?? "0");
  store.projectionCenter = {
    lat: Number.isFinite(lat) ? lat : 0,
    lon: Number.isFinite(lon) ? lon : 0,
  };
}

const { varnameSelector, loading, colormap, invertColormap } =
  storeToRefs(store);

const isDev = import.meta.env.MODE === "development";
const { paramVarname } = storeToRefs(urlParameterStore);

const globe: Ref<typeof GridTriangular | null> = ref(null);
const globeKey = ref(0);
const globeControlKey = ref(0);
const isInitialized = ref(false);
const sourceValid = ref(false);
const datasources: Ref<TSources | undefined> = ref(undefined);
const gridType: Ref<T_GRID_TYPES | undefined> = ref(undefined);
const debugPanelOpen = ref(false);

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
  const gridMapping = {
    [GRID_TYPES.HEALPIX]: GridHealpix,
    [GRID_TYPES.REGULAR]: GridRegular,
    [GRID_TYPES.REGULAR_ROTATED]: GridRegular,
    [GRID_TYPES.TRIANGULAR]: GridTriangular,
    [GRID_TYPES.GAUSSIAN_REDUCED]: GridGaussianReduced,
    [GRID_TYPES.IRREGULAR]: GridIrregular,
    [GRID_TYPES.CURVILINEAR]: GridCurvilinear,
  };

  return gridMapping[gridType.value as keyof typeof gridMapping];
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
  if (localGridType === GRID_TYPES.ERROR) {
    store.stopLoading();
  }
}

watch(
  () => props.src,
  async () => {
    // Rerender controls and globe and reset store
    // if new data is provided
    gridType.value = undefined;
    globeKey.value += 1;
    globeControlKey.value += 1;
    store.$reset();
    // stop loading is handled in the grid components after data load
    store.startLoading();
    await updateSrc();
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

function isValidVariable(varname: string, variable: zarr.Array<zarr.DataType>) {
  const EXCLUDED_VAR_PATTERNS = [
    "bnds",
    "bounds",
    "vertices",
    "latitude",
    "longitude",
  ] as const;

  const dims = variable.attrs?._ARRAY_DIMENSIONS;
  if (!Array.isArray(dims)) return false;

  const hasTime = dims.includes("time");
  const shapeValid = hasTime
    ? variable.shape.length >= 2
    : variable.shape.length >= 1;

  const hasExcludedName = EXCLUDED_VAR_PATTERNS.some((pattern) =>
    varname.includes(pattern)
  );
  const isLatLon = varname === "lat" || varname === "lon";

  return shapeValid && !hasExcludedName && !isLatLon;
}

async function indexFromZarr(src: string) {
  const store = await zarr.withConsolidated(new zarr.FetchStore(src));
  const root = await zarr.open(store, { kind: "group" });
  const dimensions = new Set<string>();
  const candidates = await Promise.allSettled(
    store.contents().map(async ({ path, kind }) => {
      const varname = path.slice(1);
      if (kind !== "array") {
        return {};
      }
      let variable = await zarr.open(root.resolve(path), { kind: "array" });
      if (variable.attrs?._ARRAY_DIMENSIONS) {
        let arrayDims = variable.attrs._ARRAY_DIMENSIONS as string[];
        for (let dim of arrayDims) {
          dimensions.add(dim);
        }
      }
      if (variable.attrs.coordinates) {
        let coords = variable.attrs.coordinates as string;
        for (let coord of coords.split(" ")) {
          dimensions.add(coord);
        }
      }
      if (isValidVariable(varname, variable)) {
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
    .filter((obj) => {
      // Filter out all dimensions and coordinates
      return (
        Object.keys(obj).length > 0 && !dimensions.has(Object.keys(obj)[0])
      );
    })
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
  ZarrDataManager.invalidateCache();

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
    store.stopLoading();
    logError(lastError, "Failed to fetch data");
  }
};

const makeSnapshot = () => {
  if (globe.value) {
    globe.value.makeSnapshot();
  }
};

const toggleRotate = () => {
  if (globe.value) {
    globe.value.toggleRotate();
  }
};

const toggleDebugPanel = () => {
  debugPanelOpen.value = !debugPanelOpen.value;
};

onMounted(async () => {
  // stop loading is handled in the grid components after data load
  store.startLoading();
  await updateSrc();
  isInitialized.value = true;
  await setGridType();
});
</script>

<template>
  <main>
    <Toast />
    <GlobeControls
      v-if="sourceValid"
      :key="globeControlKey"
      :model-info="modelInfo"
      @on-snapshot="makeSnapshot"
      @on-rotate="toggleRotate"
    />

    <!-- Debug Panel (dev mode only) -->
    <DebugPanel
      v-if="isDev"
      :datasources="datasources"
      :grid-type="gridType"
      :is-open="debugPanelOpen"
      @close="debugPanelOpen = false"
      @toggle="toggleDebugPanel"
    />

    <div v-if="loading" class="top-right-loader loader" />
    <section
      v-if="gridType === GRID_TYPES.ERROR"
      class="hero is-fullheight"
      style="background: linear-gradient(135deg, #f8fafc 60%, #ffe5e5 100%)"
    >
      <div class="hero-body">
        <div class="container has-text-centered">
          <p class="title pb-4">Error</p>
          <p class="subtitle" style="color: #333">
            Sorry, we couldn't load your data. Please check the source and try
            again.
          </p>
        </div>
      </div>
    </section>
    <currentGlobeComponent
      v-else-if="gridType !== undefined"
      ref="globe"
      :key="globeKey"
      :datasources="datasources"
      :is-rotated="gridType === GRID_TYPES.REGULAR_ROTATED"
    />
    <AboutView />
  </main>
</template>

<style lang="scss">
main {
  overflow: hidden;
}
div.top-right-loader {
  position: absolute;
  top: 10px;
  right: 10px;
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
