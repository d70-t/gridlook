export const HISTOGRAM_SUMMARY_BINS = 4096;

export type THistogramSummary = {
  bins: Uint32Array;
  min: number;
  max: number;
};

export function isHistogramSummary(obj: unknown): obj is THistogramSummary {
  return (
    obj !== null &&
    typeof obj === "object" &&
    "bins" in obj &&
    obj.bins instanceof Uint32Array &&
    "min" in obj &&
    typeof obj.min === "number" &&
    "max" in obj &&
    typeof obj.max === "number"
  );
}

export function buildHistogramSummary(
  rawData: ArrayLike<number>,
  min: number,
  max: number,
  numBins: number = HISTOGRAM_SUMMARY_BINS,
  fillValue?: number,
  missingValue?: number
): THistogramSummary {
  const data = filterInvalidData(rawData, missingValue, fillValue);
  const bins = new Uint32Array(numBins);

  if (!isFinite(min) || !isFinite(max) || data.length === 0) {
    return { bins, min, max };
  }

  const range = max - min;
  // Handle degenerate case where all values are at a single point (min === max).
  // In this case, avoid division by zero by placing all entries into the first bin.
  if (range === 0) {
    for (let i = 0; i < data.length; i++) {
      bins[0]++;
    }
    return { bins, min, max };
  }
  const binSize = range / numBins;

  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    let binIndex = Math.floor((value - min) / binSize);
    if (binIndex < 0) {
      binIndex = 0;
    }
    if (binIndex >= numBins) {
      binIndex = numBins - 1;
    }
    bins[binIndex]++;
  }

  return { bins, min, max };
}

function filterInvalidData(
  data: ArrayLike<number>,
  missingValue?: number,
  fillValue?: number
) {
  const rawData = data as ArrayLike<number>;
  const validData = Array.from(rawData).filter((value) => {
    if (!isFinite(value)) {
      return false;
    }
    if (missingValue !== undefined && value === missingValue) {
      return false;
    }
    if (fillValue !== undefined && value === fillValue) {
      return false;
    }
    return true;
  });
  return validData;
}

function countBins(bins: Uint32Array): number {
  let total = 0;
  for (let i = 0; i < bins.length; i++) {
    total += bins[i];
  }
  return total;
}

function clampBinIndex(index: number, binCount: number) {
  if (index < 0) {
    return 0;
  }
  if (index >= binCount) {
    return binCount - 1;
  }
  return index;
}

function mapValueToBin(
  value: number,
  targetMin: number,
  targetMax: number,
  targetBinCount: number
) {
  const index = Math.floor(
    ((value - targetMin) / (targetMax - targetMin)) * targetBinCount
  );
  return clampBinIndex(index, targetBinCount);
}

function addDegenerateSummaryToBins(
  summary: THistogramSummary,
  targetBins: Float64Array,
  targetMin: number,
  targetMax: number,
  totalSourceCount: number
) {
  if (targetMax <= targetMin) {
    targetBins[0] += totalSourceCount;
    return true;
  }

  if (
    !isFinite(summary.min) ||
    !isFinite(summary.max) ||
    summary.max <= summary.min
  ) {
    const degenerateIndex = isFinite(summary.min)
      ? mapValueToBin(summary.min, targetMin, targetMax, targetBins.length)
      : 0;
    targetBins[degenerateIndex] += totalSourceCount;
    return true;
  }

  return false;
}

function addOutsideRangeToBins(
  targetBins: Float64Array,
  targetMin: number,
  targetMax: number,
  rangeStart: number,
  rangeEnd: number,
  count: number,
  rangeWidth: number
) {
  if (rangeStart < targetMin) {
    const belowWidth = Math.min(rangeEnd, targetMin) - rangeStart;
    if (belowWidth > 0) {
      targetBins[0] += count * (belowWidth / rangeWidth);
    }
  }
  if (rangeEnd > targetMax) {
    const aboveWidth = rangeEnd - Math.max(rangeStart, targetMax);
    if (aboveWidth > 0) {
      targetBins[targetBins.length - 1] += count * (aboveWidth / rangeWidth);
    }
  }
}

