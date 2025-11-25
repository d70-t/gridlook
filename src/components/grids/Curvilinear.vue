<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import { makeColormapMaterial } from "../utils/colormapShaders.ts";

import { datashaderExample } from "../utils/exampleFormatters.ts";
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
import { getDataBounds } from "../utils/zarrUtils.ts";

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
  getCamera,
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
  if (props.datasources !== undefined) {
    await Promise.all([getData()]);
    updateLandSeaMask();
    updateColormap(meshes);
  }
}

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

async function getTripolarLatLonData(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  datasources: TSources | undefined
) {
  const gridsource = datasources!.levels[0].grid;
  const gridRoot = zarr.root(new zarr.FetchStore(gridsource.store));
  const grid = await zarr.open(gridRoot.resolve(gridsource.dataset), {
    kind: "group",
  });

  // For tripolar grids, latitude and longitude are 2D arrays (j, i)
  const coordinates = datavar.attrs.coordinates as string;
  let latitudeName = "latitude";
  let longitudeName = "longitude";

  if (coordinates) {
    const coordNames = coordinates.split(" ");
    for (const coordName of coordNames) {
      if (coordName.includes("lat")) {
        latitudeName = coordName;
      } else if (coordName.includes("lon")) {
        longitudeName = coordName;
      }
    }
  }

  const latitudes = (
    await zarr
      .open(grid.resolve(latitudeName), { kind: "array" })
      .then(zarr.get)
  ).data as Float64Array;

  const longitudes = (
    await zarr
      .open(grid.resolve(longitudeName), { kind: "array" })
      .then(zarr.get)
  ).data as Float64Array;

  // Get the shape of the 2D grid
  const latArray = await zarr.open(grid.resolve(latitudeName), {
    kind: "array",
  });
  const gridShape = latArray.shape; // [j, i]

  return { latitudes, longitudes, gridShape };
}

async function getGrid(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  data: Float32Array
) {
  const { latitudes, longitudes, gridShape } = await getTripolarLatLonData(
    datavar,
    props.datasources
  );

  const [nj, ni] = gridShape;

  // Build tripolar grid geometry
  await buildTripolarGeometry(latitudes, longitudes, data, nj, ni);
}

