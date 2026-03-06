<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, ref, watch } from "vue";
import type * as zarr from "zarrita";

import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  castDataVarToFloat32,
  getDataBounds,
  isLatitudeName,
  isLongitudeName,
} from "@/lib/data/zarrUtils.ts";
import {
  getColormapScaleOffset,
  makeGpuProjectedTextureMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type { TDimensionRange, TSources } from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "@/store/store.ts";
import { useLog } from "@/utils/logging.ts";

const props = defineProps<{
  datasources?: TSources;
  isRotated?: boolean;
}>();

const store = useGlobeControlStore();
const { logError } = useLog();
const {
  dimSlidersValues,
  colormap,
  varnameSelector,
  invertColormap,
  posterizeLevels,
  selection,
  isInitializingVariable,
  varinfo,
  projectionMode,
  projectionCenter,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const {
  getScene,
  redraw,
  makeSnapshot,
  toggleRotate,
  resetDataVars,
  getDataVar,
  fetchDimensionDetails,
  updateLandSeaMask,
  updateColormap,
  updateHistogram,
  projectionHelper,
  canvas,
  box,
} = useSharedGridLogic();

const pendingUpdate = ref(false);
const updatingData = ref(false);

const longitudes = ref(new Float64Array());
const latitudes = ref(new Float64Array());

const BATCH_SIZE = 60;
let meshes: THREE.Mesh[] = [];
watch(
  () => varnameSelector.value,
  () => {
    getData();
  }
);

watch(
  () => dimSlidersValues.value,
  async () => {
    if (isInitializingVariable.value) {
      isInitializingVariable.value = false;
      return;
    }
    await getData(UPDATE_MODE.SLIDER_TOGGLE);
    updateColormap(meshes);
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

watch(
  [
    () => bounds.value,
    () => invertColormap.value,
    () => colormap.value,
    () => posterizeLevels.value,
  ],
  () => {
    updateColormap(meshes);
  }
);

watch(
  [() => projectionMode.value, () => projectionCenter.value],
  () => {
    updateMeshProjectionUniforms();
  },
  { deep: true }
);

function updateMeshProjectionUniforms() {
  const helper = projectionHelper.value;
  const center = projectionCenter.value;
  for (const mesh of meshes) {
    const material = mesh.material as THREE.ShaderMaterial;
    if (material.uniforms?.projectionType) {
      updateProjectionUniforms(material, helper.type, center.lon, center.lat);
    }
  }
  redraw();
}

async function datasourceUpdate() {
  resetDataVars();
  if (props.datasources !== undefined) {
    await getDims();
    await Promise.all([makeGeometry(), getData()]);
    updateLandSeaMask();
    updateColormap(meshes);
  }
}

const isLatOnly = ref(false);

async function getDims() {
  // Assumptions: the last two dimensions of the data array are
  // latitude and longitude (in this order), or lat-only for zonally averaged data
  // FIXME: this may not always be true and probably it would be cleaner
  // to use the implemented ZarrUtils.getLatLonData function

  // We had, however, cases where we could not determine wether the grid is
  // rotated or not, which lead to failure in getLatLonData.
  // On the other hand, I didn't find any case where latitudes and longitudes were not
  // the two last dimensions of the data variable.
  const dimensions = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );

  const lastDim = dimensions[dimensions.length - 1];
  const secondLastDim = dimensions[dimensions.length - 2];

  // Check if this is a lat-only dataset (zonally averaged)
  const latOnlyCheck =
    isLatitudeName(lastDim) && !isLongitudeName(secondLastDim);
  isLatOnly.value = latOnlyCheck;

  const grid = props.datasources!.levels[0].grid;
  if (latOnlyCheck) {
    const latitudesData = await ZarrDataManager.getVariableData(grid, lastDim);
    latitudes.value = new Float64Array(latitudesData.data as Float64Array);
    // Create synthetic global longitudes for visualization
    longitudes.value = Float64Array.from({ length: 360 }, (_, i) => i - 179.5);
  } else {
    const latName = secondLastDim;
    const lonName = lastDim;
    const [latitudesData, longitudesData] = await Promise.all([
      ZarrDataManager.getVariableData(grid, latName),
      ZarrDataManager.getVariableData(grid, lonName),
    ]);
    const myLongitudes = longitudesData.data as Float64Array;
    const myLatitudes = latitudesData.data as Float64Array;
    longitudes.value = new Float64Array(new Set(myLongitudes));
    latitudes.value = new Float64Array(new Set(myLatitudes));
  }
}

function rotatedToGeographic(
  latR: number,
  lonR: number,
  poleLat: number,
  poleLon: number
) {
  const latRRad = THREE.MathUtils.degToRad(latR);
  const lonRRad = THREE.MathUtils.degToRad(lonR);
  const poleLatRad = THREE.MathUtils.degToRad(poleLat);
  const poleLonRad = THREE.MathUtils.degToRad(poleLon);

  const sinPhi =
    Math.sin(poleLatRad) * Math.sin(latRRad) +
    Math.cos(poleLatRad) * Math.cos(latRRad) * Math.cos(lonRRad);
  const phi = Math.asin(sinPhi);

  const y = -Math.cos(latRRad) * Math.sin(lonRRad);
  const x =
    Math.sin(latRRad) * Math.cos(poleLatRad) -
    Math.cos(latRRad) * Math.sin(poleLatRad) * Math.cos(lonRRad);
  const lambda = poleLonRad + Math.atan2(y, x);

  // Normalize longitude to [-180, 180)
  let lon = THREE.MathUtils.radToDeg(lambda);
  if (lon > 180) {
    lon -= 360;
  }
  if (lon < -180) {
    lon += 360;
  }

  const lat = THREE.MathUtils.radToDeg(phi);
  return { lat, lon };
}

function isLongitudeGlobal(longitudes: Float64Array): boolean {
  const n = longitudes.length;
  if (n < 2) {
    return false;
  }

  // Use unwrapped longitudes to check span
  const span = Math.abs(longitudes[n - 1] - longitudes[0]);

  // Estimate the grid spacing
  const avgDelta = span / (n - 1);

  // Check if span + one grid cell covers 360°
  return span + avgDelta > 359.5;
}

/**
 * Generates vertices, UVs, and lat/lon coordinates for a grid.
 *
 * For GPU projection, we store lat/lon as vertex attributes and use
 * placeholder positions (0,0,0) that will be computed in the vertex shader.
 * We also compute initial positions for the current projection to avoid
 * a flash of incorrect geometry on first render.
 */
function generateGridVerticesAndUVs(
  latitudes: Float64Array,
  longitudes: Float64Array,
  isReversed: boolean,
  isRotated: boolean,
  poleLat?: number,
  poleLon?: number
) {
  const positionValues: number[] = [];
  const uvs: number[] = [];
  const latCount = latitudes.length;
  const lonCount = longitudes.length;
  const latLonValues = new Float32Array(latCount * lonCount * 2);

  const helper = projectionHelper.value;

  for (let i = 0; i < latCount; i++) {
    const rawLat = latitudes[i];
    for (let j = 0; j < lonCount; j++) {
      const rawLon = longitudes[j];

      // If the grid is rotated, convert the raw latitude and longitude values
      // to geographic coordinates.
      const { lat, lon } = isRotated
        ? rotatedToGeographic(rawLat, rawLon, poleLat!, poleLon!)
        : { lat: rawLat, lon: rawLon };

      // Store lat/lon for GPU projection and set initial positions
      const latLonOffset = (i * lonCount + j) * 2;
      const positionOffset = positionValues.length;
      helper.projectLatLonToArrays(
        lat,
        lon,
        positionValues,
        positionOffset,
        latLonValues,
        latLonOffset
      );

      // Calculate the texture coordinates for the point. The `u` coordinate
      // represents the longitude, and the `v` coordinate represents the latitude.
      // The coordinates are normalized to the range [0, 1].
      const u = j / (lonCount - 1);
      const v = isReversed
        ? (latCount - 1 - i) / (latCount - 1)
        : i / (latCount - 1);
      uvs.push(u, v);
    }
  }

  return { positionValues, uvs, latLonValues };
}

function generateGridIndices(
  latCount: number,
  lonCount: number,
  isGlobal: boolean
) {
  const indices: number[] = [];
  const latIterationEnd = latCount - 1;
  const lonIterationEnd = isGlobal ? lonCount : lonCount - 1;

  for (let latIt = 0; latIt < latIterationEnd; latIt++) {
    for (let lonIt = 0; lonIt < lonIterationEnd; lonIt++) {
      const nextJ = isGlobal ? (lonIt + 1) % lonCount : lonIt + 1;
      const lowLeft = latIt * lonCount + lonIt;
      const lowRight = latIt * lonCount + nextJ;
      const topLeft = (latIt + 1) * lonCount + lonIt;
      const topRight = (latIt + 1) * lonCount + nextJ;

      indices.push(lowLeft, topRight, topLeft);
      indices.push(lowLeft, lowRight, topRight);
    }
  }

  return indices;
}

function normalizeLongitudes(longitudes: Float64Array): Float64Array {
  // Normalize longitudes to [0, 360)
  return Float64Array.from(longitudes, (lon) => ((lon % 360) + 360) % 360);
}

async function getGaussianGrid() {
  const isRotated = props.isRotated;
  let longitudeValues = normalizeLongitudes(longitudes.value);
  let latitudeValues = latitudes.value;

  // Check if latitudes are descending and reverse if necessary
  let isLatReversed =
    latitudeValues[0] > latitudeValues[latitudeValues.length - 1];
  if (isLatReversed) {
    latitudeValues = Float64Array.from(latitudeValues).reverse();
  }

  const isGlobal = isLongitudeGlobal(longitudes.value);

  if (isGlobal) {
    // Add a duplicate of the first longitude + 360 to close the globe
    const firstLon = longitudeValues[0];
    longitudeValues = new Float64Array([...longitudeValues, firstLon + 360]);
  }

  let poleLat, poleLon;
  if (isRotated) {
    const rotatedNorthPole = await getRotatedNorthPole();
    poleLat = rotatedNorthPole.lat;
    poleLon = rotatedNorthPole.lon;
  }
  const { positionValues, uvs, latLonValues } = generateGridVerticesAndUVs(
    latitudeValues,
    longitudeValues,
    isLatReversed,
    isRotated,
    poleLat,
    poleLon
  );

  const latCount = latitudeValues.length;
  const lonCount = longitudeValues.length;

  return {
    positionValues,
    uvs,
    latLonValues,
    latCount,
    lonCount,
    isGlobal,
  };
}

function cleanupMeshes(totalBatches: number) {
  if (meshes.length <= totalBatches) {
    return;
  }
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    getScene()?.remove(mesh);
  }
  meshes.length = 0;
}

function createBatchGeometry(
  positionValues: number[],
  uvs: number[],
  latLonValues: Float32Array,
  lonCount: number,
  isGlobal: boolean,
  latStart: number,
  latEnd: number
) {
  const geometry = new THREE.BufferGeometry();

  // Extract vertices for this batch (from latStart to latEnd inclusive)
  const batchLatCount = latEnd - latStart + 1;
  const startVertex = latStart * lonCount;
  const endVertex = (latEnd + 1) * lonCount;

  const batchPositions = positionValues.slice(startVertex * 3, endVertex * 3);
  const batchUvs = uvs.slice(startVertex * 2, endVertex * 2);
  const batchLatLon = latLonValues.slice(startVertex * 2, endVertex * 2);

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(batchPositions, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(batchUvs, 2));
  geometry.setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute(batchLatLon, 2)
  );

  // Generate indices for this batch
  const indices = generateGridIndices(batchLatCount, lonCount, isGlobal);
  geometry.setIndex(indices);
  return geometry;
}

async function makeGeometry() {
  try {
    const { positionValues, uvs, latLonValues, latCount, lonCount, isGlobal } =
      await getGaussianGrid();

    const totalBatches = Math.ceil((latCount - 1) / BATCH_SIZE);
    cleanupMeshes(totalBatches);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const latStart = batchIndex * BATCH_SIZE;
      const latEnd = Math.min(latStart + BATCH_SIZE, latCount - 1);

      const geometry = createBatchGeometry(
        positionValues,
        uvs,
        latLonValues,
        lonCount,
        isGlobal,
        latStart,
        latEnd
      );

      if (meshes[batchIndex]) {
        meshes[batchIndex].geometry.dispose();
        meshes[batchIndex].geometry = geometry;
      } else {
        const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial());
        mesh.frustumCulled = false;
        meshes.push(mesh);
        getScene()?.add(mesh);
      }
    }
    redraw();
  } catch (error) {
    logError(error, "Could not fetch grid");
  }
}

