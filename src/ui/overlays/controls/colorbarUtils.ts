// Shared formatting and tooltip utilities for ColorBar and DistributionPlot.

/**
 * Returns the step size for a data range: two orders of magnitude below the
 * range itself. Used by BoundsControls (input step) and ColormapControls
 * (rounding dragged values) to keep numbers readable.
 * Returns "any" when the range is zero (unknown / degenerate).
 */
export function dataRangeStep(
  low: number | undefined,
  high: number | undefined
): number | "any" {
  if (low === undefined || high === undefined) {
    return "any";
  }
  const range = Math.abs(Number(high) - Number(low));
  if (range === 0) {
    return "any";
  }
  return Math.pow(10, Math.floor(Math.log10(range)) - 2);
}

/** Round a value to the step implied by the data range. */
export function roundToDataPrecision(
  value: number,
  low: number | undefined,
  high: number | undefined
): number {
  if (low === undefined || high === undefined) {
    return value;
  }
  const range = Math.abs(Number(high) - Number(low));
  if (range === 0) {
    return value;
  }
  const decimals = Math.max(0, 2 - Math.floor(Math.log10(range)));
  return parseFloat(value.toFixed(decimals));
}

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
