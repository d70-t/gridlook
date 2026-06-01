// Utility function to format numerical values for display in the UI.
// Used for example in the hover readout and colorbar tooltips.
export function formatValue(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) {
    return "0";
  }
  if (abs >= 1e6 || abs < 1e-4) {
    return value.toExponential(1);
  }
  return String(parseFloat(value.toPrecision(3)));
}
