/**
 * A value axis's tick labels (25 Nov): as many decimals as the step
 * between ticks needs, so neighbouring ticks never read alike (three
 * significant figures wrote 270, 271, 271, 272, 272 for ticks half a
 * kelvin apart). Very large or very small values keep their exponent.
 */
import { formatValue } from "@/utils/formatValue.ts";

export function tickText(value: number, ticks: { value: number }[]) {
  const step = ticks.length > 1 ? Math.abs(ticks[1].value - ticks[0].value) : 0;
  const abs = Math.abs(value);
  if (!step || !Number.isFinite(step)) {
    return formatValue(value);
  }
  // With an exponent, as many digits as the step needs.
  if (abs >= 1e6 || (abs && abs < 1e-4)) {
    const digits = Math.min(
      15,
      Math.max(2, Math.ceil(Math.log10(abs / step) + 1e-9) + 1)
    );
    return value.toExponential(digits - 1);
  }
  const decimals = Math.min(
    10,
    Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))
  );
  return String(parseFloat(value.toFixed(decimals)));
}
