import {
  assertVolumeCurrent,
  inspectVolumeSources,
  inspectVolumeCoordinates,
  loadVolumeData,
  type TVolumeDataContext,
  type TVolumeReadOptions,
} from "./volumeData.ts";
import { VOLUME_GRID_TYPES, type TVolumeGrid } from "./volumeGrid.ts";
import {
  chooseVolumeTextureDimensions,
  chooseRegularVolumeTextureDimensions,
  HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES,
  RESERVED_VOLUME_CHANNEL_COUNT,
  type TVolumeTextureBuildResult,
} from "./volumeTexture.ts";
import { buildVolumeTextureInWorker } from "./volumeTextureWorkerClient.ts";

import type { TPathlineTimeAxis } from "@/lib/data/pathlineMetadata.ts";
import { isTimeCoordinate } from "@/lib/data/timeHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";

export type TVolumeContext = TVolumeDataContext & { grid: TVolumeGrid };
export type TVolumeFrameOptions = TVolumeReadOptions & {
  onProgress?: (fraction: number) => void;
  interpolatable?: boolean;
};
export type TVolumeFramePlan = Awaited<ReturnType<typeof planVolumeFrame>>;
export type TPreparedVolumeFrame = TVolumeTextureBuildResult & {
  plan: TVolumeFramePlan;
  timing: { fetchMs: number; totalMs: number };
  isCurrent: () => boolean;
  chunkConcurrency: number;
};

function normalizeCellCoordinates(
  coordinates: Float64Array | undefined,
  nside: number
) {
  if (!coordinates) {
    return { coordinates: undefined, key: "global" };
  }
  let isIdentity = coordinates.length === 12 * nside * nside;
  let hash = 2_166_136_261;
  const normalized = new Float64Array(coordinates.length);
  for (let index = 0; index < coordinates.length; index++) {
    const coordinate = coordinates[index];
    normalized[index] = coordinate;
    isIdentity &&= coordinate === index;
    hash = Math.imul(hash ^ coordinate, 16_777_619);
    hash = Math.imul(hash ^ Math.floor(coordinate / 2 ** 32), 16_777_619);
  }
  return isIdentity
    ? { coordinates: undefined, key: "global" }
    : {
        coordinates: normalized,
        key: `${normalized.length}:${hash >>> 0}`,
      };
}

