import { getHealpixVolumeSourceCells } from "./healpixVolumeMapping.ts";
import type { THealpixVolumeGrid } from "./healpixVolumeMapping.ts";
import { getProjectedVolumeMapping } from "./projectedVolumeMapping.ts";
import { getRegularVolumeMapping } from "./regularVolumeMapping.ts";
import { VOLUME_GRID_TYPES, type TVolumeGrid } from "./volumeGrid.ts";

import type { TGeoBounds } from "@/lib/layers/equirectLayer.ts";

const DEFAULT_VOLUME_TEXTURE_DEPTH = 64;
const DEFAULT_VOLUME_TEXTURE_BUDGET_BYTES = 64 * 1024 * 1024;
export const HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES = 512 * 1024 * 1024;
const STANDARD_VOLUME_TEXTURE_WIDTH = 2048;
const MAX_VOLUME_TEXTURE_WIDTH = 4096;
const HIGH_RES_VOLUME_TEXTURE_DEPTH = 32;
const MAX_VOLUME_CHANNEL_COUNT = 4;
export const RESERVED_VOLUME_CHANNEL_COUNT = 2;

const LOG_10 = Math.log(10);
const DENSITY_LOOKUP_MAX_INDEX = 4095;

export type TVolumeTextureDimensions = {
  width: number;
  height: number;
  depth: number;
  byteLength: number;
};

export type TVolumeTextureBuildRequest = {
  grid: TVolumeGrid;
  levels?: Float32Array;
  sourceLevelCount: number;
  sourceCellCount: number;
  values: Float32Array[];
  heights?: Float32Array;
  dimensions: TVolumeTextureDimensions;
};

export type TVolumeTextureBuildResult = {
  data: Uint8Array;
  dimensions: TVolumeTextureDimensions;
  valueScales: number[];
  channelCount: number;
  storageChannelCount: number;
  heightRange?: { min: number; max: number };
  bounds: TGeoBounds;
};

function nextPowerOfTwo(value: number) {
  return Math.pow(2, Math.ceil(Math.log2(Math.max(1, value))));
}

function volumeStorageChannelCount(channelCount: number) {
  if (channelCount <= 1) {
    return 1;
  }
  if (channelCount === 2) {
    return 2;
  }
  return 4;
}

/**
 * Pick an equirectangular texture close to the angular resolution of a
 * HEALPix grid. Each channel occupies one byte in the normalized texture.
 */
export function chooseVolumeTextureDimensions(
  nside: number,
  sourceLevelCount: number,
  max3DTextureSize: number,
  channelCount = 1,
  budgetBytes = DEFAULT_VOLUME_TEXTURE_BUDGET_BYTES
): TVolumeTextureDimensions {
  const safeMaxSize = Math.max(1, Math.floor(max3DTextureSize));
  const requestedWidth = Math.min(
    nextPowerOfTwo(Math.max(64, nside * 6)),
    MAX_VOLUME_TEXTURE_WIDTH
  );
  let width = Math.min(requestedWidth, safeMaxSize);
  let height = Math.min(Math.max(1, Math.floor(width / 2)), safeMaxSize);
  const fullDepth = Math.min(
    Math.max(1, Math.floor(sourceLevelCount)),
    DEFAULT_VOLUME_TEXTURE_DEPTH,
    safeMaxSize
  );
  const bytesPerVoxel = volumeStorageChannelCount(channelCount);
  let depth = fullDepth;

  if (width > STANDARD_VOLUME_TEXTURE_WIDTH) {
    const highResolutionDepth = Math.min(
      fullDepth,
      HIGH_RES_VOLUME_TEXTURE_DEPTH
    );
    const highResolutionBytes =
      width * height * highResolutionDepth * bytesPerVoxel;
    if (highResolutionBytes <= budgetBytes) {
      depth = highResolutionDepth;
    } else {
      width = Math.min(width, STANDARD_VOLUME_TEXTURE_WIDTH);
      height = Math.min(Math.max(1, Math.floor(width / 2)), safeMaxSize);
    }
  }

  while (width * height * depth * bytesPerVoxel > budgetBytes && width > 1) {
    width = Math.max(1, Math.floor(width / 2));
    height = Math.min(Math.max(1, Math.floor(width / 2)), safeMaxSize);
  }

  return {
    width,
    height,
    depth,
    byteLength: width * height * depth * bytesPerVoxel,
  };
}

