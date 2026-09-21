import { beforeEach, expect, it, vi } from "vitest";
import { createSSRApp, effectScope, nextTick, reactive, type Ref } from "vue";
import { renderToString } from "vue/server-renderer";
import { NotFoundError } from "zarrita";

import { GRID_TYPES } from "@/lib/data/gridTypeDetector.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import type { TTimeInfo } from "@/ui/overlays/infoPanel/types.ts";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.stubGlobal("localStorage", { getItem: () => null });
vi.mock("vue", async (original) => ({
  ...(await original<typeof import("vue")>()),
  useSSRContext: () => ({}),
}));
vi.mock("@/lib/data/variableQuery.ts", () => ({
  default: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/ui/common/useLog.ts", () => ({ useLog: () => ({ logError }) }));
vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getGroup: vi.fn().mockResolvedValue({ attrs: {} }),
    getVariableInfo: vi.fn(),
    getDimensionNames: vi.fn(),
    resolveVariablePath: (_variable: string, dimension: string) => dimension,
    getVariableDataFromArray: vi
      .fn()
      .mockResolvedValue({ data: new Float64Array([0, 24]) }),
  },
}));

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { ZarrDataManager } = await import("@/lib/data/ZarrDataManager.ts");
const { default: InfoPanel } = await import("@/ui/overlays/InfoPanel.vue");
const { default: TimeDimensionSection } =
  await import("@/ui/overlays/infoPanel/TimeDimensionSection.vue");
const source = { store: "data.zarr", dataset: "" };
const otherSource = { store: "coordinates.zarr", dataset: "" };
const sources: TSources = {
  ["zarr_format"]: ZARR_FORMAT.V3,
  levels: [{ time: source, grid: source, datasources: { tas: source } }],
};
const variable = {
  attrs: { units: "hours since 2000-01-01" },
  shape: [2],
  chunks: [2],
  dtype: "float64",
} as unknown as Awaited<ReturnType<typeof ZarrDataManager.getVariableInfo>>;

type TPanelState = {
  timeInfo: Ref<TTimeInfo | null>;
  noTimeCoordinate: Ref<boolean>;
  variableDtype: Ref<string | null>;
  isSourceDifferent: (source?: typeof otherSource) => boolean;
};

beforeEach(() => {
  setActivePinia(createPinia());
  const store = useGlobeControlStore();
  store.varnameDisplay = "tas";
  store.loading = false;
  logError.mockClear();
  vi.mocked(ZarrDataManager.getDimensionNames)
    .mockReset()
    .mockResolvedValue(["time"]);
  vi.mocked(ZarrDataManager.getVariableInfo)
    .mockReset()
    .mockResolvedValue(variable);
});

function setupPanel(datasources: TSources | undefined = sources) {
  const props = reactive({
    datasources: datasources as TSources | undefined,
    isOpen: true,
    gridType: GRID_TYPES.TRIANGULAR,
    onClose: undefined,
    onSelectGridType: undefined,
  });
  const scope = effectScope();
  const state = scope.run(() =>
    InfoPanel.setup!(props, {
      expose: vi.fn(),
      attrs: {},
      slots: {},
      emit: vi.fn(),
    })
  ) as unknown as TPanelState;
  return { props, scope, state };
}

it("shows source differences only after load and when both sources are known", async () => {
  const store = useGlobeControlStore();
  store.loading = true;
  const { state, scope, props } = setupPanel();
  try {
    expect(state.isSourceDifferent(otherSource)).toBe(false);
    store.loading = false;
    await vi.waitFor(() => expect(state.variableDtype.value).toBe("float64"));
    expect(state.isSourceDifferent(otherSource)).toBe(true);
    expect(state.isSourceDifferent(source)).toBe(false);
    expect(state.isSourceDifferent(undefined)).toBe(false);
    props.datasources = undefined;
    await nextTick();
    expect(state.isSourceDifferent(otherSource)).toBe(false);
    expect(state.noTimeCoordinate.value).toBe(false);
  } finally {
    scope.stop();
  }
});

it("reports no time coordinate when the variable has no time dimension", async () => {
  vi.mocked(ZarrDataManager.getDimensionNames).mockResolvedValue(["cell"]);
  const { state, scope } = setupPanel();
  try {
    await vi.waitFor(() => expect(state.noTimeCoordinate.value).toBe(true));
    expect(logError).not.toHaveBeenCalled();
    const html = await renderToString(
      createSSRApp(TimeDimensionSection, {
        timeInfo: null,
        noTimeCoordinate: true,
      })
    );
    expect(html).toContain("No time coordinate variable is available");
  } finally {
    scope.stop();
  }
});