/** Inspect one original timestep without fetching field data or changing the scene. */
// eslint-disable-next-line max-lines-per-function
export async function planVolumeFrame(
  datasources: TSources,
  variables: string[],
  context: TVolumeContext,
  max3DTextureSize: number,
  options: TVolumeFrameOptions = {}
) {
  assertVolumeCurrent(options);
  if (!(Number.isSafeInteger(max3DTextureSize) && max3DTextureSize > 0)) {
    throw new Error("This device does not support WebGL 3D textures.");
  }
  context = {
    ...context,
    dimensionNames: [...context.dimensionNames],
    indices: context.indices.map((index) =>
      index && typeof index === "object" ? { ...index } : index
    ),
  };
  const variablesCopy = [...variables];
  let gridKey: string;
  let grid = context.grid;
  if (grid.kind === VOLUME_GRID_TYPES.HEALPIX) {
    const normalized = normalizeCellCoordinates(
      grid.cellCoordinates,
      grid.nside
    );
    gridKey = JSON.stringify([grid.options, grid.nside, normalized.key]);
    grid = {
      ...grid,
      options: structuredClone(grid.options),
      cellCoordinates: normalized.coordinates,
    };
  } else {
    grid = structuredClone(grid);
    gridKey = JSON.stringify(grid);
  }
  context.grid = grid;
  const sources = await inspectVolumeSources(
    datasources,
    variablesCopy,
    context
  );
  assertVolumeCurrent(options);
  const first = sources[0];
  const coordinates = await inspectVolumeCoordinates(
    datasources,
    first,
    context,
    options
  );
  assertVolumeCurrent(options);
  const horizontalShape =
    grid.kind === VOLUME_GRID_TYPES.HEALPIX
      ? [grid.cellCoordinates?.length ?? 12 * grid.nside ** 2]
      : grid.kind === VOLUME_GRID_TYPES.PROJECTED
        ? [grid.y.length, grid.x.length]
        : [grid.latitudes.length, grid.longitudes.length];
  if (
    horizontalShape.length !== first.spatialShape.length ||
    horizontalShape.some((size, i) => size !== first.spatialShape[i])
  ) {
    throw new Error("Volume coordinates do not match the displayed grid.");
  }
  const channelCount = Math.max(RESERVED_VOLUME_CHANNEL_COUNT, sources.length);
  const interpolatable = options.interpolatable ?? false;
  const bytesPerChannel = interpolatable ? 2 : 1;
  const textureBudget = HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES / bytesPerChannel;
  const dimensions =
    grid.kind === VOLUME_GRID_TYPES.HEALPIX
      ? chooseVolumeTextureDimensions(
          grid.nside,
          first.sourceLevelCount,
          max3DTextureSize,
          channelCount,
          textureBudget
        )
      : chooseRegularVolumeTextureDimensions(
          horizontalShape[1],
          horizontalShape[0],
          first.sourceLevelCount,
          max3DTextureSize,
          channelCount,
          textureBudget
        );
  dimensions.byteLength *= bytesPerChannel;
  const mappingKey = JSON.stringify({
    grid: gridKey,
    dimensions,
    interpolatable,
    sources: sources.map((source) => [
      source.name,
      source.verticalDimension,
      source.sourceLevelCount,
      source.variable.attrs.units,
    ]),
    heights: coordinates.heights.map((source) => [
      source.name,
      source.variable.attrs.units,
    ]),
    levels: coordinates.levels && [
      coordinates.levels.name,
      coordinates.levels.variable.attrs,
      coordinates.levels.negative,
    ],
  });
  const key = JSON.stringify({
    variables: variablesCopy,
    selections: sources.map((source) => source.selection),
    coordinates: coordinates.heights.map((source) => [
      source.name,
      source.selection,
    ]),
    grid: gridKey,
    dimensions,
  });
  return {
    datasources,
    variables: variablesCopy,
    context,
    sources,
    coordinates,
    dimensions,
    interpolatable,
    mappingKey,
    key,
  };
}

/** Packed original-time data; preparation never allocates GPU textures. */
// eslint-disable-next-line max-lines-per-function
export async function prepareVolumeFrame(
  plan: TVolumeFramePlan,
  options: TVolumeFrameOptions = {}
): Promise<TPreparedVolumeFrame> {
  assertVolumeCurrent(options);
  const started = performance.now();
  const chunkConcurrency = options.chunkConcurrency ?? 1;
  const report = (fraction: number) => {
    if (!options.signal?.aborted && options.isCurrent?.() !== false) {
      options.onProgress?.(fraction);
    }
  };
  const { values, heights, levels } = await loadVolumeData(
    plan.datasources,
    plan.sources,
    plan.context,
    (fraction) => report(fraction * 0.75),
    {
      ...options,
      coordinates: plan.coordinates,
      chunkConcurrency,
    }
  );
  assertVolumeCurrent(options);
  if (plan.interpolatable && plan.coordinates.heights.length && !heights) {
    throw new Error(
      "Volume height coordinates could not be loaded for interpolation."
    );
  }
  const fetchMs = performance.now() - started;
  const first = plan.sources[0];
  const result = await buildVolumeTextureInWorker(
    {
      grid: structuredClone(plan.context.grid),
      sourceLevelCount: first.sourceLevelCount,
      sourceCellCount: first.sourceCellCount,
      values,
      heights,
      levels,
      dimensions: plan.dimensions,
      interpolatable: plan.interpolatable,
    },
    (done, total) => report(0.75 + (total ? done / total : 0) * 0.25)
  );
  assertVolumeCurrent(options);
  options.onProgress?.(1);
  // The shared worker finishes an in-flight build before cancellation settles.
  // Its transferred buffers/results can then be released without affecting other jobs.
  return {
    ...result,
    plan,
    chunkConcurrency,
    timing: { fetchMs, totalMs: performance.now() - started },
    isCurrent: () =>
      !options.signal?.aborted && options.isCurrent?.() !== false,
  };
}

