import { storeToRefs } from "pinia";
import type * as THREE from "three";
import { computed, ref, watch } from "vue";
import type * as zarr from "zarrita";

import { useGridCameraState } from "./useGridCameraState.ts";
import { useGridDataAccess } from "./useGridDataAccess.ts";
import { useGridHistogram } from "./useGridHistogram.ts";
import { useGridOverlays } from "./useGridOverlays.ts";
import { useGridScene } from "./useGridScene.ts";

import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import { availableColormaps } from "@/lib/shaders/colormapShaders.ts";
import { getColormapScaleOffset } from "@/lib/shaders/gridShaders.ts";
import type {
  TDimensionRange,
  TSources,
  TDimInfo,
} from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

type TVoidFunction = () => void;
type TAsyncVoidFunction = () => Promise<void>;

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
    hideLowerBound,
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
  const isSceneInMotion = ref(false);

  const projectionChangeCallbacks: TVoidFunction[] = [];
  const motionStateCallbacks: TVoidFunction[] = [];
  const colormapChangeCallbacks: TVoidFunction[] = [];

  function onProjectionChange(callback: TVoidFunction) {
    projectionChangeCallbacks.push(callback);
  }

  function onMotionStateChange(callback: TVoidFunction) {
    motionStateCallbacks.push(callback);
  }

  function onColormapChange(callback: TVoidFunction) {
    colormapChangeCallbacks.push(callback);
  }
  let updateCoastlines: TAsyncVoidFunction = async () => {};
  let updateGraticules: TAsyncVoidFunction = async () => {};

  const {
    canvas,
    box,
    getScene,
    getCamera,
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
    onMotionStateChange: (isInMotion) => {
      isSceneInMotion.value = isInMotion;
      for (const cb of motionStateCallbacks) {
        cb();
      }
    },
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

      for (const cb of projectionChangeCallbacks) {
        cb();
      }
    },
    { deep: true }
  );

  function updateColormap(meshes: (THREE.Mesh | THREE.Points | undefined)[]) {
    if (!meshes) {
      return;
    }
    const low = selection.value?.low as number;
    const high = selection.value?.high as number;
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
      if (material.uniforms.hideBelowValue) {
        material.uniforms.hideBelowValue.value = hideLowerBound.value
          ? low
          : -1e38;
      }
      material.needsUpdate = true;
    }
    redraw();
  }

  watch(
    [
      () => selection.value,
      () => invertColormap.value,
      () => colormap.value,
      () => posterizeLevels.value,
      () => hideLowerBound.value,
    ],
    () => {
      for (const cb of colormapChangeCallbacks) {
        cb();
      }
    }
  );

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

  const { updateHistogram } = useGridHistogram(selection, posterizeLevels);

  return {
    getScene,
    getCamera,
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
    isSceneInMotion,
    onProjectionChange,
    onMotionStateChange,
    onColormapChange,
    canvas,
    box,
    hoveredGeoPoint,
  };
}
