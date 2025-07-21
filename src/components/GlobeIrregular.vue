<script lang="ts" setup>
import * as THREE from "three";
import * as zarr from "zarrita";
import {
  makeColormapMaterial2,
  availableColormaps,
  calculateColorMapProperties,
} from "./utils/colormapShaders.ts";
import { decodeTime } from "./utils/timeHandling.ts";
import Delaunator from "delaunator";
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

import { useGlobeControlStore } from "./store/store.js";
import { storeToRefs } from "pinia";
import type {
  TBounds,
  TColorMap,
  TSources,
  TVarInfo,
} from "../types/GlobeTypes.ts";
import { useToast } from "primevue/usetoast";
import { getErrorMessage } from "./utils/errorHandling.ts";
import { useSharedGlobeLogic } from "./sharedGlobe.ts";

type Point3D = { x: number; y: number; z: number };

const props = defineProps<{
  datasources?: TSources;
  varbounds?: TBounds;
  colormap?: TColorMap;
  invertColormap?: boolean;
}>();

const emit = defineEmits<{ varinfo: [TVarInfo] }>();
const store = useGlobeControlStore();
const toast = useToast();
const { timeIndexSlider, timeIndex, varnameSelector, varname } =
  storeToRefs(store);

const datavars: ShallowRef<
  Record<string, zarr.Array<zarr.DataType, zarr.FetchStore>>
> = shallowRef({});
const updateCount = ref(0);
const updatingData = ref(false);

const estimatedSpacing = ref(0);

let points: THREE.Points | undefined = undefined;

let canvas: Ref<HTMLCanvasElement | undefined> = ref();
let box: Ref<HTMLDivElement | undefined> = ref();

const {
  getScene,
  getCamera,
  getRenderer,
  redraw,
  makeSnapshot,
  toggleRotate,
  getDataVar,
  getTimeVar,
  registerUpdateLOD,
} = useSharedGlobeLogic(canvas, box);

watch(
  () => varnameSelector.value,
  () => {
    getData();
  }
);

watch(
  () => timeIndexSlider.value,
  () => {
    getData();
  }
);

watch(
  () => props.datasources,
  () => {
    datasourceUpdate();
  }
);

watch(
  () => props.varbounds,
  () => {
    updateColormap();
  }
);

watch(
  () => props.invertColormap,
  () => {
    updateColormap();
  }
);

watch(
  () => props.colormap,
  () => {
    updateColormap();
  }
);

