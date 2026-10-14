import { Grid } from "healpix-geo";
import { createPinia, setActivePinia } from "pinia";
import {
  DataUtils,
  HalfFloatType,
  LinearFilter,
  Scene,
  type WebGLRenderer,
  type ShaderMaterial,
  type Data3DTexture,
} from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computed, effectScope, ref, nextTick } from "vue";
import type * as zarr from "zarrita";

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { getGridVariableData } from "@/lib/grids/gridDataWorkerClient.ts";
import {
  VolumeLayer,
  VOLUME_RENDER_QUALITY,
} from "@/lib/layers/volumeLayer.ts";
import {
  ProjectionHelper,
  PROJECTION_TYPES,
} from "@/lib/projection/projectionUtils.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import {
  planVolumeFrame,
  prepareVolumeFrame,
  estimateVolumeFrames,
  validateVolumeFrameTimes,
} from "@/lib/volume/volumeFrame.ts";
import {
  VOLUME_GRID_TYPES,
  type TVolumeGrid,
} from "@/lib/volume/volumeGrid.ts";
import {
  assertCompatibleVolumePlans,
  createVolumeInterpolation,
} from "@/lib/volume/volumeInterpolation.ts";
import {
  buildVolumeTexture,
  type TVolumeTextureBuildRequest,
} from "@/lib/volume/volumeTexture.ts";
import { buildVolumeTextureInWorker } from "@/lib/volume/volumeTextureWorkerClient.ts";
import { useGlobeControlStore, BUILTIN_LAYER_IDS } from "@/store/store.ts";
import { scalarFrameMemory } from "@/ui/grids/composables/scalarFrameMemory.ts";
import { SCALAR_INTERPOLATION } from "@/ui/grids/composables/scalarTimeline.ts";
import {
  useScalarBake,
  SCALAR_BAKE_PHASE,
} from "@/ui/grids/composables/useScalarBake.ts";
import { useScalarFieldCache } from "@/ui/grids/composables/useScalarFieldCache.ts";
import { useScalarFrames } from "@/ui/grids/composables/useScalarFrames.ts";
import { useVolume } from "@/ui/grids/composables/useVolume.ts";

vi.stubGlobal("localStorage", { getItem: () => null });
vi.mock("vue", async (original) => ({
  ...(await original<typeof import("vue")>()),
  onMounted: vi.fn(),
}));
vi.mock("@/lib/grids/gridDataWorkerClient.ts", () => ({
  getGridVariableData: vi.fn(),
}));
vi.mock("@/lib/volume/volumeTextureWorkerClient.ts", () => ({
  buildVolumeTextureInWorker: vi.fn(),
  terminateVolumeTextureWorker: vi.fn(),
}));
const regular: TVolumeGrid = {
  kind: VOLUME_GRID_TYPES.REGULAR,
  latitudes: new Float32Array([55, 56]),
  longitudes: new Float32Array([8, 9, 10]),
};
const cases: { name: string; grid: TVolumeGrid }[] = [
  { name: "regular regional", grid: regular },
  {
    name: "projected curvilinear",
    grid: {
      kind: VOLUME_GRID_TYPES.PROJECTED,
      crs: "+proj=lcc +lat_1=56 +lat_0=56 +lon_0=10 +datum=WGS84 +units=m",
      x: new Float32Array([-1000, 0, 1000]),
      y: new Float32Array([-1000, 1000]),
    },
  },
  {
    name: "rotated regular",
    grid: {
      kind: VOLUME_GRID_TYPES.PROJECTED,
      crs: "+proj=ob_tran +o_proj=longlat +o_lat_p=39.25 +o_lon_p=0 +lon_0=18 +datum=WGS84",
      x: new Float32Array([-1, 0, 1]),
      y: new Float32Array([-1, 1]),
    },
  },
  ...(["nested", "ring", "zuniq"] as const).map((scheme) => {
    using native = new Grid({ level: 1, scheme: "nested" });
    using grid = new Grid({ level: 1, scheme });
    const centres = native.healpixToLonLat(
      new BigUint64Array([0n, 1n, 2n, 3n, 4n, 5n])
    );
    return {
      name: `regional HEALPix ${scheme}`,
      grid: {
        kind: VOLUME_GRID_TYPES.HEALPIX,
        nside: 2,
        options: { level: 1, scheme },
        cellCoordinates: Float64Array.from(
          grid.lonLatToHealpix(centres),
          Number
        ),
      } as TVolumeGrid,
    };
  }),
];
const dataset = { store: "volume.zarr", dataset: "" };
const datasources: TSources = {
  ["zarr_format"]: ZARR_FORMAT.V3,
  levels: [
    {
      grid: dataset,
      time: dataset,
      datasources: { water: dataset, ice: dataset, zg: dataset },
    },
  ],
};

