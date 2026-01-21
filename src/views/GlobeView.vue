<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, onMounted, ref, watch, type Ref } from "vue";
import * as zarr from "zarrita";

import type { TModelInfo, TSources } from "../lib/types/GlobeTypes";

import {
  getGridType,
  GRID_TYPES,
  type T_GRID_TYPES,
} from "@/lib/data/gridTypeDetector";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager";
import {
  availableColormaps,
  type TColorMap,
} from "@/lib/shaders/colormapShaders";
import { useUrlParameterStore } from "@/store/paramStore";
import { useGlobeControlStore } from "@/store/store";
import { useUrlSync } from "@/store/useUrlSync";
import Toast from "@/ui/common/Toast.vue";
import GridCurvilinear from "@/ui/grids/Curvilinear.vue";
import GridGaussianReduced from "@/ui/grids/GaussianReduced.vue";
import GridHealpix from "@/ui/grids/Healpix.vue";
import GridIrregular from "@/ui/grids/Irregular.vue";
import GridRegular from "@/ui/grids/Regular.vue";
import GridTriangular from "@/ui/grids/Triangular.vue";
import AboutView from "@/ui/overlays/AboutModal.vue";
import GlobeControls from "@/ui/overlays/Controls.vue";
import InfoPanel from "@/ui/overlays/InfoPanel.vue";
import { useLog } from "@/utils/logging";

const props = defineProps<{ src: string }>();

useUrlSync();
const { logError } = useLog();
const store = useGlobeControlStore();
const urlParameterStore = useUrlParameterStore();

const { varnameSelector, loading, colormap, invertColormap } =
  storeToRefs(store);

const { paramVarname } = storeToRefs(urlParameterStore);

const globe: Ref<typeof GridTriangular | null> = ref(null);
const globeKey = ref(0);
const globeControlKey = ref(0);
const isInitialized = ref(false);
const sourceValid = ref(false);
const datasources: Ref<TSources | undefined> = ref(undefined);
const gridType: Ref<T_GRID_TYPES | undefined> = ref(undefined);
const infoPanelOpen = ref(false);

const modelInfo = computed(() => {
  if (datasources.value === undefined) {
    return undefined;
  } else {
    return {
      title: datasources.value.name,
      vars: datasources.value.levels[0].datasources,
      defaultVar: datasources.value.default_var,
      colormaps: Object.keys(availableColormaps) as TColorMap[],
    } as TModelInfo;
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
  if (!Array.isArray(dims)) {
    return false;
  }

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

async function processZarrVariables(
  store: zarr.Listable<zarr.FetchStore>,
  root: zarr.Group<zarr.FetchStore>,
  src: string
) {
  const dimensions = new Set<string>();

  const candidates = await Promise.allSettled(
    store.contents().map(async ({ path, kind }) => {
      const varname = path.slice(1);
      if (kind !== "array") {
        return {};
      }

      const variable = await zarr.open(root.resolve(path), { kind: "array" });

      // Collect dimensions from _ARRAY_DIMENSIONS attribute
      if (variable.attrs?._ARRAY_DIMENSIONS) {
        const arrayDims = variable.attrs._ARRAY_DIMENSIONS as string[];
        for (const dim of arrayDims) {
          dimensions.add(dim);
        }
      }

      // Collect dimensions from coordinates attribute
      if (variable.attrs.coordinates) {
        const coords = variable.attrs.coordinates as string;
        for (const coord of coords.split(" ")) {
          dimensions.add(coord);
        }
      }

      // Return valid variables
      if (isValidVariable(varname, variable)) {
        return {
          [varname]: {
            store: src,
            dataset: "",
            attrs: { ...variable.attrs },
          },
        };
      }

      return {};
    })
  );

  // Filter and merge datasources
  const datasources = candidates
    .filter((promise) => promise.status === "fulfilled")
    .map((promise) => promise.value)
    .filter((obj) => {
      // Filter out dimensions and coordinates
      return (
        Object.keys(obj).length > 0 && !dimensions.has(Object.keys(obj)[0])
      );
    })
    .reduce((a, b) => ({ ...a, ...b }), {});

  return datasources;
}

async function indexFromZarr(src: string): Promise<TSources> {
  const store = await zarr.withConsolidated(new zarr.FetchStore(src));
  const root = await zarr.open(store, { kind: "group" });
  const datasources = await processZarrVariables(store, root, src);

  return {
    name: root.attrs?.title as string,
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

async function indexFromIndex(src: string): Promise<TSources> {
  const res = await fetch(src);
  if (!res.ok) {
    throw new Error(`Failed to fetch index from ${src}: ${res.statusText}`);
  } else if (res.status >= 400) {
    throw new Error(`Index not found at ${src}`);
  }
  return await res.json();
}

function prepareDefaults(src: string, index: TSources) {
  if (src === props.src) {
    datasources.value = index;
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
      if (Object.hasOwn(variableDefaults.default_colormap, "inverted")) {
        invertColormap.value = variableDefaults.default_colormap.inverted;
      }
    }
    if (variableDefaults.default_range) {
      store.updateBounds(variableDefaults.default_range);
    }
  }
}

const updateSrc = async () => {
  const src = props.src;
  ZarrDataManager.invalidateCache();
  // FIXME: Trying zarr and json-index in parallel and picking the first that
  // works. If both fail, we log the last error which is from the json-index.
  // This leads to confusing error messages if the zarr source is supposed to
  // work but fails for some reason.
  let indices: PromiseSettledResult<TSources>[];
  indices = await Promise.allSettled([indexFromZarr(src), indexFromIndex(src)]);
  // FIXME: Trying zarr and json-index in parallel and picking the first that
  let lastError = null;
  // FIXME: Trying zarr and json-index in parallel and picking the first that
  store.isInitializingVariable = true;
  sourceValid.value = false;
  for (const index of indices) {
    if (index.status === "fulfilled") {
      sourceValid.value = true;
      prepareDefaults(src, index.value);
      break;
    } else {
      lastError = index.reason;
    }
  }
  // FIXME: Trying zarr and json-index in parallel and picking the first that
  if (!sourceValid.value && lastError) {
    store.stopLoading();
    logError(lastError, "Failed to fetch data");
    setGridType();
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

const toggleInfoPanel = () => {
  infoPanelOpen.value = !infoPanelOpen.value;
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
      :key="globeControlKey"
      :model-info="modelInfo"
      :current-source="props.src"
      @on-snapshot="makeSnapshot"
      @on-rotate="toggleRotate"
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
    <div class="buttons about-corner-link">
      <InfoPanel
        :datasources="datasources"
        :grid-type="gridType"
        :is-open="infoPanelOpen"
        @close="infoPanelOpen = false"
        @toggle="toggleInfoPanel"
      />
      <AboutView />
    </div>
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

.about-corner-link {
  position: absolute;
  bottom: 18px;
  right: 18px;
}
</style>
