import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import type { TSources } from "@/lib/types/GlobeTypes.ts";

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
const { useUrlSync } = await import("@/store/useUrlSync.ts");

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
  return ref<TSources>({
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

/** A pyramid whose level groups `0`, `1`, … each hold `tas`. */
function keyedPyramid(orders: number[]) {
  const sources = pyramid(orders);
  sources.value.levels.forEach((level, index) =>
    Object.assign(level, {
      path: String(index),
      datasources: { [`${index}/tas`]: { store: "s", dataset: "" } },
    })
  );
  return sources;
}

it("opens the level a varname names, and keeps picking from the zoom", async () => {
  const store = useGlobeControlStore();
  const sources = keyedPyramid([10, 8, 6]);
  const scope = effectScope();
  const { selectVariableLevel } = scope.run(() =>
    useLevelSelection(sources, () => VIEWPORT)
  )!;
  try {
    store.varnameSelector = "1/tas";
    selectVariableLevel("1/tas");
    expect(sources.value.selectedLevel).toBe(1);
    expect(store.selectedLevel).toBe(1);
    expect(store.levelAuto).toBe(true);

    // within the hysteresis the named level stays
    store.metersPerPixel = scaleFor(6.9);
    await nextPick();
    expect(store.selectedLevel).toBe(1);
    store.metersPerPixel = scaleFor(6);
    await nextPick();
    expect(store.selectedLevel).toBe(2);
    expect(store.varnameSelector).toBe("2/tas");
  } finally {
    scope.stop();
  }
});

it("stays on the level a varname names with picking off", async () => {
  const store = useGlobeControlStore();
  const sources = keyedPyramid([10, 8, 6]);
  const scope = effectScope();
  const { selectVariableLevel } = scope.run(() =>
    useLevelSelection(sources, () => VIEWPORT)
  )!;
  try {
    store.setLevelAuto(false);
    store.varnameSelector = "1/tas";
    selectVariableLevel("1/tas");
    store.metersPerPixel = scaleFor(6);
    await nextPick();
    expect(store.selectedLevel).toBe(1);
    expect(store.varnameSelector).toBe("1/tas");
  } finally {
    scope.stop();
  }
});

it("writes an automatic pick and picking off into the URL", async () => {
  const location = {
    pathname: "/",
    hash: "#https://example.test/pyramid.zarr::varname=0/tas",
  };
  vi.stubGlobal("location", location);
  vi.stubGlobal("document", { location });
  vi.stubGlobal("history", {
    replaceState: (_state: unknown, _title: string, url: string) => {
      location.hash = url.slice(url.indexOf("#"));
    },
  });
  const store = useGlobeControlStore();
  store.varnameSelector = "0/tas";
  const sources = keyedPyramid([10, 8, 6]);
  const scope = effectScope();
  scope.run(() => {
    useUrlSync();
    useLevelSelection(sources, () => VIEWPORT);
  });
  try {
    store.metersPerPixel = scaleFor(6);
    await nextPick();
    expect(location.hash).toContain("::varname=2/tas");
    expect(location.hash).not.toContain("levelauto");

    store.selectLevel(1);
    await nextTick();
    expect(location.hash).toContain("::varname=1/tas");
    expect(location.hash).toContain("::levelauto=false");

    store.setLevelAuto(true);
    await nextTick();
    expect(location.hash).not.toContain("levelauto");
  } finally {
    scope.stop();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", { getItem: () => null });
  }
});

it("does not pick for a variable without levels, and picks again after it", async () => {
  const store = useGlobeControlStore();
  const sources = keyedPyramid([10, 8, 6]);
  for (const level of sources.value.levels) {
    level.datasources["root_only"] = { store: "s", dataset: "" };
  }
  const scope = effectScope();
  scope.run(() => useLevelSelection(sources, () => VIEWPORT));
  try {
    store.varnameSelector = "root_only";
    store.metersPerPixel = scaleFor(6);
    await nextPick();
    expect(store.selectedLevel).toBe(0);

    store.varnameSelector = "0/tas";
    await nextTick();
    expect(store.selectedLevel).toBe(2);
    expect(store.varnameSelector).toBe("2/tas");
  } finally {
    scope.stop();
  }
});
