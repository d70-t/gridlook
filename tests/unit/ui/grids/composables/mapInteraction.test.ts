import { useEventListener } from "@vueuse/core";
import { expect, it, vi } from "vitest";
import { computed, effectScope, ref } from "vue";

const { mounted } = vi.hoisted(() => ({ mounted: [] as (() => void)[] }));

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: (callback: () => void) => mounted.push(callback),
  onBeforeUnmount: () => {},
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
const { ProjectionHelper, PROJECTION_TYPES } =
  await import("@/lib/projection/projectionUtils.ts");
const { useGridCameraState } =
  await import("@/ui/grids/composables/useGridCameraState.ts");
const { useGridScene } = await import("@/ui/grids/composables/useGridScene.ts");
const { getMapScene, registerMapTool } =
  await import("@/ui/grids/composables/useMapInteraction.ts");

function dispatcher(type: string) {
  // Every listener registered for `type` on the canvas, as the browser would call them.
  const handlers = vi
    .mocked(useEventListener)
    .mock.calls.filter((args) => args[1] === type)
    .map((args) => args[2] as (event: MouseEvent) => void);
  return (event: Partial<MouseEvent>) =>
    handlers.forEach((handler) =>
      handler({ preventDefault() {}, ...event } as MouseEvent)
    );
}

// eslint-disable-next-line max-lines-per-function
it("opens map tools on a stationary right-click only and projects geometry", () => {
  vi.stubGlobal("window", { innerWidth: 800, innerHeight: 600 });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.mocked(useEventListener).mockClear();
  setActivePinia(createPinia());
  const scope = effectScope();
  const grid = scope.run(() =>
    useGridScene({
      projectionHelper: computed(
        () =>
          new ProjectionHelper(PROJECTION_TYPES.EQUIRECTANGULAR, {
            lat: 0,
            lon: 0,
          })
      ),
      projectionCenter: ref({ lat: 0, lon: 0 }),
      controlPanelVisible: ref(false),
      cameraState: useGridCameraState(),
    })
  )!;
  mounted.forEach((callback) => callback());
  grid.box.value = {
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
  } as HTMLDivElement;
  grid.canvas.value = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as HTMLCanvasElement;
  grid.applyCameraPreset({ position: [0, 0, 5], quaternion: [0, 0, 0, 1] });
  grid.getCamera()!.updateMatrixWorld();

  const menus: { lat: number; lon: number }[] = [];
  const clicks: unknown[] = [];
  const unregister = registerMapTool({
    contextMenu: (event) => menus.push(event.geo!),
    click: (geo) => {
      clicks.push(geo);
      return true;
    },
  });
  const down = dispatcher("mousedown");
  const up = dispatcher("mouseup");

  down({ button: 2, clientX: 400, clientY: 300 });
  up({ button: 2, clientX: 402, clientY: 301 });
  expect(menus).toHaveLength(1);
  // 2 px from the centre at this zoom is under 0.1°
  expect(Math.abs(menus[0].lat)).toBeLessThan(0.1);
  expect(Math.abs(menus[0].lon)).toBeLessThan(0.15);

  // A right drag keeps its camera gesture and opens nothing.
  down({ button: 2, clientX: 400, clientY: 300 });
  up({ button: 2, clientX: 460, clientY: 300 });
  expect(menus).toHaveLength(1);

  down({ button: 0, clientX: 300, clientY: 300 });
  up({ button: 0, clientX: 300, clientY: 300 });
  expect(clicks).toHaveLength(1);

  const centre = getMapScene()!.project(0, 0)!;
  expect(centre.x).toBeCloseTo(400, 0);
  expect(centre.y).toBeCloseTo(300, 0);
  expect(centre.visible).toBe(true);
  unregister();
  scope.stop();
});