function sampledPositiveQuantile(values: Float32Array, quantile: number) {
  const maxSamples = 100_000;
  const stride = Math.max(1, Math.floor(values.length / maxSamples));
  const samples: number[] = [];
  for (let index = 0; index < values.length; index += stride) {
    const value = values[index];
    if (Number.isFinite(value) && value > 0) {
      samples.push(value);
    }
  }
  if (samples.length === 0) {
    return 1;
  }
  samples.sort((a, b) => a - b);
  const index = Math.min(
    samples.length - 1,
    Math.max(0, Math.floor((samples.length - 1) * quantile))
  );
  return samples[index] || 1;
}

export function chooseRegularVolumeTextureDimensions(
  width: number,
  height: number,
  sourceLevelCount: number,
  max3DTextureSize: number,
  channelCount: number,
  budgetBytes = DEFAULT_VOLUME_TEXTURE_BUDGET_BYTES
): TVolumeTextureDimensions {
  width = Math.max(
    1,
    Math.min(width, max3DTextureSize, MAX_VOLUME_TEXTURE_WIDTH)
  );
  height = Math.max(
    1,
    Math.min(height, max3DTextureSize, MAX_VOLUME_TEXTURE_WIDTH)
  );
  const depth = Math.max(
    1,
    Math.min(sourceLevelCount, DEFAULT_VOLUME_TEXTURE_DEPTH, max3DTextureSize)
  );
  const channels = volumeStorageChannelCount(channelCount);
  while (
    width * height * depth * channels > budgetBytes &&
    (width > 1 || height > 1)
  ) {
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
  return {
    width,
    height,
    depth,
    byteLength: width * height * depth * channels,
  };
}

function volumeMapping(
  request: TVolumeTextureBuildRequest,
  healpix: THealpixVolumeGrid | undefined,
  onProgress: (completed: number, total: number) => void
) {
  const { grid, dimensions, sourceCellCount } = request;
  if (grid.kind === VOLUME_GRID_TYPES.PROJECTED) {
    return getProjectedVolumeMapping(
      grid,
      dimensions.width,
      dimensions.height,
      onProgress
    );
  }
  if (grid.kind === VOLUME_GRID_TYPES.REGULAR) {
    return getRegularVolumeMapping(
      grid.latitudes,
      grid.longitudes,
      dimensions.width,
      dimensions.height,
      onProgress
    );
  }
  if (!healpix || healpix.nside !== grid.nside) {
    throw new Error("Volume HEALPix grid does not match its resolution.");
  }
  return {
    sourceCells: getHealpixVolumeSourceCells(
      healpix,
      dimensions.width,
      dimensions.height,
      sourceCellCount,
      grid.cellCoordinates,
      onProgress
    ),
    bounds: { west: -180, east: 180, south: -90, north: 90 },
  };
}

function normalizeDensity(value: number, scale: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(1, Math.log1p((9 * value) / scale) / LOG_10);
}

const DENSITY_LOOKUP = Uint8Array.from(
  { length: DENSITY_LOOKUP_MAX_INDEX + 1 },
  (_, index) =>
    Math.round(normalizeDensity(index / DENSITY_LOOKUP_MAX_INDEX, 1) * 255)
);

function findHeightRange(
  referenceValues: Float32Array,
  heights: Float32Array | undefined,
  sourceCellCount: number,
  onLevelComplete?: (completed: number, total: number) => void
) {
  if (!heights || referenceValues.length !== heights.length) {
    return undefined;
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const levelCount = Math.ceil(heights.length / sourceCellCount);
  for (let level = 0; level < levelCount; level++) {
    const end = Math.min((level + 1) * sourceCellCount, heights.length);
    for (let index = level * sourceCellCount; index < end; index++) {
      const value = referenceValues[index];
      if (!Number.isFinite(value) || value <= 0) {
        continue;
      }
      const height = heights[index];
      if (!Number.isFinite(height)) {
        continue;
      }
      min = Math.min(min, height);
      max = Math.max(max, height);
    }
    onLevelComplete?.(level + 1, levelCount);
  }
  if (!(Number.isFinite(min) && Number.isFinite(max) && max > min)) {
    return undefined;
  }
  return { min: Math.max(0, min), max };
}

function densityByte(value: number, densityFactor: number) {
  if (!(value > 0)) {
    return 0;
  }
  const lookupIndex = Math.round(value * densityFactor);
  if (lookupIndex >= DENSITY_LOOKUP_MAX_INDEX) {
    return 255;
  }
  return DENSITY_LOOKUP[lookupIndex];
}

function makeTargetHeights(
  depth: number,
  heightRange: { min: number; max: number }
) {
  const targetHeights = new Float32Array(depth);
  const denominator = Math.max(1, depth - 1);
  const span = heightRange.max - heightRange.min;
  for (let z = 0; z < depth; z++) {
    targetHeights[z] = heightRange.min + (z / denominator) * span;
  }
  return targetHeights;
}

type TLevelSamples = {
  lowerOffsets: Int32Array;
  upperOffsets: Int32Array;
  fractions: Float32Array;
};

function makeLevelSamples(
  sourceCellCount: number,
  sourceLevelCount: number,
  targetLevelCount: number,
  levels: Float32Array = Float32Array.from(
    { length: sourceLevelCount },
    (_, index) => sourceLevelCount - 1 - index
  )
): TLevelSamples {
  if (levels.length !== sourceLevelCount || !levels.every(Number.isFinite)) {
    throw new Error("Volume vertical coordinates do not match its levels.");
  }
  const descending = levels[0] > levels[levels.length - 1];
  const ordered = descending ? levels.slice().reverse() : levels;
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index] <= ordered[index - 1]) {
      throw new Error("Volume vertical coordinates must be strictly ordered.");
    }
  }
  const lowerOffsets = new Int32Array(targetLevelCount);
  const upperOffsets = new Int32Array(targetLevelCount);
  const fractions = new Float32Array(targetLevelCount);
  let lower = 0;
  for (let z = 0; z < targetLevelCount; z++) {
    const coordinate =
      ordered[0] +
      (z / Math.max(1, targetLevelCount - 1)) *
        (ordered[ordered.length - 1] - ordered[0]);
    while (lower + 1 < ordered.length - 1 && ordered[lower + 1] < coordinate) {
      lower++;
    }
    const upper = Math.min(ordered.length - 1, lower + 1);
    lowerOffsets[z] =
      (descending ? sourceLevelCount - 1 - lower : lower) * sourceCellCount;
    upperOffsets[z] =
      (descending ? sourceLevelCount - 1 - upper : upper) * sourceCellCount;
    fractions[z] =
      upper === lower
        ? 0
        : (coordinate - ordered[lower]) / (ordered[upper] - ordered[lower]);
  }
  return { lowerOffsets, upperOffsets, fractions };
}