/** Advisory estimates: original packed keyframes, at most two active GPU keyframes, and scratch space. */
// eslint-disable-next-line max-lines-per-function
export function estimateVolumeFrames(
  sample: TPreparedVolumeFrame,
  range: { dimension: string; start: number; end: number }
) {
  const { plan } = sample;
  const count = range.end - range.start + 1;
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    count < 1
  ) {
    throw new Error("Choose a valid volume time range.");
  }
  let uniqueChunks = 0,
    decodedBytes = 0,
    sourceWorkingBytes = 0,
    chunkWorkingBytes = 0;
  const readSources = [...plan.sources, ...plan.coordinates.heights];
  const level = plan.coordinates.levels;
  const reads = readSources.map(
    ({ name, variable, selection, dimensionNames }) => ({
      name,
      variable,
      selection,
      dimensionNames,
    })
  );
  if (level) {
    reads.push({
      ...level,
      selection: [null],
      dimensionNames: [plan.sources[0].verticalDimension],
    });
  }
  // Height fallbacks are all included, giving an upper estimate of source reads.
  for (const source of new Map(
    reads.map((read) => [read.name, read])
  ).values()) {
    const { variable } = source;
    const time = source.dimensionNames.indexOf(range.dimension);
    if (time >= 0 && range.end >= variable.shape[time]) {
      throw new Error(`Volume time range exceeds ${source.name}.`);
    }
    const bits = /^(?:u?int|float)(8|16|32|64)$/.exec(variable.dtype)?.[1];
    if (!bits || variable.chunks.length !== variable.shape.length) {
      throw new Error("This volume does not provide numeric chunk metadata.");
    }
    let chunkValues = 1,
      chunks = 1;
    for (let i = 0; i < variable.shape.length; i++) {
      const size = variable.shape[i],
        chunk = variable.chunks[i];
      if (
        !Number.isSafeInteger(size) ||
        size < 1 ||
        !Number.isSafeInteger(chunk) ||
        chunk < 1
      ) {
        throw new Error("This volume does not provide usable chunk metadata.");
      }
      chunkValues *= chunk;
      chunks *=
        i === time
          ? Math.floor(range.end / chunk) - Math.floor(range.start / chunk) + 1
          : source.selection[i] === null
            ? Math.ceil(size / chunk)
            : 1;
    }
    const chunkBytes = (chunkValues * Number(bits)) / 8;
    uniqueChunks += chunks;
    decodedBytes += chunks * chunkBytes;
    sourceWorkingBytes += Math.min(chunks, 1024) * chunkBytes;
    chunkWorkingBytes = Math.max(
      chunkWorkingBytes,
      chunkBytes * 4 * sample.chunkConcurrency
    );
  }
  const { grid } = plan.context;
  const gridBytes =
    grid.kind === VOLUME_GRID_TYPES.HEALPIX
      ? (grid.cellCoordinates?.byteLength ?? 0)
      : grid.kind === VOLUME_GRID_TYPES.PROJECTED
        ? grid.x.byteLength + grid.y.byteLength
        : grid.latitudes.byteLength + grid.longitudes.byteLength;
  const first = plan.sources[0];
  const fieldBytes = first.sourceCellCount * first.sourceLevelCount * 4;
  const nativeBytes = fieldBytes * plan.sources.length;
  const coordinateBytes =
    (plan.coordinates.heights.length ? fieldBytes : 0) +
    (level ? first.sourceLevelCount * 4 : 0);
  sourceWorkingBytes += chunkWorkingBytes;
  const mappingBytes = plan.dimensions.width * plan.dimensions.height * 4;
  const cellLookupBytes =
    grid.kind === VOLUME_GRID_TYPES.HEALPIX
      ? (grid.cellCoordinates?.length ?? 0) * 72
      : 0;
  // The floored sampling stride may retain nearly 200k JS numbers per channel.
  const quantileBytes =
    Math.min(first.sourceCellCount * first.sourceLevelCount, 200_000) *
    24 *
    plan.sources.length;
  const workerBytes =
    nativeBytes +
    coordinateBytes +
    gridBytes +
    mappingBytes * 2 +
    cellLookupBytes +
    plan.dimensions.depth * 16 +
    first.sourceLevelCount * 8 +
    quantileBytes;
  const retainedBytes = (sample.data.byteLength + gridBytes) * count;
  const workingBytes =
    sourceWorkingBytes + workerBytes + nativeBytes + sample.data.byteLength;
  return {
    count,
    retainedBytes,
    workingBytes,
    sourceWorkingBytes,
    coordinateBytes,
    // Interpolation holds only the adjacent keyframes, regardless of output FPS.
    gpuBytes: sample.data.byteLength * 2,
    peakBytes: (retainedBytes + workingBytes) * 1.25,
    uniqueChunks,
    decodedBytes,
    secondsLow: (sample.timing.totalMs * count) / 2000,
    secondsHigh: (sample.timing.totalMs * count) / 500,
  };
}

