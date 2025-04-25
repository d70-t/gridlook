<script lang="ts" setup>
import GlobeHealpix from "@/components/GlobeHealpix.vue";
import Globe from "@/components/Globe.vue";
import GlobeControls from "@/components/GlobeControls.vue";
import { availableColormaps } from "@/components/utils/colormapShaders.js";
import { ref, computed, watch, onMounted, type Ref, onBeforeMount } from "vue";
import type {
  TColorMap,
  TSelection,
  TSources,
  TVarInfo,
} from "../types/GlobeTypes";
import { useGlobeControlStore } from "../components/store/store";
import Toast from "primevue/toast";
import { useToast } from "primevue/usetoast";
import * as zarr from "zarrita";
import { storeToRefs } from "pinia";
import { getErrorMessage } from "../components/utils/errorHandling";

const props = defineProps<{ src: string }>();

const toast = useToast();
const store = useGlobeControlStore();

const { varnameSelector } = storeToRefs(store);

const globe: Ref<typeof Globe | null> = ref(null);
const globeKey = ref(0);
const globeControlKey = ref(0);
const datasources: Ref<TSources | undefined> = ref(undefined);
const selection: Ref<Partial<TSelection>> = ref({});
const varinfo: Ref<TVarInfo | undefined> = ref(undefined);
const isHealpixResult = ref(false);
const isHealpixCalledOnce = ref(false);

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

const updateSelection = (s: TSelection) => {
  selection.value = s;
};

const updateVarinfo = (info: TVarInfo) => {
  varinfo.value = info;
};

async function checkIsHealpix() {
  isHealpixResult.value = await isHealpix();
  if (varnameSelector.value !== "-") {
    isHealpixCalledOnce.value = true;
  }
}

watch(
  () => varnameSelector.value,
  () => {
    if (datasources.value !== undefined) {
      checkIsHealpix();
    }
  }
);

async function updateSrc() {
  const src = props.src;
  const datasourcesResponse = await fetch(src)
    .then((r) => {
      if (!r.ok) {
        throw new Error(r.statusText);
      }
      return r.json();
    })
    .catch((e: { message: string }) => {
      toast.add({
        severity: "error",
        summary: "Error",
        detail: `Failed to fetch data: ${e.message}`,
        life: 3000,
      });
    });
  console.log("wat?", src, props.src, datasourcesResponse);
  if (src === props.src) {
    datasources.value = datasourcesResponse;
  }
}

const makeSnapshot = () => {
  if (globe.value) {
    globe.value.makeSnapshot();
  }
};

async function isHealpix() {
  if (varnameSelector.value === "-") {
    return false;
  }
  const myDatasource =
    datasources.value!.levels[0].datasources[varnameSelector.value];
  try {
    const root = zarr.root(new zarr.FetchStore(myDatasource.store));
    const datavar = await zarr.open(
      root.resolve(myDatasource.dataset + `/${varnameSelector.value}`),
      {
        kind: "array",
      }
    );
    if (datavar.attrs.grid_mapping === "crs") {
      const crs = await zarr.open(root.resolve(myDatasource.dataset + `/crs`), {
        kind: "array",
      });
      if (crs.attrs["grid_mapping_name"] === "healpix") {
        return true;
      }
    }
    return false;
  } catch (error) {
    // toast.add({
    //   detail: `${getErrorMessage(error)}`,
    //   life: 3000,
    // });
    return false;
  }
}

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

watch(
  () => props.src,
  async () => {
    // Rerender controls and globe and reset store
    // if new data is provided
    globeKey.value += 1;
    globeControlKey.value += 1;
    store.$reset();
    await updateSrc();
  }
);

// onMounted(() => {
// });

onBeforeMount(async () => {
  await updateSrc();
  await checkIsHealpix();
});
</script>

<template>
  <main>
    <Toast unstyled>
      <template #container="{ message, closeCallback }">
        <div
          class="message"
          :class="message.severity === 'success' ? 'is-success' : 'is-danger'"
          style="max-width: 400px"
        >
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
      :key="globeControlKey"
      :model-info="modelInfo"
      :varinfo="varinfo"
      @selection="updateSelection"
      @on-snapshot="makeSnapshot"
      @on-example="makeExample"
      @on-rotate="toggleRotate"
    />
    <div v-if="isHealpixCalledOnce === false">load</div>
    <component
      :is="isHealpixResult ? GlobeHealpix : Globe"
      v-else
      ref="globe"
      :key="globeKey"
      :datasources="datasources"
      :colormap="selection.colormap"
      :invert-colormap="selection.invertColormap"
      :varbounds="selection.bounds"
      @varinfo="updateVarinfo"
    />
    <!-- <GlobeHealpix
      ref="globe"
      :key="globeKey"
      :datasources="datasources"
      :colormap="selection.colormap"
      :invert-colormap="selection.invertColormap"
      :varbounds="selection.bounds"
      @varinfo="updateVarinfo"
    /> -->
  </main>
</template>

<style>
main {
  overflow: hidden;
}
</style>
<!--
<component
:is="isHealpixResult ? GlobeHealpix : Globe"
ref="globe"
:key="globeKey"
:datasources="datasources"
:colormap="selection.colormap"
:invert-colormap="selection.invertColormap"
:varbounds="selection.bounds"
@varinfo="updateVarinfo"
/>
-->
