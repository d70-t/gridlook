import type * as zarr from "zarrita";

import {
  scalarSourceCost,
  type TScalarBakeEstimate,
  type TScalarBakeConfig,
} from "./scalarBakePlan.ts";
import type { TPreparedScalarFrame } from "./scalarFrame.ts";
import { scalarFrameMemory } from "./scalarFrameMemory.ts";

import { verticalCoordinateScore } from "@/lib/data/dimensionData.ts";
import {
  createPathlineGrid,
  PATHLINE_GRID,
  type TPathlineGridContext,
} from "@/lib/data/pathlineField.ts";
import {
  pathlineComponents,
  pathlineTimes,
  type TPathlineTimeAxis,
} from "@/lib/data/pathlineMetadata.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import type { TVectorVariablePair } from "@/lib/data/vectorField.ts";
import {
  createVectorMagnitudeData,
  resolveVectorMagnitude,
} from "@/lib/data/vectorMagnitude.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { getGridVariableData } from "@/lib/grids/gridDataWorkerClient.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

type TOptions = {
  sources: TSources;
  pair: TVectorVariablePair;
  levelIndex: number;
  timeName: string;
  timeDimension: number;
  config: TScalarBakeConfig;
  frame: TPreparedScalarFrame;
  selection: Record<string, number>;
  isCurrent: () => boolean;
};

function assertCurrent(options: Pick<TOptions, "isCurrent">) {
  if (!options.isCurrent()) {
    throw new DOMException("Velocity preparation cancelled", "AbortError");
  }
}

async function coordinate(
  options: TOptions,
  variable: string,
  name: string,
  oneDimensional = true
): Promise<TPathlineTimeAxis> {
  assertCurrent(options);
  const source = ZarrDataManager.getDatasetSource(options.sources, variable);
  const array = await ZarrDataManager.getVariableInfo(
    source,
    ZarrDataManager.resolveVariablePath(variable, name),
    options.sources.zarr_format
  );
  if (oneDimensional && array.shape.length !== 1) {
    throw new Error(`Velocity coordinate ${name} must be one-dimensional.`);
  }
  const data = await ZarrDataManager.getVariableDataFromArray(array, [null]);
  assertCurrent(options);
  const attrs = array.attrs;
  const scale = Number(attrs.scale_factor ?? 1),
    offset = Number(attrs.add_offset ?? 0);
  const values = Array.from(
    data.data as ArrayLike<number | bigint | string>,
    (raw) => {
      const value = Number(raw);
      return value === Number(attrs._FillValue ?? NaN) ||
        value === Number(attrs.missing_value ?? NaN)
        ? NaN
        : value * scale + offset;
    }
  );
  return { values, attrs, variable };
}

function sameCoordinates(a: TPathlineTimeAxis, b: TPathlineTimeAxis) {
  if (a.attrs.units !== b.attrs.units || a.values.length !== b.values.length) {
    return false;
  }
  for (let i = 0; i < a.values.length; i++) {
    if (
      !Number.isFinite(Number(a.values[i])) ||
      String(a.values[i]) !== String(b.values[i])
    ) {
      return false;
    }
  }
  return true;
}

/** Distinct stores/groups must prove spatial alignment, not merely equal sizes. */
// eslint-disable-next-line max-lines-per-function
async function validateSpatialCoordinates(
  options: TOptions,
  context: TPathlineGridContext
) {
  const { sources, pair, frame } = options;
  const reference = (variable: string, name: string) => {
    const source = ZarrDataManager.getDatasetSource(sources, variable);
    return JSON.stringify([
      source.store,
      source.dataset,
      ZarrDataManager.resolveVariablePath(variable, name),
    ]);
  };
  const mapping = frame.info.attrs.grid_mapping;
  if (typeof mapping === "string") {
    for (const variable of [pair.u, pair.v]) {
      if (reference(variable, mapping) === reference(frame.name, mapping)) {
        continue;
      }
      assertCurrent(options);
      const scalar = await ZarrDataManager.getCRSInfo(sources, frame.name);
      const vector = await ZarrDataManager.getCRSInfo(sources, variable);
      const attributes = (attrs: zarr.Attributes) =>
        JSON.stringify(
          Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))
        );
      if (attributes(scalar.attrs) !== attributes(vector.attrs)) {
        throw new Error(
          "Velocity and scalar grid projection metadata do not match."
        );
      }
    }
  }
  const names = new Set(context.spatialDimensionNames);
  for (const name of String(frame.info.attrs.coordinates ?? "").split(/\s+/)) {
    if (/^(?:lat|latitude|lon|longitude)$/i.test(name)) {
      names.add(name);
    }
  }
  for (const name of names) {
    const baseline = reference(frame.name, name);
    let scalar: TPathlineTimeAxis | undefined;
    for (const variable of [pair.u, pair.v]) {
      if (reference(variable, name) === baseline) {
        continue;
      }
      scalar ??= await coordinate(options, frame.name, name, false);
      if (
        !sameCoordinates(
          scalar,
          await coordinate(options, variable, name, false)
        )
      ) {
        throw new Error(
          `Velocity and scalar ${name} coordinates do not match.`
        );
      }
    }
  }
}

