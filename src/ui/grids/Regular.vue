<script lang="ts" setup>
import { storeToRefs } from "pinia";
import proj4, { type Converter as TProjectionConverter } from "proj4";
import * as THREE from "three";
import { onBeforeMount, onBeforeUnmount, ref } from "vue";
import * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import type {
  TGeoSample,
  TGeoSampleIndex,
} from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useScalarFieldCache } from "./composables/useScalarFieldCache.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";
import { useStreamlineLayer } from "./composables/useStreamlineLayer.ts";
import { useVolume } from "./composables/useVolume.ts";

import {
  getCRSWkt,
  isLatitudeName,
  isLongitudeName,
  isProjectedXName,
  isProjectedYName,
  loadGridAxes,
  projectedAxisCoordinatesToLonLat,
  projectXYGridToLonLat,
} from "@/lib/data/coordinateVariables.ts";
import { downsampleDataTexture } from "@/lib/data/dataTexture.ts";
import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import {
  coarsestLevel,
  currentLevel,
  DEFAULT_MAX_LEVEL_CELLS,
  DEFAULT_MAX_VIEW_CELLS,
  STREAMLINES_NEED_WHOLE_LEVEL,
} from "@/lib/data/levels.ts";
import { loadVectorComponents } from "@/lib/data/streamlineData.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import {
  IrregularVectorField,
  RegularVectorField,
  resolveVectorVariablePair,
} from "@/lib/data/vectorField.ts";
import {
  createVectorMagnitudeData,
  type TVectorMagnitudeData,
} from "@/lib/data/vectorMagnitude.ts";
import {
  regularWindow,
  windowCovers,
  type TRegularWindow,
} from "@/lib/data/viewWindow.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  getGridVariableData,
  terminateGridDataWorker,
} from "@/lib/grids/gridDataWorkerClient.ts";
import {
  GridTextureExportUserDataKey,
  getRegularLatLonGridBounds,
  TextureExportVCoordinate,
} from "@/lib/layers/gridExportMetadata.ts";
import {
  createWrappedProjectionMesh,
  setupProjectionGeometryWrap,
  updateProjectionMeshes,
} from "@/lib/projection/projectionEdgeQuality.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  getColormapScaleOffset,
  makeGpuProjectedTextureMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import {
  VOLUME_GRID_TYPES,
  type TProjectedVolumeGrid,
} from "@/lib/volume/volumeGrid.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";

const props = defineProps<{
  datasources?: TSources;
  isRotated?: boolean;
}>();

const store = useGlobeControlStore();
const { logError } = useLog();
const { dimSlidersValues, colormap, varnameSelector, invertColormap, varinfo } =
  storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const {
  getScene,
  getRenderer,
  redraw,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  fitCameraToDataset,
  getDataVar,
  fetchDimensionDetails,
  updateLandSeaMask,
  updateColormap,
  updateHistogram,
  projectionHelper,
  isSceneInMotion,
  onProjectionChange,
  onMotionStateChange,
  onColormapChange,
  registerAnimationCallback,
  canvas,
  box,
  hoveredGeoPoint,
} = useSharedGridLogic();

const { setHoverLookupFromIndex, clearHoverLookup } =
  useGridHoverLookup(hoveredGeoPoint);

// The axes of the cells that are loaded: the whole level, or its view window.
const longitudes = ref<Float32Array>(new Float32Array());
const latitudes = ref<Float32Array>(new Float32Array());
let levelLongitudes: Float32Array = new Float32Array();
let levelLatitudes: Float32Array = new Float32Array();
// The loaded part of a level too large to load whole; null when the view
// holds none of it, undefined when the whole level is loaded.
let gridWindow: TRegularWindow | null | undefined;
const isProjectedGrid = ref(false);
let projectedGrid: TProjectedVolumeGrid | undefined;
let rotatedProjection: TProjectionConverter | undefined;
const selectedDimensionNames = ref<string[]>([]);
let lastStreamlineIndices: (number | null | zarr.Slice)[] | undefined;
let streamlineRequestRevision = 0;
let cachedMagnitude: TVectorMagnitudeData | undefined;
let cachedStreamlineKey: string | undefined;

const BATCH_SIZE = 60;
const MAX_GEO_RESOLUTION = 512;
// A view window reaches this fraction of the view's size past every edge.
const VIEW_WINDOW_MARGIN = 0.5;

let meshes: THREE.Mesh[] = [];
let geometryPending = false;

// The coarsest level of a multi-resolution dataset at the selected slice. A
// finer level takes its colour range from it and is drawn over it, so the
// range holds still and nothing is empty where the finer level has no cells.
type TBackdropFrame = {
  key: string;
  latitudes: Float32Array;
  longitudes: Float32Array;
  data: Float32Array;
  min: number;
  max: number;
};
let backdropFrame: TBackdropFrame | undefined;
let backdrop: THREE.Mesh | undefined;

function drawnMeshes() {
  return backdrop ? [backdrop, ...meshes] : meshes;
}

onColormapChange(() => updateColormap(drawnMeshes()));

onProjectionChange(updateMeshProjectionUniforms);
onMotionStateChange(updateMeshProjectionUniforms);

