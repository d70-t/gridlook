<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import { makeColormapMaterial } from "../utils/colormapShaders.ts";

import { computed, onBeforeMount, ref, watch } from "vue";

import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "../store/store.js";
import { storeToRefs } from "pinia";
import type { TSources } from "../../types/GlobeTypes.ts";
import { useLog } from "../utils/logging.ts";
import { useSharedGridLogic } from "./useSharedGridLogic.ts";
import { useUrlParameterStore } from "../store/paramStore.ts";
import { getDimensionInfo } from "../utils/dimensionHandling.ts";
import {
  castDataVarToFloat32,
  getDataBounds,
  getLatLonData,
} from "../utils/zarrUtils.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();
const { logError } = useLog();

const {
  dimSlidersValues,
  colormap,
  varnameSelector,
  invertColormap,
  selection,
  isInitializingVariable,
  varinfo,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const updateCount = ref(0);
const updatingData = ref(false);

let meshes: THREE.Mesh[] = [];

const {
  getScene,
  redraw,
  makeSnapshot,
  toggleRotate,
  getDataVar,
  getTimeInfo,
  updateLandSeaMask,
  updateColormap,
  canvas,
  box,
} = useSharedGridLogic();

watch(
  () => varnameSelector.value,
  () => {
    getData();
  }
);

watch(
  () => dimSlidersValues.value,
  () => {
    if (isInitializingVariable.value) {
      isInitializingVariable.value = false;
      return;
    }
    getData(UPDATE_MODE.SLIDER_TOGGLE);
  },
  { deep: true }
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
    updateColormap(meshes);
  }
);

const colormapMaterial = computed(() => {
  if (invertColormap) {
    return makeColormapMaterial(colormap.value, 1.0, -1.0);
  } else {
    return makeColormapMaterial(colormap.value, 0.0, 1.0);
  }
});

async function datasourceUpdate() {
  if (props.datasources !== undefined) {
    await Promise.all([getData()]);
    updateLandSeaMask();
    updateColormap(meshes);
  }
}

const BATCH_SIZE = 30;

function latLonToCartesianFlat(
  lat: number,
  lon: number,
  out: Float32Array,
  offset: number,
  radius = 1
) {
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  out[offset] = radius * Math.cos(latRad) * Math.cos(lonRad);
  out[offset + 1] = radius * Math.cos(latRad) * Math.sin(lonRad);
  out[offset + 2] = radius * Math.sin(latRad);
}

async function getGrid(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  data: Float32Array,
  missingValue: number,
  fillValue: number
) {
  const { latitudes, longitudes } = await getLatLonData(
    datavar,
    props.datasources
  );

  const latitudesData = latitudes.data as Float64Array;
  const longitudesData = longitudes.data as Float64Array;
  const [nj, ni] = latitudes.shape;

  // Detect potential mirroring issues by analyzing longitude progression
  const shouldFlipLongitude = detectLongitudeFlip(
    longitudesData,
    missingValue,
    fillValue
  );

  await buildCurvilinearGeometry(
    latitudesData,
    longitudesData,
    data,
    nj,
    ni,
    shouldFlipLongitude
  );
}

function detectLongitudeFlip(
  longitudes: Float64Array,
  missingValue: number,
  fillValue: number
): boolean {
  for (let i = 1; i < longitudes.length; i++) {
    if (longitudes[i] === missingValue || longitudes[i] === fillValue) {
      i++; // double increment in order to avoid comparison with missing values
      continue; // skip missing values
    }
    if (longitudes[i] > longitudes[i - 1]) {
      return false;
    } else if (longitudes[i] < longitudes[i - 1]) {
      return true;
    }
  }
  return true;
}

