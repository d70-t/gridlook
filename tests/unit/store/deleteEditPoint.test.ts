// Deleting a point while editing a shape: the point is selected first
// (numbered on the map), then deleted from the edit bar, its menu or the
// Delete key; all three call the store, which keeps an area at 3 points.
import { beforeEach, expect, it, vi } from "vitest";

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
const { GEOMETRY_KINDS } = await import("@/lib/analysis/types.ts");

const square = [
  { lat: 0, lon: 0 },
  { lat: 0, lon: 10 },
  { lat: 10, lon: 10 },
  { lat: 10, lon: 0 },
];

function editing() {
  const analysis = useAnalysisStore();
  analysis.windows = [
    {
      id: "p1",
      label: "Plot 1",
      minimized: false,
      draft: {
        geometry: { kind: GEOMETRY_KINDS.POLYGON, vertices: [...square] },
      },
    } as unknown as (typeof analysis.windows)[number],
  ];
  analysis.startShapeEdit("p1");
  return analysis;
}
const vertices = (analysis: ReturnType<typeof useAnalysisStore>) =>
  (analysis.windows[0].draft.geometry as { vertices: typeof square }).vertices;

beforeEach(() => setActivePinia(createPinia()));

it("deletes the selected point, and only that one", () => {
  const analysis = editing();
  analysis.deleteEditPoint();
  expect(vertices(analysis)).toHaveLength(4); // nothing selected

  analysis.selectEditPoint(2);
  expect(analysis.shapeEdit?.selected).toBe(2);
  analysis.deleteEditPoint();
  expect(vertices(analysis)).toEqual([square[0], square[1], square[3]]);
  expect(analysis.shapeEdit?.selected).toBeUndefined();
});

it("keeps an area at three points", () => {
  const analysis = editing();
  analysis.selectEditPoint(0);
  analysis.deleteEditPoint();
  analysis.selectEditPoint(0);
  analysis.deleteEditPoint();
  expect(vertices(analysis)).toHaveLength(3);
  expect(analysis.shapeEdit?.selected).toBe(0);
});

it("starts a new edit with no point selected", () => {
  const analysis = editing();
  analysis.selectEditPoint(1);
  analysis.endShapeEdit(false);
  analysis.startShapeEdit("p1");
  expect(analysis.shapeEdit?.selected).toBeUndefined();
});
