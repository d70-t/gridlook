import * as THREE from "three";
import { onScopeDispose, watch, type ComputedRef, type Ref } from "vue";
import type * as zarr from "zarrita";

import { getLayerRenderOrder } from "./useGridOverlays.ts";

import {
  chooseRgbDimension,
  clampRgbChannels,
  getRgbDimensionOptions,
  resolveRgbDisplayRange,
  type TRgbBounds,
  type TRgbChannels,
} from "@/lib/data/rgbComposite.ts";
import { applyLayerStackPosition } from "@/lib/layers/equirectLayer.ts";
import { updateProjectionMeshes } from "@/lib/projection/projectionEdgeQuality.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  createProjectionInstancedMesh,
  makeGpuProjectedRgbTextureMaterial,
} from "@/lib/shaders/gridShaders.ts";
import type { TDimInfo, TDimensionRange } from "@/lib/types/GlobeTypes.ts";
import {
  BUILTIN_LAYER_IDS,
  LAYER_OPACITY,
  useGlobeControlStore,
} from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";

type TIndices = (number | null | zarr.Slice)[];

/** An RGBA float image; batches passing the same image share one texture. */
export type TRgbImage = {
  data: Float32Array;
  width: number;
  height: number;
  // sub-rectangle of the geometry's UV space the image covers
  dataRect?: { u: number; v: number; width: number; height: number };
  wrapRepeat?: boolean;
};

/** One mesh of the layer, drawn over a geometry of the data grid. */
export type TRgbBatch = {
  batchIndex: number;
  // shared with the data grid mesh; the RGB layer never disposes it
  geometry: THREE.BufferGeometry;
  image: TRgbImage;
};

export type TRgbRequest = {
  dimensionIndex: number;
  channels: TRgbChannels;
  indices: TIndices;
  isCurrent: () => boolean;
};

export type TRgbLoadResult = { batches: TRgbBatch[]; bounds?: TRgbBounds };

type TRgbContext = {
  indices: TIndices;
  dimRanges: TDimensionRange[];
  dimInfo: TDimInfo[];
};

type TOptions = {
  getScene: () => THREE.Scene | undefined;
  redraw: () => void;
  projectionHelper: ComputedRef<ProjectionHelper>;
  isSceneInMotion: Ref<boolean>;
  onProjectionChange: (callback: () => void) => void;
  onMotionStateChange: (callback: () => void) => void;
  load: (request: TRgbRequest) => Promise<TRgbLoadResult | undefined>;
};

type TStore = ReturnType<typeof useGlobeControlStore>;

function findLayerEntry(store: TStore) {
  return store.layerStack.find((entry) => entry.id === BUILTIN_LAYER_IDS.RGB);
}

function createTexture(image: TRgbImage) {
  const texture = new THREE.DataTexture(
    image.data,
    image.width,
    image.height,
    THREE.RGBAFormat,
    THREE.FloatType,
    THREE.UVMapping
  );
  if (image.wrapRepeat) {
    texture.wrapS = THREE.RepeatWrapping;
  }
  texture.needsUpdate = true;
  return texture;
}

function setMeshTexture(
  mesh: THREE.Mesh,
  texture: THREE.Texture,
  image: TRgbImage
) {
  const material = mesh.material as THREE.ShaderMaterial;
  material.uniforms.data.value = texture;
  const rect = image.dataRect ?? { u: 0, v: 0, width: 1, height: 1 };
  material.uniforms.dataUvOffset.value.set(rect.u, rect.v);
  material.uniforms.dataUvScale.value.set(rect.width, rect.height);
  material.uniforms.clipToDataRect.value =
    rect.width < 1 || rect.height < 1 ? 1 : 0;
}

/**
 * The "RGB composite" layer: three slices of one dimension of the current
 * variable, drawn as true colours over the data grid's own geometry. The grid
 * component loads the slices; this keeps the meshes, the settings and the
 * layer-stack position in sync.
 */