const scalarCache = useScalarFieldCache({
  updateHistogram,
  updateColormap: () => updateColormap(drawnMeshes()),
  redraw,
});

const streamlines = useStreamlineLayer({
  getScene,
  redraw,
  projectionHelper,
  onProjectionChange,
  registerAnimationCallback,
});

const volume = useVolume({
  getDatasources: () => props.datasources,
  getScene,
  getRenderer,
  redraw,
  projectionHelper,
  isSceneInMotion,
  onProjectionChange,
  onMotionStateChange,
});

function updateMeshProjectionUniforms() {
  updateProjectionMeshes(drawnMeshes(), {
    redraw,
    projectionHelper: projectionHelper.value,
    isSceneInMotion: isSceneInMotion.value,
  });
}

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  scalarCache,
  clearHoverLookup,
  prepareDatasource: async () => {
    await getDims();
    applyViewWindow();
    // On a level or window swap the meshes still show the previous grid:
    // rebuild them together with the data instead.
    geometryPending = meshes.length > 0;
    if (!geometryPending) {
      makeGeometry();
    }
  },
  canLoadByView,
  viewWindowStale,
  updateLandSeaMask,
  updateColormap: () => updateColormap(drawnMeshes()),
  refreshStreamlines: async (reuseCached) => {
    if (lastStreamlineIndices) {
      await updateStreamlines(lastStreamlineIndices, reuseCached);
    }
  },
  suspendStreamlines: () => {
    streamlineRequestRevision++;
    store.streamlineLoading = false;
    store.streamlineProgress = undefined;
  },
});

const isLatOnly = ref(false);

/**
 * A plain lat/lon grid of a pyramid with a coarsest level to draw beneath
 * can be loaded by view.
 */
function canLoadByView() {
  return (
    coarsestLevel(props.datasources!.levels) !== undefined &&
    !isLatOnly.value &&
    !isProjectedGrid.value &&
    !props.isRotated
  );
}

/**
 * Whether the selected level is loaded by view: a large level other than the
 * coarsest, which is the backdrop of the others and is always loaded whole.
 * Streamlines and volumes read the whole level, up to the whole-level cap.
 */
function loadsByView() {
  const sources = props.datasources!;
  const wholeLevelLayers =
    store.isStreamlineLayerEnabled() || store.isVolumeLayerEnabled();
  return (
    canLoadByView() &&
    (sources.selectedLevel ?? 0) !== coarsestLevel(sources.levels) &&
    levelLatitudes.length * levelLongitudes.length >
      (wholeLevelLayers ? DEFAULT_MAX_LEVEL_CELLS : DEFAULT_MAX_VIEW_CELLS)
  );
}

function viewWindow(margin: number) {
  return store.viewFootprint
    ? regularWindow(levelLatitudes, levelLongitudes, store.viewFootprint, {
        margin,
        // The loaded window is held to the budget. The view it has to cover
        // is held to half of that, so that a view too large for the budget
        // still counts as covered and does not reload on every move.
        maxCells:
          margin > 0 ? DEFAULT_MAX_VIEW_CELLS : DEFAULT_MAX_VIEW_CELLS / 2,
      })
    : null;
}

function viewWindowStale() {
  if (levelLatitudes.length === 0) {
    return false;
  }
  if (!loadsByView()) {
    return gridWindow !== undefined;
  }
  if (gridWindow === undefined) {
    return true;
  }
  const needed = viewWindow(0);
  return (
    needed !== null &&
    (gridWindow === null || !windowCovers(gridWindow, needed))
  );
}

/** Narrow the loaded axes from the whole level to the window in view. */
function applyViewWindow() {
  levelLatitudes = latitudes.value;
  levelLongitudes = longitudes.value;
  gridWindow = loadsByView() ? viewWindow(VIEW_WINDOW_MARGIN) : undefined;
  if (gridWindow === undefined) {
    return;
  }
  const { lat, lon, lonStep } = gridWindow ?? {
    lat: { start: 0, end: 0 },
    lon: [],
    lonStep: 1,
  };
  latitudes.value = levelLatitudes.subarray(lat.start, lat.end);
  // Columns east of the seam follow those west of it, one turn further on.
  const columns: number[] = [];
  for (const [part, range] of lon.entries()) {
    for (let index = range.start; index < range.end; index += lonStep) {
      columns.push(levelLongitudes[index] + 360 * part);
    }
  }
  longitudes.value = Float32Array.from(columns);
}

function getDimensionData(
  grid: TSources["levels"][0]["grid"],
  dimensionName: string
) {
  return ZarrDataManager.getVariableData(
    grid,
    ZarrDataManager.resolveVariablePath(varnameSelector.value, dimensionName)
  );
}

