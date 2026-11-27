import { expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
vi.stubGlobal("location", { hash: "", pathname: "/", search: "" });

const {
  boxFrom,
  cascadeRect,
  isReading,
  maximizedRect,
  pendingChanges,
  titleBarInset,
} = await import("@/ui/analysis/plotLayout.ts");
const { PLOT_STATUS } = await import("@/store/analysisStore.ts");
const { ANALYSIS_KINDS } = await import("@/lib/analysis/types.ts");
type TWindow = Parameters<typeof pendingChanges>[0];

it("a latitude–pressure bin width edited on its own is a change to apply", () => {
  const geometry = { kind: "box", west: 0, east: 10, south: -5, north: 5 };
  const committed = {
    version: 1,
    kind: ANALYSIS_KINDS.LAT_VERTICAL,
    source: { ref: "r", versionStatus: "session" },
    variable: "ta",
    geometry,
    time: { start: 0, stop: 1 },
    fixed: {},
    binDegrees: 1,
  };
  const w = {
    kind: ANALYSIS_KINDS.LAT_VERTICAL,
    committed,
    draft: { ...committed, sectionSamples: 400, binDegrees: 2.5 },
  } as unknown as TWindow;
  expect(pendingChanges(w)).toEqual(["bin width"]);
});

it("an untouched request without a date range has no pending edit beside its whole range", () => {
  const committed = {
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    source: { ref: "r", versionStatus: "session" },
    variable: "tas",
    geometry: { kind: "point", lat: 1, lon: 2 },
    fixed: {},
  };
  const summary = { time: { raw: [0, 1, 2, 3] } };
  const w = {
    kind: ANALYSIS_KINDS.POINT_SERIES,
    committed: { ...committed, time: { start: 1, stop: 2 } },
    // The first dates are shown of the request as asked: every date.
    preview: { intent: { ...committed, time: { start: 0, stop: 4 } } },
    draft: committed,
    summary,
  } as unknown as TWindow;
  expect(pendingChanges(w)).toEqual([]);
  // A range other than the whole one is an edit.
  const edited = {
    ...w,
    draft: { ...committed, time: { start: 0, stop: 3 } },
  } as unknown as TWindow;
  expect(pendingChanges(edited)).toEqual(["time"]);
});

it("expanding a plot keeps the app's title bar and sidebar toggle in reach", () => {
  // Sidebar collapsed: the map starts at the page's left, under the bar.
  const top = titleBarInset({ left: 0, top: 0 });
  expect(top).toBe(56);
  expect(maximizedRect({ width: 1134, height: 736, top })).toEqual({
    x: 0,
    y: 56,
    w: 1134,
    // Plotting tools keeps its room below.
    h: 680 - 68,
  });
  // Sidebar open: the map starts right of the bar; the whole map is used.
  expect(titleBarInset({ left: 384, top: 0 })).toBe(0);
  expect(maximizedRect({ width: 750, height: 736 })).toEqual({
    x: 0,
    y: 0,
    w: 750,
    h: 736 - 68,
  });
});

it("a dragged box spans its two corners the shorter way round", () => {
  expect(boxFrom({ lat: 50, lon: 5 }, { lat: 40, lon: 20 })).toEqual({
    kind: "box",
    west: 5,
    east: 20,
    south: 40,
    north: 50,
  });
  // Dragged across the antimeridian: 170° E to 170° W is 20° wide.
  expect(boxFrom({ lat: -10, lon: 170 }, { lat: 10, lon: -170 })).toEqual({
    kind: "box",
    west: 170,
    east: -170,
    south: -10,
    north: 10,
  });
});

it("a plot still reading asks before closing from the list; a finished one does not", () => {
  const reading = Object.values(PLOT_STATUS).filter((status) =>
    isReading({ status } as unknown as TWindow)
  );
  expect(reading.sort()).toEqual(
    [
      PLOT_STATUS.LOADING,
      PLOT_STATUS.PLANNING,
      PLOT_STATUS.QUEUED,
      PLOT_STATUS.RUNNING,
    ].sort()
  );
  expect(isReading({ status: PLOT_STATUS.DONE } as unknown as TWindow)).toBe(
    false
  );
});

it("a distribution opens large enough for its choices, summary and bars", () => {
  const area = { width: 1600, height: 1000 };
  const rect = cascadeRect(ANALYSIS_KINDS.DISTRIBUTION, area, 0);
  expect(rect.w).toBe(560);
  expect(rect.h).toBe(460);
  // Still inside a short map (a narrow one takes it whole anyway).
  const short = cascadeRect(
    ANALYSIS_KINDS.DISTRIBUTION,
    { width: 1200, height: 400 },
    0
  );
  expect(short.h).toBe(376);
});

it("finds the map's date and level on a plot of another store by value, not by position", async () => {
  const { correspondingIndex } = await import("@/ui/analysis/plotLayout.ts");
  // The map's store holds [Jan 1, Jan 2] and [1000, 500] hPa; the plot's
  // the reverse, in other units.
  const mapTime = { values: [0, 1], units: "days since 2000-01-01" };
  const plotTime = { values: [24, 0], units: "hours since 2000-01-01" };
  expect(correspondingIndex(mapTime, 0, plotTime, "time")).toBe(1);
  expect(correspondingIndex(mapTime, 1, plotTime, "time")).toBe(0);
  const mapLevel = { values: [1000, 500], units: "hPa" };
  const plotLevel = { values: [50000, 100000], units: "Pa" };
  expect(correspondingIndex(mapLevel, 0, plotLevel, "level")).toBe(1);
  // No such date on the plot: none, not position 0.
  expect(
    correspondingIndex({ ...mapTime, values: [5, 6] }, 0, plotTime, "time")
  ).toBeUndefined();
  // The map's own coordinate: its position.
  expect(correspondingIndex(mapTime, 1, mapTime, "time")).toBe(1);
});
