import { Grid } from "healpix-geo";
import { beforeEach, expect, it, vi } from "vitest";
import { effectScope } from "vue";

import {
  PATHLINE_GRID,
  samplePathlineTime,
  type TPathlineGrid,
} from "@/lib/data/pathlineField.ts";
import {
  pathlineGeographic,
  PATHLINE_WGS84,
} from "@/lib/data/pathlineIntegration.ts";
import {
  integratePathlines,
  pathlinePositionAt,
  planPathlineTrajectories,
  type TPathlineConfig,
} from "@/lib/data/pathlineTrajectories.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { getGridVariableData } from "@/lib/grids/gridDataWorkerClient.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import {
  planPathlinePreparation,
  extendPathlineEstimate,
} from "@/ui/grids/composables/pathlinePreparation.ts";
import type { TPreparedScalarFrame } from "@/ui/grids/composables/scalarFrame.ts";
import { scalarFrameMemory } from "@/ui/grids/composables/scalarFrameMemory.ts";
import {
  useScalarBake,
  SCALAR_BAKE_PHASE,
} from "@/ui/grids/composables/useScalarBake.ts";

vi.mock("@/lib/grids/gridDataWorkerClient.ts", () => ({
  getGridVariableData: vi.fn(),
}));
vi.stubGlobal("localStorage", { getItem: () => null });
const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const source = { store: "vectors.zarr", dataset: "" };
const sources: TSources = {
  ["zarr_format"]: ZARR_FORMAT.V2,
  levels: [
    {
      grid: source,
      time: source,
      datasources: { scalar: source, u: source, v: source },
    },
  ],
};
const pathlineConfig: TPathlineConfig = {
  particleCount: 3,
  randomSeed: 17,
  sampleSeconds: 600,
  maxStepSeconds: 60,
  maxStepMetres: 1000,
  errorToleranceMetres: 1,
  lifetimeSeconds: 1800,
  respawn: true,
};
const axis = new Float32Array([0, 1]);
const regular: TPathlineGrid = {
  kind: PATHLINE_GRID.REGULAR,
  x: axis,
  y: axis,
};
const points: TPathlineGrid = {
  kind: PATHLINE_GRID.POINTS,
  latitudes: new Float32Array([0, 0, 1, 1]),
  longitudes: new Float32Array([0, 1, 0, 1]),
};
const hp = new Grid({ level: 0, scheme: "nested" });
const cases = [
  { name: "regular", grid: regular, spatial: ["y", "x"], shape: [2, 2] },
  {
    name: "projected regular",
    grid: {
      kind: PATHLINE_GRID.PROJECTED,
      x: new Float32Array([-111319, 111319]),
      y: new Float32Array([-111325, 111325]),
      crs: "EPSG:3857",
    } as TPathlineGrid,
    spatial: ["y", "x"],
    shape: [2, 2],
  },
  {
    name: "rotated regular",
    grid: {
      kind: PATHLINE_GRID.PROJECTED,
      x: new Float32Array([-180, 180]),
      y: new Float32Array([-89, 89]),
      crs: "+proj=ob_tran +o_proj=longlat +o_lat_p=39.25 +o_lon_p=0 +lon_0=18 +datum=WGS84",
    } as TPathlineGrid,
    spatial: ["y", "x"],
    shape: [2, 2],
  },
  { name: "curvilinear", grid: points, spatial: ["y", "x"], shape: [2, 2] },
  { name: "triangular", grid: points, spatial: ["cell"], shape: [4] },
  { name: "Gaussian reduced", grid: points, spatial: ["cell"], shape: [4] },
  { name: "irregular", grid: points, spatial: ["cell"], shape: [4] },
  { name: "Delaunay", grid: points, spatial: ["cell"], shape: [4] },
  {
    name: "HEALPix",
    grid: { kind: PATHLINE_GRID.HEALPIX, grid: hp } as TPathlineGrid,
    spatial: ["cell"],
    shape: [12],
  },
];