async function getDims() {
  const dimensions = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  selectedDimensionNames.value = dimensions;

  const lastDim = dimensions[dimensions.length - 1];
  const secondLastDim = dimensions[dimensions.length - 2];

  const isProjectedXY =
    isProjectedXName(lastDim) && isProjectedYName(secondLastDim);
  isProjectedGrid.value = isProjectedXY;

  const latOnlyCheck =
    !isProjectedXY &&
    isLatitudeName(lastDim) &&
    !isLongitudeName(secondLastDim);
  isLatOnly.value = latOnlyCheck;

  projectedGrid = undefined;
  rotatedProjection = undefined;
  const grid = currentLevel(props.datasources!).grid;
  if (latOnlyCheck) {
    const latitudesData = await getDimensionData(grid, lastDim);
    latitudes.value = latitudesData.data as Float32Array;
    longitudes.value = Float32Array.from({ length: 360 }, (_, i) => i - 179.5);
  } else {
    const [{ x, y }, crs] = await Promise.all([
      loadGridAxes(props.datasources!, varnameSelector.value, dimensions),
      isProjectedXY || props.isRotated
        ? getCRSWkt(props.datasources!, varnameSelector.value)
        : null,
    ]);
    if (props.isRotated && !crs) {
      throw new Error("Rotated grids need valid pole coordinates.");
    }
    if (crs) {
      projectedGrid = { kind: VOLUME_GRID_TYPES.PROJECTED, x, y, crs };
      if (props.isRotated) {
        rotatedProjection = proj4(crs, "EPSG:4326");
      }
    }
    const coordinates = isProjectedXY
      ? projectedAxisCoordinatesToLonLat(x, y, crs)
      : { longitudes: x, latitudes: y };
    longitudes.value = new Float32Array(new Set(coordinates.longitudes));
    latitudes.value = new Float32Array(new Set(coordinates.latitudes));
  }
}

