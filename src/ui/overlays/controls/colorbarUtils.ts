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

  let beyond: string | undefined;
  if (binIndex === 0 && binIndex === numBins - 1) {
    beyond = "includes all values";
  } else if (binIndex === 0) {
    beyond = "includes all values below";
  } else if (binIndex === numBins - 1) {
    beyond = "includes all values above";
  }

  return {
    range: `${formatValue(binLow)} ≤ x < ${formatValue(binHigh)}`,
    frequency: `${pct}%`,
    beyond,
  };
}
