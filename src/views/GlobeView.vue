<script lang="ts" setup>
import * as zarr from "zarrita";
import GlobeHealpix from "@/components/GlobeHealpix.vue";
import GlobeRegular from "@/components/GlobeRegular.vue";
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

async function setGridType() {
  const localVarname = await getGridType();
  console.log("localVarname", localVarname);
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

const updateSelection = (s: TSelection) => {
  selection.value = s;
};

const updateVarinfo = (info: TVarInfo) => {
  varinfo.value = info;
};

const updateSrc = async () => {
  const src = props.src;
  const datasourcesResponse = await fetch(src)
    .then((r) => {
      if (!r.ok) {
        throw new Error(r.statusText);
      }
      return r.json();
    })
    .then((r) => {
      sourceValid.value = true;
      return r;
    })
    .catch((e: { message: string }) => {
      toast.add({
        severity: "error",
        summary: "Error",
        detail: `Failed to fetch data: ${e.message}`,
        life: 3000,
      });
      sourceValid.value = false;
    });
  if (sourceValid.value) {
    if (src === props.src) {
      datasources.value = datasourcesResponse;
    }
    varnameSelector.value =
      modelInfo.value!.defaultVar ?? Object.keys(modelInfo.value!.vars)[0];
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

async function getGridType() {
  if (!sourceValid.value) {
    return GRID_TYPES.ERROR;
  }
  const myDatasource =
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
    const root = zarr.root(new zarr.FetchStore(myDatasource.store));
    const datavar = await zarr.open(
      root.resolve(myDatasource.dataset + `/${varnameSelector.value}`),
      {
        kind: "array",
      }
    );
    console.log("dataattrs", datavar.attrs);
    if (datavar.attrs.grid_mapping === "crs") {
      const crs = await zarr.open(root.resolve(myDatasource.dataset + `/crs`), {
        kind: "array",
      });
      console.log("CRS ATTRS", crs.attrs);
      if (crs.attrs["grid_mapping_name"] === "healpix") {
        return GRID_TYPES.HEALPIX;
      }
    } else if (datavar.attrs.grid_mapping === "rotated_latitude_longitude") {
      const crs = await zarr.open(
        root.resolve(myDatasource.dataset + `/rotated_latitude_longitude`),
        {
          kind: "array",
        }
      );
      console.log("CRS ATTRS", crs.attrs);
      return GRID_TYPES.REGULAR_ROTATED;
    }
    return GRID_TYPES.REGULAR;
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
    <!-- <div
      class="notification is-danger is-light has-text-centered mx-auto"
      style="max-width: 400px"
    >
      {{ gridType }}
    </div> -->
    <div v-if="isLoading" class="mx-auto loader"></div>
    <div
      v-else-if="gridType === GRID_TYPES.ERROR"
      class="notification is-danger is-light has-text-centered mx-auto"
      style="max-width: 400px"
    >
      An error occurred. Possibly missing or not supported data.
    </div>
    <component
      :is="gridType === GRID_TYPES.HEALPIX ? GlobeHealpix : Globe"
      v-else
      ref="globe"
      :key="globeKey"
      :datasources="datasources"
      :colormap="selection.colormap"
      :invert-colormap="selection.invertColormap"
      :varbounds="selection.bounds"
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