function isLongitudeGlobal(longitudes: Float32Array): boolean {
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

function generateBatchVerticesAndUVs(
  latitudes: Float32Array,
  longitudes: Float32Array,
  latOrigIndices: Int32Array,
  lonOrigIndices: Int32Array,
  originalLatCount: number,
  textureLonCount: number,
  latStart: number,
  latEnd: number,
  isLatReversed: boolean,
  transform: TProjectionConverter | undefined
) {
  const batchLatCount = latEnd - latStart + 1;
  const lonCount = longitudes.length;
  const vertexCount = batchLatCount * lonCount;

  const positionValues = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const latLonValues = new Float32Array(vertexCount * 2);
  const latDenominator = Math.max(originalLatCount - 1, 1);

  const helper = projectionHelper.value;

  for (let li = 0; li < batchLatCount; li++) {
    const globalLatIdx = latStart + li;
    const rawLat = latitudes[globalLatIdx];
    const latOrigIdx = latOrigIndices[globalLatIdx];
    for (let lj = 0; lj < lonCount; lj++) {
      const rawLon = longitudes[lj];

      const [lon, lat] = transform
        ? transform.forward([rawLon, rawLat])
        : [rawLon, rawLat];

      const vertexIdx = li * lonCount + lj;
      helper.projectLatLonToArrays(
        lat,
        lon,
        positionValues,
        vertexIdx * 3,
        latLonValues,
        vertexIdx * 2
      );

      const u = (lonOrigIndices[lj] + 0.5) / textureLonCount;
      const v = isLatReversed
        ? (originalLatCount - 1 - latOrigIdx) / latDenominator
        : latOrigIdx / latDenominator;
      uvs[vertexIdx * 2] = u;
      uvs[vertexIdx * 2 + 1] = v;
    }
  }

  return { positionValues, uvs, latLonValues };
}

function generateGridIndices(latCount: number, lonCount: number) {
  const latIterationEnd = latCount - 1;
  const lonIterationEnd = lonCount - 1;
  const indices = new Uint32Array(latIterationEnd * lonIterationEnd * 6);
  let indexOffset = 0;

  for (let latIt = 0; latIt < latIterationEnd; latIt++) {
    for (let lonIt = 0; lonIt < lonIterationEnd; lonIt++) {
      const lowLeft = latIt * lonCount + lonIt;
      const lowRight = latIt * lonCount + lonIt + 1;
      const topLeft = (latIt + 1) * lonCount + lonIt;
      const topRight = (latIt + 1) * lonCount + lonIt + 1;

      indices[indexOffset++] = lowLeft;
      indices[indexOffset++] = topRight;
      indices[indexOffset++] = topLeft;
      indices[indexOffset++] = lowLeft;
      indices[indexOffset++] = lowRight;
      indices[indexOffset++] = topRight;
    }
  }

  return indices;
}

function normalizeLongitudes(longitudes: Float32Array): Float32Array {
  // Normalize longitudes to [0, 360)
  return Float32Array.from(longitudes, (lon) => ((lon % 360) + 360) % 360);
}

function subsampleCoords(
  values: Float32Array,
  maxCount: number
): { coords: Float32Array; origIndices: Int32Array } {
  if (values.length <= maxCount) {
    const origIndices = new Int32Array(values.length);
    for (let i = 0; i < values.length; i++) {
      origIndices[i] = i;
    }
    return { coords: values, origIndices };
  }

  const coords = new Float32Array(maxCount);
  const origIndices = new Int32Array(maxCount);
  for (let i = 0; i < maxCount; i++) {
    const sourceIdx = Math.round((i * (values.length - 1)) / (maxCount - 1));
    coords[i] = values[sourceIdx];
    origIndices[i] = sourceIdx;
  }
  return { coords, origIndices };
}

function getRegularTextureExportMetadata(
  isRotated: boolean | undefined,
  lats: Float32Array,
  lons: Float32Array
) {
  if (isRotated || isProjectedGrid.value) {
    return undefined;
  }

  const bounds = getRegularLatLonGridBounds(lats, lons);
  if (!bounds) {
    return undefined;
  }

  return {
    bounds,
    topV:
      lats[0] > lats[lats.length - 1]
        ? TextureExportVCoordinate.BOTTOM
        : TextureExportVCoordinate.TOP,
  };
}

function getRegularGridParameters(
  lats = latitudes.value,
  lons = longitudes.value
) {
  let longitudeValues = normalizeLongitudes(lons);
  let latitudeValues = lats;

  // Check if latitudes are descending and reverse if necessary
  const isLatReversed =
    latitudeValues[0] > latitudeValues[latitudeValues.length - 1];
  if (isLatReversed) {
    latitudeValues = Float32Array.from(latitudeValues).reverse();
  }

  const isGlobal = isLongitudeGlobal(lons);
  const textureLonCount = longitudeValues.length;
  const originalLatCount = latitudeValues.length;
  const textureExportMetadata = getRegularTextureExportMetadata(
    props.isRotated,
    lats,
    lons
  );

  const { coords: geoLatitudes, origIndices: latOrigIndices } = subsampleCoords(
    latitudeValues,
    MAX_GEO_RESOLUTION
  );
  const { coords: geoLongitudesBase, origIndices: lonOrigIndicesBase } =
    subsampleCoords(longitudeValues, MAX_GEO_RESOLUTION);

  let geoLongitudes = geoLongitudesBase;
  let lonOrigIndices = lonOrigIndicesBase;
  if (isGlobal) {
    geoLongitudes = new Float32Array([
      ...geoLongitudesBase,
      geoLongitudesBase[0] + 360,
    ]);
    lonOrigIndices = new Int32Array(lonOrigIndicesBase.length + 1);
    lonOrigIndices.set(lonOrigIndicesBase);
    lonOrigIndices[lonOrigIndicesBase.length] = textureLonCount;
  }

  return {
    geoLatitudes,
    geoLongitudes,
    latOrigIndices,
    lonOrigIndices,
    originalLatCount,
    textureLonCount,
    isLatReversed,
    transform: rotatedProjection,
    geoLatCount: geoLatitudes.length,
    geoLonCount: geoLongitudes.length,
    textureExportMetadata,
  };
}

function disposeMaterial(material: THREE.Material) {
  const shaderMaterial = material as THREE.ShaderMaterial;
  if (shaderMaterial.uniforms?.data?.value?.dispose) {
    shaderMaterial.uniforms.data.value.dispose();
  }
  material.dispose();
}

function collectMeshMaterials(
  mesh: THREE.Mesh,
  materials: Set<THREE.Material>
) {
  if (Array.isArray(mesh.material)) {
    for (const material of mesh.material) {
      materials.add(material);
    }
    return;
  }
  materials.add(mesh.material);
}

function disposeMaterials(materials: Set<THREE.Material>) {
  for (const material of materials) {
    disposeMaterial(material);
  }
}

function disposeMeshMaterials(targetMeshes: THREE.Mesh[]) {
  const materials = new Set<THREE.Material>();
  for (const mesh of targetMeshes) {
    collectMeshMaterials(mesh, materials);
  }
  disposeMaterials(materials);
}

function cleanupMeshes(totalBatches: number) {
  if (meshes.length <= totalBatches) {
    return;
  }
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    getScene()?.remove(mesh);
  }
  disposeMeshMaterials(meshes);
  meshes.length = 0;
}

function createBatchGeometry(
  gridParams: Awaited<ReturnType<typeof getRegularGridParameters>>,
  latStart: number,
  latEnd: number
) {
  const geometry = new THREE.InstancedBufferGeometry();
  const batchLatCount = latEnd - latStart + 1;

  const { positionValues, uvs, latLonValues } = generateBatchVerticesAndUVs(
    gridParams.geoLatitudes,
    gridParams.geoLongitudes,
    gridParams.latOrigIndices,
    gridParams.lonOrigIndices,
    gridParams.originalLatCount,
    gridParams.textureLonCount,
    latStart,
    latEnd,
    gridParams.isLatReversed,
    gridParams.transform
  );

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positionValues, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute(latLonValues, 2)
  );

  const indices = generateGridIndices(batchLatCount, gridParams.geoLonCount);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  if (gridParams.textureExportMetadata) {
    geometry.userData[GridTextureExportUserDataKey.METADATA] =
      gridParams.textureExportMetadata;
  }
  return geometry;
}

function applyBatchGeometry(
  batchIndex: number,
  geometry: THREE.InstancedBufferGeometry
) {
  if (meshes[batchIndex]) {
    setupProjectionGeometryWrap(geometry);
    meshes[batchIndex].geometry.dispose();
    meshes[batchIndex].geometry = geometry;
  } else {
    const mesh = createWrappedProjectionMesh(
      geometry,
      new THREE.ShaderMaterial(),
      projectionHelper.value.type
    );
    mesh.visible = false;
    mesh.frustumCulled = false;
    meshes.push(mesh);
    getScene()?.add(mesh);
  }
}

