import type * as THREE from "three";
import {
  onMounted,
  onScopeDispose,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";
import type * as zarr from "zarrita";

import { getMax3DTextureSize, VolumeLayer } from "@/lib/layers/volumeLayer.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import {
  inspectVolumeSources,
  loadVolumeData,
} from "@/lib/volume/volumeData.ts";
import {
  VOLUME_GRID_TYPES,
  type TVolumeGrid,
} from "@/lib/volume/volumeGrid.ts";
import {
  chooseVolumeTextureDimensions,
  chooseRegularVolumeTextureDimensions,
  HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES,
  RESERVED_VOLUME_CHANNEL_COUNT,
} from "@/lib/volume/volumeTexture.ts";
import {
  buildVolumeTextureInWorker,
  terminateVolumeTextureWorker,
} from "@/lib/volume/volumeTextureWorkerClient.ts";
import {
  BUILTIN_LAYER_IDS,
  LAYER_OPACITY,
  useGlobeControlStore,
} from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";

export type TVolumeContext = {
  dimensionNames: string[];
  indices: (number | null | zarr.Slice)[];
  grid: TVolumeGrid;
};

type TNormalizedVolumeContext = TVolumeContext & { gridKey: string };

type TOptions = {
  getDatasources: () => TSources | undefined;
  getScene: () => THREE.Scene | undefined;
  getRenderer: () => THREE.WebGLRenderer | undefined;
  redraw: () => void;
  projectionHelper: ComputedRef<ProjectionHelper>;
  isSceneInMotion: Ref<boolean>;
  onProjectionChange: (callback: () => void) => void;
  onMotionStateChange: (callback: () => void) => void;
};

function renderOrder(store: ReturnType<typeof useGlobeControlStore>) {
  const gridIndex = store.layerStack.findIndex(
    (entry) => entry.id === BUILTIN_LAYER_IDS.GRID
  );
  const volumeIndex = store.layerStack.findIndex(
    (entry) => entry.id === BUILTIN_LAYER_IDS.VOLUME
  );
  const delta = gridIndex - volumeIndex;
  return delta > 0 ? 10 + delta : Math.max(delta, -9);
}

function normalizeCellCoordinates(
  coordinates: Float64Array | undefined,
  nside: number
) {
  if (!coordinates) {
    return { coordinates: undefined, key: "global" };
  }
  let isIdentity = coordinates.length === 12 * nside * nside;
  let hash = 2_166_136_261;
  const normalized = new Float64Array(coordinates.length);
  for (let index = 0; index < coordinates.length; index++) {
    const coordinate = coordinates[index];
    normalized[index] = coordinate;
    isIdentity &&= coordinate === index;
    hash = Math.imul(hash ^ coordinate, 16_777_619);
    hash = Math.imul(hash ^ Math.floor(coordinate / 2 ** 32), 16_777_619);
  }
  return isIdentity
    ? { coordinates: undefined, key: "global" }
    : {
        coordinates: normalized,
        key: `${normalized.length}:${hash >>> 0}`,
      };
}

