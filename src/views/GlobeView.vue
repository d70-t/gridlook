<script lang="ts" setup>
import * as zarr from "zarrita";
import GlobeHealpix from "@/components/GlobeHealpix.vue";
import GlobeRegular from "@/components/GlobeRegular.vue";
// import GlobeIrregular from "@/components/GlobeIrregular.vue";
import Globe from "@/components/Globe.vue";
import GlobeControls from "@/components/GlobeControls.vue";
import { availableColormaps } from "@/components/utils/colormapShaders.js";
import { ref, computed, watch, onMounted, type Ref } from "vue";
import type {
  TColorMap,
  TSelection,
  TSources,
  TVarInfo,
} from "../types/GlobeTypes";
import { useGlobeControlStore } from "../components/store/store";
import Toast from "primevue/toast";
import { useToast } from "primevue/usetoast";
import { storeToRefs } from "pinia";
import { getErrorMessage } from "../components/utils/errorHandling";
// import GlobeRegular from "../components/GlobeRegular.vue";
const props = defineProps<{ src: string }>();

const GRID_TYPES = {
  REGULAR: "regular",
  HEALPIX: "healpix",
  REGULAR_ROTATED: "regular_rotated",
  TRIANGULAR: "triangular",
  GAUSSIAN: "gaussian",
  ERROR: "error",
} as const;

type T_GRID_TYPES = (typeof GRID_TYPES)[keyof typeof GRID_TYPES];

const toast = useToast();
const store = useGlobeControlStore();
const { varnameSelector, loading } = storeToRefs(store);

const globe: Ref<typeof Globe | null> = ref(null);
const globeKey = ref(0);
const globeControlKey = ref(0);
const isLoading = ref(false);
const sourceValid = ref(false);
const datasources: Ref<TSources | undefined> = ref(undefined);
const selection: Ref<Partial<TSelection>> = ref({});
const varinfo: Ref<TVarInfo | undefined> = ref(undefined);
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
      timeRange: {
        start: 0,
        end: 1,
      },
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
    return Globe;
  }
});

async function setGridType() {
  const localVarname = await getGridType();
  gridType.value = localVarname;
}

watch(
  () => props.src,
  async () => {
    // Rerender controls and globe and reset store
    // if new data is provided
    isLoading.value = true;
    globeKey.value += 1;
    globeControlKey.value += 1;
    store.$reset();
    await updateSrc();
    await setGridType();

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

const updateSelection = (s: TSelection) => {
  selection.value = s;
};

const updateVarinfo = (info: TVarInfo) => {
  varinfo.value = info;
};

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
        variable.shape.length === 2 &&
        variable.attrs?._ARRAY_DIMENSIONS &&
        variable.attrs?._ARRAY_DIMENSIONS instanceof Array &&
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

  sourceValid.value = false;
  for (const index of indices) {
    if (index.status === "fulfilled") {
      sourceValid.value = true;
      if (src === props.src) {
        datasources.value = index.value;
      }
      varnameSelector.value =
        modelInfo.value!.defaultVar ?? Object.keys(modelInfo.value!.vars)[0];
      break;
    } else {
      lastError = index.reason;
    }
  }
  if (!sourceValid.value && lastError) {
    toast.add({
      severity: "error",
      summary: "Error",
      detail: `Failed to fetch data: ${lastError.message}`,
      life: 3000,
    });
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

async function findCRSVar(root: zarr.FetchStore, varname: string) {
  const datavar = await zarr.open(root.resolve(varname), {
    kind: "array",
  });
  if (datavar.attrs?.grid_mapping) {
    return String(datavar.attrs.grid_mapping).split(":")[0];
  }
  const group = await zarr.open(root, { kind: "group" });
  if (group.attrs?.grid_mapping) {
    return String(group.attrs.grid_mapping).split(":")[0];
  }
  return "crs";
}

async function getGridType() {
  // FIXME: This is a clumsy hack to distinguish between different
  // grid types.
  if (!sourceValid.value) {
    return GRID_TYPES.ERROR;
  }
  const datasource =
    datasources.value!.levels[0].datasources[varnameSelector.value];
  try {
    try {
      // CHECK IF TRIANGULAR
      const gridsource = datasources.value!.levels[0].grid;
      const gridRoot = zarr.root(new zarr.FetchStore(gridsource.store));
      const grid = await zarr.open(gridRoot.resolve(gridsource.dataset), {
        kind: "group",
      });
      console.log("gridattrs", grid.attrs);
      await zarr.open(grid.resolve("vertex_of_cell"), {
        kind: "array",
      });
      return GRID_TYPES.TRIANGULAR;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      /* empty */
    }
    const root = zarr.root(
      new zarr.FetchStore(datasource.store + datasource.dataset)
    );
    const datavar = await zarr.open(root.resolve(varnameSelector.value), {
      kind: "array",
    });

    try {
      const crs = await zarr.open(
        root.resolve(await findCRSVar(root, varnameSelector.value)),
        {
          kind: "array",
        }
      );
      console.log("CRS ATTRS", crs.attrs);
      if (crs.attrs["grid_mapping_name"] === "healpix") {
        return GRID_TYPES.HEALPIX;
      }
    } catch {
      /* fall through to other cases */
    }
    if (datavar.attrs.grid_mapping === "rotated_latitude_longitude") {
      return GRID_TYPES.REGULAR_ROTATED;
    }
    if ((datavar.attrs._ARRAY_DIMENSIONS as unknown[]).length >= 3) {
      return GRID_TYPES.REGULAR;
    }
    return GRID_TYPES.GAUSSIAN;
  } catch (error) {
    toast.add({
      detail: `${getErrorMessage(error)}`,
      life: 3000,
    });
    return GRID_TYPES.ERROR;
  }
}

onMounted(async () => {
  isLoading.value = true;
  await updateSrc();
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
      :varinfo="varinfo"
      @selection="updateSelection"
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
      v-else
      ref="globe"
      :key="globeKey"
      :datasources="datasources"
      :colormap="selection.colormap"
      :invert-colormap="selection.invertColormap"
      :varbounds="selection.bounds"
      :is-rotated="gridType === GRID_TYPES.REGULAR_ROTATED"
      :projection="selection.projection"
      @varinfo="updateVarinfo"
    />
    <div v-if="isLoading || loading" class="top-right-loader loader" />
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