function makeGeometry() {
  try {
    const gridParams = getRegularGridParameters();
    const totalBatches = Math.ceil((gridParams.geoLatCount - 1) / BATCH_SIZE);
    cleanupMeshes(totalBatches);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const latStart = batchIndex * BATCH_SIZE;
      const latEnd = Math.min(
        latStart + BATCH_SIZE,
        gridParams.geoLatCount - 1
      );
      const geometry = createBatchGeometry(gridParams, latStart, latEnd);
      applyBatchGeometry(batchIndex, geometry);
    }
    updateMeshProjectionUniforms();
    fitCameraToDataset(meshes);
  } catch (error) {
    logError(error, "Could not fetch grid");
  }
}

function fitDataToMaxTextureSize(
  data: Float32Array<ArrayBufferLike>,
  sourceWidth: number,
  sourceHeight: number
) {
  let texWidth = sourceWidth;
  let texHeight = sourceHeight;
  let textureData = data;
  const maxTexSize = getRenderer()?.capabilities.maxTextureSize ?? 4096;
  if (texWidth > maxTexSize || texHeight > maxTexSize) {
    texWidth = Math.min(sourceWidth, maxTexSize);
    texHeight = Math.min(sourceHeight, maxTexSize);
    textureData = downsampleDataTexture(
      data,
      sourceWidth,
      sourceHeight,
      texWidth,
      texHeight
    );
  }

  return { data: textureData, texWidth, texHeight };
}

function createLatOnlyTextureData(
  rawData: Float32Array,
  latCount: number,
  lonCount: number
) {
  const data = new Float32Array(latCount * lonCount);
  for (let latIdx = 0; latIdx < latCount; latIdx++) {
    const value = rawData[latIdx];
    for (let lonIdx = 0; lonIdx < lonCount; lonIdx++) {
      data[latIdx * lonCount + lonIdx] = value;
    }
  }
  return data;
}

function createRegularTexture(
  rawData: Float32Array,
  wrapRepeat: boolean,
  latCount: number,
  lonCount: number
) {
  const textureData = isLatOnly.value
    ? createLatOnlyTextureData(rawData, latCount, lonCount)
    : rawData;
  const { data, texWidth, texHeight } = fitDataToMaxTextureSize(
    textureData,
    lonCount,
    latCount
  );

  const texture = new THREE.DataTexture(
    data,
    texWidth,
    texHeight,
    THREE.RedFormat,
    THREE.FloatType,
    THREE.UVMapping
  );
  if (wrapRepeat) {
    texture.wrapS = THREE.RepeatWrapping;
  }
  texture.needsUpdate = true;
  return texture;
}

function makeMaterial(
  rawData: Float32Array,
  lats = latitudes.value,
  lons = longitudes.value
) {
  const texture = createRegularTexture(
    rawData,
    isLongitudeGlobal(lons),
    lats.length,
    lons.length
  );
  const low = store.selection?.low as number;
  const high = store.selection?.high as number;
  const { addOffset, scaleFactor } = getColormapScaleOffset(
    low,
    high,
    invertColormap.value
  );

  return makeGpuProjectedTextureMaterial(
    texture,
    colormap.value,
    addOffset,
    scaleFactor
  );
}

function buildHoverSamples(rawData: Float32Array): TGeoSampleIndex {
  const transform = rotatedProjection;

  const lats = latitudes.value;
  const lons = longitudes.value;
  const latCount = lats.length;
  const lonCount = lons.length;
  // Outside a view window only the backdrop is drawn: there is no cell of
  // this level to report further than one cell from the loaded axes.
  const windowed = gridWindow !== undefined;
  const latReach = latCount > 1 ? Math.abs(lats[1] - lats[0]) : Infinity;
  const lonReach = lonCount > 1 ? Math.abs(lons[1] - lons[0]) : Infinity;

  // For regular grids, use direct index lookup instead of building a
  // 37M-entry spatial index. The grid is regular so we can binary-search
  // the lat/lon axes to find the nearest cell in O(log n).
  return {
    findNearest(queryLat: number, queryLon: number): TGeoSample | null {
      if (latCount === 0 || lonCount === 0) {
        return null;
      }

      const [nativeLon, nativeLat] = transform
        ? transform.inverse([queryLon, queryLat])
        : [queryLon, queryLat];
      // Find nearest latitude index via binary search
      const latIdx = nearestIndex(lats, nativeLat);

      if (isLatOnly.value) {
        return { lat: lats[latIdx], lon: 0, value: rawData[latIdx] };
      }

      // Find nearest longitude index (accounting for wrapping)
      const lonIdx = nearestLonIndex(lons, nativeLon);
      if (
        windowed &&
        (Math.abs(lats[latIdx] - nativeLat) > latReach ||
          Math.abs(((lons[lonIdx] - nativeLon + 540) % 360) - 180) > lonReach)
      ) {
        return null;
      }

      const rawLat = lats[latIdx];
      const rawLon = lons[lonIdx];
      const [lon, lat] = transform
        ? transform.forward([rawLon, rawLat])
        : [rawLon, rawLat];

      return {
        lat,
        lon: ProjectionHelper.normalizeLongitude(lon),
        value: rawData[latIdx * lonCount + lonIdx],
      };
    },
  };
}

