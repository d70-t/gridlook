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
import {
  LAND_SEA_MASK_MODES,
  useGlobeControlStore,
  type TLandSeaMaskMode,
} from "./store/store";
import { geojson2geometry } from "./utils/geojson.ts";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { handleKeyDown } from "./utils/OrbitControlsAddOn.ts";
import { useToast } from "primevue/usetoast";
import * as zarr from "zarrita";
import type { TSources } from "@/types/GlobeTypes.ts";
import { getErrorMessage } from "./utils/errorHandling.ts";
import { useUrlParameterStore } from "./store/paramStore.ts";
import * as d3 from "d3-geo";
import albedo from "../assets/earth.jpg";

export function useSharedGlobeLogic(
  canvas: Ref<HTMLCanvasElement | undefined>,
  box: Ref<HTMLDivElement | undefined>
) {
  const store = useGlobeControlStore();
  const { showCoastLines, landSeaMaskChoice, landSeaMaskUseTexture } =
    storeToRefs(store);

  const urlParameterStore = useUrlParameterStore();
  const { paramCameraState } = storeToRefs(urlParameterStore);

  const toast = useToast();
  const datavars: ShallowRef<
    Record<string, zarr.Array<zarr.DataType, zarr.FetchStore>>
  > = shallowRef({});
  let coast: THREE.LineSegments | undefined = undefined;
  let landSeaMask: THREE.Mesh | undefined = undefined;
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

  async function getCoastlines() {
    if (coast === undefined) {
      const coastlines = await fetch("static/ne_50m_coastline.geojson").then(
        (r) => r.json()
      );
      const geometry = geojson2geometry(coastlines, 1.002);
      const material = new THREE.LineBasicMaterial({
        color: "#ffffff",
      });
      coast = new THREE.LineSegments(geometry, material);
      coast.name = "coastlines";
    }
    return coast;
  }

  // Utility function to create canvas with standard dimensions
  function createStandardCanvas() {
    const width = 4096;
    const height = 2048;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);
    return { canvas, ctx, width, height };
  }

  // Utility function to load land GeoJSON and create projection
  async function createLandProjection(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ) {
    const land = await fetch("static/ne_50m_land.geojson").then((r) =>
      r.json()
    );
    const projection = d3
      .geoEquirectangular()
      .translate([width / 2, height / 2])
      .scale(width / (2 * Math.PI));
    const path = d3.geoPath(projection, ctx);
    return { land, path };
  }

  // Utility function to create sphere mesh
  function createSphereMesh(
    texture: THREE.CanvasTexture,
    radius: number,
    transparent = true
  ) {
    const geometry = new THREE.SphereGeometry(radius, 128, 64);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "mask";
    mesh.rotation.x = Math.PI / 2;
    return mesh;
  }

  /**
   * Get the land sea mask THREE.Mesh by using a texture (blue marble). If the mask does not exist, create it.
   * If invert is true, the land will be grey and the sea will be transparent.
   * If invert is false, the sea will be grey and the land will be transparent.
   * @returns {Promise<THREE.Mesh>} - A promise resolving to a THREE.Mesh containing the land sea mask
   */
  async function getLandSeaMask({ invert = false } = {}) {
    if (!landSeaMask) {
      const { canvas, ctx, width, height } = createStandardCanvas();

      // Load and draw base JPG
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const loader = new Image();
        loader.src = albedo;
        loader.onload = () => resolve(loader);
        loader.onerror = reject;
      });
      ctx.drawImage(img, 0, 0, width, height);

      // Setup land projection and masking
      const { land, path } = await createLandProjection(ctx, width, height);
      ctx.beginPath();
      path(land);
      ctx.globalCompositeOperation = invert
        ? "destination-in"
        : "destination-out";
      ctx.fill();

      // Create texture and mesh
      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;

      landSeaMask = createSphereMesh(texture, 1.002);
    }

    return landSeaMask;
  }

  async function getGlobeTexture() {
    // Show the full globe texture, no geojson masking, radius 0.9999
    const radius = 0.9999;
    const geometry = new THREE.SphereGeometry(radius, 128, 64);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const loader = new Image();
      loader.src = albedo;
      loader.onload = () => resolve(loader);
      loader.onerror = reject;
    });
    const texture = new THREE.Texture(img);
    texture.needsUpdate = true;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: false,
      side: THREE.FrontSide,
    });
    landSeaMask = new THREE.Mesh(geometry, material);
    landSeaMask.name = "globe_texture";
    landSeaMask.rotation.x = Math.PI / 2;
    return landSeaMask;
  }

  /**
   * Create a grey mask to be used with the globe.
   * If invert is true, the land will be grey and the sea will be transparent.
   * If invert is false, the sea will be grey and the land will be transparent.
   *
   * @param {Object} [options] - Options to be passed to the function
   * @param {boolean} [options.invert=false] - Whether to invert the mask
   * @returns {Promise<THREE.Mesh>} - A promise resolving to a THREE.Mesh containing the grey mask
   */
  async function getGreyMask({ invert = false } = {}) {
    const { canvas, ctx, width, height } = createStandardCanvas();
    const { land, path } = await createLandProjection(ctx, width, height);

    // ctx.globalAlpha = 0.7;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#888";

    if (!invert) {
      // Sea grey: fill all, then cut out land
      ctx.fillRect(0, 0, width, height);
    }
    ctx.save();
    ctx.beginPath();
    path(land);
    ctx.globalCompositeOperation = invert ? "source-over" : "destination-out";
    ctx.fill();
    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    return createSphereMesh(texture, 1.002);
  }

  async function getSolidColoredGlobe() {
    // Globe colored: solid blue ocean, grey land. Use radius 0.9999
    const radius = 0.9999;
    const width = 4096;
    const height = 2048;

    // prepare canvas (no base texture)
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);

    // fill ocean with solid blue
    ctx.fillStyle = "rgb(60,120,200)"; // solid blue
    ctx.fillRect(0, 0, width, height);

    // load land geojson and draw land as grey on top
    const land = await fetch("static/ne_50m_land.geojson").then((r) =>
      r.json()
    );
    const projection = d3
      .geoEquirectangular()
      .translate([width / 2, height / 2])
      .scale(width / (2 * Math.PI));
    const path = d3.geoPath(projection, ctx);
    ctx.beginPath();
    path(land);
    ctx.fillStyle = "rgb(136,136,136)"; // grey for land
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 16;
    texture.needsUpdate = true;

    const geometry = new THREE.SphereGeometry(radius, 128, 64);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: false,
      side: THREE.FrontSide,
    });
    landSeaMask = new THREE.Mesh(geometry, material);
    landSeaMask.name = "mask";
    landSeaMask.rotation.x = Math.PI / 2;
    return landSeaMask;
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

  async function updateLandSeaMask() {
    // Determine effective mode from simplified choice and texture flag
    console.log(landSeaMaskChoice.value, landSeaMaskUseTexture.value);
    const choice = landSeaMaskChoice.value ?? LAND_SEA_MASK_MODES.OFF;
    const useTexture = landSeaMaskUseTexture.value ?? true;
    let mode: TLandSeaMaskMode = LAND_SEA_MASK_MODES.OFF;

    if (choice === LAND_SEA_MASK_MODES.OFF) {
      mode = LAND_SEA_MASK_MODES.OFF;
    } else if (choice === LAND_SEA_MASK_MODES.SEA) {
      mode = useTexture
        ? LAND_SEA_MASK_MODES.SEA
        : LAND_SEA_MASK_MODES.SEA_GREY;
    } else if (choice === LAND_SEA_MASK_MODES.LAND) {
      mode = useTexture
        ? LAND_SEA_MASK_MODES.LAND
        : LAND_SEA_MASK_MODES.LAND_GREY;
    } else if (choice === LAND_SEA_MASK_MODES.GLOBE) {
      mode = useTexture
        ? LAND_SEA_MASK_MODES.GLOBE
        : LAND_SEA_MASK_MODES.GLOBE_COLORED;
    }
    console.log("mode", mode);
    if (landSeaMask) {
      console.log("remove land sea mask");
      scene?.remove(landSeaMask);
      landSeaMask = undefined;
    }
    if (mode === LAND_SEA_MASK_MODES.OFF) {
      redraw();
      return;
    }

    // Helper for grey mask

    try {
      if (
        mode === LAND_SEA_MASK_MODES.SEA ||
        mode === LAND_SEA_MASK_MODES.LAND
      ) {
        const invert = mode === LAND_SEA_MASK_MODES.LAND;
        scene?.add(await getLandSeaMask({ invert }));
      } else if (
        mode === LAND_SEA_MASK_MODES.SEA_GREY ||
        mode === LAND_SEA_MASK_MODES.LAND_GREY
      ) {
        const invert = mode === LAND_SEA_MASK_MODES.LAND_GREY;
        landSeaMask = await getGreyMask({ invert });
        scene?.add(landSeaMask);
      } else if (mode === LAND_SEA_MASK_MODES.GLOBE) {
        landSeaMask = await getGlobeTexture();
        scene?.add(landSeaMask);
      } else if (mode === LAND_SEA_MASK_MODES.GLOBE_COLORED) {
        landSeaMask = await getSolidColoredGlobe();
        scene?.add(landSeaMask);
      }
    } catch (e) {
      console.error("Failed to update land/sea mask:", e);
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
      encodeCameraToURL(getCamera()!);
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

    canvasValue.addEventListener(
      "touchstart",
      () => {
        mouseDown = true;
        animationLoop();
      },
      {
        passive: true,
      }
    );

    canvasValue.addEventListener(
      "touchend",
      () => {
        mouseDown = false;
      },
      {
        passive: true,
      }
    );

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

  type TCameraState = {
    position: number[];
    quaternion: number[];
    fov: number;
    aspect: number;
    near: number;
    far: number;
  };

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
    getTimeVar,
    registerUpdateLOD,
  };
}