const colormapMaterial = computed(() => {
  if (props.invertColormap) {
    return makeColormapMaterial2(props.colormap, 1.0, -1.0);
  } else {
    return makeColormapMaterial2(props.colormap, 0.0, 1.0);
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

function publishVarinfo(info: TVarInfo) {
  emit("varinfo", info);
}

async function datasourceUpdate() {
  datavars.value = {};
  if (props.datasources !== undefined) {
    await Promise.all([getData()]);
    updateColormap();
  }
}

function updateColormap() {
  const low = props.varbounds?.low as number;
  const high = props.varbounds?.high as number;
  const { addOffset, scaleFactor } = calculateColorMapProperties(
    low,
    high,
    props.invertColormap
  );

  const material = points!.material as THREE.ShaderMaterial;
  material.uniforms.colormap.value = availableColormaps[props.colormap!];
  material.uniforms.addOffset.value = addOffset;
  material.uniforms.scaleFactor.value = scaleFactor;
  material.needsUpdate = true;
  redraw();
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

// function estimateAverageSpacing(positions: Float32Array): number {
//   /*
//     Estimate average spacing between points based on first 10 points
//   */
//   let totalDist = 0;
//   let count = 0;
//   for (let i = 0; i < positions.length - 6 && count < 10; i += 3) {
//     const dx = positions[i] - positions[i + 3];
//     const dy = positions[i + 1] - positions[i + 4];
//     const dz = positions[i + 2] - positions[i + 5];
//     const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
//     totalDist += dist;
//     count++;
//   }
//   return totalDist / count;
// }

function xyzToLonLat(x: number, y: number, z: number): [number, number] {
  const lon = Math.atan2(y, x);
  const lat = Math.asin(z / Math.sqrt(x * x + y * y + z * z));
  return [lon, lat];
}

// function latLongToXYZ(lat: number, lon: number, radius: number) {
//   // Convert latitude and longitude from degrees to radians
//   const latRad = lat * (Math.PI / 180);
//   const lonRad = lon * (Math.PI / 180);

//   // Calculate the Cartesian coordinates
//   const x = radius * Math.cos(latRad) * Math.cos(lonRad);
//   const y = radius * Math.cos(latRad) * Math.sin(lonRad);
//   const z = radius * Math.sin(latRad);

//   return [x, y, z];
// }

// function estimateLocalDensity(positions: Float32Array): Float32Array {
//   const N = positions.length / 3;

//   // Step 1: Project positions to lon/lat
//   const points2D: [number, number][] = [];
//   for (let i = 0; i < N; i++) {
//     const x = positions[3 * i];
//     const y = positions[3 * i + 1];
//     const z = positions[3 * i + 2];
//     points2D.push(xyzToLonLat(x, y, z));
//   }
//   // const delaunay = Delaunator.triangles(positions);

//   // Step 2: Run Delaunay triangulation
//   const delaunay = Delaunator.from(points2D);

//   // Prepare adjacency lists
//   const adjacency: number[][] = Array.from({ length: N }, () => []);

//   for (let i = 0; i < delaunay.triangles.length; i += 3) {
//     const a = delaunay.triangles[i];
//     const b = delaunay.triangles[i + 1];
//     const c = delaunay.triangles[i + 2];

//     adjacency[a].push(b, c);
//     adjacency[b].push(a, c);
//     adjacency[c].push(a, b);
//   }

//   // Step 3: Compute average edge length for each point
//   const densities = new Float32Array(N);
//   for (let i = 0; i < N; i++) {
//     const neighbors = adjacency[i];
//     if (neighbors.length === 0) continue;

//     let totalDist = 0;
//     for (const j of neighbors) {
//       const dx = positions[3 * i] - positions[3 * j];
//       const dy = positions[3 * i + 1] - positions[3 * j + 1];
//       const dz = positions[3 * i + 2] - positions[3 * j + 2];
//       totalDist += Math.sqrt(dx * dx + dy * dy + dz * dz);
//     }

//     densities[i] = totalDist / neighbors.length;
//   }

//   return densities;
// }

function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in km
  const toRad = Math.PI / 180;

  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateLocalDensityLatLon(latLons: [number, number][]): Float32Array {
  const N = latLons.length;

  const delaunay = Delaunator.from(latLons);
  const { triangles } = delaunay;
  // Prepare adjacency lists
  const adjacency: number[][] = Array.from({ length: N }, () => []);
  const densities = new Float32Array(N);

  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i];
    const b = triangles[i + 1];
    const c = triangles[i + 2];

    // Add undirected edges
    adjacency[a].push(b, c);
    adjacency[b].push(a, c);
    adjacency[c].push(a, b);
  }

  // Remove duplicates from adjacency lists
  for (let i = 0; i < N; i++) {
    adjacency[i] = Array.from(new Set(adjacency[i]));
  }

  // Estimate local density based on average neighbor distance
  for (let i = 0; i < N; i++) {
    const [lat1, lon1] = latLons[i];
    const neighbors = adjacency[i];

    if (neighbors.length === 0) {
      densities[i] = 0; // Isolated point
      continue;
    }

    let sumDistances = 0;

    for (const j of neighbors) {
      const [lat2, lon2] = latLons[j];
      sumDistances += haversineDistance(lat1, lon1, lat2, lon2);
    }

    const avgDistance = sumDistances / neighbors.length;

    // Density can be inversely proportional to distance
    densities[i] = 1 / avgDistance;
  }

  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < densities.length; i++) {
    if (densities[i] < min) min = densities[i];
    if (densities[i] > max) max = densities[i];
  }

  // Normalize densities to [0, 1]
  for (let i = 0; i < densities.length; i++) {
    densities[i] = (densities[i] - min) / (max - min);
  }

  return densities;
}

// function dist(a: Point3D, b: Point3D): number {
//   const dx = a.x - b.x;
//   const dy = a.y - b.y;
//   const dz = a.z - b.z;
//   return Math.sqrt(dx * dx + dy * dy + dz * dz);
// }

// function estimateLocalDensity(positions: Float32Array, k = 5): Float32Array {
//   const N = positions.length / 3;
//   const pts: Point3D[] = Array(N);

//   // Convert to array of point objects
//   for (let i = 0; i < N; i++) {
//     pts[i] = {
//       x: positions[3 * i],
//       y: positions[3 * i + 1],
//       z: positions[3 * i + 2],
//     };
//   }

//   // Build KD-tree
//   const tree = new kdTree(pts, dist, ["x", "y", "z"]);

//   const densities = new Float32Array(N);

//   for (let i = 0; i < N; i++) {
//     const p = pts[i];
//     const neigh = tree.nearest(p, k + 1); // +1 to skip self
//     const kth = neigh
//       .filter(([pt]) => pt !== p)
//       .slice(0, k)
//       .map(([, d]) => d)
//       .sort((a, b) => a - b)[k - 1];
//     densities[i] = kth;
//   }

//   return densities;
// }

function computePointSizes(
  densities: Float32Array,
  baseSize: number = 10,
  power: number = 0.5,
  minSize: number = 1,
  maxSize: number = 5
): Float32Array {
  let minDensity = Infinity;
  let maxDensity = -Infinity;

  const N = densities.length;

  // Step 1: Find min and max density
  for (let i = 0; i < N; i++) {
    const d = densities[i];
    if (d < minDensity) minDensity = d;
    if (d > maxDensity) maxDensity = d;
  }
  console.log("minMaxDen", minDensity, maxDensity);

  const range = maxDensity - minDensity;
  if (range === 0) {
    // All densities are identical, assign default size
    const defaultSizes = new Float32Array(N);
    for (let i = 0; i < N; i++) defaultSizes[i] = baseSize;
    return defaultSizes;
  }

  // Step 2: Compute point sizes directly
  const sizes = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let d = densities[i];

    // Normalize to 0 - 1
    let norm = (d - minDensity) / range;

    // Apply contrast boost
    norm = Math.pow(norm, power);

    // Optional: Invert mapping so dense areas get smaller points
    // norm = 1.0 - norm;

    // Compute final size
    let size = minSize + (maxSize - minSize) * (1.0 - norm); // Inverted so smaller densities → bigger points
    sizes[i] = size;
  }

  return sizes;
}

