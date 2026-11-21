import { expect, it, vi } from "vitest";

vi.mock("@/store/store.ts", () => ({
  useGlobeControlStore: () => ({
    varnameSelector: "tas",
    varinfo: { dimRanges: [{ name: "time" }] },
    dimSlidersValues: [0],
  }),
}));
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
});

const { createPinia, setActivePinia } = await import("pinia");
const { useAnalysisStore } = await import("@/store/analysisStore.ts");

it("a deferred link write without an address does not throw", async () => {
  vi.stubGlobal("location", { hash: "", pathname: "/", search: "" });
  vi.stubGlobal("history", { replaceState: () => undefined });
  setActivePinia(createPinia());
  const analysis = useAnalysisStore();
  analysis.writeLinkSoon();
  vi.unstubAllGlobals();
  const thrown: unknown[] = [];
  const catcher = (error: unknown) => thrown.push(error);
  process.on("uncaughtException", catcher);
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.off("uncaughtException", catcher);
  expect(thrown).toEqual([]);
});
