import { useEventListener } from "@vueuse/core";
import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { computed, effectScope, ref } from "vue";

import type { TProjectionType } from "@/lib/projection/projectionUtils.ts";

const { mounted, unmounted } = vi.hoisted(() => ({
  mounted: [] as (() => void)[],
  unmounted: [] as (() => void)[],
}));

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: (callback: () => void) => mounted.push(callback),
  onBeforeUnmount: (callback: () => void) => unmounted.push(callback),
}));

vi.mock("@vueuse/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vueuse/core")>()),
  useEventListener: vi.fn(),
  useResizeObserver: vi.fn(),
}));

vi.mock("three", async (importOriginal) => ({
  ...(await importOriginal<typeof import("three")>()),
  WebGLRenderer: class {
    domElement = Object.assign(new EventTarget(), {
      ownerDocument: new EventTarget(),
      style: { touchAction: "" },
      getRootNode() {
        return this.ownerDocument;
      },
    });
    render() {}
    dispose() {}
  },
}));

vi.mock("@/ui/grids/composables/useGridSnapshot.ts", () => ({
  useGridSnapshot: () => ({ makeSnapshot: vi.fn() }),
}));

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { useUrlParameterStore } = await import("@/store/paramStore.ts");
const { ProjectionHelper, PROJECTION_TYPES } =
  await import("@/lib/projection/projectionUtils.ts");
const { EARTH_RADIUS_METERS, useGridCameraState } =
  await import("@/ui/grids/composables/useGridCameraState.ts");
const { useGridScene } = await import("@/ui/grids/composables/useGridScene.ts");

type TSceneSetupOptions = {
  alt?: string;
  lat?: string;
  lon?: string;
  flat?: boolean;
  projection?: TProjectionType;
};

function setupRegionalScene(saved: TSceneSetupOptions = {}) {
  vi.useFakeTimers();
  vi.stubGlobal("window", { innerWidth: 800, innerHeight: 600 });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16)
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  setActivePinia(createPinia());
  const params = useUrlParameterStore();
  params.paramCameraAlt = saved.alt;
  params.paramLat = saved.lat;
  params.paramLon = saved.lon;
  const scope = effectScope();
  const center = ref({ lat: 0, lon: 0 });
  const grid = scope.run(() =>
    useGridScene({
      projectionHelper: computed(
        () =>
          new ProjectionHelper(
            saved.projection ??
              (saved.flat
                ? PROJECTION_TYPES.EQUIRECTANGULAR
                : PROJECTION_TYPES.NEARSIDE_PERSPECTIVE),
            center.value
          )
      ),
      projectionCenter: center,
      controlPanelVisible: ref(false),
      cameraState: useGridCameraState(),
    })
  )!;
  mounted.forEach((callback) => callback());
  grid.box.value = {
    getBoundingClientRect: () => ({ width: 400, height: 800 }),
  } as HTMLDivElement;
  const geometry = new THREE.BufferGeometry().setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute([49, 9, 49, 11, 51, 9, 51, 11], 2)
  );
  return {
    grid,
    center,
    params,
    scope,
    mesh: new THREE.Mesh(geometry),
    camera: grid.getCamera()!,
  };
}

it("fits a fresh dataset after its default camera was saved during loading", async () => {
  const { grid, center, params, scope, mesh, camera } = setupRegionalScene();
  const initialDistance = camera.position.length();
  const defaultAltitude = params.paramCameraAlt;
  expect(defaultAltitude).toBeDefined();
  await vi.advanceTimersByTimeAsync(2000);
  // Coordinate-only bounds can arrive before any render mesh or texture exists.
  grid.fitCameraToDataset([{ geometry: mesh.geometry }]);
  expect(params.paramCameraAlt).not.toBe(defaultAltitude);
  expect(camera.position.length()).toBeLessThan(initialDistance);
  expect(camera.aspect).toBe(0.5);
  expect(center.value.lat).toBeCloseTo(50, 1);
  expect(center.value.lon).toBeCloseTo(10, 1);
  expect(Number(params.paramCameraAlt)).toBeCloseTo(
    (camera.position.length() - 1) * EARTH_RADIUS_METERS,
    0
  );
  camera.position.setLength(5);
  grid.fitCameraToDataset([mesh]);
  expect(camera.position.length()).toBeCloseTo(5);
  scope.stop();
});