// function normalizeAndAmplifyDensities(
//   densities: Float32Array,
//   power: number = 0.5
// ): Float32Array {
//   let minDensity = Infinity;
//   let maxDensity = -Infinity;

//   const N = densities.length;

//   // Step 1: Find min and max
//   for (let i = 0; i < N; i++) {
//     const d = densities[i];
//     if (d < minDensity) minDensity = d;
//     if (d > maxDensity) maxDensity = d;
//   }

//   const range = maxDensity - minDensity;
//   if (range === 0) return densities; // Avoid division by zero if all values are identical

//   // Step 2: Normalize and apply contrast amplification (in place)
//   const normalized = new Float32Array(N);
//   for (let i = 0; i < N; i++) {
//     let d = densities[i];
//     let norm = (d - minDensity) / range;

//     // Apply contrast boost (power function)
//     norm = Math.pow(norm, power);

//     // Optional: Invert mapping if you want smaller densities to appear larger
//     norm = 1.0 - norm;

//     normalized[i] = norm;
//   }

//   return normalized;
// }

async function getGrid(grid: zarr.Group<zarr.Readable>, data: Float64Array) {
  // Load latitudes and longitudes arrays (1D)
  const latitudes = (
    await zarr.open(grid.resolve("lat"), { kind: "array" }).then(zarr.get)
  ).data as Float64Array;

  const longitudes = (
    await zarr.open(grid.resolve("lon"), { kind: "array" }).then(zarr.get)
  ).data as Float64Array;

  const N = latitudes.length;

  if (longitudes.length !== N || data.length !== N) {
    throw new Error(
      "Latitudes, longitudes, and data must have the same length"
    );
  }

  // Allocate typed arrays for positions and values
  const positions = new Float32Array(N * 3);
  const dataValues = new Float32Array(N);

  // Convert lat/lon to Cartesian positions
  for (let i = 0; i < N; i++) {
    latLonToCartesianFlat(latitudes[i], longitudes[i], positions, i * 3);
    dataValues[i] = data[i];
  }

  // estimatedSpacing.value = estimateAverageSpacing(
  //   positions,
  //   getCamera()!,
  //   getRenderer()!
  // );

  console.time("estimateLocalDensity");
  const points2D: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    points2D.push([longitudes[i], latitudes[i]]);
  }
  const densities = estimateLocalDensityLatLon(points2D);

  console.timeEnd("estimateLocalDensity");

  points!.geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3)
  );
  const pointSizes = computePointSizes(densities, 1.0);

  // const amplifiedDensities = normalizeAndAmplifyDensities(densities, 1.0);
  console.log("densities", densities);
  console.log("pointSizes", pointSizes);
  points!.geometry.setAttribute(
    "localDensity",
    new THREE.BufferAttribute(densities, 1)
  );
  points!.geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(dataValues, 1)
  );
  points!.geometry.computeBoundingSphere();
  const material = points!.material as THREE.ShaderMaterial;
  material.needsUpdate = true;
  updateLOD();
}