async function selectedIndices(
  options: TOptions,
  dimensions: string[],
  shape: number[],
  context: TPathlineGridContext
) {
  const selection: (number | null)[] = [];
  let levels = 0;
  for (const [i, name] of dimensions.entries()) {
    if (context.spatialDimensionNames.includes(name)) {
      selection.push(null);
      continue;
    }
    if (name === options.timeName) {
      selection.push(options.config.start);
      continue;
    }
    const a = await coordinate(options, options.pair.u, name);
    const b = await coordinate(options, options.pair.v, name);
    if (!sameCoordinates(a, b) || a.values.length !== shape[i]) {
      throw new Error(
        `Velocity components have incompatible ${name} coordinates.`
      );
    }
    const vertical = verticalCoordinateScore(name, a.attrs) > 0;
    if (vertical) {
      levels++;
    }
    const index = vertical
      ? options.levelIndex
      : (options.selection[name] ?? (shape[i] === 1 ? 0 : NaN));
    if (
      levels > 1 ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= shape[i]
    ) {
      throw new Error(
        `Choose a valid, unambiguous velocity level/selection for ${name}.`
      );
    }
    selection.push(index);
  }
  return selection;
}

/** Physical-vector planning is opt-in; no scene mutation or streamline normalization. */
// eslint-disable-next-line max-lines-per-function
export async function planPathlinePreparation(options: TOptions) {
  options = {
    ...options,
    pair: { ...options.pair },
    config: { ...options.config },
    selection: { ...options.selection },
  };
  const { sources, pair, frame, config } = options;
  const context = frame.pathlineGrid;
  if (!context) {
    throw new Error(
      "This scalar grid does not provide compatible horizontal flow coordinates."
    );
  }
  const start = performance.now();
  const arrays: zarr.Array<zarr.DataType, zarr.AsyncReadable>[] = [];
  const dimensions: string[][] = [];
  for (const variable of [pair.u, pair.v]) {
    assertCurrent(options);
    arrays.push(
      await ZarrDataManager.getVariableInfo(
        ZarrDataManager.getDatasetSource(sources, variable),
        variable,
        sources.zarr_format
      )
    );
    dimensions.push(await ZarrDataManager.getDimensionNames(sources, variable));
  }
  assertCurrent(options);
  const [u, v] = arrays;
  const names = dimensions[0];
  if (
    JSON.stringify(names) !== JSON.stringify(dimensions[1]) ||
    JSON.stringify(u.shape) !== JSON.stringify(v.shape)
  ) {
    throw new Error(
      "Velocity components must have matching dimensions and sizes."
    );
  }
  const timeDimension = names.indexOf(options.timeName);
  const spatialNames = names.filter((name) =>
    context.spatialDimensionNames.includes(name)
  );
  if (
    timeDimension < 0 ||
    JSON.stringify(spatialNames) !==
      JSON.stringify(context.spatialDimensionNames)
  ) {
    throw new Error(
      "Velocity components must use the displayed spatial dimensions and time axis."
    );
  }
  const components = pathlineComponents(u.attrs, v.attrs);
  if (u.attrs.grid_mapping !== frame.info.attrs.grid_mapping) {
    throw new Error(
      "Velocity components and the displayed field use different grid projections."
    );
  }
  if (
    components.gridRelative &&
    context.grid.kind !== PATHLINE_GRID.PROJECTED
  ) {
    throw new Error(
      "Grid-relative velocity requires a supported projection to rotate into east/north directions."
    );
  }
  const scalarTime = frame.info.dimInfo[options.timeDimension];
  if (!scalarTime || !("values" in scalarTime)) {
    throw new Error("Scalar timestamps are unavailable.");
  }
  const ut = await coordinate(options, pair.u, options.timeName);
  const vt = await coordinate(options, pair.v, options.timeName);
  const times = pathlineTimes(
    {
      values: scalarTime.values!,
      attrs: scalarTime.attrs!,
      variable: frame.name,
    },
    ut,
    vt,
    config.start,
    config.end
  );
  if (u.shape[timeDimension] !== ut.values.length) {
    throw new Error("Velocity time coordinates do not match the array shape.");
  }
  await validateSpatialCoordinates(options, context);
  const selection = await selectedIndices(options, names, u.shape, context);
  assertCurrent(options);
  const grid = createPathlineGrid(context.grid);
  if (
    JSON.stringify(context.spatialShape) !==
    JSON.stringify(u.shape.filter((_, i) => selection[i] === null))
  ) {
    throw new Error(
      "Velocity components do not match the displayed spatial shape."
    );
  }
  const spatialLength = u.shape.reduce(
    (size, count, i) => (selection[i] === null ? size * count : size),
    1
  );
  if (spatialLength !== grid.length) {
    throw new Error(
      "Velocity components do not match the displayed grid size."
    );
  }
  const costs = arrays.map((array) => {
    const bits = /^(?:u?int|float)(8|16|32|64)$/.exec(array.dtype)?.[1];
    if (!bits) {
      throw new Error("Pathlines require numeric velocity arrays.");
    }
    return scalarSourceCost(
      {
        shape: array.shape,
        chunks: array.chunks,
        bytesPerValue: Number(bits) / 8,
      },
      selection.map((index) => index === null),
      timeDimension,
      config,
      sources.zarr_format !== ZARR_FORMAT.NETCDF
    );
  });
  assertCurrent(options);
  const geometryMs = performance.now() - start;
  // Retained velocity readers must not keep the initial scalar field alive when
  // preparation replaces it with a magnitude background.
  const current = { isCurrent: options.isCurrent };
  return {
    times,
    seedPosition: grid.seedPosition,
    surface:
      context.grid.kind === PATHLINE_GRID.HEALPIX
        ? {
            semiMajorAxis: context.grid.grid.semiMajorAxis,
            flattening: context.grid.grid.flattening,
          }
        : undefined,
    context,
    geometryMs,
    sharedMemory: {
      buffers: grid.buffers,
      extraBytes: grid.extraBytes,
      gpuBytes: 0,
    },
    source: {
      uniqueChunks: costs[0].uniqueChunks + costs[1].uniqueChunks,
      decodedBytes: costs[0].decodedBytes + costs[1].decodedBytes,
      workingBytes: costs[0].workingBytes + costs[1].workingBytes,
    },
    async prepare(index: number, magnitude = false) {
      if (
        !Number.isSafeInteger(index) ||
        index < config.start ||
        index > config.end
      ) {
        throw new Error("Invalid velocity timestep.");
      }
      const started = performance.now();
      const data: Float32Array[] = [];
      let fetchMs = 0;
      for (const [i, variable] of [pair.u, pair.v].entries()) {
        assertCurrent(current);
        const indices = [...selection];
        indices[timeDimension] = index;
        const before = performance.now();
        // Sequential components share the animation's bounded worker queue.
        const raw = await getGridVariableData({
          source: ZarrDataManager.getDatasetSource(sources, variable),
          variable,
          format: sources.zarr_format,
          selection: indices,
          chunkConcurrency: costs[i].chunkConcurrency,
        });
        fetchMs += performance.now() - before;
        assertCurrent(current);
        const values = castDataVarToFloat32(raw);
        decodeVariableDataAndGetBounds(arrays[i], values);
        const scale = i === 0 ? components.uScale : components.vScale;
        for (let j = 0; j < values.length; j++) {
          // HEALPix's conventional UNSEEN value is not always declared in attrs.
          values[j] = values[j] <= -1e30 ? NaN : values[j] * scale;
        }
        data.push(values);
      }
      assertCurrent(current);
      return {
        field: grid.field(data[0], data[1], components.gridRelative),
        magnitude: magnitude
          ? createVectorMagnitudeData(
              data[0],
              data[1],
              resolveVectorMagnitude(
                { ...u.attrs, units: "m s-1" },
                { ...v.attrs, units: "m s-1" }
              )!
            )
          : undefined,
        memory: scalarFrameMemory(undefined, ...data),
        timing: { fetchMs, totalMs: performance.now() - started },
      };
    },
  };
}