// eslint-disable-next-line max-lines-per-function
function setup(test = cases[0]) {
  const dimensions = ["time", "pressure", ...test.spatial];
  const shape = [3, 2, ...test.shape];
  const time = {
    values: [0, 2, 5],
    attrs: { units: "hours since 2000-01-01" },
  };
  const state = {
    current: true,
    gate: undefined as Promise<void> | undefined,
    badUnits: false,
    shiftedTime: false,
    badLevel: false,
  };
  const variable = (name: string) => ({
    shape,
    chunks: [1, 1, ...test.shape],
    dtype: "float32",
    attrs: {
      ["standard_name"]: name === "u" ? "eastward_wind" : "northward_wind",
      units: state.badUnits ? "K" : name === "u" ? "cm/s" : "m s-1",
    },
  });
  vi.spyOn(ZarrDataManager, "getVariableInfo").mockImplementation(
    async (_source, name) => {
      const value =
        name === "time"
          ? {
              shape: [3],
              attrs: time.attrs,
              values: state.shiftedTime ? [0, 3, 5] : time.values,
            }
          : name === "pressure"
            ? {
                shape: [2],
                attrs: { units: "hPa", axis: "Z" },
                values: state.badLevel ? [1000] : [1000, 850],
              }
            : variable(name);
      return value as unknown as Awaited<
        ReturnType<typeof ZarrDataManager.getVariableInfo>
      >;
    }
  );
  vi.spyOn(ZarrDataManager, "getDimensionNames").mockResolvedValue(dimensions);
  vi.spyOn(ZarrDataManager, "getVariableDataFromArray").mockImplementation(
    async (array) =>
      ({ data: (array as unknown as { values: number[] }).values }) as never
  );
  vi.mocked(getGridVariableData).mockImplementation(async (request) => {
    await state.gate;
    const count = test.shape.reduce((a, b) => a * b, 1);
    return new Float32Array(count).fill(
      request.variable === "u" ? 100 * (Number(request.selection[0]) + 1) : 4
    );
  });
  const frame: TPreparedScalarFrame = {
    name: "scalar",
    data: new Float32Array(4),
    indices: [0, 0],
    info: {
      attrs: {},
      bounds: { low: 0, high: 1 },
      dimInfo: [{ ...time, current: 0 }],
      dimRanges: [
        { name: "time", minBound: 0, maxBound: 2, startPos: 0 },
        { name: "pressure", minBound: 0, maxBound: 1, startPos: 0 },
        ...test.spatial.map(() => null),
      ],
    },
    pathlineGrid: {
      grid: test.grid,
      spatialDimensionNames: test.spatial,
      spatialShape: test.shape,
    },
    isCurrent: () => state.current,
    updateLayers: async () => {},
    render: () => {},
    timing: { totalMs: 10, fetchMs: 5 },
    memory: scalarFrameMemory(undefined, new Float32Array(4)),
  };
  const options: Parameters<typeof planPathlinePreparation>[0] = {
    sources,
    pair: { u: "u", v: "v", kind: "u/v" },
    levelIndex: 1,
    timeName: "time",
    timeDimension: 0,
    config: { start: 0, end: 2 },
    frame,
    selection: {},
    isCurrent: () => state.current,
  };
  return { options, frame, state, shape };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(getGridVariableData).mockReset();
  setActivePinia(createPinia());
});

it.each(cases)(
  "plans and prepares physical velocity on $name with bounded reads",

  async (test) => {
    const h = setup(test);
    const plan = await planPathlinePreparation(h.options);
    expect(getGridVariableData).not.toHaveBeenCalled();
    expect(plan.times).toEqual([0, 7200, 18000]);
    const prepared = await plan.prepare(1);
    const velocity = prepared.field.sample(0, 0)!;
    expect(velocity.u).toBeCloseTo(2);
    expect(velocity.v).toBeCloseTo(4);
    expect(velocity.speed).toBeCloseTo(Math.hypot(2, 4));
    expect(prepared.memory.gpuBytes).toBe(0);
    expect(getGridVariableData).toHaveBeenCalledTimes(2);
    expect(getGridVariableData).toHaveBeenCalledWith(
      expect.objectContaining({
        variable: "u",
        selection: [1, 1, ...test.spatial.map(() => null)],
        chunkConcurrency: 1,
      })
    );
    const estimate = {
      count: 3,
      retainedBytes: 100,
      peakBytes: 0,
      gpuBytes: 40,
      workingBytes: 20,
      sourceWorkingBytes: 20,
      uniqueChunks: 0,
      decodedBytes: 0,
      secondsLow: 0,
      secondsHigh: 0,
    };
    extendPathlineEstimate(
      estimate,
      plan,
      prepared,
      new Set(plan.sharedMemory.buffers),
      planPathlineTrajectories([0, 10], pathlineConfig).bytes
    );
    const fieldBytes = test.shape.reduce((a, b) => a * b, 1) * 8;
    expect(estimate.retainedBytes).toBe(
      100 +
        plan.sharedMemory.extraBytes +
        3 * fieldBytes +
        planPathlineTrajectories([0, 10], pathlineConfig).bytes
    );
    expect(estimate.gpuBytes).toBe(40);
    expect(estimate.peakBytes).toBe(
      (estimate.retainedBytes + estimate.workingBytes) * 1.25
    );
  }
);

