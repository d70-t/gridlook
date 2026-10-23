import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectScope, nextTick, type Ref } from "vue";

import type { T_GRID_TYPES } from "@/lib/data/gridTypeDetector.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

const { mounted, getGridType, indexFromZarr } = vi.hoisted(() => ({
  mounted: [] as (() => Promise<void>)[],
  getGridType: vi.fn(),
  indexFromZarr: vi.fn(),
}));

vi.mock("vue", async (original) => ({
  ...(await original<typeof import("vue")>()),
  onMounted: (callback: () => Promise<void>) => mounted.push(callback),
  useSSRContext: () => ({}),
}));
vi.mock("@/lib/data/gridTypeDetector.ts", async (original) => ({
  ...(await original<typeof import("@/lib/data/gridTypeDetector.ts")>()),
  getGridType,
}));
vi.mock("@/lib/data/sourceIndexing.ts", () => ({
  indexFromZarr,
  indexFromIndex: () => Promise.reject(new Error("not an index")),
  indexFromNetCDF: vi.fn(),
}));
vi.mock("@/lib/layers/textureStore.ts", () => ({
  loadTextures: async () => [],
}));

const location = { pathname: "/", search: "", hash: "#src::" };
vi.stubGlobal("localStorage", { getItem: () => null });
vi.stubGlobal("location", location);
vi.stubGlobal("history", {
  replaceState: (_state: unknown, _title: string, url: string) => {
    location.hash = url.slice(url.indexOf("#"));
  },
});
const listeners = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
vi.stubGlobal("document", { location, ...listeners });
vi.stubGlobal("window", {
  location,
  innerWidth: 1000,
  innerHeight: 1000,
  BroadcastChannel,
  ...listeners,
});

const { createPinia, setActivePinia } = await import("pinia");
const { GRID_TYPES } = await import("@/lib/data/gridTypeDetector.ts");
const { useUrlParameterStore } = await import("@/store/paramStore.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: GlobeView } = await import("@/views/GlobeView.vue");

type TBindings = {
  datasources: Ref<TSources | undefined>;
  globeKey: Ref<number>;
};

/**
 * A pyramid whose level groups `0`, `1`, `2` each hold `tas` and `pr`, with
 * `root_only` outside its levels.
 */
function pyramid(): TSources {
  return {
    zarr_format: ZARR_FORMAT.V3, // eslint-disable-line camelcase
    levels: [0, 1, 2].map((index) => ({
      path: String(index),
      grid: { store: "s", dataset: String(index) },
      time: { store: "s", dataset: String(index) },
      datasources: {
        [`${index}/tas`]: { store: "s", dataset: String(index) },
        [`${index}/pr`]: { store: "s", dataset: String(index) },
        // eslint-disable-next-line camelcase
        root_only: { store: "s", dataset: "" },
      },
    })),
  } as unknown as TSources;
}

const scopes: ReturnType<typeof effectScope>[] = [];

async function openGlobe(params: { varname?: string; levelauto?: string }) {
  const urlParameters = useUrlParameterStore();
  urlParameters.paramVarname = params.varname;
  urlParameters.paramLevelAuto = params.levelauto;
  const sources = pyramid();
  indexFromZarr.mockResolvedValue(sources);
  const scope = effectScope();
  scopes.push(scope);
  const bindings = scope.run(() =>
    GlobeView.setup!(
      { src: "src" },
      { expose: vi.fn(), attrs: {}, slots: {}, emit: vi.fn() }
    )
  ) as unknown as TBindings;
  await mounted.pop()!();
  return { bindings, store: useGlobeControlStore() };
}

beforeEach(() => {
  setActivePinia(createPinia());
  location.search = "";
  getGridType.mockReset().mockResolvedValue(GRID_TYPES.REGULAR);
});

afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
});

it("opens the level a link's varname names, with picking as the link says", async () => {
  const { bindings, store } = await openGlobe({
    varname: "1/tas",
    levelauto: "false",
  });
  expect(store.levelAuto).toBe(false);
  expect(store.selectedLevel).toBe(1);
  expect(bindings.datasources.value!.selectedLevel).toBe(1);
  expect(store.varnameSelector).toBe("1/tas");
});

it("opens a bare name from an older link on the first level", async () => {
  const { store } = await openGlobe({ varname: "pr" });
  expect(store.varnameSelector).toBe("0/pr");
});

it("picks the level when the link's varname cannot name one", async () => {
  const { store } = await openGlobe({
    varname: "root_only",
    levelauto: "false",
  });
  expect(store.levelAuto).toBe(true);
});

it("reloads a level switch in place, detecting the grid on the level it read", async () => {
  const { bindings, store } = await openGlobe({ varname: "0/tas" });
  await nextTick();
  const key = bindings.globeKey.value;
  getGridType.mockClear();
  let detect!: (gridType: T_GRID_TYPES) => void;
  getGridType.mockImplementationOnce(
    () => new Promise((resolve) => (detect = resolve))
  );

  store.selectLevel(2);
  await nextTick();
  await nextTick();
  expect(store.varnameSelector).toBe("2/tas");
  // one detection, from the level change, and no remount for the rename
  expect(getGridType).toHaveBeenCalledOnce();
  // the detection keeps the level it started on, should another be picked
  store.selectLevel(1);
  await nextTick();
  expect(getGridType.mock.calls[0][2].selectedLevel).toBe(2);
  detect(GRID_TYPES.REGULAR);
  await vi.waitFor(() => expect(getGridType).toHaveBeenCalledTimes(2));
  await nextTick();
  expect(bindings.globeKey.value).toBe(key);
});

it("takes the controller's variable onto the display's own level", async () => {
  location.search = "?mode=display";
  const { store } = await openGlobe({ varname: "0/tas" });
  store.stopLoading();
  const controller = new BroadcastChannel("gridlook-presenter");
  try {
    controller.postMessage({
      type: "state-update",
      payload: { varnameSelector: "2/pr" },
    });
    await vi.waitFor(() => expect(store.varnameSelector).toBe("0/pr"));
    expect(store.selectedLevel).toBe(0);
  } finally {
    controller.close();
  }
});

it("takes the controller's level toggles, null as the variable's default", async () => {
  location.search = "?mode=display";
  const { store } = await openGlobe({ varname: "0/tas" });
  store.stopLoading();
  const controller = new BroadcastChannel("gridlook-presenter");
  try {
    controller.postMessage({
      type: "state-update",
      payload: { levelWhole: true, levelRangeShared: false },
    });
    await vi.waitFor(() => expect(store.levelRangeShared).toBe(false));
    expect(store.levelWhole).toBe(true);
    controller.postMessage({
      type: "state-update",
      payload: { levelRangeShared: null },
    });
    await vi.waitFor(() => expect(store.levelRangeShared).toBeUndefined());
    expect(store.levelWhole).toBe(true);
  } finally {
    controller.close();
  }
});
