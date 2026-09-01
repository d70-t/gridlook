import { getHealpixVolumeSourceCells } from "./healpixVolumeMapping.ts";

export const DEFAULT_VOLUME_TEXTURE_WIDTH = 512;
export const DEFAULT_VOLUME_TEXTURE_DEPTH = 64;
export const DEFAULT_VOLUME_TEXTURE_BUDGET_BYTES = 64 * 1024 * 1024;
export const HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES = 512 * 1024 * 1024;
export const STANDARD_VOLUME_TEXTURE_WIDTH = 2048;
export const MAX_VOLUME_TEXTURE_WIDTH = 4096;
export const HIGH_RES_VOLUME_TEXTURE_DEPTH = 32;
export const MAX_VOLUME_CHANNEL_COUNT = 4;
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
  nside: number;
  sourceLevelCount: number;
  sourceCellCount: number;
  values: Float32Array[];
  heights?: Float32Array;
  cellCoordinates?: Int32Array;
  dimensions: TVolumeTextureDimensions;
};

export type TVolumeTextureBuildResult = {
  data: Uint8Array;
  dimensions: TVolumeTextureDimensions;
  valueScales: number[];
  channelCount: number;
  storageChannelCount: number;
  heightRange?: { min: number; max: number };
};

function nextPowerOfTwo(value: number) {
  return Math.pow(2, Math.ceil(Math.log2(Math.max(1, value))));
}

export function volumeStorageChannelCount(channelCount: number) {
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
  targetLevelCount: number
): TLevelSamples {
  const lowerOffsets = new Int32Array(targetLevelCount);
  const upperOffsets = new Int32Array(targetLevelCount);
  const fractions = new Float32Array(targetLevelCount);
  const denominator = Math.max(1, targetLevelCount - 1);
  const sourceSpan = sourceLevelCount - 1;
  for (let z = 0; z < targetLevelCount; z++) {
    // Atmospheric model levels commonly run from top to bottom. Texture depth
    // runs from the globe surface outwards, so reverse the source level order.
    const sourcePosition = sourceSpan - (z / denominator) * sourceSpan;
    const lower = Math.max(0, Math.floor(sourcePosition));
    const upper = Math.min(sourceLevelCount - 1, lower + 1);
    lowerOffsets[z] = lower * sourceCellCount;
    upperOffsets[z] = upper * sourceCellCount;
    fractions[z] = sourcePosition - lower;
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
  onProgress?: (completed: number, total: number) => void
): TVolumeTextureBuildResult {
  const {
    nside,
    sourceLevelCount,
    sourceCellCount,
    values,
    heights,
    cellCoordinates,
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
  if ((cellCoordinates?.length ?? 12 * nside * nside) !== sourceCellCount) {
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
    : makeLevelSamples(sourceCellCount, sourceLevelCount, dimensions.depth);
  const sourceCells = getHealpixVolumeSourceCells(
    nside,
    dimensions.width,
    dimensions.height,
    sourceCellCount,
    cellCoordinates,
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
  };
}