function writeLevelColumn(
  output: Uint8Array,
  columnOffset: number,
  values: Float32Array[],
  sourceCell: number,
  levelSamples: TLevelSamples,
  densityFactors: number[],
  storageChannelCount: number
) {
  for (let z = 0; z < levelSamples.fractions.length; z++) {
    const lowerIndex = levelSamples.lowerOffsets[z] + sourceCell;
    const upperIndex = levelSamples.upperOffsets[z] + sourceCell;
    const fraction = levelSamples.fractions[z];
    const voxelOffset = columnOffset + z * storageChannelCount;
    for (let channel = 0; channel < values.length; channel++) {
      const field = values[channel];
      const lowerValue = field[lowerIndex];
      const upperValue = field[upperIndex];
      let value = 0;
      if (!Number.isFinite(lowerValue) && !Number.isFinite(upperValue)) {
        value = 0;
      } else if (!Number.isFinite(lowerValue)) {
        value = upperValue;
      } else if (!Number.isFinite(upperValue)) {
        value = lowerValue;
      } else {
        value = lowerValue + (upperValue - lowerValue) * fraction;
      }
      output[voxelOffset + channel] = densityByte(
        value,
        densityFactors[channel]
      );
    }
  }
}

// eslint-disable-next-line max-lines-per-function
function writeHeightColumn(
  output: Uint8Array,
  columnOffset: number,
  targetHeights: Float32Array,
  values: Float32Array[],
  heights: Float32Array,
  sourceCell: number,
  sourceCellCount: number,
  sourceLevelCount: number,
  densityFactors: number[],
  storageChannelCount: number
) {
  const firstHeight = heights[sourceCell];
  const lastHeight =
    heights[(sourceLevelCount - 1) * sourceCellCount + sourceCell];
  const step = firstHeight <= lastHeight ? 1 : -1;
  let level = step > 0 ? 0 : sourceLevelCount - 1;

  for (let z = 0; z < targetHeights.length; z++) {
    const targetHeight = targetHeights[z];
    let bracketFound = false;
    while (level + step >= 0 && level + step < sourceLevelCount) {
      const lowerIndex = level * sourceCellCount + sourceCell;
      const upperIndex = (level + step) * sourceCellCount + sourceCell;
      const lowerHeight = heights[lowerIndex];
      const upperHeight = heights[upperIndex];
      if (!(Number.isFinite(lowerHeight) && Number.isFinite(upperHeight))) {
        level += step;
        continue;
      }
      const low = Math.min(lowerHeight, upperHeight);
      const high = Math.max(lowerHeight, upperHeight);
      if (targetHeight < low) {
        break;
      }
      if (targetHeight > high) {
        level += step;
        continue;
      }
      bracketFound = true;
      break;
    }
    if (!bracketFound) {
      continue;
    }
    const nextLevel = level + step;
    const lowerIndex = level * sourceCellCount + sourceCell;
    const upperIndex = nextLevel * sourceCellCount + sourceCell;
    const lowerHeight = heights[lowerIndex];
    const upperHeight = heights[upperIndex];
    const span = upperHeight - lowerHeight;
    const fraction = span === 0 ? 0 : (targetHeight - lowerHeight) / span;
    const voxelOffset = columnOffset + z * storageChannelCount;
    for (let channel = 0; channel < values.length; channel++) {
      const field = values[channel];
      const lowerValue = field[lowerIndex];
      const upperValue = field[upperIndex];
      let value = 0;
      if (!Number.isFinite(lowerValue) && !Number.isFinite(upperValue)) {
        value = 0;
      } else if (!Number.isFinite(lowerValue)) {
        value = upperValue;
      } else if (!Number.isFinite(upperValue)) {
        value = lowerValue;
      } else {
        value = lowerValue + (upperValue - lowerValue) * fraction;
      }
      output[voxelOffset + channel] = densityByte(
        value,
        densityFactors[channel]
      );
    }
  }
}