// eslint-disable-next-line max-lines-per-function
export function useVolume(options: TOptions) {
  const store = useGlobeControlStore();
  store.volumeAvailable = true;
  const { logError } = useLog();
  let context: TNormalizedVolumeContext | undefined;
  let layer: VolumeLayer | undefined;
  let cachedKey: string | undefined;
  let hasData = false;
  let requestRevision = 0;
  let disposed = false;

  function reportProgress(revision: number, progress: number) {
    if (revision !== requestRevision || disposed) {
      return;
    }
    const rounded = Math.max(0, Math.min(100, Math.round(progress)));
    store.volumeProgress = Math.max(store.volumeProgress ?? 0, rounded);
  }

  function ensureLayer() {
    if (!layer) {
      layer = new VolumeLayer();
      options.getScene()?.add(layer.object);
    }
    return layer;
  }

  function updateAppearance() {
    if (!layer) {
      return;
    }
    const entry = store.layerStack.find(
      (candidate) => candidate.id === BUILTIN_LAYER_IDS.VOLUME
    );
    layer.setOpacity(entry?.opacity ?? LAYER_OPACITY.MAX);
    layer.setRenderOrder(renderOrder(store));
    layer.object.visible = Boolean(
      hasData && entry?.visible && !options.projectionHelper.value.isFlat
    );
    options.redraw();
  }

  // eslint-disable-next-line max-lines-per-function
  async function loadVolume() {
    const revision = ++requestRevision;
    const requestContext = context;
    const datasources = options.getDatasources();
    const selections = store.volumeSelections.slice(0, 4);
    const renderer = options.getRenderer();
    if (
      disposed ||
      !requestContext ||
      !datasources ||
      selections.length === 0 ||
      !renderer ||
      options.projectionHelper.value.isFlat ||
      !store.isVolumeLayerEnabled()
    ) {
      store.volumeLoading = false;
      store.volumeProgress = undefined;
      updateAppearance();
      return;
    }

    store.volumeLoading = true;
    store.volumeProgress = 0;
    try {
      const sources = await inspectVolumeSources(
        datasources,
        selections.map((selection) => selection.variable),
        requestContext
      );
      if (revision !== requestRevision || disposed) {
        return;
      }
      reportProgress(revision, 5);
      const first = sources[0];
      const max3DTextureSize = getMax3DTextureSize(renderer);
      if (!(max3DTextureSize > 0)) {
        throw new Error("This device does not support WebGL 3D textures.");
      }
      const grid = requestContext.grid;
      // Reserve water/ice channels to keep resolution stable when adding a field.
      const channelCount = Math.max(
        RESERVED_VOLUME_CHANNEL_COUNT,
        sources.length
      );
      if (
        grid.kind === VOLUME_GRID_TYPES.REGULAR &&
        (first.spatialShape[0] !== grid.latitudes.length ||
          first.spatialShape[1] !== grid.longitudes.length)
      ) {
        throw new Error("Volume coordinates do not match the displayed grid.");
      }
      const dimensions =
        grid.kind === VOLUME_GRID_TYPES.HEALPIX
          ? chooseVolumeTextureDimensions(
              grid.nside,
              first.sourceLevelCount,
              max3DTextureSize,
              channelCount,
              HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES
            )
          : chooseRegularVolumeTextureDimensions(
              grid.longitudes.length,
              grid.latitudes.length,
              first.sourceLevelCount,
              max3DTextureSize,
              channelCount,
              HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES
            );
      const key = JSON.stringify({
        variables: sources.map((source) => source.name),
        selection: first.selection,
        grid: requestContext.gridKey,
        dimensions,
      });
      if (key === cachedKey && hasData) {
        layer?.setAppearance(
          selections.map((selection) => selection.color),
          selections.map((selection) => selection.opacity)
        );
        updateAppearance();
        return;
      }

      const { values, heights, levels } = await loadVolumeData(
        datasources,
        sources,
        requestContext,
        (fraction) => reportProgress(revision, 5 + fraction * 70)
      );
      if (revision !== requestRevision || disposed) {
        return;
      }
      const result = await buildVolumeTextureInWorker(
        {
          grid:
            grid.kind === VOLUME_GRID_TYPES.HEALPIX
              ? { ...grid, cellCoordinates: grid.cellCoordinates?.slice() }
              : {
                  ...grid,
                  latitudes: grid.latitudes.slice(),
                  longitudes: grid.longitudes.slice(),
                },
          sourceLevelCount: first.sourceLevelCount,
          sourceCellCount: first.sourceCellCount,
          values,
          heights,
          levels,
          dimensions,
        },
        (completed, total) =>
          reportProgress(
            revision,
            75 + (total > 0 ? (completed / total) * 24 : 0)
          )
      );
      if (revision !== requestRevision || disposed) {
        return;
      }
      ensureLayer().setData(
        result.data,
        result.dimensions,
        result.channelCount,
        result.storageChannelCount,
        store.volumeSelections.map((selection) => selection.color),
        store.volumeSelections.map((selection) => selection.opacity),
        result.bounds
      );
      cachedKey = key;
      hasData = true;
      reportProgress(revision, 100);
      updateAppearance();
    } catch (error) {
      if (revision === requestRevision && !disposed) {
        hasData = false;
        updateAppearance();
        logError(error, "Could not render the volume");
      }
    } finally {
      if (revision === requestRevision) {
        store.volumeLoading = false;
        store.volumeProgress = undefined;
      }
    }
  }

  function setContext(nextContext: TVolumeContext) {
    const grid = nextContext.grid;
    if (grid.kind === VOLUME_GRID_TYPES.HEALPIX) {
      const normalized = normalizeCellCoordinates(
        grid.cellCoordinates,
        grid.nside
      );
      context = {
        ...nextContext,
        grid: { ...grid, cellCoordinates: normalized.coordinates },
        gridKey: JSON.stringify([grid.options, grid.nside, normalized.key]),
      };
    } else {
      context = {
        ...nextContext,
        gridKey: JSON.stringify([
          grid.kind,
          Array.from(grid.latitudes),
          Array.from(grid.longitudes),
        ]),
      };
    }
    void loadVolume();
  }

  function refresh() {
    return loadVolume();
  }

  watch(
    () =>
      `${store.isVolumeLayerEnabled()}:${store.volumeSelections
        .map((selection) => selection.variable)
        .join("\u0000")}`,
    () => {
      updateAppearance();
      void loadVolume();
    }
  );
  watch(
    () =>
      store.volumeSelections
        .map((selection) => `${selection.color}:${selection.opacity}`)
        .join(),
    () => {
      layer?.setAppearance(
        store.volumeSelections.map((selection) => selection.color),
        store.volumeSelections.map((selection) => selection.opacity)
      );
      options.redraw();
    }
  );
  watch(() => store.layerStack, updateAppearance, { deep: true });
  options.onProjectionChange(() => {
    updateAppearance();
    void loadVolume();
  });
  options.onMotionStateChange(() => {
    layer?.setInteractive(options.isSceneInMotion.value);
    options.redraw();
  });
  onMounted(() => void loadVolume());
  onScopeDispose(() => {
    disposed = true;
    requestRevision++;
    store.volumeLoading = false;
    store.volumeProgress = undefined;
    store.volumeAvailable = false;
    terminateVolumeTextureWorker();
    if (layer) {
      options.getScene()?.remove(layer.object);
      layer.dispose();
      layer = undefined;
    }
  });

  return { setContext, refresh };
}
