<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, ref, watch } from "vue";
import * as zarr from "zarrita";

import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { castDataVarToFloat32, getDataBounds } from "@/lib/data/zarrUtils.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  makeGpuProjectedMeshMaterial,
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
}>();

const store = useGlobeControlStore();
const { logError } = useLog();
const {
  dimSlidersValues,
  varnameSelector,
  colormap,
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

const pendingUpdate = ref(false);
const updatingData = ref(false);

let meshes: THREE.Mesh[] = [];

const {
  getScene,
  redraw,
  makeSnapshot,
  toggleRotate,
  fetchDimensionDetails,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
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

// GPU projection: update shader uniforms instead of rebuilding geometry
watch(
  [() => projectionMode.value, () => projectionCenter.value],
  () => {
    updateMeshProjectionUniforms();
  },
  { deep: true }
);

/**
 * Update projection uniforms on all mesh materials.
 * This is the fast path - no geometry rebuild needed.
 */
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

const colormapMaterial = computed(() => {
  // Use GPU-projected material
  const material = invertColormap.value
    ? makeGpuProjectedMeshMaterial(colormap.value, 1.0, -1.0)
    : makeGpuProjectedMeshMaterial(colormap.value, 0.0, 1.0);

  return material;
});

const gridsource = computed(() => {
  if (props.datasources) {
    return props.datasources.levels[0].grid;
  } else {
    return undefined;
  }
});

async function datasourceUpdate() {
  if (props.datasources !== undefined) {
    await fetchGrid();
    await getData();
    updateLandSeaMask();
    updateColormap(meshes);
  }
}

function cleanupMeshes() {
  for (const mesh of meshes) {
    getScene()?.remove(mesh);
    mesh.geometry.dispose();
    if (mesh.material instanceof THREE.Material) {
      mesh.material.dispose();
    }
  }
  meshes.length = 0;
}

// Split triangles into batches for multiple meshes
const BATCH_SIZE = 3000000; // number of triangles per mesh (tune as needed)

async function fetchGrid() {
  try {
    const verts = await grid2buffer(gridsource.value!);
    cleanupMeshes();

    const nTriangles = verts.length / 9;
    for (let i = 0; i < nTriangles; i += BATCH_SIZE) {
      const count = Math.min(BATCH_SIZE, nTriangles - i);
      const geometry = new THREE.BufferGeometry();
      // Each triangle has 9 values (3 vertices * 3 coords)
      const batchVerts = verts.subarray(i * 9, (i + count) * 9);
      const positionValues = new Float32Array(batchVerts.length);
      const numVerts = positionValues.length / 3;
      // Create latLon array for GPU projection (2 values per vertex)
      const latLonValues = new Float32Array(numVerts * 2);
      for (let v = 0; v < numVerts; v++) {
        const positionOffset = v * 3;
        const x = batchVerts[positionOffset];
        const y = batchVerts[positionOffset + 1];
        const z = batchVerts[positionOffset + 2];
        const { lat, lon } = ProjectionHelper.cartesianToLatLon(x, y, z);
        // Store lat/lon for GPU projection and compute initial positions
        projectionHelper.value.projectLatLonToArrays(
          lat,
          lon,
          positionValues,
          positionOffset,
          latLonValues,
          v * 2
        );
      }
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positionValues, 3)
      );
      // Add latLon attribute for GPU projection
      geometry.setAttribute(
        "latLon",
        new THREE.BufferAttribute(latLonValues, 2)
      );
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, colormapMaterial.value);
      // Disable frustum culling - GPU projection changes actual positions
      mesh.frustumCulled = false;
      meshes.push(mesh);
      getScene()?.add(mesh);
    }
    // Update projection uniforms on all meshes after creation
    updateMeshProjectionUniforms();
    redraw();
  } catch (error) {
    logError(error, "Could not fetch grid");
  }
}

function getVertexCoordinates(
  index: number,
  vx: zarr.Chunk<zarr.DataType>,
  vy: zarr.Chunk<zarr.DataType>,
  vz: zarr.Chunk<zarr.DataType>
) {
  return {
    x: (vx.data as Float64Array)[index],
    y: (vy.data as Float64Array)[index],
    z: (vz.data as Float64Array)[index],
  };
}

function shouldFlipTriangle(
  v0: { x: number; y: number; z: number },
  v1: { x: number; y: number; z: number },
  v2: { x: number; y: number; z: number }
) {
  const a = new THREE.Vector3(v0.x, v0.y, v0.z);
  const b = new THREE.Vector3(v1.x, v1.y, v1.z);
  const c = new THREE.Vector3(v2.x, v2.y, v2.z);

  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  const centroid = new THREE.Vector3().add(a).add(b).add(c);

  return ab.cross(ac).dot(centroid) < 0;
}