async function buildTripolarGeometry(
  latitudes: Float64Array, // 2D array flattened: lat values at each (j,i) grid point
  longitudes: Float64Array, // 2D array flattened: lon values at each (j,i) grid point
  data: Float32Array, // 2D array flattened: data values at each (j,i) grid point
  nj: number, // Number of rows in the grid (j dimension)
  ni: number // Number of columns in the grid (i dimension)
) {
  // Calculate total cells in the grid
  // We use (nj-1) because each cell spans from row j to row j+1
  // So the last row (nj-1) can't form cells since there's no j+1 row
  const totalCells = (nj - 1) * ni;

  // Pre-allocate arrays for Three.js geometry
  // Each cell becomes a quad (4 vertices), each vertex has 3 coordinates (x,y,z)
  const positions = new Float32Array(totalCells * 4 * 3);
  // Each vertex gets a data value for the colormap shader
  const dataValues = new Float32Array(totalCells * 4);
  // Each quad is made of 2 triangles, each triangle needs 3 indices
  const indices = new Uint32Array(totalCells * 6);

  // Track our current position in the output arrays
  let vtxOffset = 0; // Offset into positions array (increments by 12 per cell)
  let idxOffset = 0; // Offset into indices array (increments by 6 per cell)
  let cellIndex = 0; // Current cell number (used for vertex indexing)

  // Main loop: iterate through all grid cells
  // j goes from 0 to nj-2 (we need j+1 to exist for each cell)
  // i goes from 0 to ni-1 (full width, with wraparound for last column)
  for (let j = 0; j < nj - 1; j++) {
    for (let i = 0; i < ni; i++) {
      // Convert 2D grid coordinates (j,i) to 1D array indices
      // The 2D arrays are flattened in row-major order: index = j * ni + i

      // Calculate indices for the 4 corners of this grid cell:
      // 00 = bottom-left, 01 = bottom-right, 10 = top-left, 11 = top-right
      const idx00 = j * ni + i; // Current position (j, i)
      const idx01 = j * ni + ((i + 1) % ni); // Next column with wraparound (j, i+1)
      const idx10 = (j + 1) * ni + i; // Next row (j+1, i)
      const idx11 = (j + 1) * ni + ((i + 1) % ni); // Next row + column (j+1, i+1)

      // Extract latitude and longitude values for each corner of the cell
      const lat00 = latitudes[idx00];
      const lon00 = longitudes[idx00];
      const lat01 = latitudes[idx01];
      const lon01 = longitudes[idx01];
      const lat10 = latitudes[idx10];
      const lon10 = longitudes[idx10];
      const lat11 = latitudes[idx11];
      const lon11 = longitudes[idx11];

      // Skip cells where any corner has invalid coordinates
      // This can happen at land boundaries or where the grid is not defined
      if (
        isNaN(lat00) ||
        isNaN(lon00) ||
        isNaN(lat01) ||
        isNaN(lon01) ||
        isNaN(lat10) ||
        isNaN(lon10) ||
        isNaN(lat11) ||
        isNaN(lon11)
      ) {
        continue;
      }

      // Handle longitude discontinuities for tripolar grids
      // Start with original longitude values, we'll adjust as needed
      let lon01Adj = lon01;
      let lon10Adj = lon10;
      let lon11Adj = lon11;

      // Check if we're at the wraparound boundary (last column connecting to first)
      // In tripolar grids, column ni-1 connects to column 0
      const isWraparound = (i + 1) % ni === 0;

      if (isWraparound) {
        // Special handling for wraparound boundary (longitude seam)
        // We need to ensure the wrapped longitudes create a smooth connection
        // rather than a 360-degree jump that would create visual artifacts

        // Adjust longitude for bottom edge of cell (lat00 -> lat01)
        if (lon01 < lon00 - 180) {
          lon01Adj = lon01 + 360; // lon01 wrapped too far negative, bring it up
        } else if (lon01 > lon00 + 180) {
          lon01Adj = lon01 - 360; // lon01 wrapped too far positive, bring it down
        }

        // Adjust longitude for top edge of cell (lat10 -> lat11)
        if (lon11 < lon10 - 180) {
          lon11Adj = lon11 + 360;
        } else if (lon11 > lon10 + 180) {
          lon11Adj = lon11 - 360;
        }
      } else {
        // Standard longitude adjustment for normal adjacent cells
        // Handle cases where longitude jumps more than 180° (crossing dateline)

        // Check horizontal neighbors (same latitude row)
        if (Math.abs(lon00 - lon01) > 180) {
          lon01Adj = lon01 < lon00 ? lon01 + 360 : lon01 - 360;
        }
        if (Math.abs(lon10 - lon11) > 180) {
          lon11Adj = lon11 < lon10 ? lon11 + 360 : lon11 - 360;
        }
      }

      // Also check and adjust vertical neighbors (different latitude rows)
      // This ensures smooth transitions between rows as well
      if (Math.abs(lon00 - lon10) > 180) {
        lon10Adj = lon10 < lon00 ? lon10 + 360 : lon10 - 360;
      }

      // Convert lat/lon to 3D Cartesian coordinates and store in positions array
      // Vertices are arranged counter-clockwise: 00 -> 01 -> 11 -> 10
      // This creates proper triangle winding for Three.js rendering
      latLonToCartesianFlat(lat00, lon00, positions, vtxOffset); // Bottom-left
      latLonToCartesianFlat(lat01, lon01Adj, positions, vtxOffset + 3); // Bottom-right
      latLonToCartesianFlat(lat11, lon11Adj, positions, vtxOffset + 6); // Top-right
      latLonToCartesianFlat(lat10, lon10Adj, positions, vtxOffset + 9); // Top-left

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

  // Trim arrays to remove unused space (if some cells were skipped due to NaN)
  // We pre-allocated for all possible cells, but some might have been invalid
  const trimmedPositions = positions.slice(0, cellIndex * 4 * 3);
  const trimmedDataValues = dataValues.slice(0, cellIndex * 4);
  const trimmedIndices = indices.slice(0, cellIndex * 6);

  // Create Three.js BufferGeometry from our arrays
  const geometry = new THREE.BufferGeometry();

  // Set vertex positions (x, y, z coordinates for each vertex)
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(trimmedPositions, 3)
  );

  // Set data values for colormap shader (one value per vertex)
  geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(trimmedDataValues, 1)
  );

  // Set triangle indices (which vertices form each triangle)
  geometry.setIndex(new THREE.BufferAttribute(trimmedIndices, 1));

  // Clean up: remove old meshes from scene and dispose their geometries
  for (const mesh of meshes) {
    mesh.geometry.dispose(); // Free GPU memory
    getScene()?.remove(mesh); // Remove from Three.js scene
  }
  meshes.length = 0; // Clear our mesh array

  // Create new mesh with the tripolar grid geometry and add to scene
  const mesh = new THREE.Mesh(geometry, colormapMaterial.value);
  meshes.push(mesh);
  getScene()?.add(mesh);
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
    const currentTimeIndexSliderValue = timeIndexSlider.value as number;
    const datavar = await getDataVar(localVarname, props.datasources!);

    if (datavar !== undefined) {
      const { dimensionRanges, indices } = getDimensionInfo(
        datavar,
        paramDimIndices.value,
        paramDimMinBounds.value,
        paramDimMaxBounds.value,
        dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
        2, // For curvilinear grids, we expect 2 spatial dimensions (j, i)
        varinfo.value?.dimRanges,
        updateMode
      );

      let rawData = (await zarr.get(datavar, indices)).data as Float32Array;
      if (rawData instanceof Float64Array) {
        // WebGL doesn't support Float64Array textures
        // we convert it to Float32Array and accept the loss of precision
        rawData = Float32Array.from(rawData);
      }
      let { min, max, missingValue, fillValue } = getDataBounds(
        datavar,
        rawData
      );
      for (let mesh of meshes) {
        const material = mesh.material as THREE.ShaderMaterial;
        material.uniforms.missingValue.value = missingValue;
        material.uniforms.fillValue.value = fillValue;
      }
      await getGrid(datavar, rawData);

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

function copyPythonExample() {
  const example = datashaderExample({
    cameraPosition: getCamera()!.position,
    datasrc: datasource.value!.store + datasource.value!.dataset,
    gridsrc: gridsource.value!.store + gridsource.value!.dataset,
    varname: varnameSelector.value,
    timeIndex: timeIndexSlider.value as number,
    varbounds: bounds.value!,
    colormap: colormap.value!,
    invertColormap: invertColormap.value,
  });
  navigator.clipboard.writeText(example);
}

onBeforeMount(async () => {
  await datasourceUpdate();
});

defineExpose({ makeSnapshot, copyPythonExample, toggleRotate });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