function addRangeToBins(
  targetBins: Float64Array,
  targetMin: number,
  targetMax: number,
  rangeStart: number,
  rangeEnd: number,
  count: number
) {
  const rangeWidth = rangeEnd - rangeStart;
  if (count === 0 || rangeWidth <= 0) {
    return;
  }

  const targetBinCount = targetBins.length;
  const targetBinSize = (targetMax - targetMin) / targetBinCount;

  // Clamp contributions outside the selected range into edge bins to preserve
  // existing histogram semantics.
  addOutsideRangeToBins(
    targetBins,
    targetMin,
    targetMax,
    rangeStart,
    rangeEnd,
    count,
    rangeWidth
  );

  const insideStart = Math.max(rangeStart, targetMin);
  const insideEnd = Math.min(rangeEnd, targetMax);
  if (insideEnd <= insideStart) {
    return;
  }

  const startIndex = clampBinIndex(
    Math.floor((insideStart - targetMin) / targetBinSize),
    targetBinCount
  );
  const endValue =
    insideEnd === targetMax ? insideEnd - Number.EPSILON : insideEnd;
  const endIndex = clampBinIndex(
    Math.floor((endValue - targetMin) / targetBinSize),
    targetBinCount
  );

  for (let targetIndex = startIndex; targetIndex <= endIndex; targetIndex++) {
    const binStart = targetMin + targetIndex * targetBinSize;
    const binEnd =
      targetIndex === targetBinCount - 1 ? targetMax : binStart + targetBinSize;
    const overlap =
      Math.min(insideEnd, binEnd) - Math.max(insideStart, binStart);
    if (overlap > 0) {
      targetBins[targetIndex] += count * (overlap / rangeWidth);
    }
  }
}

function addSummaryToBins(
  summary: THistogramSummary,
  targetBins: Float64Array,
  targetMin: number,
  targetMax: number
) {
  const sourceBins = summary.bins;
  if (
    sourceBins.length === 0 ||
    targetBins.length === 0 ||
    !isFinite(targetMin) ||
    !isFinite(targetMax)
  ) {
    return;
  }

  const totalSourceCount = countBins(sourceBins);
  if (totalSourceCount === 0) {
    return;
  }

  if (
    addDegenerateSummaryToBins(
      summary,
      targetBins,
      targetMin,
      targetMax,
      totalSourceCount
    )
  ) {
    return;
  }

  const sourceBinSize = (summary.max - summary.min) / sourceBins.length;
  for (let i = 0; i < sourceBins.length; i++) {
    const count = sourceBins[i];
    if (count === 0) {
      continue;
    }

    const sourceStart = summary.min + i * sourceBinSize;
    const sourceEnd =
      i === sourceBins.length - 1 ? summary.max : sourceStart + sourceBinSize;
    addRangeToBins(
      targetBins,
      targetMin,
      targetMax,
      sourceStart,
      sourceEnd,
      count
    );
  }
}

export function mergeHistogramSummaries(
  summaries: THistogramSummary[],
  min: number,
  max: number,
  numBins: number = HISTOGRAM_SUMMARY_BINS
): THistogramSummary {
  const mergedBinsFloat = new Float64Array(numBins);
  for (const summary of summaries) {
    addSummaryToBins(summary, mergedBinsFloat, min, max);
  }
  const mergedBins = new Uint32Array(numBins);
  for (let i = 0; i < mergedBins.length; i++) {
    mergedBins[i] = Math.round(mergedBinsFloat[i]);
  }
  return { bins: mergedBins, min, max };
}

export function rebinHistogramSummary(
  summary: THistogramSummary,
  numBins: number,
  min: number,
  max: number
): number[] {
  if (numBins <= 0) {
    return [];
  }

  const rebinnedFloat = new Float64Array(numBins);
  addSummaryToBins(summary, rebinnedFloat, min, max);
  const rebinned = new Array(numBins);
  for (let i = 0; i < numBins; i++) {
    rebinned[i] = Math.round(rebinnedFloat[i]);
  }
  return rebinned;
}