it.each(["badUnits", "shiftedTime", "badLevel"] as const)(
  "rejects %s while planning without fetching velocity data",
  async (key) => {
    const h = setup();
    h.state[key] = true;
    await expect(planPathlinePreparation(h.options)).rejects.toThrow();
    expect(getGridVariableData).not.toHaveBeenCalled();
  }
);

it.each(cases)(
  "discards a cancelled $name fetch before starting the next component",

  async (test) => {
    const h = setup(test);
    const plan = await planPathlinePreparation(h.options);
    let release!: () => void;
    h.state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = plan.prepare(0);
    h.state.current = false;
    release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(getGridVariableData).toHaveBeenCalledTimes(1);
  }
);

it.each(
  cases.flatMap((grid) =>
    [false, true].map((trajectories) => ({ ...grid, trajectories }))
  )
)(
  "shares the scalar job lifecycle and releases $name velocity fields on settings changes (trajectories: $trajectories)",
  // eslint-disable-next-line max-lines-per-function
  async (test) => {
    const h = setup(test);
    const store = useGlobeControlStore();
    store.varnameSelector = "scalar";
    store.varinfo = h.frame.info;
    store.dimSlidersValues = [0, 0, ...test.spatial.map(() => null)];
    store.streamlineLevelIndex = 1;
    const scope = effectScope();
    const handle = {
      getScalarFrameLayout: async () => ({
        shape: h.shape,
        chunks: [1, 1, ...test.shape],
        bytesPerValue: 4,
      }),
      prepareScalarFrame: async () => ({ ...h.frame }),
      commitScalarFrame: async () => true,
    };
    const bake = scope.run(() =>
      useScalarBake(
        () => handle,
        () => sources
      )
    )!;
    try {
      await bake.plan({
        start: 0,
        end: 2,
        prepareVelocity: true,
        pathlines: test.trajectories ? pathlineConfig : undefined,
      });
      expect(bake.message).toBe("");
      expect(bake.phase).toBe(SCALAR_BAKE_PHASE.PLANNED);
      expect(bake.estimate!.vectorBytes).toBeGreaterThan(0);
      expect(bake.estimate!.trajectoryBytes).toBe(
        test.trajectories
          ? planPathlineTrajectories([0, 7200, 18000], pathlineConfig).bytes
          : 0
      );
      await bake.bake();
      expect(bake.phase).toBe(SCALAR_BAKE_PHASE.READY);
      if (test.trajectories) {
        expect(bake.trajectoryProgress).toBe(1);
        bake.fps = 60;
        bake.intermediateFrames = 20;
        expect(bake.pathlinePosition(0, 0)).toBeDefined();
        const initial = bake.pathlinePosition(0, 0);
        bake.pathlinePosition(0, 1200);
        expect(bake.pathlinePosition(0, 0)).toEqual(initial);
        expect(bake.pathlineTrail(0, 0, 1000)).toEqual([]);
      }
      expect(getGridVariableData).toHaveBeenCalledTimes(6);
      expect(bake.sampleVelocity(0, 0, 3600)?.u).toBeCloseTo(1.5);
      expect(getGridVariableData).toHaveBeenCalledTimes(6);
      store.streamlineLevelIndex = 0;
      expect(bake.phase).toBe(SCALAR_BAKE_PHASE.EMPTY);
      expect(bake.sampleVelocity(0, 0, 3600)).toBeUndefined();
      expect(bake.pathlinePosition(0, 0)).toBeUndefined();
      expect(bake.pathlineTrail(0, 0, 1000)).toEqual([]);
    } finally {
      scope.stop();
    }
  }
);

it("rejects different spatial coordinates in another component store", async () => {
  const h = setup();
  const original = vi
    .mocked(ZarrDataManager.getVariableInfo)
    .getMockImplementation()!;
  const sourceFor = ZarrDataManager.getDatasetSource;
  vi.spyOn(ZarrDataManager, "getDatasetSource").mockImplementation(
    (data, name) =>
      name === "v"
        ? { ...source, store: "different.zarr" }
        : sourceFor(data, name)
  );
  vi.spyOn(ZarrDataManager, "getVariableInfo").mockImplementation(
    async (data, name, format) => {
      if (name === "x" || name === "y") {
        return {
          shape: [2],
          attrs: { units: "degrees" },
          values: data.store === source.store ? [0, 1] : [0, 2],
        } as unknown as Awaited<
          ReturnType<typeof ZarrDataManager.getVariableInfo>
        >;
      }
      return original(data, name, format);
    }
  );
  await expect(planPathlinePreparation(h.options)).rejects.toThrow(
    /coordinates do not match/
  );
  expect(getGridVariableData).not.toHaveBeenCalled();
});

