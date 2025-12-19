import { useEventListener } from "@vueuse/core";
import type { FeatureCollection } from "geojson";
import debounce from "lodash.debounce";
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type Ref,
  type ShallowRef,
} from "vue";
import * as zarr from "zarrita";

import { useUrlParameterStore } from "../store/paramStore.ts";
import { LAND_SEA_MASK_MODES, useGlobeControlStore } from "../store/store.ts";
import {
  availableColormaps,
  calculateColorMapProperties,
} from "../utils/colormapShaders.ts";
import { geojson2geometry } from "../utils/geojson.ts";
import { getLandSeaMask, loadJSON } from "../utils/landSeaMask.ts";
import { useLog } from "../utils/logging.ts";
import { handleKeyDown } from "../utils/OrbitControlsAddOn.ts";
import { ProjectionHelper } from "../utils/projectionUtils.ts";
import { decodeTime } from "../utils/timeHandling.ts";
import {
  CONTROL_PANEL_WIDTH,
  MOBILE_BREAKPOINT,
} from "../utils/viewConstants.ts";
import { ZarrDataManager } from "../utils/ZarrDataManager.ts";

import type {
  TDimensionRange,
  TSources,
  TTimeInfo,
} from "@/types/GlobeTypes.ts";

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
  } = storeToRefs(store);

  const urlParameterStore = useUrlParameterStore();
  const { paramCameraState } = storeToRefs(urlParameterStore);

  const { logError } = useLog();
  const datavars: ShallowRef<
    Record<string, zarr.Array<zarr.DataType, zarr.FetchStore>>
  > = shallowRef({});

  const canvas: Ref<HTMLCanvasElement | undefined> = ref();
  const box: Ref<HTMLDivElement | undefined> = ref();
  let coast: THREE.LineSegments | undefined = undefined;
  let landSeaMask: THREE.Object3D | undefined = undefined;
  let scene: THREE.Scene | undefined = undefined;
  let camera: THREE.PerspectiveCamera | undefined = undefined;
  let renderer: THREE.WebGLRenderer | undefined = undefined;
  let orbitControls: OrbitControls | undefined = undefined;
  let resizeObserver: ResizeObserver | undefined = undefined;
  const width: Ref<number | undefined> = ref(undefined);
  const height: Ref<number | undefined> = ref(undefined);
  let updateLOD: (() => void) | undefined = undefined;
  let mouseDown = false;
  const frameId = ref(0);
  let baseSurface: THREE.Mesh | undefined = undefined;
  const longitudeDomain = ref({ min: -180, max: 180 });
  const latitudeDomain = ref({ min: -90, max: 90 });

  const projectionHelper = computed(() => {
    return new ProjectionHelper(
      projectionMode.value,
      { lat: 0, lon: 0 },
      {
        longitudeDomain: longitudeDomain.value,
      }
    );
  });

  watch(
    () => showCoastLines.value,
    () => {
      updateCoastlines();
    }
  );

  // Watch for control panel visibility changes and trigger resize
  watch(
    () => controlPanelVisible.value,
    () => {
      updateCameraForPanel();
    }
  );

  watch(
    [() => landSeaMaskChoice.value, () => landSeaMaskUseTexture.value],
    () => {
      updateLandSeaMask();
    }
  );

  watch(
    () => projectionHelper.value,
    () => {
      updateBaseSurface();
      updateCoastlines();
      updateLandSeaMask();
      configureCameraForProjection();
    }
  );

  const bounds = computed(() => {
    return selection.value;
  });

  function getCoast() {
    return coast;
  }

  function registerUpdateLOD(func: () => void) {
    updateLOD = func;
  }

  function getScene() {
    return scene;
  }

  function getCamera() {
    return camera;
  }

  function getRenderer() {
    return renderer;
  }

  function getOrbitControls() {
    return orbitControls;
  }

  function getResizeObserver() {
    return resizeObserver;
  }

  function resetDataVars() {
    datavars.value = {};
  }

  function setResizeObserver(observer: ResizeObserver) {
    resizeObserver = observer;
  }
  function redraw() {
    if (getOrbitControls()?.autoRotate) {
      return;
    }
    render();
  }

  function render() {
    if (updateLOD) {
      updateLOD();
    }
    getOrbitControls()?.update();
    getRenderer()?.render(getScene()!, getCamera()!);
  }

  let coastlineData: FeatureCollection | undefined;

  async function getCoastlines() {
    if (!coastlineData) {
      coastlineData = await loadJSON("static/ne_50m_coastline.geojson");
    }
    if (!coast) {
      const material = new THREE.LineBasicMaterial({
        color: "#ffffff",
      });
      coast = new THREE.LineSegments(new THREE.BufferGeometry(), material);
      coast.name = "coastlines";
    }
    const geometry = geojson2geometry(coastlineData, projectionHelper.value, {
      radius: projectionHelper.value.isFlat ? 1 : 1.002,
      zOffset: projectionHelper.value.isFlat ? 0.002 : 0,
    });
    coast.geometry.dispose();
    coast.geometry = geometry;
    return coast;
  }

  async function updateCoastlines() {
    if (!scene) {
      return;
    }
    if (showCoastLines.value === false) {
      if (getCoast()) {
        scene?.remove(getCoast()!);
      }
    } else {
      scene?.add(await getCoastlines());
    }
    redraw();
  }

  async function updateLandSeaMask() {
    const choice = landSeaMaskChoice.value ?? LAND_SEA_MASK_MODES.OFF;
    if (landSeaMask) {
      scene?.remove(landSeaMask);
      landSeaMask = undefined;
    }
    if (choice === LAND_SEA_MASK_MODES.OFF) {
      redraw();
      return;
    }

    const projectionBounds = getProjectedBounds();
    const mask = await getLandSeaMask(
      landSeaMaskChoice.value!,
      landSeaMaskUseTexture.value!,
      projectionHelper.value,
      projectionBounds
    );
    landSeaMask = mask;
    if (landSeaMask) {
      scene?.add(landSeaMask);
    }
    redraw();
  }

  function updateColormap(meshes: (THREE.Mesh | THREE.Points | undefined)[]) {
    if (!meshes) {
      return;
    }
    const low = bounds.value?.low as number;
    const high = bounds.value?.high as number;
    const { addOffset, scaleFactor } = calculateColorMapProperties(
      low,
      high,
      invertColormap.value
    );

    for (const myMesh of meshes) {
      if (!myMesh) {
        continue;
      }
      const material = myMesh!.material as THREE.ShaderMaterial;
      material.uniforms.colormap.value = availableColormaps[colormap.value];
      material.uniforms.addOffset.value = addOffset;
      material.uniforms.scaleFactor.value = scaleFactor;
      material.needsUpdate = true;
    }
    redraw();
  }

  function getProjectedBounds() {
    const helper = projectionHelper.value;
    const latMin = latitudeDomain.value.min ?? -90;
    const latMax = latitudeDomain.value.max ?? 90;
    const lonMin = longitudeDomain.value.min ?? -180;
    const lonMax = longitudeDomain.value.max ?? 180;
    const latRange = latMax - latMin;
    const lonRange = lonMax - lonMin;
    const latSteps = Math.max(8, Math.ceil(latRange / 10));
    const lonSteps = Math.max(16, Math.ceil(lonRange / 10));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i <= latSteps; i++) {
      const lat = latRange === 0 ? latMin : latMin + (i / latSteps) * latRange;
      for (let j = 0; j <= lonSteps; j++) {
        const lon =
          lonRange === 0 ? lonMin : lonMin + (j / lonSteps) * lonRange;
        const [x, y] = helper.project(lat, helper.normalizeLongitude(lon));
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    return {
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
      centerX,
      centerY,
      minLat: latMin,
      maxLat: latMax,
      minLon: lonMin,
      maxLon: lonMax,
    };
  }

  function updateBaseSurface() {
    if (!scene) {
      return;
    }
    if (baseSurface) {
      scene.remove(baseSurface);
      baseSurface.geometry.dispose();
      (baseSurface.material as THREE.Material).dispose();
      baseSurface = undefined;
    }
    if (projectionHelper.value.isFlat) {
      const bounds = getProjectedBounds();
      const width = Math.max(bounds.width, 1);
      const height = Math.max(bounds.height, 1);
      const geometry = new THREE.PlaneGeometry(width * 1.05, height * 1.05);
      const material = new THREE.MeshBasicMaterial({
        color: 0x000000,
        side: THREE.DoubleSide,
      });
      baseSurface = new THREE.Mesh(geometry, material);
      baseSurface.position.set(bounds.centerX, bounds.centerY, -0.05);
    } else {
      const geometry = new THREE.SphereGeometry(0.99, 64, 64);
      const material = new THREE.MeshBasicMaterial({ color: 0x000000 });
      baseSurface = new THREE.Mesh(geometry, material);
      baseSurface.rotation.x = Math.PI / 2;
    }
    scene.add(baseSurface);
  }

  function configureCameraForProjection() {
    const cam = getCamera();
    const controls = getOrbitControls();
    if (!cam || !controls) {
      return;
    }
    if (projectionHelper.value.isFlat) {
      const bounds = getProjectedBounds();
      const targetDistance =
        Math.max(bounds.height, bounds.width) /
        2 /
        Math.tan(((cam.fov ?? 45) * Math.PI) / 360);
      cam.position.set(
        bounds.centerX,
        bounds.centerY,
        Math.max(targetDistance * 1.1, 3)
      );
      cam.up.set(0, 1, 0);
      controls.enablePan = true;
      controls.enableRotate = false;
      controls.minDistance = 1;
      controls.maxDistance = 200;
      controls.target.set(bounds.centerX, bounds.centerY, 0);
    } else {
      cam.up.set(0, 0, 1);
      controls.enablePan = false;
      controls.enableRotate = true;
      controls.minDistance = 1.1;
      controls.maxDistance = 1000;
      if (cam.position.length() < 2) {
        cam.position.set(30, 0, 0);
      }
      controls.target.set(0, 0, 0);
    }
    const target = controls.target.clone();
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    controls.update();
    redraw();
  }

  function initEssentials() {
    // from: https://stackoverflow.com/a/65732553
    scene = new THREE.Scene();
    const center = new THREE.Vector3();
    camera = new THREE.PerspectiveCamera(
      7.5,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    renderer = new THREE.WebGLRenderer({ canvas: canvas.value });

    if (paramCameraState.value === undefined) {
      camera.up = new THREE.Vector3(0, 0, 1);
      camera.position.x = 30;
      camera.lookAt(center);
    } else {
      camera.up = new THREE.Vector3(0, 0, 1);
      camera.position.x = 30;
      camera.lookAt(center);
      const state = decodeCameraFromURL();
      if (state) {
        applyCameraState(camera, state);
      }
    }

    orbitControls = new OrbitControls(camera, renderer.domElement);
    // smaller minDistances than 1.1 will reveal the naked mesh
    // under the texture when zoomed in
    orbitControls.minDistance = 1.1;
    orbitControls.enablePan = false;

    updateBaseSurface();
    configureCameraForProjection();
    updateCoastlines();
  }

  let init = true;
  let currentOffset = 0;
  let targetOffset = 0;

  function updateCameraForPanel() {
    const camera = getCamera();
    if (!camera || !box.value) return;

    const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
    const panelWidth =
      !isMobile && controlPanelVisible.value ? CONTROL_PANEL_WIDTH : 0;
    const { width: boxWidth } = box.value.getBoundingClientRect();

    // Calculate target offset
    targetOffset = panelWidth > 0 ? panelWidth / boxWidth / 2 : 0;
    currentOffset = init ? targetOffset : currentOffset;
    init = false;

    animateCamera();
  }

  function animateCamera() {
    const camera = getCamera();
    if (!camera || !box.value) {
      return;
    }

    currentOffset = THREE.MathUtils.lerp(currentOffset, targetOffset, 0.1);

    // Stop animation when close enough
    if (Math.abs(targetOffset - currentOffset) < 0.001) {
      currentOffset = targetOffset;
    }

    // Apply the projection matrix with current offset
    const aspect = camera.aspect;
    const fov = (camera.fov * Math.PI) / 180;
    const near = camera.near;
    const far = camera.far;

    const top = near * Math.tan(fov / 2);
    const bottom = -top;
    const right = top * aspect;
    const left = -right;

    const shiftAmount = (right - left) * currentOffset;
    const shiftedLeft = left - shiftAmount;
    const shiftedRight = right - shiftAmount;

    camera.projectionMatrix.makePerspective(
      shiftedLeft,
      shiftedRight,
      top,
      bottom,
      near,
      far
    );

    redraw();

    // Continue animation
    if (currentOffset !== targetOffset) {
      requestAnimationFrame(animateCamera);
    }
  }

  function onCanvasResize() {
    if (!box.value) {
      return;
    }
    const { width: boxWidth, height: boxHeight } =
      box.value.getBoundingClientRect();

    if (boxWidth !== width.value || boxHeight !== height.value) {
      getResizeObserver()?.unobserve(box.value);

      const aspect = boxWidth / boxHeight;
      getCamera()!.aspect = aspect;
      getCamera()!.updateProjectionMatrix();

      const myRenderer = getRenderer() as THREE.WebGLRenderer;
      if (myRenderer) {
        myRenderer.setSize(boxWidth, boxHeight);
      }

      width.value = boxWidth;
      height.value = boxHeight;

      // Update camera offset for panel
      updateCameraForPanel();

      redraw();

      if (box.value) {
        getResizeObserver()!.observe(box.value);
      }
    }
  }

  function toggleRotate() {
    if (projectionHelper.value.isFlat) {
      getOrbitControls()!.autoRotate = false;
      return;
    }
    getOrbitControls()!.autoRotate = !getOrbitControls()!.autoRotate;
    animationLoop();
  }

  function animationLoop() {
    cancelAnimationFrame(frameId.value);
    if (!mouseDown && !getOrbitControls()?.autoRotate) {
      render();
      debouncedEncodeCameraToURL(getCamera()!);
      return;
    }
    render();
    frameId.value = requestAnimationFrame(animationLoop);
  }

  onMounted(() => {
    mouseDown = false;
    useEventListener(
      canvas.value,
      "wheel",
      () => {
        mouseDown = true;
        animationLoop();
        mouseDown = false;
      },
      { passive: true }
    );

    useEventListener(
      canvas.value,
      "mouseup",
      () => {
        mouseDown = false;
      },
      { passive: true }
    );

    useEventListener(
      canvas.value,
      "mousedown",
      () => {
        mouseDown = true;
        animationLoop();
      },
      { passive: true }
    );

    useEventListener(
      canvas.value,
      "touchstart",
      () => {
        mouseDown = true;
        animationLoop();
      },
      { passive: true }
    );

    useEventListener(
      canvas.value,
      "touchend",
      () => {
        mouseDown = false;
      },
      { passive: true }
    );

    useEventListener(box.value, "keydown", (e: KeyboardEvent) => {
      if (
        e.key === "ArrowRight" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "+" ||
        e.key === "-"
      ) {
        mouseDown = true;
        handleKeyDown(e, getOrbitControls()!);
        animationLoop();
        mouseDown = false;
      }
    });

    initEssentials();
    setResizeObserver(new ResizeObserver(onCanvasResize));
    getResizeObserver()?.observe(box.value!);
  });

  onBeforeUnmount(() => {
    scene?.clear();
    camera?.clear();
    renderer?.dispose();
    if (box.value) {
      getResizeObserver()?.unobserve(box.value!);
    }
    scene = undefined;
    renderer = undefined;
    camera = undefined;
  });

  function makeSnapshot() {
    render();
    canvas.value?.toBlob((blob) => {
      const link = document.createElement("a");
      link.download = "gridlook.png";

      link.href = URL.createObjectURL(blob!);
      link.click();

      // delete the internal blob reference, to let the browser clear memory from it
      URL.revokeObjectURL(link.href);
    }, "image/png");
  }

  async function getDataVar(myVarname: string, datasources: TSources) {
    const myDatasource = datasources!.levels[0].datasources[myVarname];
    try {
      const datavar = await ZarrDataManager.getVariableInfoByDatasetSources(
        datasources!,
        myVarname
      );
      return datavar;
    } catch (error) {
      logError(
        error,
        `Couldn't fetch variable ${myVarname} from store: ${myDatasource.store} and dataset: ${myDatasource.dataset}`
      );
      return undefined;
    }
  }

  async function getTimeInfo(
    datasources: TSources,
    dimensionRanges: TDimensionRange[],
    index: number
  ): Promise<TTimeInfo> {
    if (dimensionRanges[0]?.name !== "time") {
      return {};
    }
    const myDatasource = datasources!.levels[0].time;
    const timevar = await ZarrDataManager.getVariableInfo(myDatasource, "time");
    const timevalues = (
      await ZarrDataManager.getVariableData(myDatasource, "time", [null])
    ).data as Int32Array;
    return {
      values: timevalues,
      current: decodeTime(timevalues[index], timevar.attrs),
    };
  }

  type TCameraState = {
    position: number[];
    quaternion: number[];
    fov: number;
    aspect: number;
    near: number;
    far: number;
  };

  const debouncedEncodeCameraToURL = debounce(
    (camera: THREE.PerspectiveCamera) => {
      encodeCameraToURL(camera);
    },
    300
  );

  function encodeCameraToURL(camera: THREE.PerspectiveCamera) {
    // Encodes the camera state to the URL parameters.
    // This function is getting called at the end of each render loop.
    const state: TCameraState = {
      position: camera.position.toArray(),
      quaternion: camera.quaternion.toArray(),
      fov: camera.fov,
      aspect: camera.aspect,
      near: camera.near,
      far: camera.far,
    };

    // Stringify and Base64-encode (URL-safe)
    const json = JSON.stringify(state);
    const encoded = btoa(json)
      .replace(/\+/g, "-") // URL-safe base64
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    paramCameraState.value = encoded;
  }

  function decodeCameraFromURL(): TCameraState | null {
    // Decodes the camera state from the URL parameters.
    // This function is getting called during initialization of the globe,
    // when a camera state is found in the URL parameters.
    const encoded = paramCameraState.value;
    if (!encoded) return null;

    try {
      const json = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
      return JSON.parse(json);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (ignore) {
      return null;
    }
  }

  function applyCameraState(
    camera: THREE.PerspectiveCamera,
    data: TCameraState
  ) {
    // Applies a camera state to the camera.
    // This function is getting called during initialization of the globe,
    // when a camera state is found in the URL parameters.
    if (!data) return;

    if (data.position && data.position.length === 3) {
      camera.position.fromArray(data.position);
    }

    if (data.quaternion && data.quaternion.length === 4) {
      camera.quaternion.fromArray(data.quaternion);
    }

    if (typeof data.fov === "number") {
      camera.fov = data.fov;
    }

    if (typeof data.aspect === "number") {
      camera.aspect = data.aspect;
    }

    if (typeof data.near === "number") {
      camera.near = data.near;
    }

    if (typeof data.far === "number") {
      camera.far = data.far;
    }

    camera.updateProjectionMatrix();
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
    getTimeInfo,
    registerUpdateLOD,
    updateLandSeaMask,
    updateColormap,
    projectionHelper,
    canvas,
    box,
  };
}
