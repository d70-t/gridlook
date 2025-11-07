<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import { grid2buffer, data2valueBuffer } from "./utils/gridlook.ts";
import {
  makeColormapMaterial,
  availableColormaps,
  calculateColorMapProperties,
} from "./utils/colormapShaders.ts";
import { decodeTime } from "./utils/timeHandling.ts";

import { datashaderExample } from "./utils/exampleFormatters.ts";
import {
  computed,
  onBeforeMount,
  ref,
  shallowRef,
  onMounted,
  watch,
  type Ref,
  type ShallowRef,
} from "vue";

import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "./store/store.js";
import { storeToRefs } from "pinia";
import type { TSources } from "../types/GlobeTypes.ts";
import { useLog } from "./utils/logging";
import { useSharedGlobeLogic } from "./sharedGlobe.ts";
import { useUrlParameterStore } from "./store/paramStore.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();
const { logError } = useLog();
const {
  dimSlidersValues,
  varnameSelector,
  colormap,
  invertColormap,
  selection,
  isInitializingVariable,
  varinfo,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const datavars: ShallowRef<
  Record<string, zarr.Array<zarr.DataType, zarr.FetchStore>>
> = shallowRef({});
const updateCount = ref(0);
const updatingData = ref(false);

let mainMesh: THREE.Mesh | undefined = undefined;

let canvas: Ref<HTMLCanvasElement | undefined> = ref();
let box: Ref<HTMLDivElement | undefined> = ref();

const {
  getScene,
  getCamera,
  redraw,
  makeSnapshot,
  toggleRotate,
  getDataVar,
  getTimeVar,
  updateLandSeaMask,
} = useSharedGlobeLogic(canvas, box);

watch(
  () => varnameSelector.value,
  () => {
    getData();
  }
);

watch(
  () => dimSlidersValues.value,
  () => {
    console.log("GLOBE: watch dimsliders", dimSlidersValues.value);
    if (isInitializingVariable.value) {
      isInitializingVariable.value = false;
      return;
    }
    getData(UPDATE_MODE.SLIDER_TOGGLE);
  },
  { deep: true }
);

watch(
  () => props.datasources,
  () => {
    datasourceUpdate();
  }
);

const bounds = computed(() => {
  return selection.value;
});

const timeIndexSlider = computed(() => {
  if (varinfo.value?.dimRanges[0]?.name !== "time") {
    return 0;
  }
  return dimSlidersValues.value[0];
});

watch(
  [() => bounds.value, () => invertColormap.value, () => colormap.value],
  () => {
    updateColormap();
  }
);

const colormapMaterial = computed(() => {
  if (invertColormap.value) {
    return makeColormapMaterial(colormap.value, 1.0, -1.0);
  } else {
    return makeColormapMaterial(colormap.value, 0.0, 1.0);
  }
});

const gridsource = computed(() => {
  if (props.datasources) {
    return props.datasources.levels[0].grid;
  } else {
    return undefined;
  }
});

const datasource = computed(() => {
  if (props.datasources) {
    return props.datasources.levels[0].datasources[varnameSelector.value];
  } else {
    return undefined;
  }
});

async function datasourceUpdate() {
  datavars.value = {};
  if (props.datasources !== undefined) {
    await Promise.all([fetchGrid(), getData()]);
    updateLandSeaMask();
    updateColormap();
  }
}

async function fetchGrid() {
  try {
    const root = zarr.root(new zarr.FetchStore(gridsource.value!.store));
    const grid = await zarr.open(root.resolve(gridsource.value!.dataset), {
      kind: "group",
    });
    const verts = await grid2buffer(grid);
    const myMesh = mainMesh as THREE.Mesh;
    myMesh.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(verts, 3)
    );
    myMesh.geometry.computeBoundingSphere();
    redraw();
  } catch (error) {
    logError(error, "Could not fetch grid");
  }
}

function updateColormap() {
  const low = bounds.value?.low as number;
  const high = bounds.value?.high as number;
  const { addOffset, scaleFactor } = calculateColorMapProperties(
    low,
    high,
    invertColormap.value
  );

  const myMesh = mainMesh as THREE.Mesh;
  const material = myMesh.material as THREE.ShaderMaterial;
  material.uniforms.colormap.value = availableColormaps[colormap.value];
  material.uniforms.addOffset.value = addOffset;
  material.uniforms.scaleFactor.value = scaleFactor;
  redraw();
}