export type TPathlinePreparation = Awaited<
  ReturnType<typeof planPathlinePreparation>
>;

/** Geometry may be reloaded, but every retained velocity field must use the same grid. */
// eslint-disable-next-line max-lines-per-function
export function samePathlineGrid(
  a: TPathlineGridContext,
  b?: TPathlineGridContext
) {
  if (
    !b ||
    JSON.stringify(a.spatialDimensionNames) !==
      JSON.stringify(b.spatialDimensionNames) ||
    JSON.stringify(a.spatialShape) !== JSON.stringify(b.spatialShape) ||
    a.grid.kind !== b.grid.kind
  ) {
    return false;
  }
  const equal = (left: unknown, right: unknown): boolean => {
    if (left === right) {
      return true;
    }
    if (
      (ArrayBuffer.isView(left) || Array.isArray(left)) &&
      (ArrayBuffer.isView(right) || Array.isArray(right))
    ) {
      const x = left as ArrayLike<number>,
        y = right as ArrayLike<number>;
      if (x.length !== y.length) {
        return false;
      }
      for (let i = 0; i < x.length; i++) {
        if (x[i] !== y[i]) {
          return false;
        }
      }
      return true;
    }
    return false;
  };
  if (
    a.grid.kind === PATHLINE_GRID.HEALPIX &&
    b.grid.kind === PATHLINE_GRID.HEALPIX
  ) {
    return (
      a.grid.grid.nside === b.grid.grid.nside &&
      a.grid.grid.scheme === b.grid.grid.scheme &&
      a.grid.grid.semiMajorAxis === b.grid.grid.semiMajorAxis &&
      a.grid.grid.flattening === b.grid.grid.flattening &&
      equal(a.grid.cells, b.grid.cells)
    );
  }
  return Object.entries(a.grid).every(([key, value]) =>
    equal(value, (b.grid as unknown as Record<string, unknown>)[key])
  );
}