function getRegularData(arr: Float32Array, latCount: number, lonCount: number) {
  let data = arr;
  // For lat-only data, tile it across all longitudes
  if (isLatOnly.value) {
    data = new Float32Array(latCount * lonCount);
    for (let lat = 0; lat < latCount; lat++) {
      for (let lon = 0; lon < lonCount; lon++) {
        data[lat * lonCount + lon] = arr[lat];
      }
    }
  }
  const texture = new THREE.DataTexture(
    data,
    lonCount,
    latCount,
    THREE.RedFormat,
    THREE.FloatType,
    THREE.UVMapping
  );
  texture.needsUpdate = true;
  return texture;
}

async function getRotatedNorthPole(): Promise<{ lat: number; lon: number }> {
  const crs = await ZarrDataManager.getCRSInfo(
    props.datasources!,
    varnameSelector.value
  );
  const lat = crs.attrs["grid_north_pole_latitude"] as number;
  const lon = crs.attrs["grid_north_pole_longitude"] as number;
  return { lat, lon };
}

function makeMaterial(rawData: Float32Array) {
  const textures = getRegularData(
    rawData,
    latitudes.value.length,
    longitudes.value.length
  );
  const low = bounds.value?.low as number;
  const high = bounds.value?.high as number;
  const { addOffset, scaleFactor } = getColormapScaleOffset(
    low,
    high,
    invertColormap.value
  );

  // Use GPU-projected material for instant projection center changes
  return makeGpuProjectedTextureMaterial(
    textures,
    colormap.value,
    addOffset,
    scaleFactor
  );
}