async function grid2buffer(grid: { store: string; dataset: string }) {
  const [voc, vx, vy, vz] = await Promise.all([
    ZarrDataManager.getVariableData(grid, "vertex_of_cell"),
    ZarrDataManager.getVariableData(grid, "cartesian_x_vertices"),
    ZarrDataManager.getVariableData(grid, "cartesian_y_vertices"),
    ZarrDataManager.getVariableData(grid, "cartesian_z_vertices"),
  ]);

  const ncells = voc.shape[1];

  const verts = new Float32Array(ncells * 3 * 3);

  const vs0 = (voc.data as Int32Array).slice(ncells * 0, ncells * 1);
  const vs1 = (voc.data as Int32Array).slice(ncells * 1, ncells * 2);
  const vs2 = (voc.data as Int32Array).slice(ncells * 2, ncells * 3);

  for (let i = 0; i < ncells; i++) {
    const v0Idx = vs0[i] - 1;
    const v1Idx = vs1[i] - 1;
    const v2Idx = vs2[i] - 1;

    // Cache vertex values
    let v0 = getVertexCoordinates(v0Idx, vx, vy, vz);
    let v1 = getVertexCoordinates(v1Idx, vx, vy, vz);
    let v2 = getVertexCoordinates(v2Idx, vx, vy, vz);

    if (shouldFlipTriangle(v0, v1, v2)) {
      [v1, v2] = [v2, v1];
    }

    // Set verts array values
    const baseIndex = 9 * i;
    verts[baseIndex + 0] = v0.x;
    verts[baseIndex + 1] = v0.y;
    verts[baseIndex + 2] = v0.z;
    verts[baseIndex + 3] = v1.x;
    verts[baseIndex + 4] = v1.y;
    verts[baseIndex + 5] = v1.z;
    verts[baseIndex + 6] = v2.x;
    verts[baseIndex + 7] = v2.y;
    verts[baseIndex + 8] = v2.z;
  }

  return verts;
}

function data2valueBuffer(
  data: zarr.Chunk<zarr.DataType>,
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  const awaitedData = data;
  const ncells = awaitedData.shape[0];
  const plotdata = castDataVarToFloat32(awaitedData.data);

  const { min, max, missingValue, fillValue } = getDataBounds(
    datavar,
    plotdata
  );
  const dataValues = new Float32Array(ncells * 3);

  for (let i = 0; i < ncells; i++) {
    const v = plotdata[i];
    const baseIndex = 3 * i;
    dataValues[baseIndex + 0] = v;
    dataValues[baseIndex + 1] = v;
    dataValues[baseIndex + 2] = v;
  }
  return {
    dataValues: dataValues,
    dataMin: min,
    dataMax: max,
    missingValue,
    fillValue,
  };
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
  const { dimensionRanges, indices } = buildDimensionRangesAndIndices(
    datavar,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    [datavar.shape.length - 1],
    varinfo.value?.dimRanges,
    updateMode === UPDATE_MODE.SLIDER_TOGGLE
  );

  const rawData = await ZarrDataManager.getVariableDataFromArray(
    datavar,
    indices
  );
  const dataBuffer = data2valueBuffer(rawData, datavar);
  // Distribute data values to each mesh
  let offset = 0;
  for (const mesh of meshes) {
    const nVerts = mesh.geometry.getAttribute("position").count;
    // Each triangle has 3 vertices, each vertex has a value
    const meshData = dataBuffer.dataValues.subarray(offset, offset + nVerts);
    mesh.geometry.setAttribute(
      "data_value",
      new THREE.BufferAttribute(meshData, 1)
    );
    const material = mesh.material as THREE.ShaderMaterial;
    material.uniforms.missingValue.value = dataBuffer.missingValue;
    material.uniforms.fillValue.value = dataBuffer.fillValue;
    offset += nVerts;
  }

  const dimInfo = await getDimensionValues(dimensionRanges, indices);
  store.updateVarInfo(
    {
      attrs: datavar.attrs,
      dimInfo,
      bounds: { low: dataBuffer.dataMin, high: dataBuffer.dataMax },
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
    return;
  }
  updatingData.value = true;

  try {
    do {
      pendingUpdate.value = false;
      const localVarname = varnameSelector.value;
      const datavar = await ZarrDataManager.getVariableInfo(
        ZarrDataManager.getDatasetSource(props.datasources!, localVarname),
        localVarname
      );

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

// Maybe for later use
// function copyPythonExample() {
//   const example = datashaderExample({
//     cameraPosition: getCamera()!.position,
//     datasrc: datasource.value!.store + datasource.value!.dataset,
//     gridsrc: gridsource.value!.store + gridsource.value!.dataset,
//     varname: varnameSelector.value,
//     timeIndex: timeIndexSlider.value as number,
//     varbounds: bounds.value,
//     colormap: colormap.value,
//     invertColormap: invertColormap.value,
//   });
//   navigator.clipboard.writeText(example);
// }

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
