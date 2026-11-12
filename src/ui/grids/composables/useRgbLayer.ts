import * as THREE from "three";
import { onScopeDispose, watch, type ComputedRef, type Ref } from "vue";
import type * as zarr from "zarrita";

import { getLayerRenderOrder } from "./useGridOverlays.ts";

import {
  chooseRgbDimension,
  chooseRgbVariables,
  clampRgbChannels,
  getRgbDimensionOptions,
  getRgbVariableOptions,
  resolveRgbDisplayRange,
  resolveRgbSource,
  isTrueColour,
  RGB_TRUE_COLOUR_RANGE,
  resolveSiblingVariable,
  RGB_SOURCES,
  type TRgbBounds,
  type TRgbChannels,
  type TRgbVariables,
} from "@/lib/data/rgbComposite.ts";
import { applyLayerStackPosition } from "@/lib/layers/equirectLayer.ts";
import { updateProjectionMeshes } from "@/lib/projection/projectionEdgeQuality.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  createProjectionInstancedMesh,
  makeGpuProjectedRgbTextureMaterial,
} from "@/lib/shaders/gridShaders.ts";
import type {
  TDataSource,
  TDimInfo,
  TDimensionRange,
} from "@/lib/types/GlobeTypes.ts";
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

/**
 * Either three entries of one dimension of the current variable, or the same
 * selection of three other variables (full names) on the same grid.
 */
export type TRgbRequest = (
  | { dimensionIndex: number; channels: TRgbChannels; variables?: undefined }
  | { variables: TRgbVariables }
) & {
  indices: TIndices;
  isCurrent: () => boolean;
};

export type TRgbLoadResult = { batches: TRgbBatch[]; bounds?: TRgbBounds };

type TRgbContext = {
  indices: TIndices;
  dimRanges: TDimensionRange[];
  dimInfo: TDimInfo[];
  // the variable the grid shows and the variables next to it
  varname: string;
  vars: Record<string, TDataSource>;
};

type TDataVar = zarr.Array<zarr.DataType, zarr.AsyncReadable>;

/** What one channel reads, and the array whose attributes decode it. */
export type TRgbChannelRead = {
  // undefined: the current variable
  variable?: string;
  selection: TIndices;
  datavar: TDataVar;
};

/**
 * The three reads of a request: the channel entries of the RGB dimension of
 * the current variable, or the same selection of each channel variable.
 */
export function getRgbChannelReads(
  request: TRgbRequest,
  datavar: TDataVar,
  openVariable: (variable: string) => Promise<TDataVar>
): Promise<TRgbChannelRead[]> {
  if (request.variables) {
    return Promise.all(
      request.variables.map(async (variable) => ({
        variable,
        selection: request.indices.slice(),
        datavar: await openVariable(variable),
      }))
    );
  }
  const { dimensionIndex } = request;
  return Promise.resolve(
    request.channels.map((channel) => {
      const selection = request.indices.slice();
      selection[dimensionIndex] = channel;
      return { selection, datavar };
    })
  );
}

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
 * variable, or three variables next to it, drawn as true colours over the data grid's own geometry. The grid
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

  function install(result: TRgbLoadResult, defaultRange?: TRgbBounds) {
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
    store.rgbDataBounds = defaultRange ?? result.bounds;
    updateProjection();
    updateAppearance();
  }

  function resolveVariablesRequest(current: TRgbContext) {
    const variables = chooseRgbVariables(
      getRgbVariableOptions(current.vars, current.varname),
      store.rgbSettings.variables
    )?.map((name) => resolveSiblingVariable(current.varname, name)) as
      TRgbVariables | undefined;
    if (!variables) {
      return undefined;
    }
    const trueColour = isTrueColour(
      variables.map((name) =>
        name.slice(name.lastIndexOf("/") + 1)
      ) as TRgbVariables
    );
    const key = JSON.stringify({ indices: current.indices, variables });
    return { variables, indices: current.indices, key, trueColour };
  }

  function resolveRequest(current: TRgbContext) {
    const dimensionOptions = getRgbDimensionOptions(
      current.dimRanges,
      current.dimInfo
    );
    const source = resolveRgbSource(
      store.rgbSettings,
      dimensionOptions,
      getRgbVariableOptions(current.vars, current.varname)
    );
    if (source === RGB_SOURCES.VARIABLES) {
      return resolveVariablesRequest(current);
    }
    const option = chooseRgbDimension(
      dimensionOptions,
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
    return {
      dimensionIndex: option.index,
      channels,
      indices,
      key,
      trueColour: false,
    };
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
      // Allow the loading indicator to paint before decoding the channels.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (!isCurrent()) {
        return;
      }
      const result = await options.load({ ...request, isCurrent });
      if (!result || !isCurrent()) {
        return;
      }
      // reflectance bands look right in a fixed range, not the data range
      install(result, request.trueColour ? RGB_TRUE_COLOUR_RANGE : undefined);
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
      store.rgbSettings.source,
      store.rgbSettings.dimension,
      ...store.rgbSettings.channels,
      ...(store.rgbSettings.variables ?? []),
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