it.each([{ alt: "1000000" }, { lat: "0" }, { lon: "0" }, { flat: true }])(
  "preserves saved views and flat projections (%j)",
  (saved) => {
    const { grid, scope, mesh, camera } = setupRegionalScene(saved);
    const position = camera.position.clone();
    grid.fitCameraToDataset([mesh]);
    expect(camera.position).toEqual(position);
    scope.stop();
  }
);

it("does not replace a camera the user zoomed while data was loading", () => {
  vi.mocked(useEventListener).mockClear();
  const { grid, scope, mesh, camera } = setupRegionalScene();
  const wheelListener = vi
    .mocked(useEventListener)
    .mock.calls.find((args) => args[1] === "wheel")![2] as () => void;
  wheelListener();
  const position = camera.position.clone();
  grid.fitCameraToDataset([mesh]);
  expect(camera.position).toEqual(position);
  scope.stop();
});

it.each(
  Object.values(PROJECTION_TYPES).filter(
    (type) => type !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE
  )
)(
  "supports close zoom on a panned %s map without clipping the surface or crop",
  (projection) => {
    const { grid, scope, camera, params } = setupRegionalScene({ projection });
    grid.applyCameraPreset({
      position: [2, 1, 0.0001],
      quaternion: [0, 0, 0, 1],
    });
    expect(camera.position.z).toBeCloseTo(0.001, 6);
    expect(camera.near).toBeCloseTo(0.0005, 6);
    expect(Number(params.paramCameraAlt)).toBe(
      Math.round(0.001 * EARTH_RADIUS_METERS)
    );
    camera.updateMatrixWorld();
    const crop = grid
      .getScene()!
      .children.find((object) => object.renderOrder === -10)!.children[0];
    const cropZ = crop ? crop.getWorldPosition(new THREE.Vector3()).z : 0;
    expect(cropZ).toBe(0);
    for (const z of [0, cropZ]) {
      const depth = new THREE.Vector3(2, 1, z).project(camera).z;
      expect(depth).toBeGreaterThan(-1);
      expect(depth).toBeLessThan(1);
    }
    scope.stop();
  }
);

afterEach(() => {
  unmounted.splice(0).forEach((callback) => callback());
  mounted.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  { frameDuration: 4, center: { lat: 0, lon: 0 } },
  { frameDuration: 16, center: { lat: 0, lon: 0 } },
  { frameDuration: 16, center: { lat: 35, lon: 139 } },
  { frameDuration: 16, center: { lat: 35, lon: 139 }, stopLayer: true },
])(
  "saves the closest altitude ($frameDuration ms, $center, stopLayer=$stopLayer)",
  // eslint-disable-next-line max-lines-per-function
  async ({ frameDuration, center, stopLayer }) => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { innerWidth: 800, innerHeight: 600 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), frameDuration)
    );
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    setActivePinia(createPinia());
    const scope = effectScope();
    const cameraState = useGridCameraState();
    const grid = scope.run(() =>
      useGridScene({
        projectionHelper: computed(
          () =>
            new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, center)
        ),
        projectionCenter: ref(center),
        controlPanelVisible: ref(false),
        cameraState,
      })
    )!;
    mounted.forEach((callback) => callback());
    const camera = grid.getCamera() as THREE.PerspectiveCamera;
    const previousAltitude = useUrlParameterStore().paramCameraAlt;
    camera.position.setLength(0.5);
    const animateLayer = vi.fn();
    const stopAnimation = grid.registerAnimationCallback(animateLayer);
    if (stopLayer) {
      stopAnimation();
    }

    try {
      await vi.advanceTimersByTimeAsync(1200);
      expect(useUrlParameterStore().paramCameraAlt).not.toBe(previousAltitude);
      expect(useUrlParameterStore().paramCameraAlt).toBe(
        String(Math.round(0.001 * EARTH_RADIUS_METERS))
      );
      expect(camera.near).toBeCloseTo(0.0005);
      const surfacePoint = camera.position.clone().normalize();
      camera.updateMatrixWorld();
      const surfaceDepth = surfacePoint.project(camera).z;
      expect(surfaceDepth).toBeGreaterThan(-1);
      expect(surfaceDepth).toBeLessThan(1);
      const frameCount = animateLayer.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      if (stopLayer) {
        expect(animateLayer.mock.calls.length).toBe(frameCount);
        expect(vi.getTimerCount()).toBe(0);
      } else {
        expect(animateLayer.mock.calls.length).toBeGreaterThan(frameCount);
      }
    } finally {
      stopAnimation();
      scope.stop();
    }
  }
);