export function extendPathlineEstimate(
  estimate: TScalarBakeEstimate,
  plan: TPathlinePreparation,
  sample: Awaited<ReturnType<TPathlinePreparation["prepare"]>>,
  scalarBuffers: Set<ArrayBufferLike>,
  trajectoryBytes = 0
) {
  let sharedBytes = plan.sharedMemory.extraBytes;
  for (const buffer of new Set(plan.sharedMemory.buffers)) {
    if (!scalarBuffers.has(buffer)) {
      sharedBytes += buffer.byteLength;
    }
  }
  const fieldBytes = sample.memory.buffers.reduce(
    (bytes, buffer) => bytes + buffer.byteLength,
    sample.memory.extraBytes
  );
  const vectorBytes = sharedBytes + fieldBytes * estimate.count;
  estimate.vectorBytes = vectorBytes;
  estimate.trajectoryBytes = trajectoryBytes;
  estimate.retainedBytes += vectorBytes + trajectoryBytes;
  estimate.workingBytes += plan.source.workingBytes + fieldBytes * 2;
  estimate.sourceWorkingBytes += plan.source.workingBytes;
  estimate.uniqueChunks += plan.source.uniqueChunks;
  estimate.decodedBytes += plan.source.decodedBytes;
  estimate.peakBytes = (estimate.retainedBytes + estimate.workingBytes) * 1.25;
  estimate.secondsLow +=
    (plan.geometryMs + sample.timing.totalMs * estimate.count) / 2000;
  estimate.secondsHigh +=
    (plan.geometryMs + sample.timing.totalMs * estimate.count) / 500;
}
