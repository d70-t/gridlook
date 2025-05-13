import { storeToRefs } from "pinia";
import {
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type Ref,
  type ShallowRef,
} from "vue";
import { useGlobeControlStore } from "./store/store";
import { geojson2geometry } from "./utils/geojson.ts";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { handleKeyDown } from "./utils/OrbitControlsAddOn.ts";
import { useToast } from "primevue/usetoast";
import * as zarr from "zarrita";
import type { TSources } from "@/types/GlobeTypes.ts";
import { getErrorMessage } from "./utils/errorHandling.ts";

export function useSharedGlobeLogic(
  canvas: Ref<HTMLCanvasElement | undefined>,
  box: Ref<HTMLDivElement | undefined>
) {
  const store = useGlobeControlStore();
  const { showCoastLines } = storeToRefs(store);

  const toast = useToast();
  const datavars: ShallowRef<
    Record<string, zarr.Array<zarr.DataType, zarr.FetchStore>>
  > = shallowRef({});
  let coast: THREE.LineSegments | undefined = undefined;
  let scene: THREE.Scene | undefined = undefined;
  let camera: THREE.PerspectiveCamera | undefined = undefined;
  let renderer: THREE.WebGLRenderer | undefined = undefined;
  let orbitControls: OrbitControls | undefined = undefined;
  let resizeObserver: ResizeObserver | undefined = undefined;
  const width: Ref<number | undefined> = ref(undefined);
  const height: Ref<number | undefined> = ref(undefined);
  let mouseDown = false;
  const frameId = ref(0);

  watch(
    () => showCoastLines.value,
    () => {
      updateCoastlines();
    }
  );

  function getCoast() {
    return coast;
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
    getOrbitControls()?.update();
    getRenderer()?.render(getScene()!, getCamera()!);
  }

  async function getCoastlines() {
    if (coast === undefined) {
      const coastlines = await fetch("static/ne_50m_coastline.geojson").then(
        (r) => r.json()
      );
      const geometry = geojson2geometry(coastlines, 1.001);
      const material = new THREE.LineBasicMaterial({ color: "#ffffff" });
      coast = new THREE.LineSegments(geometry, material);
      coast.name = "coastlines";
    }
    return coast;
  }

  async function updateCoastlines() {
    if (showCoastLines.value === false) {
      if (getCoast()) {
        scene?.remove(getCoast()!);
      }
    } else {
      scene?.add(await getCoastlines());
    }
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

    camera.up = new THREE.Vector3(0, 0, 1);
    camera.position.x = 30;
    camera.lookAt(center);

    //scene.add(mainMesh as THREE.Mesh);

    orbitControls = new OrbitControls(camera, renderer.domElement);
    // smaller minDistances than 1.1 will reveal the naked mesh
    // under the texture when zoomed in
    orbitControls.minDistance = 1.1;
    orbitControls.enablePan = false;
    // coast = undefined;
    updateCoastlines();
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
      width.value = boxWidth;
      height.value = boxHeight;
      const myRenderer = getRenderer() as THREE.WebGLRenderer;
      if (width.value !== undefined && height.value !== undefined) {
        myRenderer.setSize(width.value, height.value);
      }
      redraw();
      if (box.value) {
        getResizeObserver()!.observe(box.value);
      }
    }
  }

  function toggleRotate() {
    getOrbitControls()!.autoRotate = !getOrbitControls()!.autoRotate;
    animationLoop();
  }

  function animationLoop() {
    cancelAnimationFrame(frameId.value);
    if (!mouseDown && !getOrbitControls()?.autoRotate) {
      render();
      return;
    }
    render();
    frameId.value = requestAnimationFrame(animationLoop);
  }

  onMounted(() => {
    const canvasValue = canvas.value as HTMLCanvasElement;

    mouseDown = false;

    canvasValue.addEventListener("wheel", () => {
      mouseDown = true;
      animationLoop();
      mouseDown = false;
    });

    canvasValue.addEventListener("mouseup", () => {
      mouseDown = false;
    });

    canvasValue.addEventListener("mousedown", () => {
      mouseDown = true;
      animationLoop();
    });

    canvasValue.addEventListener("touchstart", () => {
      mouseDown = true;
      animationLoop();
    });

    canvasValue.addEventListener("touchend", () => {
      mouseDown = false;
    });

    box.value!.addEventListener("keydown", (e: KeyboardEvent) => {
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
    onCanvasResize();
  });

  onBeforeUnmount(() => {
    getResizeObserver()?.unobserve(box.value!);
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
    if (!datavars.value[myVarname]) {
      let myDatasource;
      if (myVarname === "time") {
        myDatasource = datasources!.levels[0].time;
      } else {
        myDatasource = datasources!.levels[0].datasources[myVarname];
      }
      try {
        const root = zarr.root(new zarr.FetchStore(myDatasource.store));
        const datavar = await zarr.open(
          root.resolve(myDatasource.dataset + "/" + myVarname),
          {
            kind: "array",
          }
        );
        datavars.value[myVarname] = datavar;
      } catch (error) {
        toast.add({
          detail: `Couldn't fetch variable ${myVarname} from store: ${myDatasource.store} and dataset: ${myDatasource.dataset}: ${getErrorMessage(error)}`,
          life: 3000,
        });
        return undefined;
      }
    }
    return datavars.value[myVarname];
  }

  async function getTimeVar(datasources: TSources) {
    return await getDataVar("time", datasources);
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
    getTimeVar,
  };
}