function nearestIndex(sorted: Float32Array, target: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  // Handle both ascending and descending arrays
  const ascending = sorted[0] <= sorted[hi];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ascending ? sorted[mid] < target : sorted[mid] > target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  // Check neighbour to find actual nearest
  if (
    lo > 0 &&
    Math.abs(sorted[lo - 1] - target) < Math.abs(sorted[lo] - target)
  ) {
    return lo - 1;
  }
  return lo;
}

function nearestLonIndex(lons: Float32Array, target: number): number {
  // The lons array is monotonically sorted in its native range (either
  // [-180,180] or [0,360]). Search the raw values directly and handle
  // wrap by checking target, target+360, and target-360.
  const lo = lons[0];
  const hi = lons[lons.length - 1];

  // Shift target into the data range
  let adjustedTarget = target;
  if (adjustedTarget < lo - 180) {
    adjustedTarget += 360;
  } else if (adjustedTarget > hi + 180) {
    adjustedTarget -= 360;
  }

  const idx = nearestIndex(lons, adjustedTarget);

  // Also check the wrapped alternative for grids near the boundary
  const altTarget =
    adjustedTarget < (lo + hi) / 2
      ? adjustedTarget + 360
      : adjustedTarget - 360;
  const altIdx = nearestIndex(lons, altTarget);

  const dist = Math.abs(lons[idx] - adjustedTarget);
  let altDist = Math.abs(lons[altIdx] - altTarget);
  // Normalize distance for wrap comparison
  if (altDist > 180) {
    altDist = 360 - altDist;
  }
  return dist <= altDist ? idx : altIdx;
}

async function buildDimensionConfig(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const dimensionNames = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  const excludedDims = isLatOnly.value
    ? [datavar.shape.length - 1]
    : [datavar.shape.length - 2, datavar.shape.length - 1];
  return buildDimensionRangesAndIndices(
    datavar,
    dimensionNames,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    excludedDims,
    varinfo.value?.dimRanges
  );
}

function fetchRegularGridVariableData(
  selection: (number | null | zarr.Slice)[]
) {
  return getGridVariableData({
    source: ZarrDataManager.getDatasetSource(
      props.datasources!,
      varnameSelector.value
    ),
    variable: varnameSelector.value,
    format: props.datasources!.zarr_format,
    selection,
  });
}

/** The loaded cells of the selected slice, row by row. */
async function fetchLoadedData(indices: (number | null | zarr.Slice)[]) {
  if (gridWindow === undefined) {
    return castDataVarToFloat32(await fetchRegularGridVariableData(indices));
  }
  if (gridWindow === null) {
    return new Float32Array();
  }
  const { lat, lon, lonStep } = gridWindow;
  const parts = await Promise.all(
    lon.map(async (range) =>
      castDataVarToFloat32(
        await fetchRegularGridVariableData([
          ...indices.slice(0, -2),
          zarr.slice(lat.start, lat.end),
          zarr.slice(range.start, range.end, lonStep),
        ])
      )
    )
  );
  if (parts.length === 1) {
    return parts[0];
  }
  const rows = lat.end - lat.start;
  const columns = longitudes.value.length;
  const stitched = new Float32Array(rows * columns);
  let offset = 0;
  for (const [part, range] of lon.entries()) {
    const width = Math.ceil((range.end - range.start) / lonStep);
    for (let row = 0; row < rows; row++) {
      stitched.set(
        parts[part].subarray(row * width, (row + 1) * width),
        row * columns + offset
      );
    }
    offset += width;
  }
  return stitched;
}

function setMeshMaterials(material: THREE.ShaderMaterial) {
  if (meshes.length === 0) {
    disposeMaterial(material);
    return;
  }

  const previousMaterials = new Set<THREE.Material>();
  for (const mesh of meshes) {
    collectMeshMaterials(mesh, previousMaterials);
    mesh.material = material;
  }
  previousMaterials.delete(material);
  disposeMaterials(previousMaterials);
  material.needsUpdate = true;
}

function updateMeshMaterials(rawData: Float32Array) {
  const material = makeMaterial(rawData);
  updateProjectionUniforms(material, projectionHelper.value);
  // A level is drawn after its backdrop and over it whatever the depth says:
  // up close the two surfaces are nearer than float32 positions can order.
  material.depthFunc = backdrop ? THREE.AlwaysDepth : THREE.LessEqualDepth;
  setMeshMaterials(material);
  updateColormap(drawnMeshes());
}

