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

  const {
    canvas,
    box,
    getScene,
    getCamera,
    getResizeObserver,
    redraw,
    toggleRotate,
    makeSnapshot,
    registerUpdateLOD,
    updateBaseSurface,
    configureCameraForProjection,
  } = useGridScene({
    projectionHelper,
    projectionCenter,
    controlPanelVisible,
    cameraState,
    onReady: () => {
      updateCoastlines();
    },
  });

  const {
    updateCoastlines: updateCoastlinesInternal,
    updateLandSeaMask,
    updateLandSeaMaskProjectionUniforms,
  } = useGridOverlays({
    projectionHelper,
    showCoastLines,
    landSeaMaskChoice,
    landSeaMaskUseTexture,
    getScene,
    redraw,
  });

  updateCoastlines = updateCoastlinesInternal;

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
        updateCoastlines();
        updateLandSeaMask();
        configureCameraForProjection();
      } else if (centerChanged) {
        updateBaseSurface();
        updateCoastlines();
        updateLandSeaMaskProjectionUniforms();
        redraw();
      }
    },
    { deep: true, flush: "sync" }
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
    for (const dim of dimensionRanges) {
      if (dim?.name === "time") {
        const timeInfo = await getTimeInfo(
          datasources,
          dimensionRanges,
          dimSlidersValues[0] as number
        );
        array.push(timeInfo);
      } else {
        const dimInfo = await getDimensionInfo(
          datasources.levels[0].datasources[currentVariable],
          dim!,
          dimSlidersValues[dimensionRanges.indexOf(dim)] as number
        );
        array.push(dimInfo);
      }
    }
    return array;
  }

  const lastHistogramSummary = ref<THistogramSummary | null>(null);

  function getDisplayHistogramBinCount() {
    return posterizeLevels.value > 0 ? posterizeLevels.value : 50;
  }

  function resolveHistogramBounds(min?: number, max?: number) {
    const selectedLow = bounds.value?.low as number | undefined;
    const selectedHigh = bounds.value?.high as number | undefined;
    const hasValidSelectedBounds =
      selectedLow !== undefined &&
      selectedHigh !== undefined &&
      isFinite(selectedLow) &&
      isFinite(selectedHigh) &&
      selectedHigh > selectedLow;

    if (hasValidSelectedBounds) {
      return { low: selectedLow, high: selectedHigh };
    }

    const low = min ?? selectedLow;
    const high = max ?? selectedHigh;
    return { low, high };
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
        getDisplayHistogramBinCount(),
        low,
        high
      );
      store.updateHistogram(histogram);
    }
  }

  // Watch posterizeLevels and recompute histogram with new bin count
  watch(
    () => posterizeLevels.value,
    () => {
      if (lastHistogramSummary.value) {
        const low = bounds.value?.low as number;
        const high = bounds.value?.high as number;
        recomputeHistogramFromSummary(lastHistogramSummary.value, low, high);
      }
    }
  );

  // Watch bounds and recompute histogram with new range
  watch(
    () => bounds.value,
    (newBounds) => {
      if (lastHistogramSummary.value && newBounds) {
        const low = newBounds.low;
        const high = newBounds.high;
        recomputeHistogramFromSummary(lastHistogramSummary.value, low, high);
      }
    },
    { deep: true }
  );

  function updateHistogram(
    data: ArrayLike<number> | THistogramSummary[] | undefined,
    min?: number,
    max?: number,
    missingValue?: number,
    fillValue?: number
  ) {
    if (!data || data.length === 0) {
      store.updateHistogram(undefined);
      lastHistogramSummary.value = null;
      return;
    }

    const { low, high } = resolveHistogramBounds(min, max);

    if (
      low === undefined ||
      high === undefined ||
      !isFinite(low) ||
      !isFinite(high)
    ) {
      store.updateHistogram(undefined);
      lastHistogramSummary.value = null;
      return;
    }
    let summary: THistogramSummary;
    if (isHistogramSummary(data[0])) {
      // Data is already a histogram summary
      summary = mergeHistogramSummaries(
        data as THistogramSummary[],
        low,
        high,
        HISTOGRAM_SUMMARY_BINS
      );
    } else {
      // Filter out missing/fill values and non-finite values

      if (data.length === 0) {
        store.updateHistogram(undefined);
        lastHistogramSummary.value = null;
        return;
      }

      summary = buildHistogramSummary(
        data as ArrayLike<number>,
        low,
        high,
        HISTOGRAM_SUMMARY_BINS,
        fillValue,
        missingValue
      );
    }
    lastHistogramSummary.value = summary;
    recomputeHistogramFromSummary(summary, low, high);
  }

  return {
    getScene,
    getCamera,
    getResizeObserver,
    redraw,
    toggleRotate,
    makeSnapshot,
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
  };
}