function createDimensionRanges(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  presetStarts: Record<string, string>,
  presetMinBounds: Record<string, string>,
  presetMaxBounds: Record<string, string>,
  lastToIgnore: number
) {
  const dimensions = datavar.attrs._ARRAY_DIMENSIONS as string[];
  const shape = datavar.shape;
  const indices: ({
    name: string;
    startPos: number;
    minBound: number;
    maxBound: number;
  } | null)[] = shape.slice(0, shape.length - lastToIgnore).map((size, i) => {
    // console.log(dimensions[i]);
    if (size === 1) {
      // return 0;
      return { name: dimensions[i], startPos: 0, minBound: 0, maxBound: 0 }; // Single element dimension
    } else {
      // Placeholder for dimensions that need actual indexing
      // You'll need to define the logic for each dimension
      // const dimName = dimensions[i];
      let startPos = 0;
      let minBound = 0;
      let maxBound = size - 1;
      if (
        Object.hasOwn(presetMinBounds, dimensions[i]) &&
        !isNaN(Number(presetMinBounds[dimensions[i]]))
      ) {
        minBound = Number(presetMinBounds[dimensions[i]]);
      }
      if (
        Object.hasOwn(presetMaxBounds, dimensions[i]) &&
        !isNaN(Number(presetMaxBounds[dimensions[i]]))
      ) {
        maxBound = Number(presetMaxBounds[dimensions[i]]);
      }
      if (
        Object.hasOwn(presetStarts, dimensions[i]) &&
        !isNaN(Number(presetStarts[dimensions[i]]))
      ) {
        startPos = Number(presetStarts[dimensions[i]]);
        if (startPos < minBound) {
          startPos = minBound;
        }
        if (startPos > maxBound) {
          startPos = maxBound;
        }
      }
      return {
        name: dimensions[i],
        startPos,
        minBound,
        maxBound,
      };
    }
  });

  for (let i = 0; i < lastToIgnore; i++) {
    indices.push(null);
  }
  return indices;
  // Add wildcard for last dimension
}

async function getData(updateMode: TUpdateMode = UPDATE_MODE.INITIAL_LOAD) {
  console.log(">>> GET DATA <<<", updateMode);
  store.startLoading();
  try {
    updateCount.value += 1;
    const myUpdatecount = updateCount.value;
    if (updatingData.value) {
      return;
    }
    updatingData.value = true;

    const localVarname = varnameSelector.value;
    const currentTimeIndexSliderValue = timeIndexSlider.value;
    console.log("currentTimeIndexSliderValue", currentTimeIndexSliderValue);
    const [timevar, datavar] = await Promise.all([
      getTimeVar(props.datasources!),
      getDataVar(localVarname, props.datasources!),
    ]);
    let timeinfo = {};
    if (timevar !== undefined) {
      const timeattrs = timevar.attrs;
      const timevalues = (await zarr.get(timevar, [null])).data;
      timeinfo = {
        values: timevalues,
        current: decodeTime(
          (timevalues as number[])[currentTimeIndexSliderValue],
          timeattrs
        ),
      };
    }
    if (datavar !== undefined) {
      let dimensionRanges: ({
        name: string;
        startPos: number;
        minBound: number;
        maxBound: number;
      } | null)[] = [];
      dimensionRanges = createDimensionRanges(
        datavar,
        paramDimIndices.value,
        paramDimMinBounds.value,
        paramDimMaxBounds.value,
        1
      );
      let indices: (number | null)[] = [];
      if (updateMode === UPDATE_MODE.INITIAL_LOAD) {
        indices = dimensionRanges.map((d) => {
          if (d === null) {
            return null;
          } else {
            return d.startPos;
          }
        });
        console.log("initial indices", indices);
      } else {
        console.log("dimslidervalues", dimSlidersValues.value);
        indices = dimSlidersValues.value;
      }

      const rawData = await zarr.get(datavar, indices);
      // console.log("rawData", rawData);
      const dataBuffer = data2valueBuffer(rawData);
      mainMesh?.geometry.setAttribute(
        "data_value",
        new THREE.BufferAttribute(dataBuffer.dataValues, 1)
      );
      store.updateVarInfo(
        {
          attrs: datavar.attrs,
          timeinfo,
          timeRange: { start: 0, end: datavar.shape[0] - 1 },
          bounds: { low: dataBuffer.dataMin, high: dataBuffer.dataMax },
          dimRanges: dimensionRanges,
        },
        updateMode
      );
      redraw();
    }
    updatingData.value = false;
    if (updateCount.value !== myUpdatecount) {
      console.log("UPDATE COUNT?!");
      await getData(updateMode);
    }
  } catch (error) {
    logError(error, "Could not fetch data");
    updatingData.value = false;
  } finally {
    store.stopLoading();
  }
}

function copyPythonExample() {
  const example = datashaderExample({
    cameraPosition: getCamera()!.position,
    datasrc: datasource.value!.store + datasource.value!.dataset,
    gridsrc: gridsource.value!.store + gridsource.value!.dataset,
    varname: varnameSelector.value,
    timeIndex: timeIndexSlider.value,
    varbounds: bounds.value,
    colormap: colormap.value,
    invertColormap: invertColormap.value,
  });
  navigator.clipboard.writeText(example);
}

onMounted(() => {
  getScene()?.add(mainMesh as THREE.Mesh);
});

onBeforeMount(async () => {
  const geometry = new THREE.BufferGeometry();
  const material = colormapMaterial.value;
  mainMesh = new THREE.Mesh(geometry, material);
  await datasourceUpdate();
});

defineExpose({ makeSnapshot, copyPythonExample, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>

<style>
div.globe_box {
  height: 100%;
  width: 100%;
  padding: 0;
  margin: 0;
  overflow: hidden;
  display: flex;
  z-index: 0;
}

div.globe_canvas {
  padding: 0;
  margin: 0;
}
</style>
