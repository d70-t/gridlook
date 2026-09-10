import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { computed, effectScope, ref } from "vue";

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

afterEach(() => {
  unmounted.splice(0).forEach((callback) => callback());
  mounted.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([4, 16])(
  "saves the closest altitude while layer animation continues (%i ms frames)",
  async (frameDuration) => {
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
            new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
              lat: 0,
              lon: 0,
            })
        ),
        projectionCenter: ref({ lat: 0, lon: 0 }),
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

    try {
      await vi.advanceTimersByTimeAsync(1200);
      expect(useUrlParameterStore().paramCameraAlt).not.toBe(previousAltitude);
      expect(useUrlParameterStore().paramCameraAlt).toBe(
        String(Math.round(0.12 * EARTH_RADIUS_METERS))
      );
      const frameCount = animateLayer.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      expect(animateLayer.mock.calls.length).toBeGreaterThan(frameCount);
    } finally {
      stopAnimation();
      scope.stop();
    }
  }
);
