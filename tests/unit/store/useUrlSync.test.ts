import { expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useUrlSync } = await import("@/store/useUrlSync.ts");

it("shares the magnitude request while retaining the underlying scalar", async () => {
  setActivePinia(createPinia());
  const location = {
    pathname: "/",
    hash: "#https://example.test/data.zarr::varname=temperature::streamlines=true",
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
  try {
    store.setStreamlineMagnitudeDisplayed(true);
    await nextTick();
    expect(location.hash).toContain("::streamlinemagnitude=true");
    expect(location.hash).toContain("::varname=temperature");

    store.setStreamlineMagnitudeInfo(undefined);
    await nextTick();
    expect(store.streamlineMagnitudeDisplayed).toBe(false);
    expect(location.hash).toContain("::streamlinemagnitude=true");

    store.setStreamlineMagnitudeDisplayed(false);
    await nextTick();
    expect(location.hash).not.toContain("streamlinemagnitude");

    store.setStreamlineMagnitudeDisplayed(true);
    await nextTick();
    store.setStreamlineLayerEnabled(false);
    await nextTick();
    expect(location.hash).not.toContain("streamlinemagnitude");
    expect(location.hash).toContain("::varname=temperature");
  } finally {
    scope.stop();
    vi.unstubAllGlobals();
  }
});
