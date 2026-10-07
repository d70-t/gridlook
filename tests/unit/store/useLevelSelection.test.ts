import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { EARTH_RADIUS_METERS, CAMERA_VERTICAL_FOV_DEGREES } =
  await import("@/lib/camera/cameraSettings.ts");
const { DEFAULT_PIXELS_PER_CELL } = await import("@/lib/data/levels.ts");
const { PROJECTION_TYPES } =
  await import("@/lib/projection/projectionUtils.ts");
const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
const { useUrlParameterStore } = await import("@/store/paramStore.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { LEVEL_PICK_INTERVAL_MS, useLevelSelection } =
  await import("@/store/useLevelSelection.ts");

const VIEWPORT = { width: 1000, height: 1000 };

function resolution(order: number) {
  return (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 2 ** order;
}

function altitudeFor(order: number) {
  const halfFov = (CAMERA_VERTICAL_FOV_DEGREES * Math.PI) / 360;
  return (
    (resolution(order) * VIEWPORT.height) /
    (2 * DEFAULT_PIXELS_PER_CELL * Math.tan(halfFov))
  );
}

function pyramid(orders: number[]) {
  return ref({
    zarr_format: ZARR_FORMAT.V3, // eslint-disable-line camelcase
    levels: orders.map((order) => ({
      name: String(order),
      grid: { store: "s", dataset: String(order) },
      time: { store: "s", dataset: String(order) },
      datasources: {},
      resolution: resolution(order),
      cellCount: 12 * 4 ** order,
    })),
  });
}

/** The measured scale at which one cell of `order` spans the target pixels. */
function scaleFor(order: number) {
  return resolution(order) / DEFAULT_PIXELS_PER_CELL;
}

async function nextPick() {
  await nextTick();
  vi.advanceTimersByTime(LEVEL_PICK_INTERVAL_MS);
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("picks the level from the rendered ground scale", async () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  scope.run(() => useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT));
  try {
    store.metersPerPixel = scaleFor(8);
    await nextPick();
    expect(store.selectedLevel).toBe(1);
    expect(store.levelAuto).toBe(true);

    store.metersPerPixel = scaleFor(6);
    await nextPick();
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }
});

it("switches while the camera keeps moving, once per interval", async () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  scope.run(() => useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT));
  try {
    store.metersPerPixel = scaleFor(8);
    await nextTick();
    expect(store.selectedLevel).toBe(1);

    store.metersPerPixel = scaleFor(6);
    await nextTick();
    vi.advanceTimersByTime(LEVEL_PICK_INTERVAL_MS / 2);
    expect(store.selectedLevel).toBe(1);
    vi.advanceTimersByTime(LEVEL_PICK_INTERVAL_MS / 2);
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }
});

it("keeps a manual pick until automatic selection is re-enabled", async () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  scope.run(() => useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT));
  try {
    store.selectLevel(0);
    store.metersPerPixel = scaleFor(6);
    await nextPick();
    expect(store.selectedLevel).toBe(0);

    store.setLevelAuto(true);
    await nextTick();
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }
});

it("picks on flat projections too, and leaves single-level datasets alone", async () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  scope.run(() => useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT));
  try {
    store.projectionMode = PROJECTION_TYPES.ROBINSON;
    store.metersPerPixel = scaleFor(6);
    await nextPick();
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }

  const single = effectScope();
  const singleLevel = single.run(() =>
    useLevelSelection(pyramid([10]), () => VIEWPORT)
  )!;
  try {
    store.selectLevel(0, false);
    singleLevel.pickLevel();
    expect(store.selectedLevel).toBe(0);
  } finally {
    single.stop();
  }
});

it("picks from the URL camera before the first frame is rendered", () => {
  const store = useGlobeControlStore();
  useUrlParameterStore().paramCameraAlt = String(altitudeFor(6));
  const scope = effectScope();
  const { pickLevel } = scope.run(() =>
    useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT)
  )!;
  try {
    pickLevel();
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }
});

it("picks from the globe's fitted framing before the URL has a camera", () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  const { pickLevel } = scope.run(() =>
    useLevelSelection(pyramid([12, 10, 8, 5]), () => VIEWPORT)
  )!;
  try {
    pickLevel();
    // A square 1000 px viewport frames the globe ~15 radii up: order-5 cells
    // are about 16 pixels there, and order 12 is over the renderer's cap anyway.
    expect(store.selectedLevel).toBe(3);
  } finally {
    scope.stop();
  }
});

it("lifts the cap for levels loaded by view, not for one that is loaded whole", async () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  // order 12 holds 201M cells: far over the whole-level cap
  scope.run(() => useLevelSelection(pyramid([12, 10, 8]), () => VIEWPORT));
  try {
    store.metersPerPixel = scaleFor(12);
    await nextPick();
    expect(store.selectedLevel).toBe(1);

    // the grid reports that it loads only the view: order 12 is in reach
    store.viewLoading = true;
    await nextTick();
    expect(store.selectedLevel).toBe(0);

    // order 12 turns out to need loading whole: the pick settles on order 10
    // and does not return while the grid still loads the others by view
    store.wholeLevels = [0];
    await nextTick();
    expect(store.selectedLevel).toBe(1);
    store.metersPerPixel = scaleFor(12) * 1.01;
    await nextPick();
    expect(store.selectedLevel).toBe(1);
  } finally {
    scope.stop();
  }
});
