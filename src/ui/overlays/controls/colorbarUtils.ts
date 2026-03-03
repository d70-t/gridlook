// Shared formatting and tooltip utilities for ColorBar and DistributionPlot.

export function formatValue(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) {
    return "0";
  }
  if (abs >= 1000 || abs < 0.01) {
    return value.toExponential(1);
  }
  if (abs >= 100) {
    return value.toFixed(0);
  }
  if (abs >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

export interface BinTooltip {
  range: string;
  frequency: string;
  beyond?: string;
}

export function computeBinTooltip(
  binIndex: number,
  bins: number[],
  rangeLow: number,
  rangeHigh: number
): BinTooltip {
  const numBins = bins.length;
  const binSize = (rangeHigh - rangeLow) / numBins;
  const binLow = rangeLow + binIndex * binSize;
  const binHigh = rangeLow + (binIndex + 1) * binSize;
  const total = bins.reduce((s, v) => s + v, 0);
  const pct = total > 0 ? ((bins[binIndex] / total) * 100).toFixed(2) : "0.00";

  let range: string;
  let beyond: string | undefined;
  if (numBins === 1) {
    // Single bin: all values are clamped into this bin.
    range = "all values";
    beyond = "includes all values";
  } else if (binIndex === 0) {
    // First bin: includes all values below the lower range bound.
    range = `x < ${formatValue(binHigh)}`;
    beyond = `includes all values below ${formatValue(rangeLow)}`;
  } else if (binIndex === numBins - 1) {
    // Last bin: includes all values above the upper range bound.
    range = `${formatValue(binLow)} ≤ x`;
    beyond = `includes all values above ${formatValue(rangeHigh)}`;
  } else {
    // Interior bins: standard half-open interval.
    range = `${formatValue(binLow)} ≤ x < ${formatValue(binHigh)}`;
  }

  return {
    range,
    frequency: `${pct}%`,
    beyond,
  };
}