// function estimateAverageSpacing(positions: Float32Array): number {
//   const N = positions.length / 3;
//   if (N < 2) return 0;

//   let totalDist = 0;
//   let sampleCount = 0;

//   // Sample every ~N/100 point to reduce computation cost
//   const step = Math.max(1, Math.floor(N / 100));

//   for (let i = 0; i < N; i += step) {
//     const i3 = i * 3;

//     // Search nearest neighbor in a small window (next 5 points)
//     let minDistSq = Infinity;
//     for (let j = i + 1; j < Math.min(N, i + 6); j++) {
//       const j3 = j * 3;
//       const dx = positions[i3] - positions[j3];
//       const dy = positions[i3 + 1] - positions[j3 + 1];
//       const dz = positions[i3 + 2] - positions[j3 + 2];
//       const distSq = dx * dx + dy * dy + dz * dz;
//       if (distSq < minDistSq) minDistSq = distSq;
//     }

//     if (minDistSq < Infinity) {
//       totalDist += Math.sqrt(minDistSq);
//       sampleCount++;
//     }
//   }

//   return sampleCount > 0 ? totalDist / sampleCount : 0;
// }

function estimateAverageSpacing(
  positions: Float32Array,
  camera: THREE.Camera,
  renderer: THREE.WebGLRenderer
): number {
  const N = positions.length / 3;
  if (N < 2) return 0;

  const step = Math.max(1, Math.floor(N / 100));
  const width = renderer.domElement.width;
  const height = renderer.domElement.height;

  let totalPixelDist = 0;
  let sampleCount = 0;

  const vector = new THREE.Vector3();

  for (let i = 0; i < N; i += step) {
    const i3 = i * 3;
    vector.set(positions[i3], positions[i3 + 1], positions[i3 + 2]);
    vector.project(camera);
    const x1 = (vector.x * 0.5 + 0.5) * width;
    const y1 = (vector.y * -0.5 + 0.5) * height;

    let minPixelDistSq = Infinity;

    for (let j = i + 1; j < Math.min(N, i + 6); j++) {
      const j3 = j * 3;
      vector.set(positions[j3], positions[j3 + 1], positions[j3 + 2]);
      vector.project(camera);
      const x2 = (vector.x * 0.5 + 0.5) * width;
      const y2 = (vector.y * -0.5 + 0.5) * height;

      const dx = x1 - x2;
      const dy = y1 - y2;
      const distSq = dx * dx + dy * dy;
      if (distSq < minPixelDistSq) minPixelDistSq = distSq;
    }

    if (minPixelDistSq < Infinity) {
      totalPixelDist += Math.sqrt(minPixelDistSq);
      sampleCount++;
    }
  }

  return sampleCount > 0 ? totalPixelDist / sampleCount : 0;
}