async function buildCurvilinearGeometry(
  latitudes: Float64Array, // 2D array flattened: lat values at each (j,i) grid point
  longitudes: Float64Array, // 2D array flattened: lon values at each (j,i) grid point
  data: Float32Array, // 2D array flattened: data values at each (j,i) grid point
  nj: number, // Number of rows in the grid (j dimension)
  ni: number, // Number of columns in the grid (i dimension)
  flipLongitude: boolean = false // Whether to flip longitude ordering
) {
  // Clean up: remove old meshes from scene and dispose their geometries

  const totalBatches = Math.ceil((nj - 1) / BATCH_SIZE);
  if (meshes.length > totalBatches) {
    // we have more meshes than needed
    // Seems like the grid has changed to a smaller size
    for (const mesh of meshes) {
      mesh.geometry.dispose(); // Free GPU memory
      getScene()?.remove(mesh); // Remove from Three.js scene
    }
    meshes.length = 0; // Clear our mesh array
  }

  // Calculate total number of batches

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const jStart = batchIndex * BATCH_SIZE;
    const jEnd = Math.min(jStart + BATCH_SIZE, nj - 1);

    // Calculate cells in this batch
    const batchCells = (jEnd - jStart) * ni;

    // Pre-allocate arrays for this batch's Three.js geometry
    // Each cell becomes a quad (4 vertices), each vertex has 3 coordinates (x,y,z)
    const positions = new Float32Array(batchCells * 4 * 3);
    // Each vertex gets a data value for the colormap shader
    const dataValues = new Float32Array(batchCells * 4);
    // Each quad is made of 2 triangles, each triangle needs 3 indices
    const indices = new Uint32Array(batchCells * 6);

    // Track our current position in the output arrays
    let vtxOffset = 0; // Offset into positions array (increments by 12 per cell)
    let idxOffset = 0; // Offset into indices array (increments by 6 per cell)
    let cellIndex = 0; // Current cell number (used for vertex indexing)

    // Main loop: iterate through grid cells in this batch
    // j goes from jStart to jEnd-1 (we need j+1 to exist for each cell)
    // i goes from 0 to ni-1 (full width, with wraparound for last column)
    for (let j = jStart; j < jEnd; j++) {
      for (let i = 0; i < ni; i++) {
        // Convert 2D grid coordinates (j,i) to 1D array indices
        // The 2D arrays are flattened in row-major order: index = j * ni + i

        // Calculate indices for the 4 corners of this grid cell:
        // Handle longitude ordering based on flip flag
        let iNext;
        if (flipLongitude) {
          // For datasets with decreasing longitude, reverse the progression
          iNext = i === 0 ? ni - 1 : i - 1;
        } else {
          // Normal progression: wraparound for longitude
          iNext = (i + 1) % ni;
        }

        const idx00 = j * ni + i; // Current position (j, i)
        const idx01 = j * ni + iNext; // Next/previous column based on flip (j, i±1)
        const idx10 = (j + 1) * ni + i; // Next row (j+1, i)
        const idx11 = (j + 1) * ni + iNext; // Next row + column (j+1, i±1)

        // Extract latitude and longitude values for each corner of the cell
        const lat00 = latitudes[idx00];
        const lon00 = longitudes[idx00];
        const lat01 = latitudes[idx01];
        const lon01 = longitudes[idx01];
        const lat10 = latitudes[idx10];
        const lon10 = longitudes[idx10];
        const lat11 = latitudes[idx11];
        const lon11 = longitudes[idx11];

        // Convert lat/lon to 3D Cartesian coordinates and store in positions array
        // Vertices are arranged counter-clockwise: 00 -> 01 -> 11 -> 10
        // This creates proper triangle winding for Three.js rendering
        latLonToCartesianFlat(lat00, lon00, positions, vtxOffset); // Bottom-left
        latLonToCartesianFlat(lat01, lon01, positions, vtxOffset + 3); // Bottom-right
        latLonToCartesianFlat(lat11, lon11, positions, vtxOffset + 6); // Top-right
        latLonToCartesianFlat(lat10, lon10, positions, vtxOffset + 9); // Top-left

        // Assign data value to all 4 vertices of this cell
        // We use the data value from the bottom-left corner (idx00)
        const dataValue = data[idx00];
        dataValues.fill(dataValue, cellIndex * 4, cellIndex * 4 + 4);

        // Create triangle indices to form a quad from our 4 vertices
        // Each quad is split into 2 triangles:
        // Triangle 1: vertices 0, 1, 2 (bottom-left, bottom-right, top-right)
        // Triangle 2: vertices 0, 2, 3 (bottom-left, top-right, top-left)
        // This creates counter-clockwise winding for proper rendering
        const v = cellIndex * 4; // Base vertex index for this cell
        indices.set([v, v + 1, v + 2, v, v + 2, v + 3], idxOffset);

        // Move to next position in arrays for the next cell
        vtxOffset += 12; // 4 vertices × 3 coordinates = 12 floats
        idxOffset += 6; // 2 triangles × 3 indices = 6 indices
        cellIndex++; // Increment cell counter
      }
    }
    // Create Three.js BufferGeometry from our arrays for this batch
    const geometry = new THREE.BufferGeometry();

    // Set vertex positions (x, y, z coordinates for each vertex)
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    // Set data values for colormap shader (one value per vertex)
    geometry.setAttribute(
      "data_value",
      new THREE.BufferAttribute(dataValues, 1)
    );

    // Set triangle indices (which vertices form each triangle)
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    if (meshes[batchIndex]) {
      meshes[batchIndex].geometry.dispose();
      meshes[batchIndex].geometry = geometry;
    } else {
      const mesh = new THREE.Mesh(geometry, colormapMaterial.value);
      meshes.push(mesh);
      getScene()?.add(mesh);
    }
  }
}

async function getData(updateMode: TUpdateMode = UPDATE_MODE.INITIAL_LOAD) {
  store.startLoading();
  try {
    updateCount.value += 1;
    const myUpdatecount = updateCount.value;
    if (updatingData.value) {
      return;
    }
    updatingData.value = true;
    const localVarname = varnameSelector.value;
    const datavar = await getDataVar(localVarname, props.datasources!);

    if (datavar !== undefined) {
      const { dimensionRanges, indices } = getDimensionInfo(
        datavar,
        paramDimIndices.value,
        paramDimMinBounds.value,
        paramDimMaxBounds.value,
        dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
        [datavar.shape.length - 2, datavar.shape.length - 1],
        varinfo.value?.dimRanges,
        updateMode
      );

      let rawData = castDataVarToFloat32(
        (await zarr.get(datavar, indices)).data
      );

      let { min, max, missingValue, fillValue } = getDataBounds(
        datavar,
        rawData
      );

      await getGrid(datavar, rawData, missingValue, fillValue);

      for (let mesh of meshes) {
        const material = mesh.material as THREE.ShaderMaterial;
        material.uniforms.missingValue.value = missingValue;
        material.uniforms.fillValue.value = fillValue;
      }

      const currentTimeIndexSliderValue = timeIndexSlider.value as number;
      const timeinfo = await getTimeInfo(
        props.datasources!,
        dimensionRanges,
        currentTimeIndexSliderValue
      );

      store.updateVarInfo(
        {
          attrs: datavar.attrs,
          timeinfo,
          bounds: { low: min, high: max },
          dimRanges: dimensionRanges,
        },
        indices as number[],
        updateMode
      );
      redraw();
    }
    updatingData.value = false;
    if (updateCount.value !== myUpdatecount) {
      await getData();
    }
  } catch (error) {
    logError(error, "Could not fetch data");
    updatingData.value = false;
  } finally {
    store.stopLoading();
  }
}

onBeforeMount(async () => {
  await datasourceUpdate();
});

defineExpose({ makeSnapshot, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
