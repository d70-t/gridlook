import { storeToRefs } from "pinia";
import type * as THREE from "three";
import { computed, ref, watch } from "vue";
import type * as zarr from "zarrita";

import { useGridCameraState } from "./useGridCameraState.ts";
import { useGridDataAccess } from "./useGridDataAccess.ts";
import { useGridOverlays } from "./useGridOverlays.ts";
import { useGridScene } from "./useGridScene.ts";

import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import { availableColormaps } from "@/lib/shaders/colormapShaders.ts";
import { getColormapScaleOffset } from "@/lib/shaders/gridShaders.ts";
import type {
  TDimensionRange,
  TSources,
  TDimInfo,
} from "@/lib/types/GlobeTypes";
import { useGlobeControlStore } from "@/store/store.ts";
import {
  HISTOGRAM_SUMMARY_BINS,
  buildHistogramSummary,
  isHistogramSummary,
  mergeHistogramSummaries,
  rebinHistogramSummary,
  type THistogramSummary,
} from "@/utils/histogram.ts";

/* eslint-disable-next-line max-lines-per-function */
export function useSharedGridLogic() {
  const store = useGlobeControlStore();
  const {
    showCoastLines,
    showGraticules,
    landSeaMaskChoice,
    landSeaMaskUseTexture,
    selection,
    colormap,
    invertColormap,
    posterizeLevels,
    controlPanelVisible,
    projectionMode,
    projectionCenter,
  } = storeToRefs(store);

  const projectionHelper = computed(() => {
    return new ProjectionHelper(
      projectionMode.value,
      projectionCenter.value ?? { lat: 0, lon: 0 }
    );
  });

  const cameraState = useGridCameraState();
  let updateCoastlines: () => Promise<void> = async () => {};
  let updateGraticules: () => Promise<void> = async () => {};

  const {
    canvas,
    box,
    getScene,
    getCamera,
    getResizeObserver,
    redraw,
    toggleRotate,
    makeSnapshot,
    applyCameraPreset,
    registerUpdateLOD,
    updateBaseSurface,
    configureCameraForProjection,
    hoveredGeoPoint,
  } = useGridScene({
    projectionHelper,
    projectionCenter,
    controlPanelVisible,
    cameraState,
    onReady: () => {
      updateCoastlines();
      updateGraticules();
    },
  });

  const {
    updateCoastlines: updateCoastlinesInternal,
    updateGraticules: updateGraticulesInternal,
    updateLandSeaMask,
    updateLandSeaMaskProjectionUniforms,
    updateOverlayProjectionUniforms,
  } = useGridOverlays({
    projectionHelper,
    showCoastLines,
    showGraticules,
    landSeaMaskChoice,
    landSeaMaskUseTexture,
    getScene,
    redraw,
  });

  updateCoastlines = updateCoastlinesInternal;
  updateGraticules = updateGraticulesInternal;

  const { resetDataVars, getDataVar, getTimeInfo, getDimensionInfo } =
    useGridDataAccess();

  const bounds = computed(() => {
    return selection.value;
  });

  watch(
    () => showCoastLines.value,
    () => {
      updateCoastlines();
    }
  );

  watch(
    () => showGraticules.value,
    () => {
      updateGraticules();
    }
  );

  watch(
    [() => landSeaMaskChoice.value, () => landSeaMaskUseTexture.value],
    () => {
      updateLandSeaMask();
    }
  );

  watch(
    [() => projectionMode.value, () => projectionCenter.value],
    ([newMode, newCenter], [oldMode, oldCenter]) => {
      const modeChanged = newMode !== oldMode;
      const centerChanged =
        newCenter?.lat !== oldCenter?.lat || newCenter?.lon !== oldCenter?.lon;

      if (!modeChanged && !centerChanged) {
        return;
      }

      if (modeChanged) {
        updateBaseSurface();
        void updateOverlayProjectionUniforms(true);
        updateLandSeaMask();
        configureCameraForProjection();
      } else if (centerChanged) {
        void updateOverlayProjectionUniforms();
        updateLandSeaMaskProjectionUniforms();
      }
    },
    { deep: true }
  );

  function updateColormap(meshes: (THREE.Mesh | THREE.Points | undefined)[]) {
    if (!meshes) {
      return;
    }
    const low = bounds.value?.low as number;
    const high = bounds.value?.high as number;
    const { addOffset, scaleFactor } = getColormapScaleOffset(
      low,
      high,
      invertColormap.value
    );

    for (const myMesh of meshes) {
      if (!myMesh) {
        continue;
      }
      const material = myMesh.material as THREE.ShaderMaterial;
      material.uniforms.colormap.value = availableColormaps[colormap.value];
      material.uniforms.addOffset.value = addOffset;
      material.uniforms.scaleFactor.value = scaleFactor;
      if (material.uniforms.posterizeLevels) {
        material.uniforms.posterizeLevels.value = posterizeLevels.value;
      }
      material.needsUpdate = true;
    }
    redraw();
  }

  async function fetchDimensionDetails(
    currentVariable: string,
    datasources: TSources,
    dimensionRanges: TDimensionRange[],
    dimSlidersValues: (number | zarr.Slice | null)[]
  ): Promise<TDimInfo[]> {
    const array: TDimInfo[] = [];
    for (let i = 0; i < dimensionRanges.length; i++) {
      const dim = dimensionRanges[i];
      if (dim?.name === "time") {
        const timeInfo = await getTimeInfo(
          datasources,
          dimensionRanges,
          i,
          dimSlidersValues[i] as number
        );
        array.push(timeInfo);
      } else {
        const dimInfo = await getDimensionInfo(
          datasources.levels[0].datasources[currentVariable],
          dim!,
          dimSlidersValues[i] as number
        );
        array.push(dimInfo);
      }
    }
    return array;
  }

  const lastHistogramSummary = ref<THistogramSummary | null>(null);

  const DISPLAY_BIN_COUNT = 50;

  function getSelectionBinCount() {
    return posterizeLevels.value > 1
      ? posterizeLevels.value
      : DISPLAY_BIN_COUNT;
  }

  function recomputeHistogramFromSummary(
    summary: THistogramSummary,
    low: number,
    high: number
  ) {
    if (
      low !== undefined &&
      high !== undefined &&
      isFinite(low) &&
      isFinite(high)
    ) {
      const histogram = rebinHistogramSummary(
        summary,
        getSelectionBinCount(),
        low,
        high
      );
      store.updateHistogram(histogram);
    } else {
      store.updateHistogram(undefined);
    }
  }

  // Watch posterizeLevels and recompute histogram with new bin count
  watch(
    () => posterizeLevels.value,
    () => {
      if (
        lastHistogramSummary.value &&
        bounds.value?.low !== undefined &&
        bounds.value?.high !== undefined
      ) {
        const low = bounds.value?.low as number;
        const high = bounds.value?.high as number;
        recomputeHistogramFromSummary(lastHistogramSummary.value, low, high);
      } else {
        store.updateHistogram(undefined);
      }
    }
  );

  // Watch bounds and recompute histogram with new range
  watch(
    () => bounds.value,
    (newBounds) => {
      if (
        lastHistogramSummary.value &&
        newBounds.low !== undefined &&
        newBounds.high !== undefined
      ) {
        const low = newBounds.low;
        const high = newBounds.high;
        recomputeHistogramFromSummary(lastHistogramSummary.value, low, high);
      } else {
        store.updateHistogram(undefined);
      }
    },
    { deep: true }
  );

  function updateHistogram(
    data: ArrayLike<number> | THistogramSummary[] | undefined,
    min: number,
    max: number,
    missingValue?: number,
    fillValue?: number
  ) {
    if (!data || data.length === 0 || !isFinite(min) || !isFinite(max)) {
      store.updateHistogram(undefined);
      store.updateFullHistogram(undefined);
      lastHistogramSummary.value = null;
      return;
    }

    let summary: THistogramSummary;
    if (isHistogramSummary(data[0])) {
      // Data is already a histogram summary
      summary = mergeHistogramSummaries(
        data as THistogramSummary[],
        min,
        max,
        HISTOGRAM_SUMMARY_BINS
      );
    } else {
      summary = buildHistogramSummary(
        data as ArrayLike<number>,
        min,
        max,
        HISTOGRAM_SUMMARY_BINS,
        fillValue,
        missingValue
      );
    }

    // Full-range histogram: fixed over [min, max], never changes with bounds
    const fullHist = rebinHistogramSummary(
      summary,
      DISPLAY_BIN_COUNT,
      min,
      max
    );
    store.updateFullHistogram(fullHist);

    // Selection-range histogram: over current bounds
    recomputeHistogramFromSummary(summary, bounds.value.low, bounds.value.high);
    lastHistogramSummary.value = summary;
  }

  return {
    getScene,
    getCamera,
    getResizeObserver,
    redraw,
    toggleRotate,
    makeSnapshot,
    applyCameraPreset,
    resetDataVars,
    getDataVar,
    fetchDimensionDetails,
    registerUpdateLOD,
    updateLandSeaMask,
    updateColormap,
    updateHistogram,
    projectionHelper,
    canvas,
    box,
    hoveredGeoPoint,
  };
}