it("rejects changed geometry and invalid trajectory allocations", async () => {
  const { samePathlineGrid } =
    await import("@/ui/grids/composables/pathlinePreparation.ts");
  const h = setup();
  const context = h.frame.pathlineGrid!;
  expect(
    samePathlineGrid(context, {
      ...context,
      grid: { ...regular, x: new Float32Array([0, 2]) } as TPathlineGrid,
    })
  ).toBe(false);
  for (const value of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER]) {
    expect(() =>
      planPathlineTrajectories([0, 10], {
        ...pathlineConfig,
        particleCount: value,
      })
    ).toThrow();
  }
});

it("rejects same-named projections with different definitions in another store", async () => {
  const h = setup();
  h.frame.info.attrs["grid_mapping"] = "crs";
  const original = vi
    .mocked(ZarrDataManager.getVariableInfo)
    .getMockImplementation()!;
  vi.spyOn(ZarrDataManager, "getVariableInfo").mockImplementation(
    async (...args) => {
      const info = await original(...args);
      if (args[1] === "u" || args[1] === "v") {
        info.attrs["grid_mapping"] = "crs";
      }
      return info;
    }
  );
  const sourceFor = ZarrDataManager.getDatasetSource;
  vi.spyOn(ZarrDataManager, "getDatasetSource").mockImplementation(
    (data, name) =>
      name === "v"
        ? { ...source, store: "different.zarr" }
        : sourceFor(data, name)
  );
  vi.spyOn(ZarrDataManager, "getCRSInfo").mockImplementation(
    async (_data, name) =>
      ({
        attrs: { ["longitude_of_central_meridian"]: name === "v" ? 20 : 10 },
      }) as never
  );
  await expect(planPathlinePreparation(h.options)).rejects.toThrow(
    /projection metadata do not match/
  );
  expect(getGridVariableData).not.toHaveBeenCalled();
});

it.each(cases)(
  "integrates a known time-dependent physical flow through $name",
  async (test) => {
    const h = setup(test);
    const plan = await planPathlinePreparation(h.options);
    const fields = [
      (await plan.prepare(0)).field,
      (await plan.prepare(1)).field,
      (await plan.prepare(2)).field,
    ];
    const data = await integratePathlines(
      {
        sourceTimes: [0, 60],
        seedPosition: () => ({ latitude: 0.5, longitude: 0.5 }),
        sample: (lat, lon, time) =>
          samplePathlineTime(plan.times, fields, lat, lon, time),
        surface: plan.surface,
      },
      {
        ...pathlineConfig,
        particleCount: 1,
        sampleSeconds: 30,
        maxStepSeconds: 10,
      }
    );
    const end = pathlineGeographic(pathlinePositionAt(data, 0, 60)!);
    const surface = plan.surface ?? PATHLINE_WGS84;
    const latitude = (0.5 * Math.PI) / 180;
    const e2 = surface.flattening * (2 - surface.flattening);
    const factor = 1 - e2 * Math.sin(latitude) ** 2;
    const n = surface.semiMajorAxis / Math.sqrt(factor),
      m = (n * (1 - e2)) / factor;
    // u(t) = 1 + t/7200, v(t) = 4. Curvature variation over 240 m is below this tolerance.
    expect(end.latitude).toBeCloseTo(0.5 + ((240 / m) * 180) / Math.PI, 6);
    expect(end.longitude).toBeCloseTo(
      0.5 + ((60.25 / (n * Math.cos(latitude))) * 180) / Math.PI,
      6
    );
  }
);

it.each(cases)(
  "stops $name trajectories when a component becomes missing",
  async (test) => {
    const h = setup(test);
    vi.mocked(getGridVariableData).mockImplementation(async (request) =>
      new Float32Array(test.shape.reduce((a, b) => a * b, 1)).fill(
        request.variable === "u" && request.selection[0] === 2 ? NaN : 4
      )
    );
    const plan = await planPathlinePreparation(h.options);
    const fields = [
      (await plan.prepare(0)).field,
      (await plan.prepare(1)).field,
      (await plan.prepare(2)).field,
    ];
    const times = [0, 10, 20];
    const data = await integratePathlines(
      {
        sourceTimes: times,
        seedPosition: () => ({ latitude: 0.5, longitude: 0.5 }),
        sample: (lat, lon, time) =>
          samplePathlineTime(times, fields, lat, lon, time),
        surface: plan.surface,
      },
      {
        ...pathlineConfig,
        particleCount: 1,
        sampleSeconds: 10,
        maxStepSeconds: 2,
        respawn: false,
      }
    );
    expect(pathlinePositionAt(data, 0, 10)).toBeDefined();
    expect(pathlinePositionAt(data, 0, 11)).toBeUndefined();
    expect(data.times[data.counts[0] - 1]).toBe(10);
  }
);