it.each([
  new NotFoundError("time"),
  new Error("NetCDF variable not found: /time"),
])("does not toast for an absent time coordinate: %s", async (error) => {
  vi.mocked(ZarrDataManager.getVariableInfo).mockImplementation(
    async (_source, name) => {
      if (name === "time") {
        throw error;
      }
      return variable;
    }
  );
  const { state, scope } = setupPanel();
  try {
    await vi.waitFor(() => expect(state.noTimeCoordinate.value).toBe(true));
    expect(state.timeInfo.value).toBeNull();
    expect(logError).not.toHaveBeenCalled();
  } finally {
    scope.stop();
  }
});

it("still reports real failures when fetching a time coordinate", async () => {
  const error = new Error("Network unavailable");
  vi.mocked(ZarrDataManager.getVariableInfo).mockImplementation(
    async (_source, name) => {
      if (name === "time") {
        throw error;
      }
      return variable;
    }
  );
  const { state, scope } = setupPanel();
  try {
    await vi.waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        error,
        "Error fetching time dimension info"
      )
    );
    expect(state.noTimeCoordinate.value).toBe(false);
  } finally {
    scope.stop();
  }
});

it("shows valid time coverage without an absence message", async () => {
  const { state, scope } = setupPanel();
  try {
    await vi.waitFor(() => expect(state.timeInfo.value?.numTimesteps).toBe(2));
    expect(state.timeInfo.value?.firstTimestamp).toBe("2000-01-01 00:00:00");
    expect(state.noTimeCoordinate.value).toBe(false);
    expect(logError).not.toHaveBeenCalled();
  } finally {
    scope.stop();
  }
});

it("ignores an old time-coordinate result after loading another dataset starts", async () => {
  let rejectTime!: (error: Error) => void;
  const pending = new Promise<typeof variable>((_resolve, reject) => {
    rejectTime = reject;
  });
  vi.mocked(ZarrDataManager.getVariableInfo).mockImplementation(
    async (_source, name) => (name === "time" ? pending : variable)
  );
  const { state, scope } = setupPanel();
  try {
    await vi.waitFor(() =>
      expect(ZarrDataManager.getVariableInfo).toHaveBeenCalledWith(
        source,
        "time"
      )
    );
    useGlobeControlStore().loading = true;
    await nextTick();
    rejectTime(new NotFoundError("time"));
    await nextTick();
    await nextTick();
    expect(state.noTimeCoordinate.value).toBe(false);
    expect(logError).not.toHaveBeenCalled();
  } finally {
    scope.stop();
  }
});

it("recognizes time metadata on a dimension with a nonstandard name", async () => {
  vi.mocked(ZarrDataManager.getDimensionNames).mockResolvedValue(["sample"]);
  const { state, scope } = setupPanel({
    ...sources,
    levels: [
      {
        ...sources.levels[0],
        datasources: {
          tas: source,
          sample: { ...source, attrs: { axis: "T" } },
        },
      },
    ],
  });
  try {
    await vi.waitFor(() => expect(state.timeInfo.value?.numTimesteps).toBe(2));
    expect(state.noTimeCoordinate.value).toBe(false);
  } finally {
    scope.stop();
  }
});

it("places source notices in Overview before the Browse content", async () => {
  const html = await renderToString(
    createSSRApp(
      {
        ...InfoPanel,
        setup(
          props: Parameters<NonNullable<typeof InfoPanel.setup>>[0],
          context: Parameters<NonNullable<typeof InfoPanel.setup>>[1]
        ) {
          const state = InfoPanel.setup!(
            props,
            context
          ) as unknown as TPanelState;
          state.variableDtype.value = "float64";
          state.timeInfo.value = {
            units: "hours",
            calendar: "standard",
            numTimesteps: 2,
            timestep: "1 day",
            firstTimestamp: "2000-01-01",
            lastTimestamp: "2000-01-02",
          };
          return state;
        },
      },
      {
        isOpen: false,
        datasources: {
          ...sources,
          levels: [
            { ...sources.levels[0], time: otherSource, grid: otherSource },
          ],
        },
      }
    )
  );
  const browse = html.indexOf('placeholder="Search variables and coordinates');
  for (const notice of [
    "Time variable is from a different file",
    "Grid related dimensions are from a different file",
  ]) {
    expect(html.indexOf(notice)).toBeGreaterThan(-1);
    expect(html.indexOf(notice)).toBeLessThan(browse);
  }
});
