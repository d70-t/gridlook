/**
 * What turning Follow the map on asks the plot to read: the map's level
 * or date, also where the plot already is when it did not finish there
 * (a stopped cross-section stayed stopped when Follow was turned back on).
 */
export function followRequest(plot: {
  /** It follows the level (a one-level plot over levels), else the date. */
  byLevel: boolean;
  /** Whether Follow is on now, after the toggle. */
  following: boolean;
  /** It finished its read: done, and not a partial result. */
  complete: boolean;
  mapLevel?: number;
  mapTime?: number;
  /** The date the plot shows (its committed query's start). */
  shownTime?: number;
}): { level: number; again: boolean } | { time: number } | undefined {
  if (!plot.following) {
    return undefined;
  }
  if (plot.byLevel) {
    return plot.mapLevel === undefined
      ? undefined
      : { level: plot.mapLevel, again: !plot.complete };
  }
  return plot.mapTime !== undefined &&
    (!plot.complete || plot.shownTime !== plot.mapTime)
    ? { time: plot.mapTime }
    : undefined;
}