/** Load the coarsest level at the selected slice, unless it is on screen. */
async function loadBackdrop(indices: (number | null | zarr.Slice)[]) {
  const sources = props.datasources!;
  const level = coarsestLevel(sources.levels);
  if (
    level === undefined ||
    level === (sources.selectedLevel ?? 0) ||
    !canLoadByView()
  ) {
    return undefined;
  }
  const variable = varnameSelector.value;
  const key = JSON.stringify([level, variable, indices]);
  if (backdropFrame?.key === key) {
    return backdropFrame;
  }
  const coarse = { ...sources, selectedLevel: level };
  const datavar = await getDataVar(variable, coarse);
  if (!datavar) {
    return undefined;
  }
  const [{ x, y }, values] = await Promise.all([
    loadGridAxes(coarse, variable, selectedDimensionNames.value),
    getGridVariableData({
      source: ZarrDataManager.getDatasetSource(coarse, variable),
      variable,
      format: sources.zarr_format,
      selection: indices,
    }),
  ]);
  const data = castDataVarToFloat32(values);
  const { min, max } = decodeVariableDataAndGetBounds(datavar, data);
  backdropFrame = { key, latitudes: y, longitudes: x, data, min, max };
  return backdropFrame;
}

function removeBackdrop() {
  if (backdrop) {
    backdrop.geometry.dispose();
    disposeMaterial(backdrop.material as THREE.Material);
    getScene()?.remove(backdrop);
    backdrop = undefined;
  }
}

/** Draw the coarsest level under a level that leaves part of the view empty. */
function showBackdrop(frame: TBackdropFrame | undefined) {
  const wanted =
    frame && (gridWindow !== undefined || !isLongitudeGlobal(levelLongitudes))
      ? frame
      : undefined;
  if (backdrop?.userData.key === wanted?.key) {
    return;
  }
  removeBackdrop();
  if (!wanted) {
    return;
  }
  const params = getRegularGridParameters(wanted.latitudes, wanted.longitudes);
  const geometry = createBatchGeometry(params, 0, params.geoLatCount - 1);
  // With two grids on screen a texture export renders them: it must not
  // take the backdrop for the one grid whose texture it can copy.
  delete geometry.userData[GridTextureExportUserDataKey.METADATA];
  const material = makeMaterial(
    wanted.data,
    wanted.latitudes,
    wanted.longitudes
  );
  updateProjectionUniforms(material, projectionHelper.value);
  backdrop = createWrappedProjectionMesh(
    geometry,
    material,
    projectionHelper.value.type
  );
  backdrop.frustumCulled = false;
  // after the layers stacked below the grid (-1 and down), before the grid
  backdrop.renderOrder = -0.5;
  backdrop.userData.key = wanted.key;
  getScene()?.add(backdrop);
}

async function showMagnitude(scalar: TVectorMagnitudeData) {
  await scalarCache.showMagnitude(scalar, async () => {
    const hoverIndex = buildHoverSamples(scalar.data);
    return () => {
      updateMeshMaterials(scalar.data);
      setHoverLookupFromIndex(hoverIndex, NaN, NaN);
    };
  });
}

async function makeVectorField(
  uData: Float32Array,
  vData: Float32Array,
  isCurrent: () => boolean
) {
  if (!props.isRotated) {
    return new RegularVectorField(
      latitudes.value,
      longitudes.value,
      uData,
      vData
    );
  }
  const coordinates = projectXYGridToLonLat(
    longitudes.value,
    latitudes.value,
    projectedGrid!.crs
  );
  return IrregularVectorField.create(
    coordinates.latitudes.data,
    coordinates.longitudes.data,
    uData,
    vData,
    {
      isCancelled: () => !isCurrent() || !store.isStreamlineLayerEnabled(),
      onProgress: (progress) => {
        if (isCurrent() && store.isStreamlineLayerEnabled()) {
          streamlines.setFieldProgress(progress);
        }
      },
    }
  );
}

function selectedVectorPair() {
  return resolveVectorVariablePair(
    Object.keys(
      (props.datasources && currentLevel(props.datasources)?.datasources) ?? {}
    ),
    varnameSelector.value,
    store.streamlineSelection,
    store.isStreamlineLayerEnabled() ? store.streamlinePair : undefined
  );
}