// eslint-disable-next-line max-lines-per-function
export function useRgbLayer(options: TOptions) {
  const store = useGlobeControlStore();
  store.rgbAvailable = true;
  const { logError } = useLog();
  const meshes = new Map<number, THREE.Mesh>();
  let textures = new Map<TRgbImage, THREE.DataTexture>();
  let context: TRgbContext | undefined;
  let loadedKey: string | undefined;
  let requestRevision = 0;
  let disposed = false;

  function updateAppearance() {
    const entry = findLayerEntry(store);
    const renderOrder = getLayerRenderOrder(
      store.layerStack,
      BUILTIN_LAYER_IDS.RGB
    );
    const { low, high } = resolveRgbDisplayRange(
      store.rgbSettings,
      store.rgbDataBounds
    );
    for (const mesh of meshes.values()) {
      const material = mesh.material as THREE.ShaderMaterial;
      material.uniforms.rgbLow.value = low;
      material.uniforms.rgbHigh.value = high;
      material.uniforms.gamma.value = store.rgbSettings.gamma;
      applyLayerStackPosition(
        mesh,
        renderOrder,
        entry?.opacity ?? LAYER_OPACITY.MAX
      );
      mesh.visible = Boolean(entry?.visible);
    }
    options.redraw();
  }

  function updateProjection() {
    updateProjectionMeshes([...meshes.values()], {
      redraw: options.redraw,
      projectionHelper: options.projectionHelper.value,
      isSceneInMotion: options.isSceneInMotion.value,
    });
  }

  function disposeMesh(batchIndex: number) {
    const mesh = meshes.get(batchIndex);
    if (!mesh) {
      return;
    }
    (mesh.material as THREE.Material).dispose();
    options.getScene()?.remove(mesh);
    meshes.delete(batchIndex);
  }

  function clear() {
    requestRevision++;
    loadedKey = undefined;
    for (const batchIndex of [...meshes.keys()]) {
      disposeMesh(batchIndex);
    }
    textures.forEach((texture) => texture.dispose());
    textures.clear();
    store.rgbLoading = false;
    store.rgbDataBounds = undefined;
    options.redraw();
  }

  function installBatch(
    batch: TRgbBatch,
    nextTextures: Map<TRgbImage, THREE.DataTexture>
  ) {
    let mesh = meshes.get(batch.batchIndex);
    if (!mesh) {
      const material = makeGpuProjectedRgbTextureMaterial(new THREE.Texture());
      material.uniforms.useTriangleWrapCull.value = 1;
      mesh = createProjectionInstancedMesh(
        batch.geometry as THREE.InstancedBufferGeometry,
        material,
        options.projectionHelper.value.type
      );
      mesh.frustumCulled = false;
      meshes.set(batch.batchIndex, mesh);
      options.getScene()?.add(mesh);
    }
    mesh.geometry = batch.geometry;
    let texture = nextTextures.get(batch.image);
    if (!texture) {
      texture = createTexture(batch.image);
      nextTextures.set(batch.image, texture);
    }
    setMeshTexture(mesh, texture, batch.image);
  }

  function install(result: TRgbLoadResult) {
    const batchIndices = new Set(result.batches.map((b) => b.batchIndex));
    for (const batchIndex of [...meshes.keys()]) {
      if (!batchIndices.has(batchIndex)) {
        disposeMesh(batchIndex);
      }
    }
    const nextTextures = new Map<TRgbImage, THREE.DataTexture>();
    result.batches.forEach((batch) => installBatch(batch, nextTextures));
    textures.forEach((texture) => texture.dispose());
    textures = nextTextures;
    store.rgbDataBounds = result.bounds;
    updateProjection();
    updateAppearance();
  }

  function resolveRequest(current: TRgbContext) {
    const option = chooseRgbDimension(
      getRgbDimensionOptions(current.dimRanges, current.dimInfo),
      store.rgbSettings.dimension
    );
    if (!option) {
      return undefined;
    }
    const channels = clampRgbChannels(
      store.rgbSettings.channels,
      option.labels.length
    );
    // The RGB dimension's own slider does not select what is shown.
    const indices = current.indices.slice();
    indices[option.index] = null;
    const key = JSON.stringify({ indices, dimension: option.index, channels });
    return { dimensionIndex: option.index, channels, indices, key };
  }

  async function refresh() {
    if (disposed || !context || !store.isRgbLayerEnabled()) {
      updateAppearance();
      return;
    }
    const request = resolveRequest(context);
    if (!request) {
      clear();
      return;
    }
    if (request.key === loadedKey) {
      updateAppearance();
      return;
    }
    const revision = ++requestRevision;
    const isCurrent = () => !disposed && revision === requestRevision;
    store.rgbLoading = true;
    try {
      const result = await options.load({ ...request, isCurrent });
      if (!result || !isCurrent()) {
        return;
      }
      install(result);
      loadedKey = request.key;
    } catch (error) {
      if (isCurrent()) {
        clear();
        logError(error, "Could not load the RGB composite");
      }
    } finally {
      if (isCurrent()) {
        store.rgbLoading = false;
      }
    }
  }

  /** Called by the grid after each scalar load with its current selection. */
  async function setContext(next: TRgbContext) {
    context = next;
    await refresh();
  }

  function updateGeometry(batchIndex: number, geometry: THREE.BufferGeometry) {
    const mesh = meshes.get(batchIndex);
    if (mesh) {
      mesh.geometry = geometry;
    }
  }

  options.onProjectionChange(updateProjection);
  options.onMotionStateChange(updateProjection);
  watch(
    () => [
      store.isRgbLayerEnabled(),
      store.rgbSettings.dimension,
      ...store.rgbSettings.channels,
    ],
    () => void refresh()
  );
  watch(
    () => [
      store.layerStack,
      store.rgbSettings.low,
      store.rgbSettings.high,
      store.rgbSettings.gamma,
    ],
    updateAppearance,
    { deep: true }
  );
  onScopeDispose(() => {
    clear();
    disposed = true;
    store.rgbAvailable = false;
  });

  return { setContext, updateGeometry };
}
