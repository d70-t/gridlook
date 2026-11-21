/**
 * Its own module state: other store tests keep runs (and run slots) in flight,
 * which held this plot's first read.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

const client = vi.hoisted(() => ({
  describeVariable: vi.fn(),
  planRun: vi.fn(),
  executeRun: vi.fn(),
  cancelRun: vi.fn(),
  releaseSource: vi.fn(),
  setRunPaused: vi.fn(),
  sourcePublished: vi.fn(),
}));

vi.mock("@/lib/analysis/analysisClient.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/analysis/analysisClient.ts")
  >()),
  ...client,
}));

vi.mock("@/store/store.ts", () => ({
  useGlobeControlStore: () => ({
    varnameSelector: "tas",
    varinfo: { dimRanges: [{ name: "time" }] },
    dimSlidersValues: [3],
  }),
}));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});
const page = {
  hash: "#https://example.org/data.zarr",
  pathname: "/",
  search: "",
};
vi.stubGlobal("location", page);
vi.stubGlobal("history", {
  replaceState: (_: unknown, __: string, url: string) => {
    page.hash = url.slice(url.indexOf("#"));
  },
});

const { createPinia, setActivePinia } = await import("pinia");
const { useAnalysisStore } = await import("@/store/analysisStore.ts");
const { ANALYSIS_KINDS } = await import("@/lib/analysis/types.ts");
const { rowIndices } = await import("@/lib/analysis/timeRows.ts");

const summary = {
  variable: "tas",
  dims: ["time", "cell"],
  shape: [4, 768],
  gridLabel: "HEALPix order 3",
  order: 3,
  conflicts: [],
  time: {
    dimension: "time",
    raw: [0, 1, 2, 3],
    units: "days since 2000-01-01",
    calendar: "standard",
  },
  others: [],
  capabilities: {
    [ANALYSIS_KINDS.POINT_SERIES]: { available: true },
    [ANALYSIS_KINDS.REGION_SERIES]: { available: true },
    [ANALYSIS_KINDS.PROFILE]: {
      available: false,
      reason: "The variable has no vertical dimension.",
    },
    [ANALYSIS_KINDS.SECTION]: {
      available: false,
      reason: "The variable has no vertical dimension.",
    },
  },
  decoding: "",
  overviews: [],
};

const source = {
  key: "src#1",
  store: "https://example.org/data.zarr",
  dataset: "",
  format: 3 as const,
};
const ref = {
  ref: "https://example.org/data.zarr",
  versionStatus: "best-effort" as const,
};
const rect = { x: 0, y: 0, w: 400, h: 300 };
const map = { variable: "tas", indices: { time: 2 } };

beforeEach(() => {
  setActivePinia(createPinia());
  Object.values(client).forEach((fn) => fn.mockReset());
  client.describeVariable.mockResolvedValue(summary);
  client.planRun.mockResolvedValue({
    chunks: 1,
    decodedBytes: 8,
    workingBytes: 8,
    outputValues: 4,
    modest: true,
    notes: [],
  });
});

function store() {
  const analysis = useAnalysisStore();
  analysis.setActiveSource(source, ref, "Example");
  return analysis;
}

const clickDate = vi.hoisted(() => [] as ((day: number) => void)[]);
const pickerLimits = vi.hoisted(() => [] as number[][]);
vi.mock("@vuepic/vue-datepicker", async () => {
  const { defineComponent } = await import("vue");
  return {
    VueDatePicker: defineComponent({
      props: { minDate: Date, maxDate: Date },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        clickDate.push((day) =>
          emit("update:modelValue", new Date(2000, 0, day))
        );
        pickerLimits.push([props.minDate!.getDate(), props.maxDate!.getDate()]);
        return () => null;
      },
    }),
  };
});

async function expectAllDatesSelectable(raw: number[]) {
  pickerLimits.length = 0;
  clickDate.length = 0;
  const analysis = store();
  const time = { ...summary.time, raw };
  client.describeVariable.mockResolvedValue({ ...summary, time });
  await analysis.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 20, lon: 10 },
    map,
    rect
  );
  const { default: PlotSettings } =
    await import("@/ui/analysis/PlotSettings.vue");
  const { getActivePinia } = await import("pinia");
  const app = createSSRApp(PlotSettings, { plot: analysis.windows[0] });
  await renderToString(app.use(getActivePinia()!));
  expect(pickerLimits).toEqual([
    [1, 4],
    [1, 4],
  ]);
  return analysis.windows[0];
}

it("allows every source date in the plot calendar when dates are stored descending", async () => {
  await expectAllDatesSelectable([3, 2, 1, 0]);
});

it("allows an interior file date outside both stored endpoints in the plot calendar", async () => {
  await expectAllDatesSelectable([1, 3, 0, 2]);
});

it("selects all three dates from January 1 through January 3 on a descending series", async () => {
  const dates = [3, 2, 1, 0];
  const plot = await expectAllDatesSelectable(dates);
  clickDate[0](1);
  clickDate[1](3);
  const { start, stop } = plot.draft.time!;
  expect(dates.slice(start, stop).sort((a, b) => a - b)).toEqual([0, 1, 2]);
});

it("reads only January 1 through January 3 when the source stores January 4 in between", async () => {
  // Rewritten to the selection of several stored slices (25 Nov): no one
  // slice holds Jan 1 to Jan 3 alone, so the range is the slices [0, 1)
  // and [2, 4), and those are what the engine is asked to read.
  const dates = [0, 3, 1, 2];
  const plot = await expectAllDatesSelectable(dates);
  clickDate[0](1);
  clickDate[1](3);
  const time = plot.draft.time!;
  expect(rowIndices(time).map((at) => dates[at])).toEqual([0, 1, 2]);
  expect(time.runs).toEqual([
    [0, 1],
    [2, 4],
  ]);
  const analysis = useAnalysisStore();
  client.planRun.mockClear();
  await analysis.apply(plot.id);
  await vi.waitFor(() => expect(client.planRun).toHaveBeenCalled());
  const asked = client.planRun.mock.calls.at(-1)![2];
  expect(rowIndices(asked.time).map((at: number) => dates[at])).toEqual([
    0, 1, 2,
  ]);
});