function setup(grid = regular) {
  const horizontal =
    grid.kind === VOLUME_GRID_TYPES.HEALPIX ? ["cell"] : ["lat", "lon"];
  const shape =
    grid.kind === VOLUME_GRID_TYPES.HEALPIX ? [3, 2, 6] : [3, 2, 2, 3];
  const dimensionNames = ["time", "level", ...horizontal];
  vi.spyOn(ZarrDataManager, "getDimensionNames").mockResolvedValue(
    dimensionNames
  );
  vi.spyOn(ZarrDataManager, "getVariableInfo").mockRejectedValue(
    new Error("No axis")
  );
  vi.spyOn(
    ZarrDataManager,
    "getVariableInfoByDatasetSources"
  ).mockImplementation(
    async (_, name) =>
      ({
        shape,
        chunks: [2, ...shape.slice(1)],
        dtype: "float32",
        attrs:
          name === "zg"
            ? { ["standard_name"]: "height", units: "m" }
            : { coordinates: "zg" },
      }) as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>
  );
  vi.mocked(getGridVariableData).mockImplementation(
    async ({ variable, selection }) => {
      const time = selection[0] as number;
      return Float32Array.from({ length: 12 }, (_, i) =>
        variable === "zg"
          ? i < 6
            ? 1000 + time * 100
            : 0
          : (i + time) % 5 === 0
            ? NaN
            : i + time + 1
      );
    }
  );
  return {
    dimensionNames,
    indices: [0, 0, ...horizontal.map(() => null)],
    grid,
  };
}

async function build(request: TVolumeTextureBuildRequest) {
  using hp =
    request.grid.kind === VOLUME_GRID_TYPES.HEALPIX
      ? new Grid(request.grid.options)
      : undefined;
  return buildVolumeTexture(request, undefined, hp);
}

beforeEach(() => {
  vi.mocked(getGridVariableData).mockReset();
  vi.mocked(buildVolumeTextureInWorker)
    .mockReset()
    .mockImplementation(async (request) => ({
      ...(await build(request)),
      requestId: 1,
      type: "result",
    }));
});
afterEach(() => vi.restoreAllMocks());

it.each(cases)(
  "prepares matching original-time $name volumes with their own heights",
  async ({ grid }) => {
    const context = setup(grid);
    const first = await planVolumeFrame(
      datasources,
      ["water", "ice"],
      context,
      8
    );
    expect(getGridVariableData).not.toHaveBeenCalled();
    const a = await prepareVolumeFrame(first);
    const second = await planVolumeFrame(
      datasources,
      ["water", "ice"],
      { ...context, indices: [1, ...context.indices.slice(1)] },
      8
    );
    const b = await prepareVolumeFrame(second);
    expect(first.key).not.toBe(second.key);
    expect(a.heightRange).toEqual({ min: 0, max: 1000 });
    expect(b.heightRange).toEqual({ min: 0, max: 1100 });
    expect(a.data).toEqual(
      (await build(vi.mocked(buildVolumeTextureInWorker).mock.calls[0][0])).data
    );
    expect(b.data).toEqual(
      (await build(vi.mocked(buildVolumeTextureInWorker).mock.calls[1][0])).data
    );
    expect(a.data.some((value) => value > 0)).toBe(true);
    expect(b.data).not.toEqual(a.data);
    expect(a.plan.context.indices[0]).toBe(0);
    for (const [read] of vi.mocked(getGridVariableData).mock.calls) {
      expect(read.chunkConcurrency).toBe(1);
      expect(read.selection[1]).toBeNull();
    }
    const estimate = estimateVolumeFrames(a, {
      dimension: "time",
      start: 0,
      end: 2,
    });
    expect(estimate.count).toBe(3);
    expect(estimate.uniqueChunks).toBe(6);
    expect(estimate.decodedBytes).toBe(6 * 2 * 12 * 4);
    expect(estimate.retainedBytes).toBeGreaterThanOrEqual(
      a.data.byteLength * 3
    );
    expect(estimate.gpuBytes).toBe(a.data.byteLength * 2);
    expect(estimate.peakBytes).toBe(
      (estimate.retainedBytes + estimate.workingBytes) * 1.25
    );
  }
);

