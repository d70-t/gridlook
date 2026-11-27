/**
 * Zooming into a chart as monitoring charts do (Zabbix): drag across the
 * plot to zoom to that stretch, double-click (or Reset) to see it all. And
 * the pointer's readout on one line: every detail, separated by dots.
 */

/** The axis range a drag from pixel `a` to `b` selects; none for a click. */
export function dragRange(
  a: number,
  b: number,
  toValue: (pixel: number) => number,
  least = 6
) {
  if (Math.abs(b - a) < least) {
    return undefined;
  }
  const [lo, hi] = [toValue(Math.min(a, b)), toValue(Math.max(a, b))];
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo
    ? { min: lo, max: hi }
    : undefined;
}

/**
 *  A long quantity name before a value is left to the axis title, so the
 * value itself fits on the line ("Near-surface air …: 289 K" → "289 K").
 */
function shortened(part: string) {
  const match = /^([^:]{24,}):\s+(\S.*)$/.exec(part);
  return match ? match[2] : part;
}

/**
 * The readout of the samples under the pointer as one line: the first
 * one's lines (its date or place first), then the last line of each other
 * one, without empty parts.
 */
export function oneLine(first: string[], others: string[][]) {
  const parts = [...first, ...others.map((lines) => lines.at(-1) ?? "")]
    .map((part) => shortened(part.trim()))
    .filter(Boolean);
  // Samples sharing a line (a single-line readout: the date) show it once.
  return [...new Set(parts)].join(" — ");
}

/**
 *  The cell whose [lo, hi] holds `position` (the nearest centre among
 * overlapping ones), or undefined.
 */
export function cellUnder(
  position: number,
  lo: ArrayLike<number>,
  hi: ArrayLike<number>
) {
  let best: number | undefined;
  let distance = Infinity;
  for (let at = 0; at < lo.length; at++) {
    const [a, b] = [Math.min(lo[at], hi[at]), Math.max(lo[at], hi[at])];
    const off = Math.abs(position - (a + b) / 2);
    if (position >= a && position <= b && off < distance) {
      [best, distance] = [at, off];
    }
  }
  return best;
}

/** "Depth (m)" and 250 read as "Depth 250 m"; a level index as its number. */
export function titled(title: string, value: string) {
  const match = /^(.*?)\s*\(([^()]*)\)$/.exec(title.trim());
  if (!match) {
    return `${title} ${value}`.trim();
  }
  const [, name, unit] = match;
  return unit === "index" || !unit
    ? `${name} ${value}`
    : `${name} ${value} ${unit}`;
}
