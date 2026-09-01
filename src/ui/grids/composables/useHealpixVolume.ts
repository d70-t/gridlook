import type * as THREE from "three";
import {
  onMounted,
  onScopeDispose,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";
import type * as zarr from "zarrita";

import {
  getMax3DTextureSize,
  SphericalVolumeLayer,
} from "@/lib/layers/volumeLayer.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import {
  inspectHealpixVolumeSources,
  loadHealpixVolumeData,
} from "@/lib/volume/healpixVolumeData.ts";
import {
  chooseVolumeTextureDimensions,
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

export type THealpixVolumeContext = {
  dimensionNames: string[];
  indices: (number | null | zarr.Slice)[];
  nside: number;
  cellCoordinates?: number[];
};

type TNormalizedHealpixVolumeContext = Omit<
  THealpixVolumeContext,
  "cellCoordinates"
> & {
  cellCoordinates?: Int32Array;
  cellCoordinatesKey: string;
};

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
  coordinates: number[] | undefined,
  nside: number
) {
  if (!coordinates) {
    return { coordinates: undefined, key: "global" };
  }
  let isIdentity = coordinates.length === 12 * nside * nside;
  let hash = 2_166_136_261;
  const normalized = new Int32Array(coordinates.length);
  for (let index = 0; index < coordinates.length; index++) {
    const coordinate = coordinates[index];
    normalized[index] = coordinate;
    isIdentity &&= coordinate === index;
    hash = Math.imul(hash ^ coordinate, 16_777_619);
  }
  return isIdentity
    ? { coordinates: undefined, key: "global" }
    : {
        coordinates: normalized,
        key: `${normalized.length}:${hash >>> 0}`,
      };
}

// eslint-disable-next-line max-lines-per-function
export function useHealpixVolume(options: TOptions) {
  const store = useGlobeControlStore();
  store.volumeAvailable = true;
  const { logError } = useLog();
  let context: TNormalizedHealpixVolumeContext | undefined;
  let layer: SphericalVolumeLayer | undefined;
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
      layer = new SphericalVolumeLayer();
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
    const datasources = options.getDatasources();
    const selections = store.volumeSelections.slice(0, 4);
    const renderer = options.getRenderer();
    if (
      disposed ||
      !context ||
      !datasources ||
      selections.length === 0 ||
      !renderer ||
      !store.isVolumeLayerEnabled() ||
      options.projectionHelper.value.isFlat
    ) {
      store.volumeLoading = false;
      store.volumeProgress = undefined;
      updateAppearance();
      return;
    }

    const revision = ++requestRevision;
    store.volumeLoading = true;
    store.volumeProgress = 0;
    try {
      const sources = await inspectHealpixVolumeSources(
        datasources,
        selections.map((selection) => selection.variable),
        context
      );
      reportProgress(revision, 5);
      const first = sources[0];
      const max3DTextureSize = getMax3DTextureSize(renderer);
      if (!(max3DTextureSize > 0)) {
        throw new Error("This device does not support WebGL 3D textures.");
      }
      const dimensions = chooseVolumeTextureDimensions(
        context.nside,
        first.sourceLevelCount,
        max3DTextureSize,
        // Reserve the common water/ice pair so toggling a second volume does
        // not change the primary volume's spatial resolution.
        Math.max(RESERVED_VOLUME_CHANNEL_COUNT, sources.length),
        HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES
      );
      const key = JSON.stringify({
        variables: sources.map((source) => source.name),
        selection: first.selection,
        nside: context.nside,
        cellCoordinates: context.cellCoordinatesKey,
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

      const { values, heights } = await loadHealpixVolumeData(
        datasources,
        sources,
        context,
        (fraction) => reportProgress(revision, 5 + fraction * 70)
      );
      if (revision !== requestRevision || disposed) {
        return;
      }
      const result = await buildVolumeTextureInWorker(
        {
          nside: context.nside,
          cellCoordinates: context.cellCoordinates?.slice(),
          sourceLevelCount: first.sourceLevelCount,
          sourceCellCount: first.sourceCellCount,
          values,
          heights,
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
        selections.map((selection) => selection.color),
        selections.map((selection) => selection.opacity)
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

  function setContext(nextContext: THealpixVolumeContext) {
    const normalized = normalizeCellCoordinates(
      nextContext.cellCoordinates,
      nextContext.nside
    );
    context = {
      ...nextContext,
      cellCoordinates: normalized.coordinates,
      cellCoordinatesKey: normalized.key,
    };
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
      requestRevision++;
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
    if (!options.projectionHelper.value.isFlat) {
      void loadVolume();
    }
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