it("does not read another channel or build a texture after cancellation", async () => {
  const context = setup();
  const plan = await planVolumeFrame(datasources, ["water", "ice"], context, 8);
  const controller = new AbortController();
  vi.mocked(getGridVariableData).mockImplementationOnce(async () => {
    controller.abort();
    return new Float32Array(12);
  });
  await expect(
    prepareVolumeFrame(plan, { signal: controller.signal })
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(getGridVariableData).toHaveBeenCalledOnce();
  expect(buildVolumeTextureInWorker).not.toHaveBeenCalled();
});

it("rejects unsupported selections, native shapes, devices and ranges before payload reads", async () => {
  const context = setup();
  await expect(planVolumeFrame(datasources, [], context, 8)).rejects.toThrow(
    /Select/
  );
  await expect(
    planVolumeFrame(datasources, ["water"], context, 0)
  ).rejects.toThrow(/3D textures/);
  await expect(
    planVolumeFrame(
      datasources,
      ["water"],
      { ...context, indices: [3, 0, null, null] },
      8
    )
  ).rejects.toThrow(/index/);
  await expect(
    planVolumeFrame(
      datasources,
      ["water"],
      {
        ...context,
        grid: { ...regular, longitudes: new Float32Array([8, 9]) },
      },
      8
    )
  ).rejects.toThrow(/coordinates/);
  expect(getGridVariableData).not.toHaveBeenCalled();
  const sample = await prepareVolumeFrame(
    await planVolumeFrame(datasources, ["water"], context, 8)
  );
  expect(() =>
    estimateVolumeFrames(sample, { dimension: "time", start: 0, end: 3 })
  ).toThrow(/range/);
});

it("keeps changing height selections in the cache key for a static volume variable", async () => {
  const context = setup();
  vi.mocked(ZarrDataManager.getDimensionNames).mockImplementation(
    async (_, name) =>
      name === "zg" ? ["time", "level", "lat", "lon"] : ["level", "lat", "lon"]
  );
  vi.mocked(ZarrDataManager.getVariableInfoByDatasetSources).mockImplementation(
    async (_, name) =>
      ({
        shape: name === "zg" ? [3, 2, 2, 3] : [2, 2, 3],
        chunks: name === "zg" ? [2, 2, 2, 3] : [2, 2, 3],
        dtype: "float32",
        attrs:
          name === "zg"
            ? { ["standard_name"]: "height", units: "m" }
            : { coordinates: "zg" },
      }) as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>
  );
  const first = await planVolumeFrame(datasources, ["water"], context, 8);
  const second = await planVolumeFrame(
    datasources,
    ["water"],
    { ...context, indices: [1, 0, null, null] },
    8
  );
  expect(first.sources[0].selection).toEqual(second.sources[0].selection);
  expect(first.key).not.toBe(second.key);
  expect(second.coordinates.heights[0].selection[0]).toBe(1);
  const sample = await prepareVolumeFrame(first);
  expect(
    estimateVolumeFrames(sample, { dimension: "time", start: 0, end: 2 })
      .uniqueChunks
  ).toBe(3);
});

it.each(cases)(
  "interpolates physical $name volumes at common heights with bounded GPU textures",
  // eslint-disable-next-line max-lines-per-function
  async ({ grid }) => {
    const context = setup(grid);
    vi.mocked(getGridVariableData).mockImplementation(
      async ({ variable, selection }) => {
        const time = selection[0] as number;
        // Adjacent frames overlap at height 1000. The scalar varies linearly in
        // height and time; channel two is deliberately in much smaller units.
        return Float32Array.from({ length: 12 }, (_, i) => {
          const height = (i < 6 ? 1000 : 0) + time * 1000;
          return variable === "zg"
            ? height
            : (0.002 + height * 0.000002 + time * 0.002) *
                (variable === "ice" ? 1e-6 : 1);
        });
      }
    );
    const plans = await Promise.all(
      [0, 1, 2].map((time) =>
        planVolumeFrame(
          datasources,
          ["water", "ice"],
          { ...context, indices: [time, ...context.indices.slice(1)] },
          8,
          { interpolatable: true }
        )
      )
    );
    assertCompatibleVolumePlans(plans);
    expect(getGridVariableData).not.toHaveBeenCalled();
    const frames = [];
    for (const plan of plans) {
      frames.push(await prepareVolumeFrame(plan));
    }
    const sequence = createVolumeInterpolation(frames);
    expect(sequence.range).toEqual({ min: 0, max: 3000 });
    expect(sequence.valueScales[0]).toBeCloseTo(0.012);
    expect(sequence.valueScales[1]).toBeCloseTo(1.2e-8, 12);
    const first = frames[0],
      next = frames[1];
    expect(first.data).toBeInstanceOf(Uint16Array);
    expect(first.dimensions.byteLength).toBe(first.data.byteLength);
    expect(
      estimateVolumeFrames(first, { dimension: "time", start: 0, end: 2 })
        .gpuBytes
    ).toBe(first.data.byteLength * 2);
    const layer = new VolumeLayer();
    try {
      layer.setInterpolation(sequence, 0, 1, 0.5);
      const { uniforms } = layer.object.material as ShaderMaterial;
      const a = uniforms.volumeData.value as Data3DTexture;
      const b = uniforms.nextVolumeData.value as Data3DTexture;
      expect(a.type).toBe(HalfFloatType);
      expect(a.minFilter).toBe(LinearFilter);
      expect(a.image.data).toBe(first.data);
      expect(uniforms.firstHeightTransform.value.toArray()).toEqual([3, 0]);
      expect(uniforms.nextHeightTransform.value.toArray()).toEqual([3, -1]);
      // At shell height 1/3 both endpoints sample physical height 1000:
      // frame 0's upper level and frame 1's lower level.
      const column = first.data.findIndex((value) => value > 0);
      expect(column).toBeGreaterThanOrEqual(0);
      for (const channel of [0, 1]) {
        const upper =
          DataUtils.fromHalfFloat(first.data[column + 2 + channel]) *
          first.physical!.scales[channel];
        const lower =
          DataUtils.fromHalfFloat(next.data[column + channel]) *
          next.physical!.scales[channel];
        const factor = channel ? 1e-6 : 1;
        expect(upper / factor).toBeCloseTo(0.004, 5);
        expect(lower / factor).toBeCloseTo(0.006, 5);
        expect((upper + lower) / 2 / factor).toBeCloseTo(0.005, 5);
        expect(uniforms.normalizationScale.value.getComponent(channel)).toBe(
          sequence.valueScales[channel]
        );
      }
      const disposeA = vi.spyOn(a, "dispose"),
        disposeB = vi.spyOn(b, "dispose");
      const textureVersion = a.version;
      for (const alpha of [0, 0.15625, 0.5, 1]) {
        layer.setInterpolation(sequence, 0, 1, alpha);
        expect(uniforms.volumeData.value).toBe(a);
        expect(uniforms.nextVolumeData.value).toBe(b);
        expect(uniforms.volumeAlpha.value).toBe(alpha);
        expect(a.version).toBe(textureVersion);
      }
      expect(disposeA).not.toHaveBeenCalled();
      // AB at alpha=1 and BC at alpha=0 must sample exactly the same field,
      // including changing vertical coverage and per-frame physical scales.
      const boundaryMapping = {
        height: uniforms.nextHeightTransform.value.toArray(),
        scale: uniforms.nextPhysicalScale.value.toArray(),
        normalization: uniforms.normalizationScale.value.toArray(),
        bounds: uniforms.textureBounds.value.toArray(),
      };
      layer.setInterpolation(sequence, 1, 2, 0);
      expect({
        height: uniforms.firstHeightTransform.value.toArray(),
        scale: uniforms.firstPhysicalScale.value.toArray(),
        normalization: uniforms.normalizationScale.value.toArray(),
        bounds: uniforms.textureBounds.value.toArray(),
      }).toEqual(boundaryMapping);
      expect(disposeA).toHaveBeenCalledOnce();
      expect(disposeB).not.toHaveBeenCalled();
      expect(uniforms.volumeData.value).toBe(b);
      const c = uniforms.nextVolumeData.value as Data3DTexture;
      const disposeC = vi.spyOn(c, "dispose");
      expect(uniforms.normalizationScale.value.x).toBe(sequence.valueScales[0]);
      expect(() => layer.setInterpolation(sequence, 1, 2, NaN)).toThrow(
        /fraction/
      );
      expect(uniforms.volumeData.value).toBe(b);
      layer.setData(
        new Uint8Array(1),
        { width: 1, height: 1, depth: 1, byteLength: 1 },
        1,
        1,
        ["#ffffff"],
        [1],
        first.bounds
      );
      expect(disposeB).toHaveBeenCalledOnce();
      expect(disposeC).toHaveBeenCalledOnce();
      expect(uniforms.interpolateValues.value).toBe(false);
    } finally {
      layer.dispose();
    }
  }
);

it("rejects incompatible grids or units before fetching and a changed vertical mode before display", async () => {
  const context = setup();
  const a = await planVolumeFrame(datasources, ["water"], context, 8, {
    interpolatable: true,
  });
  const b = await planVolumeFrame(
    datasources,
    ["water"],
    {
      ...context,
      grid: { ...regular, longitudes: new Float32Array([9, 10, 11]) },
    },
    8,
    { interpolatable: true }
  );
  expect(() => assertCompatibleVolumePlans([a, b])).toThrow(/matching grids/);
  const inspect = vi.mocked(ZarrDataManager.getVariableInfoByDatasetSources);
  const original = inspect.getMockImplementation()!;
  inspect.mockImplementation(async (...args) => {
    const variable = await original(...args);
    variable.attrs.units = "kg/kg";
    return variable;
  });
  const c = await planVolumeFrame(datasources, ["water"], context, 8, {
    interpolatable: true,
  });
  expect(() => assertCompatibleVolumePlans([a, c])).toThrow(/matching grids/);
  expect(getGridVariableData).not.toHaveBeenCalled();
  const frame = await prepareVolumeFrame(a);
  expect(() =>
    createVolumeInterpolation([
      frame,
      { ...frame, physical: { ...frame.physical!, vertical: "level" } },
    ])
  ).toThrow(/physical mappings/);
});

it.each(cases)(
  "keeps pressure-level ordering and empty channels on $name",
  async ({ grid }) => {
    const context = setup(grid);
    const axis = {
      shape: [2],
      chunks: [2],
      dtype: "float32",
      attrs: { ["standard_name"]: "air_pressure", units: "hPa" },
    } as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>;
    vi.mocked(ZarrDataManager.getVariableInfo).mockResolvedValue(axis);
    const sources = {
      ...datasources,
      levels: [
        {
          ...datasources.levels[0],
          datasources: { water: dataset, ice: dataset },
        },
      ],
    };
    vi.mocked(getGridVariableData).mockImplementation(async ({ variable }) =>
      variable === "level"
        ? new Float32Array([1000, 500])
        : Float32Array.from({ length: 12 }, (_, i) =>
            variable === "ice" ? NaN : i < 6 ? 2 : 4
          )
    );
    const frame = await prepareVolumeFrame(
      await planVolumeFrame(sources, ["water", "ice"], context, 8, {
        interpolatable: true,
      })
    );
    const sequence = createVolumeInterpolation([frame]);
    expect(sequence.range).toEqual({ min: -1000, max: -500 });
    expect(frame.physical!.vertical).toBe("level");
    const column = frame.data.findIndex((value) => value > 0);
    expect(column).toBeGreaterThanOrEqual(0);
    expect(
      DataUtils.fromHalfFloat(frame.data[column]) * frame.physical!.scales[0]
    ).toBe(2);
    expect(
      DataUtils.fromHalfFloat(frame.data[column + 2]) *
        frame.physical!.scales[0]
    ).toBe(4);
    for (let index = 1; index < frame.data.length; index += 2) {
      expect(frame.data[index]).toBe(0);
    }
  }
);

it("does not silently fall back to model levels when animation height reads fail", async () => {
  const context = setup();
  const plan = await planVolumeFrame(datasources, ["water"], context, 8, {
    interpolatable: true,
  });
  const original = vi.mocked(getGridVariableData).getMockImplementation()!;
  vi.mocked(getGridVariableData).mockImplementation(async (request) => {
    if (request.variable === "zg") {
      throw new Error("Missing height chunk");
    }
    return original(request);
  });
  await expect(prepareVolumeFrame(plan)).rejects.toThrow(/height coordinates/);
  expect(buildVolumeTextureInWorker).not.toHaveBeenCalled();
});

it.each(cases)(
  "plays and exports prepared $name volumes through the scalar lifecycle",
  // eslint-disable-next-line max-lines-per-function
  async ({ grid }) => {
    const context = setup(grid);
    setActivePinia(createPinia());
    const store = useGlobeControlStore();
    store.varnameSelector = "water";
    store.dimSlidersValues = [
      0,
      0,
      ...context.indices.slice(2).map(() => null),
    ];
    store.varinfo = {
      attrs: {},
      bounds: { low: 0, high: 3 },
      dimRanges: context.dimensionNames.map((name, index) =>
        index > 1
          ? null
          : { name, minBound: 0, maxBound: index ? 1 : 2, startPos: 0 }
      ),
      dimInfo: [
        {
          current: 0,
          values: [0, 1, 2],
          attrs: { units: "hours since 2000-01-01" },
        },
      ],
    };
    store.setVolumeSelections([
      { variable: "water", color: "#ffffff", opacity: 1 },
    ]);
    store.setVolumeLayerEnabled(true);
    const scene = new Scene();
    const scope = effectScope();
    const moving = ref(false);
    let motionChanged = () => {};
    // eslint-disable-next-line max-lines-per-function
    const handle = scope.run(() => {
      const volume = useVolume({
        getDatasources: () => datasources,
        getScene: () => scene,
        getRenderer: () =>
          ({
            getContext: () => ({
              MAX_3D_TEXTURE_SIZE: 1,
              getParameter: () => 8,
            }),
          }) as unknown as WebGLRenderer,
        redraw: vi.fn(),
        projectionHelper: computed(
          () =>
            new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
              lat: 0,
              lon: 0,
            })
        ),
        isSceneInMotion: moving,
        onProjectionChange: vi.fn(),
        onMotionStateChange: (callback) => (motionChanged = callback),
      });
      return useScalarFrames({
        volume,
        getDatasources: () => datasources,
        getScalarObjects: () => [],
        getDataVar: async () =>
          ZarrDataManager.getVariableInfoByDatasetSources(datasources, "water"),
        prepareFrame: async (_, request) => {
          const time = request.dimensionIndices.time ?? 0;
          const data = new Float32Array([time, time + 1]);
          return {
            name: "water",
            data,
            indices: [time, ...store.dimSlidersValues.slice(1)] as number[],
            info: { ...store.varinfo!, bounds: { low: time, high: time + 1 } },
            volumeContext: {
              ...context,
              indices: [time, ...context.indices.slice(1)],
            },
            memory: scalarFrameMemory(data),
            interpolation: { values: [data], geometry: [], sample: () => null },
            isCurrent: request.isCurrent,
            render: vi.fn(),
            updateLayers: async () => {},
          };
        },
        scalarCache: useScalarFieldCache({
          updateHistogram: vi.fn(),
          updateColormap: vi.fn(),
          redraw: vi.fn(),
        }),
      });
    })!;
    const commit = vi.spyOn(handle, "commitScalarFrame");
    const bake = scope.run(() =>
      useScalarBake(
        () => handle,
        () => datasources
      )
    )!;
    try {
      expect(bake.unavailable).toBe("");
      await bake.plan({ start: 0, end: 2 });
      expect(bake.message).toBe("");
      expect(bake.phase).toBe(SCALAR_BAKE_PHASE.PLANNED);
      expect(bake.hasVolumes).toBe(true);
      expect(buildVolumeTextureInWorker).toHaveBeenCalledOnce();
      expect(scene.children).toHaveLength(0);
      expect(bake.estimate!.volumeBytes).toBeGreaterThan(0);
      await bake.bake();
      expect(bake.message).toBe("");
      expect(bake.phase).toBe(SCALAR_BAKE_PHASE.READY);
      expect(buildVolumeTextureInWorker).toHaveBeenCalledTimes(3);
      expect(scene.children).toHaveLength(1);
      const material = (scene.children[0] as import("three").Mesh)
        .material as ShaderMaterial;
      expect(material.uniforms.stepCount.value).toBe(
        VOLUME_RENDER_QUALITY.PREVIEW
      );
      // Rotating and settling must not overwrite preview or export quality.
      for (const motion of [true, false]) {
        moving.value = motion;
        motionChanged();
        expect(material.uniforms.stepCount.value).toBe(
          VOLUME_RENDER_QUALITY.PREVIEW
        );
      }
      const scale = material.uniforms.normalizationScale.value.x;
      const reads = vi.mocked(getGridVariableData).mock.calls.length;
      const retained = bake.estimate!.retainedBytes;
      await bake.seek(2);
      expect(material.uniforms.normalizationScale.value.x).toBe(scale);
      expect(store.dimSlidersDisplay[0]).toBe(2);
      bake.intermediateFrames = 3;
      for (const mode of [
        SCALAR_INTERPOLATION.LINEAR,
        SCALAR_INTERPOLATION.SMOOTHSTEP,
      ]) {
        bake.interpolationMode = mode;
        await bake.seek(1);
        expect(material.uniforms.volumeAlpha.value).toBe(
          mode === SCALAR_INTERPOLATION.LINEAR ? 0.25 : 0.15625
        );
        expect(commit.mock.lastCall![2]!.alpha).toBe(
          commit.mock.lastCall![1]!.alpha
        );
        expect(material.uniforms.normalizationScale.value.x).toBe(scale);
      }
      const texture = material.uniforms.volumeData.value as Data3DTexture;
      const version = texture.version;
      await bake.seek(2);
      expect(material.uniforms.volumeData.value).toBe(texture);
      expect(texture.version).toBe(version);
      store.setVolumeSelections([
        { variable: "water", color: "#ff0000", opacity: 0.4 },
      ]);
      store.updateLayerOpacity(BUILTIN_LAYER_IDS.VOLUME, 0.3);
      await nextTick();
      expect(bake.phase).toBe(SCALAR_BAKE_PHASE.READY);
      expect(material.uniforms.channelColors.value[0].getHexString()).toBe(
        "ff0000"
      );
      expect(material.uniforms.channelOpacities.value[0]).toBe(0.4);
      expect(material.uniforms.opacity.value).toBe(0.3);
      await bake.withPreparedFrames(async (session) => {
        for (let index = 0; index < session.frameCount; index++) {
          await session.seek(index);
          const presentation = commit.mock.lastCall![2]!;
          expect(material.uniforms.stepCount.value).toBe(
            VOLUME_RENDER_QUALITY.FULL
          );
          moving.value = !moving.value;
          motionChanged();
          expect(material.uniforms.stepCount.value).toBe(
            VOLUME_RENDER_QUALITY.FULL
          );
          expect(material.uniforms.opacity.value).toBe(0.3);
          expect(material.uniforms.channelOpacities.value[0]).toBe(0.4);
          expect(material.uniforms.volumeAlpha.value).toBe(presentation.alpha);
          expect(material.uniforms.volumeData.value.image.data).toBe(
            presentation.sequence.frames[presentation.first].data
          );
          expect(material.uniforms.normalizationScale.value.x).toBe(scale);
        }
      });
      expect(bake.current).toBe(2);
      expect(material.uniforms.stepCount.value).toBe(
        VOLUME_RENDER_QUALITY.PREVIEW
      );
      await expect(
        bake.withPreparedFrames(async (session) => {
          await session.seek(4);
          bake.cancelExport();
          await session.seek(0);
        })
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(bake.current).toBe(2);
      expect(material.uniforms.stepCount.value).toBe(
        VOLUME_RENDER_QUALITY.PREVIEW
      );
      await expect(
        bake.withPreparedFrames(async (session) => {
          store.volumeSelections[0].opacity = 0.6;
          await session.seek(0);
        })
      ).rejects.toThrow(/settings changed/);
      expect(bake.phase).toBe(SCALAR_BAKE_PHASE.READY);
      expect(getGridVariableData).toHaveBeenCalledTimes(reads);
      expect(bake.estimate!.retainedBytes).toBe(retained);
      const oldTexture = material.uniforms.volumeData.value as Data3DTexture;
      const disposed = vi.spyOn(oldTexture, "dispose");
      bake.clear();
      expect(bake.hasVolumes).toBe(false);
      expect(bake.completed).toBe(0);
      await bake.plan({ start: 0, end: 1 });
      await bake.bake();
      expect(bake.phase).toBe(SCALAR_BAKE_PHASE.READY);
      expect(disposed).toHaveBeenCalledOnce();
      store.setVolumeSelections([
        { variable: "ice", color: "#ffffff", opacity: 1 },
      ]);
      expect(bake.phase).toBe(SCALAR_BAKE_PHASE.EMPTY);
    } finally {
      scope.stop();
    }
    expect(scene.children).toHaveLength(0);
  }
);

