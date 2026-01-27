import { storeToRefs } from "pinia";
import type * as THREE from "three";
import { computed, watch } from "vue";
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
    projectionHelper,
    canvas,
    box,
  };
}
