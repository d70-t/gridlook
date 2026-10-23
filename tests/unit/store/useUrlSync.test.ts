import { expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useUrlSync } = await import("@/store/useUrlSync.ts");

it("writes the layer stack and drops the legacy mask parameters", async () => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  const location = {
    pathname: "/",
    hash: "#https://example.test/data.zarr::varname=temperature::maskmode=off",
  };
  vi.stubGlobal("location", location);
  vi.stubGlobal("document", { location });
  vi.stubGlobal("history", {
    replaceState: (_state: unknown, _title: string, url: string) => {
      location.hash = url.slice(url.indexOf("#"));
    },
  });
  const store = useGlobeControlStore();
  store.varnameSelector = "temperature";
  store.setStreamlineLayerEnabled(true);
  const scope = effectScope();
  scope.run(useUrlSync);
  const flush = async () => {
    await nextTick();
    vi.advanceTimersByTime(100);
  };
  try {
    store.setStreamlineMagnitudeDisplayed(true);
    await flush();
    expect(location.hash).toContain(
      "::layers=streamlines,1,0.55,,,1;coastlines;grid"
    );
    expect(location.hash).toContain("::varname=temperature");
    expect(location.hash).not.toContain("maskmode");

    // the request is shared even when the magnitude cannot be derived
    store.setStreamlineMagnitudeInfo(undefined);
    await flush();
    expect(store.streamlineMagnitudeDisplayed).toBe(false);
    expect(location.hash).toContain("::layers=streamlines,1,0.55,,,1;");

    store.setStreamlineLayerEnabled(false);
    await flush();
    expect(location.hash).toContain("::layers=streamlines,0;coastlines;grid");

    store.removeLayer("streamlines");
    await flush();
    expect(location.hash).not.toContain("layers");
    expect(location.hash).toContain("::varname=temperature");
  } finally {
    scope.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it("writes the level toggles only when they are not at their default", async () => {
  setActivePinia(createPinia());
  const location = { pathname: "/", hash: "#https://example.test/p.zarr" };
  vi.stubGlobal("location", location);
  vi.stubGlobal("document", { location });
  vi.stubGlobal("history", {
    replaceState: (_state: unknown, _title: string, url: string) => {
      location.hash = url.slice(url.indexOf("#"));
    },
  });
  const store = useGlobeControlStore();
  const scope = effectScope();
  scope.run(useUrlSync);
  try {
    store.setLevelWhole(true);
    store.setLevelRangeShared(false);
    await nextTick();
    expect(location.hash).toContain("::levelwhole=true");
    expect(location.hash).toContain("::levelshared=false");

    store.setLevelWhole(false);
    store.setLevelRangeShared(true);
    await nextTick();
    expect(location.hash).not.toContain("levelwhole");
    expect(location.hash).not.toContain("levelshared");

    // a variable that sums over cells has its levels' ranges apart by default
    store.updateVarInfo(
      {
        dimInfo: [],
        bounds: {},
        dimRanges: [],
        attrs: { cell_methods: "area: sum" }, // eslint-disable-line camelcase
      },
      []
    );
    store.setLevelRangeShared(true);
    await nextTick();
    expect(location.hash).toContain("::levelshared=true");
  } finally {
    scope.stop();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", { getItem: () => null });
  }
});