it("rejects a volume's shifted time axis in another group before full preparation", async () => {
  const context = setup();
  const plan = await planVolumeFrame(datasources, ["water"], context, 8, {
    interpolatable: true,
  });
  const shared = {
    variable: "water",
    dimension: "time",
    values: [0, 1, 2],
    attrs: { units: "hours since 2000-01-01" },
  };
  await validateVolumeFrameTimes(plan, shared, { start: 0, end: 2 });
  const scalar = { ...shared, variable: "other/scalar" };
  const otherSources = {
    ...datasources,
    levels: [
      {
        ...datasources.levels[0],
        datasources: {
          ...datasources.levels[0].datasources,
          "other/scalar": { store: "other.zarr", dataset: "" },
        },
      },
    ],
  };
  const axis = { shape: [3], attrs: scalar.attrs } as unknown as zarr.Array<
    zarr.DataType,
    zarr.AsyncReadable
  >;
  vi.mocked(ZarrDataManager.getVariableInfo).mockResolvedValue(axis);
  const read = vi
    .spyOn(ZarrDataManager, "getVariableDataFromArray")
    .mockResolvedValue({ data: new Float64Array([0, 2, 3]) } as never);
  await expect(
    validateVolumeFrameTimes({ ...plan, datasources: otherSources }, scalar, {
      start: 0,
      end: 2,
    })
  ).rejects.toThrow(/timestamps do not match/);
  read.mockResolvedValue({ data: new Float64Array([0, 1, 2]) } as never);
  await validateVolumeFrameTimes(
    { ...plan, datasources: otherSources },
    scalar,
    { start: 0, end: 2 }
  );
});