/** Identical dimension names alone do not prove alignment across stores/groups. */

// eslint-disable-next-line max-lines-per-function
export async function validateVolumeFrameTimes(
  plan: TVolumeFramePlan,
  scalar: TPathlineTimeAxis & { variable: string; dimension: string },
  range: { start: number; end: number },
  options: TVolumeReadOptions = {}
) {
  const reference = (variable: string) => {
    const source = ZarrDataManager.getDatasetSource(plan.datasources, variable);
    const name = ZarrDataManager.resolveVariablePath(
      variable,
      scalar.dimension
    );
    return {
      source,
      name,
      key: JSON.stringify([source.store, source.dataset, name]),
    };
  };
  const checked = new Set([reference(scalar.variable).key]);
  for (const field of [...plan.sources, ...plan.coordinates.heights]) {
    assertVolumeCurrent(options);
    if (
      field.dimensionNames.some(
        (name) => name !== scalar.dimension && isTimeCoordinate(name, {})
      )
    ) {
      throw new Error(
        "Volume and scalar fields must use the same time dimension."
      );
    }
    const time = field.dimensionNames.indexOf(scalar.dimension);
    if (time < 0) {
      continue;
    } // Static channels/coordinates repeat across the range.
    if (range.end >= field.variable.shape[time]) {
      throw new Error(`Volume time range exceeds ${field.name}.`);
    }
    const { source, name, key } = reference(field.name);
    if (checked.has(key)) {
      continue;
    }
    const axis = await ZarrDataManager.getVariableInfo(
      source,
      name,
      plan.datasources.zarr_format
    );
    assertVolumeCurrent(options);
    // ponytail: distinct coordinate stores require matching epochs/units/calendars.
    // Calendar-aware epoch conversion can widen compatibility later.
    if (
      axis.shape.length !== 1 ||
      axis.shape[0] <= range.end ||
      axis.attrs.units !== scalar.attrs.units ||
      (axis.attrs.calendar ?? "standard") !==
        (scalar.attrs.calendar ?? "standard")
    ) {
      throw new Error(
        "Volume and scalar time coordinates must have matching units, epochs and calendars."
      );
    }
    const raw = await ZarrDataManager.getVariableDataFromArray(axis, [null]);
    assertVolumeCurrent(options);
    const values = raw.data as ArrayLike<number | bigint | string>;
    const scale = Number(axis.attrs.scale_factor ?? 1),
      offset = Number(axis.attrs.add_offset ?? 0);
    for (let index = range.start; index <= range.end; index++) {
      const value = Number(values[index]);
      if (
        !Number.isFinite(value) ||
        value === Number(axis.attrs._FillValue ?? NaN) ||
        value === Number(axis.attrs.missing_value ?? NaN) ||
        !Number.isFinite(Number(scalar.values[index])) ||
        Math.abs(value * scale + offset - Number(scalar.values[index])) > 1e-6
      ) {
        throw new Error("Volume and scalar timestamps do not match.");
      }
    }
    checked.add(key);
  }
}
