import { useEventListener } from "@vueuse/core";
import * as d3 from "d3-geo";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import {
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";

import type { THoverGeoPoint } from "./gridHoverUtils.ts";
import type { GridCameraState, TCameraState } from "./useGridCameraState.ts";
import { useGridSnapshot } from "./useGridSnapshot.ts";

import { handleKeyDown } from "@/lib/camera/OrbitControlsAddOn.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
  type TProjectionCenter,
} from "@/lib/projection/projectionUtils.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { isDisplayMode, isPresenterActive } from "@/store/usePresenterSync";
import {
  CONTROL_PANEL_WIDTH,
  MOBILE_BREAKPOINT,
} from "@/ui/common/viewConstants.ts";

type UseGridSceneOptions = {
  projectionHelper: ComputedRef<ProjectionHelper>;
  projectionCenter: Ref<TProjectionCenter | undefined>;
  controlPanelVisible: Ref<boolean>;
  cameraState: GridCameraState;
  onReady?: () => void | Promise<void>;
};

/* eslint-disable-next-line max-lines-per-function */
export function useGridScene(options: UseGridSceneOptions) {
  const {
    projectionHelper,
    projectionCenter,
    controlPanelVisible,
    cameraState,
    onReady,
  } = options;

  const store = useGlobeControlStore();
  const urlParameterStore = useUrlParameterStore();

  const canvas: Ref<HTMLCanvasElement | undefined> = ref();
  const box: Ref<HTMLDivElement | undefined> = ref();
  const width: Ref<number | undefined> = ref(undefined);
  const height: Ref<number | undefined> = ref(undefined);
  const frameId = ref(0);

  let scene: THREE.Scene | undefined = undefined;
  let camera: THREE.PerspectiveCamera | undefined = undefined;
  let renderer: THREE.WebGLRenderer | undefined = undefined;
  let orbitControls: OrbitControls | undefined = undefined;
  let resizeObserver: ResizeObserver | undefined = undefined;
  let updateLOD: (() => void) | undefined = undefined;
  let baseSurface: THREE.Mesh | undefined = undefined;
  let pickSurface: THREE.Mesh | undefined = undefined;
  let mouseDown = false;
  const raycaster = new THREE.Raycaster();
  const hoveredGeoPoint = shallowRef<THoverGeoPoint | null>(null);
  let lastPointerPosition: { clientX: number; clientY: number } | null = null;

  let projectionDragActive = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartCenterLon = 0;
  let dragStartCenterLat = 0;

  let init = true;
  let currentOffset = 0;
  // Counts consecutive frames where OrbitControls reported no camera change.
  // The loop keeps running until this reaches IDLE_FRAMES_BEFORE_STOP so that
  // the damping delta in OrbitControls is fully drained to zero before we
  // stop calling update(). Without this, residual velocity would be applied
  // the next time anything triggers a render (click, bounds change, etc.).
  let idleFrameCount = 0;
  const IDLE_FRAMES_BEFORE_STOP = 30; // ~500 ms at 60 fps – outlasts any realistic damping
  let targetOffset = 0;
  let isInitialLoad = true;

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

  function getBaseSurface() {
    return baseSurface;
  }

  function registerUpdateLOD(func: () => void) {
    updateLOD = func;
  }

  function setResizeObserver(observer: ResizeObserver) {
    resizeObserver = observer;
  }

  function redraw() {
    if (store.isRotating) {
      return;
    }
    render();
  }

  function render() {
    if (updateLOD) {
      updateLOD();
    }
    const controlsUpdated = getOrbitControls()?.update() ?? false;
    getRenderer()?.render(getScene()!, getCamera()!);
    return controlsUpdated;
  }

  function invertFlatProjection(intersection: THREE.Intersection) {
    const projection = projectionHelper.value.getD3Projection();
    const inverted = projection?.invert?.([
      intersection.point.x,
      -intersection.point.y,
    ]);
    if (
      !inverted ||
      !Number.isFinite(inverted[0]) ||
      !Number.isFinite(inverted[1])
    ) {
      return null;
    }

    const [lon, lat] = inverted;
    const [projectedX, projectedY] = projectionHelper.value.project(lat, lon);
    if (
      !Number.isFinite(projectedX) ||
      !Number.isFinite(projectedY) ||
      Math.abs(projectedX - intersection.point.x) > 1e-3 ||
      Math.abs(projectedY - intersection.point.y) > 1e-3
    ) {
      return null;
    }

    return { lat, lon: ProjectionHelper.normalizeLongitude(lon) };
  }

  function getHoveredGeoPoint(clientX: number, clientY: number) {
    if (!canvas.value || !camera || !pickSurface) {
      return null;
    }

    const rect = canvas.value.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(pointer, camera);

    const [intersection] = raycaster.intersectObject(pickSurface, false);
    if (!intersection) {
      return null;
    }

    if (!projectionHelper.value.isFlat) {
      const { lat, lon } = ProjectionHelper.cartesianToLatLon(
        intersection.point.x,
        intersection.point.y,
        intersection.point.z
      );
      return { lat, lon, screenX: clientX, screenY: clientY };
    }

    const geo = invertFlatProjection(intersection);
    if (!geo) {
      return null;
    }
    return { ...geo, screenX: clientX, screenY: clientY };
  }

  function isHoverActive() {
    return (
      store.hoverEnabled &&
      projectionHelper.value.type !== PROJECTION_TYPES.AZIMUTHAL_HYBRID
    );
  }

  function refreshHover() {
    if (!isHoverActive()) {
      hoveredGeoPoint.value = null;
      return;
    }

    if (!lastPointerPosition) {
      hoveredGeoPoint.value = null;
      return;
    }

    hoveredGeoPoint.value = getHoveredGeoPoint(
      lastPointerPosition.clientX,
      lastPointerPosition.clientY
    );
  }

  function getProjectedBounds() {
    const helper = projectionHelper.value;

    if (!helper.isFlat) {
      return {
        minX: -Math.PI,
        maxX: Math.PI,
        minY: -Math.PI / 2,
        maxY: Math.PI / 2,
        width: 2 * Math.PI,
        height: Math.PI,
        centerX: 0,
        centerY: 0,
      };
    }

    const projection = helper.getD3Projection();
    const path = d3.geoPath(projection);

    const [[minX, minY], [maxX, maxY]] = path.bounds({ type: "Sphere" });

    return {
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
    };
  }

  function cleanupSurface(mesh: THREE.Mesh | undefined) {
    if (!scene || !mesh) {
      return;
    }
    scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  function makePickMaterial(doubleSided = false) {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    material.depthWrite = false;
    material.colorWrite = false;
    return material;
  }

  function createFlatSurfaces() {
    const bounds = getProjectedBounds();
    const width = Math.max(bounds.width, 1);
    const height = Math.max(bounds.height, 1);
    const scaledWidth = width * 1.05;
    const scaledHeight = height * 1.05;

    baseSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(scaledWidth, scaledHeight),
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide })
    );
    baseSurface.position.set(bounds.centerX, bounds.centerY, -0.05);

    pickSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(scaledWidth, scaledHeight),
      makePickMaterial(true)
    );
    pickSurface.position.set(bounds.centerX, bounds.centerY, 0);
  }

  function createGlobeSurfaces() {
    baseSurface = new THREE.Mesh(
      new THREE.SphereGeometry(0.99, 64, 64),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    baseSurface.rotation.x = Math.PI / 2;

    pickSurface = new THREE.Mesh(
      new THREE.SphereGeometry(1.0, 64, 64),
      makePickMaterial()
    );
    pickSurface.rotation.x = Math.PI / 2;
  }

  function updateBaseSurface() {
    if (!scene) {
      return;
    }

    cleanupSurface(baseSurface);
    cleanupSurface(pickSurface);
    baseSurface = undefined;
    pickSurface = undefined;

    if (projectionHelper.value.isFlat) {
      createFlatSurfaces();
    } else {
      createGlobeSurfaces();
    }

    if (baseSurface) {
      scene.add(baseSurface);
    }
    if (pickSurface) {
      scene.add(pickSurface);
    }
  }

  function configureFlatProjectionCamera(
    cam: THREE.PerspectiveCamera,
    controls: OrbitControls
  ) {
    const bounds = getProjectedBounds();

    // Compute the tightest distance that keeps the full projection visible,
    // accounting for the camera aspect ratio.
    const vHalfFov = THREE.MathUtils.degToRad((cam.fov ?? 45) / 2);
    const hHalfFov = Math.atan(Math.tan(vHalfFov) * cam.aspect);
    const zForHeight = bounds.height / 2 / Math.tan(vHalfFov);
    const zForWidth = bounds.width / 2 / Math.tan(hHalfFov);
    const targetDistance = Math.max(zForHeight, zForWidth);

    cam.up.set(0, 1, 0);
    cam.quaternion.identity();
    cam.rotation.set(0, 0, 0);

    cam.near = 0.005;
    cam.far = 200;
    cam.updateProjectionMatrix();

    cam.position.set(
      bounds.centerX,
      bounds.centerY,
      Math.max(targetDistance * 1.1, 3)
    );
    controls.target.set(bounds.centerX, bounds.centerY, 0);

    controls.enablePan = true;
    controls.enableRotate = false;
    controls.enableDamping = false;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    controls.minDistance = 0.1;
    controls.maxDistance = 200;
  }

  function configureGlobeProjectionCamera(
    cam: THREE.PerspectiveCamera,
    controls: OrbitControls
  ) {
    // Compute the tightest distance at which the globe (radius 1) still fits
    // fully within the viewport on both axes, with a small 5 % margin.
    const vHalfFov = THREE.MathUtils.degToRad((cam.fov ?? 7.5) / 2);
    const hHalfFov = Math.atan(Math.tan(vHalfFov) * cam.aspect);
    const minHalfFov = Math.min(vHalfFov, hHalfFov);
    const targetDistance = 1.05 / Math.sin(minHalfFov);

    cam.up.set(0, 0, 1);
    controls.enablePan = false;
    controls.enableRotate = true;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.minDistance = 1.1;
    controls.maxDistance = 1000;
    cam.position.set(targetDistance, 0, 0);
    controls.target.set(0, 0, 0);
  }

  function applyCameraTarget(
    cam: THREE.PerspectiveCamera,
    controls: OrbitControls
  ) {
    const target = controls.target.clone();
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    controls.update();
  }

  function syncCameraStateWithUrl(
    cam: THREE.PerspectiveCamera,
    controls: OrbitControls
  ) {
    if (isInitialLoad) {
      const state = cameraState.decodeCameraFromURL();
      if (state) {
        cameraState.applyCameraState(cam, state);
        if (projectionHelper.value.isFlat) {
          controls.target.set(cam.position.x, cam.position.y, 0);
        }
        controls.update();
      }
      isInitialLoad = false;
      return;
    }

    cameraState.encodeCameraToURL(cam);
  }

  function configureCameraForProjection() {
    const cam = getCamera();
    const controls = getOrbitControls();
    if (!cam || !controls) {
      return;
    }

    if (projectionHelper.value.isFlat) {
      configureFlatProjectionCamera(cam, controls);
      controls.autoRotate = false;
    } else {
      configureGlobeProjectionCamera(cam, controls);
      controls.autoRotate = store.isRotating;
    }

    applyCameraTarget(cam, controls);
    syncCameraStateWithUrl(cam, controls);

    // In display mode, disable all direct interaction after camera is set up
    if (isDisplayMode.value) {
      controls.enabled = false;
    }

    updateCameraForPanel();
    redraw();

    if (store.isRotating) {
      animationLoop();
    }
  }

  // set the camera from external preset (e.g. presenter sync) and apply to controls
  function applyCameraPreset(data: TCameraState) {
    const cam = getCamera();
    const controls = getOrbitControls();
    if (!cam || !controls) {
      return;
    }

    cameraState.applyCameraState(cam, data);
    if (projectionHelper.value.isFlat) {
      controls.target.set(cam.position.x, cam.position.y, 0);
    } else {
      controls.target.set(0, 0, 0);
    }
    controls.update();
    cameraState.encodeCameraToURL(cam);
    redraw();
  }

  function initEssentials() {
    scene = new THREE.Scene();
    const center = new THREE.Vector3();
    camera = new THREE.PerspectiveCamera(
      7.5,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    renderer = new THREE.WebGLRenderer({
      canvas: canvas.value,
      powerPreference: "high-performance",
    });

    camera.up = new THREE.Vector3(0, 0, 1);
    camera.position.x = 30;
    camera.lookAt(center);

    orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.minDistance = 1.1;
    orbitControls.enablePan = false;

    updateBaseSurface();
    configureCameraForProjection();
  }

  function updateCameraForPanel() {
    const camera = getCamera();
    if (!camera || !box.value) {
      return;
    }

    const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
    const panelWidth =
      !isMobile && controlPanelVisible.value ? CONTROL_PANEL_WIDTH : 0;
    const { width: boxWidth } = box.value.getBoundingClientRect();

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

    if (Math.abs(targetOffset - currentOffset) < 0.001) {
      currentOffset = targetOffset;
    }

    const aspect = camera.aspect;
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const near = camera.near;
    const far = camera.far;

    const top = near * Math.tan(fov / 2);
    const bottom = -top;
    const right = top * aspect;
    const left = -right;

    camera.projectionMatrix.makePerspective(
      left,
      right,
      top,
      bottom,
      near,
      far
    );

    redraw();

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

      updateCameraForPanel();
      redraw();

      if (box.value) {
        getResizeObserver()!.observe(box.value);
      }
    }
  }

  function startProjectionDrag(clientX: number, clientY: number) {
    if (!projectionHelper.value.isFlat || isDisplayMode.value) {
      return false;
    }
    projectionDragActive = true;
    dragStartX = clientX;
    dragStartY = clientY;
    const center = projectionCenter.value ?? { lat: 0, lon: 0 };
    dragStartCenterLon = center.lon;
    dragStartCenterLat = center.lat;
    return true;
  }

  function updateProjectionDrag(clientX: number, clientY: number) {
    if (!projectionDragActive || !projectionHelper.value.isFlat) {
      return;
    }

    const deltaX = clientX - dragStartX;
    const deltaY = clientY - dragStartY;

    const canvasWidth = width.value ?? 800;
    const canvasHeight = height.value ?? 600;

    const lonSensitivity = 180 / canvasWidth;
    const latSensitivity = 90 / canvasHeight;

    let newLon = dragStartCenterLon + deltaX * lonSensitivity;
    let newLat = dragStartCenterLat - deltaY * latSensitivity;

    newLat = Math.round(Math.max(-90, Math.min(90, newLat)) * 100) / 100;
    newLon =
      Math.round(ProjectionHelper.normalizeLongitude(newLon) * 100) / 100;

    projectionCenter.value = { lat: newLat, lon: newLon };
  }

  function handleRightMouseDown(event: MouseEvent) {
    if (event.button !== 2) {
      return;
    }
    if (startProjectionDrag(event.clientX, event.clientY)) {
      event.preventDefault();
    }
  }

  function handleRightMouseMove(event: MouseEvent) {
    if (projectionDragActive) {
      event.preventDefault();
      updateProjectionDrag(event.clientX, event.clientY);
    }
  }

  function toggleRotate() {
    store.toggleRotating();
    if (!projectionHelper.value.isFlat) {
      getOrbitControls()!.autoRotate = store.isRotating;
    }
    animationLoop();
  }

  function animationLoop() {
    cancelAnimationFrame(frameId.value);

    // Rotate 2D projection center longitude
    if (store.isRotating && projectionHelper.value.isFlat) {
      const center = projectionCenter.value ?? { lat: 0, lon: 0 };
      const newLon = ProjectionHelper.normalizeLongitude(center.lon - 0.3);
      projectionCenter.value = { lat: center.lat, lon: newLon };
    }

    // Update rotation speed based on camera distance
    if (!projectionHelper.value.isFlat && orbitControls && camera) {
      const distance = camera.position.length();
      const normalizedDistance = distance / 30;
      orbitControls.rotateSpeed = Math.min(1, 0.01 + normalizedDistance ** 2);
    }

    const controlsUpdated = render();
    if (lastPointerPosition) {
      refreshHover();
    }
    const cam = getCamera();
    if (!mouseDown && !store.isRotating) {
      if (controlsUpdated) {
        // Controls are still moving (damping draining) – reset idle counter.
        idleFrameCount = 0;
      } else {
        idleFrameCount++;
      }
      if (idleFrameCount >= IDLE_FRAMES_BEFORE_STOP) {
        // Damping is fully drained – safe to stop the loop.
        idleFrameCount = 0;
        if (cam) {
          cameraState.debouncedEncodeCameraToURL(cam);
        }
        return;
      }
    } else {
      idleFrameCount = 0;
      if (isPresenterActive.value && cam) {
        cameraState.encodeCameraToURL(cam);
      }
    }
    frameId.value = requestAnimationFrame(animationLoop);
  }

  function onInteractionStart() {
    mouseDown = true;
    idleFrameCount = 0;
    animationLoop();
  }

  function onInteractionEnd() {
    mouseDown = false;
    animationLoop();
  }

  function setupHoverListeners() {
    useEventListener(
      canvas.value,
      "mousemove",
      (event: MouseEvent) => {
        if (!isHoverActive()) {
          return;
        }
        lastPointerPosition = {
          clientX: event.clientX,
          clientY: event.clientY,
        };
        refreshHover();
      },
      { passive: true }
    );

    useEventListener(
      canvas.value,
      "mouseleave",
      () => {
        lastPointerPosition = null;
        hoveredGeoPoint.value = null;
      },
      { passive: true }
    );
  }

  function setupInteractionListeners() {
    setupHoverListeners();

    useEventListener(
      canvas.value,
      "wheel",
      () => {
        onInteractionStart();
        onInteractionEnd();
      },
      { passive: true }
    );

    useEventListener(canvas.value, "mouseup", onInteractionEnd, {
      passive: true,
    });
    useEventListener(canvas.value, "mousedown", onInteractionStart, {
      passive: true,
    });
    useEventListener(canvas.value, "touchstart", onInteractionStart, {
      passive: true,
    });
    useEventListener(canvas.value, "touchend", onInteractionEnd, {
      passive: true,
    });
  }

  // Setup right-click drag listeners for projection center adjustment
  function setupRightClickListeners() {
    useEventListener(
      canvas.value,
      "mousedown",
      (e: MouseEvent) => {
        if (e.button === 2) {
          handleRightMouseDown(e);
        }
      },
      { passive: false }
    );

    useEventListener(
      canvas.value,
      "mousemove",
      (e: MouseEvent) => {
        if (projectionDragActive) {
          handleRightMouseMove(e);
        }
      },
      { passive: false }
    );

    useEventListener(
      canvas.value,
      "mouseup",
      (e: MouseEvent) => {
        if (e.button === 2) {
          projectionDragActive = false;
        }
      },
      { passive: false }
    );
  }

  // Setup touch drag listeners for projection center adjustment
  function setupTouchProjectionListeners() {
    useEventListener(
      canvas.value,
      "touchstart",
      (e: TouchEvent) => {
        const shouldPrevent =
          e.touches.length === 1 &&
          startProjectionDrag(e.touches[0].clientX, e.touches[0].clientY);
        if (shouldPrevent) {
          e.preventDefault();
        }
      },
      { passive: false }
    );

    useEventListener(
      canvas.value,
      "touchmove",
      (e: TouchEvent) => {
        if (e.touches.length === 1 && projectionDragActive) {
          e.preventDefault();
          updateProjectionDrag(e.touches[0].clientX, e.touches[0].clientY);
        }
      },
      { passive: false }
    );

    useEventListener(
      canvas.value,
      "touchend",
      () => {
        projectionDragActive = false;
      },
      { passive: false }
    );
  }

  const projectionArrowKeys = [
    "ArrowRight",
    "ArrowLeft",
    "ArrowUp",
    "ArrowDown",
  ];

  // Setup keyboard navigation listeners
  function setupKeyboardListeners() {
    if (isDisplayMode.value) {
      // Disable keyboard navigation in display/presenter mode to avoid
      // interfering with presenter controls
      return;
    }
    useEventListener(box.value, "keydown", (e: KeyboardEvent) => {
      const navigationKeys = [...projectionArrowKeys, "+", "-"];

      if (navigationKeys.includes(e.key)) {
        onInteractionStart();
        handleKeyDown(e, getOrbitControls()!, projectionHelper.value.isFlat);
        onInteractionEnd();
      }
    });
  }

  onMounted(() => {
    mouseDown = false;

    setupInteractionListeners();
    setupRightClickListeners();
    setupTouchProjectionListeners();
    setupKeyboardListeners();

    initEssentials();
    setResizeObserver(new ResizeObserver(onCanvasResize));
    getResizeObserver()?.observe(box.value!);
    void onReady?.();
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

  watch(
    () => controlPanelVisible.value,
    () => {
      updateCameraForPanel();
      refreshHover();
    }
  );

  // Sync rotation when store.isRotating is changed externally (e.g. presenter mode)
  watch(
    () => store.isRotating,
    (rotating) => {
      if (!projectionHelper.value.isFlat) {
        const oc = getOrbitControls();
        if (oc) {
          oc.autoRotate = rotating;
        }
      }
      animationLoop();
    }
  );

  watch(
    () => urlParameterStore.paramCameraState,
    () => {
      // This watcher is only relevant in presenter display mode where camera state is synced via URL.
      // The controller display writes the URL on every camera change, and the
      // display reacts to URL changes by applying the camera state.
      if (!isDisplayMode.value) {
        return;
      }
      const cam = getCamera();
      const controls = getOrbitControls();
      if (!cam || !controls) {
        return;
      }
      const state = cameraState.decodeCameraFromURL();
      if (!state) {
        return;
      }
      cameraState.applyCameraState(cam, state);
      if (projectionHelper.value.isFlat) {
        controls.target.set(cam.position.x, cam.position.y, 0);
      } else {
        controls.target.set(0, 0, 0);
      }
      controls.update();
      redraw();
    }
  );

  watch(
    [() => projectionHelper.value.type, () => projectionCenter.value],
    () => {
      refreshHover();
    },
    { deep: true }
  );

  watch(
    () => store.hoverEnabled,
    (enabled) => {
      if (!enabled) {
        hoveredGeoPoint.value = null;
        return;
      }
      refreshHover();
    }
  );

  const { makeSnapshot } = useGridSnapshot({
    canvas,
    getRenderer,
    getScene,
    getCamera,
    getBaseSurface,
    render,
  });

  return {
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
  };
}