async function getDimensionValues(
  dimensionRanges: TDimensionRange[],
  indices: (number | zarr.Slice | null)[]
) {
  const dimValues = await fetchDimensionDetails(
    varnameSelector.value,
    props.datasources!,
    dimensionRanges,
    indices
  );
  return dimValues;
}

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  updateMode: TUpdateMode
) {
  const dimensionNames = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  // For lat-only data, only exclude the last dimension (lat)
  // For regular lat/lon data, exclude the last two dimensions
  const excludedDims = isLatOnly.value
    ? [datavar.shape.length - 1]
    : [datavar.shape.length - 2, datavar.shape.length - 1];
  const { dimensionRanges, indices } = buildDimensionRangesAndIndices(
    datavar,
    dimensionNames,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    excludedDims,
    varinfo.value?.dimRanges,
    updateMode === UPDATE_MODE.SLIDER_TOGGLE
  );

  let rawData = castDataVarToFloat32(
    (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
  );

  const material = makeMaterial(rawData);

  // Set initial projection uniforms
  const helper = projectionHelper.value;
  const center = projectionCenter.value;
  updateProjectionUniforms(material, helper.type, center.lon, center.lat);

  const { min, max, missingValue, fillValue } = getDataBounds(datavar, rawData);
  // Set missing/fill values as uniforms for the shader
  material.uniforms.missingValue.value = missingValue;
  material.uniforms.fillValue.value = fillValue;
  updateHistogram(rawData, min, max, missingValue, fillValue);

  for (const mesh of meshes) {
    mesh.material = material;
    mesh.material.needsUpdate = true;
  }

  const dimInfo = await getDimensionValues(dimensionRanges, indices);

  store.updateVarInfo(
    {
      attrs: datavar.attrs,
      dimInfo,
      bounds: { low: min, high: max },
      dimRanges: dimensionRanges,
    },
    indices as number[],
    updateMode
  );
  redraw();
}

async function getData(updateMode: TUpdateMode = UPDATE_MODE.INITIAL_LOAD) {
  store.startLoading();
  if (updatingData.value) {
    pendingUpdate.value = true;
    return;
  }

  try {
    do {
      pendingUpdate.value = false;
      updatingData.value = true;

      const localVarname = varnameSelector.value;

      const datavar = await getDataVar(localVarname, props.datasources!);

      if (datavar !== undefined) {
        await fetchAndRenderData(datavar, updateMode);
      }
      updatingData.value = false;
    } while (pendingUpdate.value);
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
