<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, ref, watch } from "vue";
import * as zarr from "zarrita";

import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { getDimensionInfo } from "@/lib/data/dimensionHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { castDataVarToFloat32, getDataBounds } from "@/lib/data/zarrUtils.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  makeGpuProjectedMeshMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
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
  selection,
  isInitializingVariable,
  varinfo,
  projectionMode,
  projectionCenter,
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
  getTime,
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
  [() => bounds.value, () => invertColormap.value, () => colormap.value],
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

// Split triangles into batches for multiple meshes
const BATCH_SIZE = 3000000; // number of triangles per mesh (tune as needed)

async function fetchGrid() {
  try {
    const verts = await grid2buffer(gridsource.value!);

    // Remove old meshes from scene
    for (const mesh of meshes) {
      getScene()?.remove(mesh);
      mesh.geometry.dispose();
      if (mesh.material instanceof THREE.Material) {
        mesh.material.dispose();
      }
    }
    meshes.length = 0;

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

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  for (let i = 0; i < ncells; i++) {
    const v0 = vs0[i] - 1;
    const v1 = vs1[i] - 1;
    const v2 = vs2[i] - 1;

    // Cache vertex values
    const v0x = (vx.data as Float64Array)[v0],
      v0y = (vy.data as Float64Array)[v0],
      v0z = (vz.data as Float64Array)[v0];
    let v1x = (vx.data as Float64Array)[v1] as number,
      v1y = (vy.data as Float64Array)[v1] as number,
      v1z = (vz.data as Float64Array)[v1] as number;
    let v2x = (vx.data as Float64Array)[v2] as number,
      v2y = (vy.data as Float64Array)[v2] as number,
      v2z = (vz.data as Float64Array)[v2] as number;

    // Set vector values
    a.set(v0x, v0y, v0z);
    b.set(v1x, v1y, v1z);
    c.set(v2x, v2y, v2z);

    // Perform in-place operations
    ab.subVectors(b, a);
    ac.subVectors(c, a);

    if (ab.cross(ac).dot(a.add(b).add(c)) < 0) {
      [v1x, v2x] = [v2x, v1x];
      [v1y, v2y] = [v2y, v1y];
      [v1z, v2z] = [v2z, v1z];
    }

    // Set verts array values
    const baseIndex = 9 * i;
    verts[baseIndex + 0] = v0x;
    verts[baseIndex + 1] = v0y;
    verts[baseIndex + 2] = v0z;

    verts[baseIndex + 3] = v1x;
    verts[baseIndex + 4] = v1y;
    verts[baseIndex + 5] = v1z;

    verts[baseIndex + 6] = v2x;
    verts[baseIndex + 7] = v2y;
    verts[baseIndex + 8] = v2z;
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

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  updateMode: TUpdateMode
) {
  const { dimensionRanges, indices } = getDimensionInfo(
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

  const timeinfo = await getTime(props.datasources!, dimensionRanges, indices);
  store.updateVarInfo(
    {
      attrs: datavar.attrs,
      timeinfo,
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
  try {
    updateCount.value += 1;
    const myUpdatecount = updateCount.value;
    if (updatingData.value) {
      return;
    }
    updatingData.value = true;

    const localVarname = varnameSelector.value;
    const datavar = await ZarrDataManager.getVariableInfo(
      ZarrDataManager.getDatasetSource(props.datasources!, localVarname),
      localVarname
    );

    if (datavar !== undefined) {
      await fetchAndRenderData(datavar, updateMode);
    }
    updatingData.value = false;
    if (updateCount.value !== myUpdatecount) {
      await getData(updateMode);
    }
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