function updateLOD() {
  /* FIXME: Points do not scale automatically when the camera zooms in.
  This is a hack to make the points bigger when the camera is close by
  taking into acount some the distance of some arbitrary points (estimatedSpacing)
  the distance of the camera (cameraDistance) and some scaling factor (k).

  The size will vary between 0.5 and 30, which is probably not the best way to do it.
  It would be better to have the size also depend on the screen size aswell.
   */
  // const desiredSpacing = 5.0; // desired pixel spacing between points
  // const actualSpacing = estimatedSpacing.value;
  // const basePointSize = 1.0;
  // // If actual spacing is smaller than desired, make points smaller
  // const scale = THREE.MathUtils.clamp(desiredSpacing / actualSpacing, 0.5, 4.0);
  // const material: THREE.ShaderMaterial = points!
  //   .material as THREE.ShaderMaterial;
  // material.uniforms.pointSize.value = scale * basePointSize;
  // const cameraDistance = getCamera()!.position.length();
  // const k = 1000000; // tweak this value to taste
  // const size = THREE.MathUtils.clamp(
  //   (k * estimatedSpacing.value) / cameraDistance,
  //   1.0,
  //   30 // maybe something dynamic, depending on the screen size?
  // );
  // console.log("size", size);
  // const material: THREE.ShaderMaterial = points!
  //   .material as THREE.ShaderMaterial;
  // material.uniforms.pointSize.value = size;
}

async function getData() {
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
    const [timevar, datavar] = await Promise.all([
      getTimeVar(props.datasources!),
      getDataVar(localVarname, props.datasources!),
    ]);
    let timeinfo = {};
    if (timevar !== undefined) {
      const timeattrs = timevar.attrs;
      const timevalues = (await zarr.get(timevar, [null])).data;
      timeinfo = {
        attrs: timeattrs,
        values: timevalues,
        current: decodeTime(
          (timevalues as number[])[currentTimeIndexSliderValue],
          timeattrs
        ),
      };
    }
    if (datavar !== undefined) {
      const root = zarr.root(new zarr.FetchStore(gridsource.value!.store));
      const grid = await zarr.open(root.resolve(gridsource.value!.dataset), {
        kind: "group",
      });
      const rawData = await zarr.get(datavar, [
        currentTimeIndexSliderValue,
        ...Array(datavar.shape.length - 1).fill(null),
      ]);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i of rawData.data as Float64Array) {
        if (Number.isNaN(i)) continue;
        min = Math.min(min, i);
        max = Math.max(max, i);
      }
      await getGrid(grid, rawData.data as Float64Array);
      publishVarinfo({
        attrs: datavar.attrs,
        timeinfo,
        timeRange: { start: 0, end: datavar.shape[0] - 1 },
        bounds: { low: min, high: max },
      });
      timeIndex.value = currentTimeIndexSliderValue;
      varname.value = localVarname;
    }
    updatingData.value = false;
    if (updateCount.value !== myUpdatecount) {
      await getData();
    }
  } catch (error) {
    toast.add({
      detail: `Couldn't fetch data: ${getErrorMessage(error)}`,
      life: 3000,
    });
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
    varname: varname.value,
    timeIndex: timeIndex.value,
    varbounds: props.varbounds!,
    colormap: props.colormap!,
    invertColormap: props.invertColormap,
  });
  navigator.clipboard.writeText(example);
}

onMounted(() => {
  let sphereGeometry = new THREE.SphereGeometry(0.999, 64, 64);
  const earthMat = new THREE.MeshBasicMaterial({ color: 0x000000 }); // black color

  // it is quite likely that the data points do not cover the whole globe
  // in order to avoid some ugly transparency issues, we add an opaque black
  // sphere underneath
  const globeMesh = new THREE.Mesh(sphereGeometry, earthMat);
  globeMesh.geometry.attributes.position.needsUpdate = true;
  globeMesh.rotation.x = Math.PI / 2;
  globeMesh.geometry.computeBoundingBox();
  globeMesh.geometry.computeBoundingSphere();

  getScene()?.add(points as THREE.Points);
  getScene()?.add(globeMesh);
});

onBeforeMount(async () => {
  const geometry = new THREE.BufferGeometry();
  const material = colormapMaterial.value;
  points = new THREE.Points(geometry, material);
  await datasourceUpdate();
  registerUpdateLOD(updateLOD);
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
