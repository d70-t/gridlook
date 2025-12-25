<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, ref, watch } from "vue";

import type { TSources } from "../../types/GlobeTypes.ts";
import { useUrlParameterStore } from "../store/paramStore.ts";
import {
  UPDATE_MODE,
  useGlobeControlStore,
  type TUpdateMode,
} from "../store/store.js";
import {
  makeGpuProjectedColormapMaterial,
  updateProjectionUniforms,
} from "../utils/colormapShaders.ts";
import { getDimensionInfo } from "../utils/dimensionHandling.ts";
import { grid2buffer, data2valueBuffer } from "../utils/gridlook.ts";
import { useLog } from "../utils/logging.ts";
import { getProjectionTypeFromMode } from "../utils/projectionShaders.ts";
import { ZarrDataManager } from "../utils/ZarrDataManager.ts";

import { useSharedGridLogic } from "./useSharedGridLogic.ts";
import { ProjectionHelper } from "../utils/projectionUtils.ts";

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
  getTimeInfo,
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
  const projType = getProjectionTypeFromMode(helper.type);
  const center = projectionCenter.value ?? { lat: 0, lon: 0 };

  for (const mesh of meshes) {
    if (!mesh) continue;
    const material = mesh.material as THREE.ShaderMaterial;
    if (material.uniforms?.projectionType) {
      updateProjectionUniforms(material, projType, center.lon, center.lat, 1.0);
    }
  }
  redraw();
}

const colormapMaterial = computed(() => {
  // Use GPU-projected material
  const material = invertColormap.value
    ? makeGpuProjectedColormapMaterial(colormap.value, 1.0, -1.0)
    : makeGpuProjectedColormapMaterial(colormap.value, 0.0, 1.0);

  // Set initial projection uniforms
  const helper = projectionHelper.value;
  const projType = getProjectionTypeFromMode(helper.type);
  const center = projectionCenter.value ?? { lat: 0, lon: 0 };
  updateProjectionUniforms(material, projType, center.lon, center.lat, 1.0);

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
      if (mesh.material instanceof THREE.Material) mesh.material.dispose();
    }
    meshes.length = 0;

    const nTriangles = verts.length / 9;
    for (let i = 0; i < nTriangles; i += BATCH_SIZE) {
      const count = Math.min(BATCH_SIZE, nTriangles - i);
      const geometry = new THREE.BufferGeometry();
      // Each triangle has 9 values (3 vertices * 3 coords)
      const batchVerts = verts.subarray(i * 9, (i + count) * 9);
      const projectedVerts = new Float32Array(batchVerts.length);
      const numVerts = projectedVerts.length / 3;
      // Create latLon array for GPU projection (2 values per vertex)
      const latLonArray = new Float32Array(numVerts * 2);
      for (let v = 0; v < numVerts; v++) {
        const baseIndex = v * 3;
        const x = batchVerts[baseIndex];
        const y = batchVerts[baseIndex + 1];
        const z = batchVerts[baseIndex + 2];
        const { lat, lon } = ProjectionHelper.cartesianToLatLon(x, y, z);
        // Store lat/lon for GPU projection
        latLonArray[v * 2] = lat;
        latLonArray[v * 2 + 1] = lon;
        // Compute initial positions for first frame
        const [px, py, pz] = projectionHelper.value.project(lat, lon, 1);
        projectedVerts[baseIndex] = px;
        projectedVerts[baseIndex + 1] = py;
        projectedVerts[baseIndex + 2] = pz;
      }
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(projectedVerts, 3)
      );
      // Add latLon attribute for GPU projection
      geometry.setAttribute(
        "latLon",
        new THREE.BufferAttribute(latLonArray, 2)
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
      const { dimensionRanges, indices } = getDimensionInfo(
        datavar,
        paramDimIndices.value,
        paramDimMinBounds.value,
        paramDimMaxBounds.value,
        dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
        [datavar.shape.length - 1],
        varinfo.value?.dimRanges,
        updateMode
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
        const meshData = dataBuffer.dataValues.subarray(
          offset,
          offset + nVerts
        );
        mesh.geometry.setAttribute(
          "data_value",
          new THREE.BufferAttribute(meshData, 1)
        );
        const material = mesh.material as THREE.ShaderMaterial;
        material.uniforms.missingValue.value = dataBuffer.missingValue;
        material.uniforms.fillValue.value = dataBuffer.fillValue;
        offset += nVerts;
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
          bounds: { low: dataBuffer.dataMin, high: dataBuffer.dataMax },
          dimRanges: dimensionRanges,
        },
        indices as number[],
        updateMode
      );
      redraw();
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