// eslint-disable-next-line max-lines-per-function
async function updateStreamlines(
  selectedIndices: (number | null | zarr.Slice)[],
  reuseCached = false
) {
  const requestRevision = ++streamlineRequestRevision;
  const pair = selectedVectorPair();
  if (!pair || isLatOnly.value || !props.datasources) {
    cachedMagnitude = undefined;
    cachedStreamlineKey = undefined;
    store.setStreamlineMagnitudeInfo(undefined);
    streamlines.clear();
    return;
  }
  const requestKey = JSON.stringify({
    indices: selectedIndices,
    pair: [pair.u, pair.v],
    level: store.streamlineLevelIndex,
  });
  if (
    reuseCached &&
    requestKey === cachedStreamlineKey &&
    streamlines.showCached()
  ) {
    if (store.streamlineMagnitudeDisplayed && cachedMagnitude) {
      await showMagnitude(cachedMagnitude);
    }
    return;
  }
  if (!store.isStreamlineLayerEnabled()) {
    if (requestKey === cachedStreamlineKey) {
      store.setStreamlinePair(pair);
    } else {
      cachedMagnitude = undefined;
      cachedStreamlineKey = undefined;
      store.setStreamlineMagnitudeInfo(undefined);
      streamlines.setAvailablePair(pair);
    }
    return;
  }
  if (gridWindow !== undefined) {
    // only a level picked by hand that is over the whole-level cap gets here
    cachedMagnitude = undefined;
    cachedStreamlineKey = undefined;
    store.setStreamlineMagnitudeInfo(undefined);
    streamlines.clear(STREAMLINES_NEED_WHOLE_LEVEL);
    return;
  }

  streamlines.startLoading();
  try {
    const components = await loadVectorComponents({
      pair,
      datasources: props.datasources,
      getDataVar,
      currentDimensionNames: selectedDimensionNames.value,
      currentIndices: selectedIndices,
      spatialDimensionNames: selectedDimensionNames.value.slice(-2),
      expectedDataLength: latitudes.value.length * longitudes.value.length,
      selectedLevelIndex: store.streamlineLevelIndex,
    });
    if (requestRevision !== streamlineRequestRevision) {
      return;
    }
    store.setStreamlineLevelInfo(components?.levelInfo);
    store.setStreamlineMagnitudeInfo(
      components?.magnitudeInfo,
      components?.canDeriveMagnitude
    );
    if (!components || components.incompatibility !== undefined) {
      cachedMagnitude = undefined;
      cachedStreamlineKey = undefined;
      streamlines.clear(components?.incompatibility);
      return;
    }
    if (
      !(await streamlines.prepareField(
        () => requestRevision === streamlineRequestRevision
      ))
    ) {
      return;
    }
    const field = await makeVectorField(
      components.uData,
      components.vData,
      () => requestRevision === streamlineRequestRevision
    );
    if (!field || requestRevision !== streamlineRequestRevision) {
      return;
    }
    const magnitude =
      components.magnitudeInfo && components.canDeriveMagnitude
        ? createVectorMagnitudeData(
            components.uData,
            components.vData,
            components.magnitudeInfo
          )
        : undefined;
    const rendered = await streamlines.setField(
      field,
      pair,
      () => requestRevision === streamlineRequestRevision,
      async () => {
        if (store.streamlineMagnitudeDisplayed && magnitude) {
          await showMagnitude(magnitude);
        } else {
          await scalarCache.restoreScalar();
        }
      }
    );
    if (!rendered || requestRevision !== streamlineRequestRevision) {
      return;
    }
    cachedMagnitude = magnitude;
    cachedStreamlineKey = requestKey;
  } catch (error) {
    if (requestRevision === streamlineRequestRevision) {
      streamlines.clear();
      logError(error, "Could not render vector streamlines");
    }
  }
}

// eslint-disable-next-line max-lines-per-function
async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  isCurrent: () => boolean
) {
  const { dimensionRanges, indices } = await buildDimensionConfig(datavar);

  const [rawData, backdropData] = await Promise.all([
    fetchLoadedData(indices),
    loadBackdrop(indices).catch(() => undefined),
  ]);

  if (!isCurrent()) {
    return;
  }
  const { min, max, missingValue, fillValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );

  const hoverIndex = buildHoverSamples(rawData);

  lastStreamlineIndices = indices;

  if (!isCurrent()) {
    return;
  }
  const dimInfo = await fetchDimensionDetails(
    varnameSelector.value,
    props.datasources!,
    dimensionRanges,
    indices
  );

  const scalarInfo = {
    attrs: datavar.attrs,
    dimInfo,
    bounds: { low: backdropData?.min ?? min, high: backdropData?.max ?? max },
    dimRanges: dimensionRanges,
  };
  const renderScalar = () => {
    if (geometryPending) {
      makeGeometry();
      geometryPending = false;
    }
    showBackdrop(backdropData);
    updateMeshMaterials(rawData);
    setHoverLookupFromIndex(hoverIndex, fillValue, missingValue);
  };
  const volumeGrid =
    gridWindow !== undefined
      ? undefined
      : isProjectedGrid.value || props.isRotated
        ? projectedGrid
        : !isLatOnly.value
          ? {
              kind: VOLUME_GRID_TYPES.REGULAR,
              latitudes: latitudes.value,
              longitudes: longitudes.value,
            }
          : undefined;
  if (!isCurrent()) {
    return;
  }
  volume.setContext(
    volumeGrid
      ? {
          dimensionNames: selectedDimensionNames.value,
          indices,
          grid: volumeGrid,
        }
      : undefined
  );
  scalarCache.captureScalar({
    render: renderScalar,
    info: scalarInfo,
    indices: indices as number[],
    data: backdropData?.data ?? rawData,
    missingValue,
    fillValue,
    isCurrent,
  });
  await updateStreamlines(indices);
  if (isCurrent() && !store.streamlineMagnitudeDisplayed) {
    await scalarCache.restoreScalar();
  }
}

onBeforeMount(async () => {
  await datasourceUpdate();
});

onBeforeUnmount(() => {
  streamlineRequestRevision++;
  terminateGridDataWorker();
  removeBackdrop();
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    getScene()?.remove(mesh);
  }
  disposeMeshMaterials(meshes);
  meshes.length = 0;
});

defineExpose({
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
});
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