/** Convert level-by-cell fields into a longitude/latitude/height volume. */
// eslint-disable-next-line max-lines-per-function
export function buildVolumeTexture(
  request: TVolumeTextureBuildRequest,
  onProgress: ((completed: number, total: number) => void) | undefined,
  healpix?: THealpixVolumeGrid
): TVolumeTextureBuildResult {
  const {
    grid,
    levels,
    sourceLevelCount,
    sourceCellCount,
    values,
    heights,
    dimensions,
  } = request;
  const expectedLength = sourceLevelCount * sourceCellCount;
  if (
    values.length === 0 ||
    values.length > MAX_VOLUME_CHANNEL_COUNT ||
    values.some((field) => field.length !== expectedLength)
  ) {
    throw new Error("Volume source data does not match its level/cell shape.");
  }
  if (heights && heights.length !== expectedLength) {
    throw new Error("Volume height data does not match the source field.");
  }
  const coordinateCount =
    grid.kind === VOLUME_GRID_TYPES.HEALPIX
      ? (grid.cellCoordinates?.length ?? 12 * grid.nside * grid.nside)
      : grid.kind === VOLUME_GRID_TYPES.PROJECTED
        ? grid.x.length * grid.y.length
        : grid.latitudes.length * grid.longitudes.length;
  if (coordinateCount !== sourceCellCount) {
    throw new Error("Volume coordinates do not match the source grid.");
  }

  const channelCount = values.length;
  const storageChannelCount = volumeStorageChannelCount(channelCount);
  const output = new Uint8Array(
    dimensions.width *
      dimensions.height *
      dimensions.depth *
      storageChannelCount
  );
  const valueScales = values.map((field) =>
    sampledPositiveQuantile(field, 0.995)
  );
  const densityFactors = valueScales.map(
    (scale) => DENSITY_LOOKUP_MAX_INDEX / scale
  );
  const heightRangeUnits = heights ? expectedLength : 0;
  const pixelLookupUnits = dimensions.width * dimensions.height;
  const columnUnits = pixelLookupUnits * dimensions.depth;
  const progressTotal = heightRangeUnits + pixelLookupUnits + columnUnits;
  onProgress?.(0, progressTotal);
  // Anchor the shared vertical mapping to the primary field. Additional
  // channels therefore cannot stretch or compress its appearance, while the
  // occupied part of the atmosphere still fills the rendered volume shell.
  const heightRange = findHeightRange(
    values[0],
    heights,
    sourceCellCount,
    (completed, total) =>
      onProgress?.(
        Math.round((completed / total) * heightRangeUnits),
        progressTotal
      )
  );
  const targetHeights = heightRange
    ? makeTargetHeights(dimensions.depth, heightRange)
    : undefined;
  const levelSamples = heightRange
    ? undefined
    : makeLevelSamples(
        sourceCellCount,
        sourceLevelCount,
        dimensions.depth,
        levels
      );
  const { sourceCells, bounds } = volumeMapping(
    request,
    healpix,
    (completed, total) =>
      onProgress?.(
        heightRangeUnits + Math.round((completed / total) * pixelLookupUnits),
        progressTotal
      )
  );
  const columnStride = dimensions.depth * storageChannelCount;
  const sourceColumnOffsets = new Int32Array(sourceCellCount);
  sourceColumnOffsets.fill(-1);
  const progressInterval = Math.max(1, Math.floor(dimensions.height / 100));

  for (let y = 0; y < dimensions.height; y++) {
    for (let x = 0; x < dimensions.width; x++) {
      const targetColumn = y * dimensions.width + x;
      const sourceCell = sourceCells[targetColumn];
      if (sourceCell < 0) {
        continue;
      }
      const columnOffset = targetColumn * columnStride;
      const cachedColumnOffset = sourceColumnOffsets[sourceCell];
      if (cachedColumnOffset >= 0) {
        output.copyWithin(
          columnOffset,
          cachedColumnOffset,
          cachedColumnOffset + columnStride
        );
      } else if (targetHeights && heights) {
        writeHeightColumn(
          output,
          columnOffset,
          targetHeights,
          values,
          heights,
          sourceCell,
          sourceCellCount,
          sourceLevelCount,
          densityFactors,
          storageChannelCount
        );
        sourceColumnOffsets[sourceCell] = columnOffset;
      } else if (levelSamples) {
        writeLevelColumn(
          output,
          columnOffset,
          values,
          sourceCell,
          levelSamples,
          densityFactors,
          storageChannelCount
        );
        sourceColumnOffsets[sourceCell] = columnOffset;
      }
    }
    if (
      onProgress &&
      ((y + 1) % progressInterval === 0 || y + 1 === dimensions.height)
    ) {
      onProgress(
        heightRangeUnits +
          pixelLookupUnits +
          (y + 1) * dimensions.width * dimensions.depth,
        progressTotal
      );
    }
  }

  return {
    data: output,
    dimensions,
    valueScales,
    channelCount,
    storageChannelCount,
    heightRange,
    bounds,
  };
}
