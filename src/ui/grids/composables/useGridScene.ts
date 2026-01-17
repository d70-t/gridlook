import { useEventListener } from "@vueuse/core";
import * as d3 from "d3-geo";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import {
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";

import type { GridCameraState } from "./useGridCameraState.ts";

import { handleKeyDown } from "@/lib/camera/OrbitControlsAddOn.ts";
import type {
  ProjectionHelper,
  TProjectionCenter,
} from "@/lib/projection/projectionUtils.ts";
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
  let mouseDown = false;

  let rightMouseDown = false;
  let rightDragStartX = 0;
  let rightDragStartY = 0;
  let rightDragStartCenterLon = 0;
  let rightDragStartCenterLat = 0;

  let init = true;
  let currentOffset = 0;
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

  function registerUpdateLOD(func: () => void) {
    updateLOD = func;
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

  function configureFlatProjectionCamera(
    cam: THREE.PerspectiveCamera,
    controls: OrbitControls
  ) {
    const bounds = getProjectedBounds();
    const targetDistance =
      Math.max(bounds.height, bounds.width) /
      2 /
      Math.tan(((cam.fov ?? 45) * Math.PI) / 360);

    cam.up.set(0, 1, 0);
    cam.quaternion.identity();
    cam.rotation.set(0, 0, 0);

    cam.position.set(
      bounds.centerX,
      bounds.centerY,
      Math.max(targetDistance * 1.1, 3)
    );
    controls.target.set(bounds.centerX, bounds.centerY, 0);

    controls.enablePan = true;
    controls.enableRotate = false;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    controls.minDistance = 1;
    controls.maxDistance = 200;
  }

  function configureGlobeProjectionCamera(
    cam: THREE.PerspectiveCamera,
    controls: OrbitControls
  ) {
    cam.up.set(0, 0, 1);
    controls.enablePan = false;
    controls.enableRotate = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.minDistance = 1.1;
    controls.maxDistance = 1000;
    cam.position.set(30, 0, 0);
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
    } else {
      configureGlobeProjectionCamera(cam, controls);
    }

    applyCameraTarget(cam, controls);
    syncCameraStateWithUrl(cam, controls);

    updateCameraForPanel();
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
    renderer = new THREE.WebGLRenderer({ canvas: canvas.value });

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

  function handleRightMouseDown(event: MouseEvent) {
    if (event.button !== 2) {
      return;
    }
    if (!projectionHelper.value.isFlat) {
      return;
    }

    event.preventDefault();
    rightMouseDown = true;
    rightDragStartX = event.clientX;
    rightDragStartY = event.clientY;
    const center = projectionCenter.value ?? { lat: 0, lon: 0 };
    rightDragStartCenterLon = center.lon;
    rightDragStartCenterLat = center.lat;
  }

  function handleRightMouseMove(event: MouseEvent) {
    if (!rightMouseDown) {
      return;
    }
    if (!projectionHelper.value.isFlat) {
      return;
    }

    event.preventDefault();

    const deltaX = event.clientX - rightDragStartX;
    const deltaY = event.clientY - rightDragStartY;

    const canvasWidth = width.value ?? 800;
    const canvasHeight = height.value ?? 600;

    const lonSensitivity = 180 / canvasWidth;
    const latSensitivity = 90 / canvasHeight;

    let newLon = rightDragStartCenterLon + deltaX * lonSensitivity;
    let newLat = rightDragStartCenterLat - deltaY * latSensitivity;

    newLat = Math.max(-90, Math.min(90, newLat));
    newLon = projectionHelper.value.normalizeLongitude(newLon);

    projectionCenter.value = { lat: newLat, lon: newLon };
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
      const cam = getCamera();
      if (cam) {
        cameraState.debouncedEncodeCameraToURL(cam);
      }
      return;
    }
    render();
    frameId.value = requestAnimationFrame(animationLoop);
  }

  function setupInteractionListeners() {
    // Wheel events
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

    // Mouse events for general interaction
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

    // Touch events
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
        if (rightMouseDown) {
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
          rightMouseDown = false;
        }
      },
      { passive: false }
    );
  }

  // Setup keyboard navigation listeners
  function setupKeyboardListeners() {
    useEventListener(box.value, "keydown", (e: KeyboardEvent) => {
      const navigationKeys = [
        "ArrowRight",
        "ArrowLeft",
        "ArrowUp",
        "ArrowDown",
        "+",
        "-",
      ];

      if (navigationKeys.includes(e.key)) {
        mouseDown = true;
        handleKeyDown(e, getOrbitControls()!, projectionHelper.value.isFlat);
        animationLoop();
        mouseDown = false;
      }
    });
  }

  onMounted(() => {
    mouseDown = false;

    setupInteractionListeners();
    setupRightClickListeners();
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
    }
  );

  function makeSnapshot() {
    render();
    canvas.value?.toBlob((blob) => {
      const link = document.createElement("a");
      link.download = "gridlook.png";

      link.href = URL.createObjectURL(blob!);
      link.click();

      URL.revokeObjectURL(link.href);
    }, "image/png");
  }

  return {
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
  };
}
