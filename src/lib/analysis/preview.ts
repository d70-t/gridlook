/**
 * A first figure instead of a gate: when a time series or a time × space
 * plot over its whole date range would need Compute (or more values than
 * a plot holds), the dates around the map's date are read first, whole
 * stored chunks of them, within a small budget. The full request stays
 * the plot's intent; the scientist extends the dates or reads them all.
 */

import type { TErrorDetail } from "./analysisErrors.ts";
import { MAX_PLANNED_CHUNKS } from "./chunkVisitor.ts";
import {
  clipSelection,
  indexRange,
  rowCount,
  rowRange,
  type TTimeSelection,
} from "./timeRows.ts";

/** What an automatic first figure may decode: about 16 MiB. */
export const PREVIEW_BYTES = 16 * 2 ** 20;
/** Stored chunks a first preview reads at most (below a modest request's). */
const PREVIEW_CHUNKS = 256;
/** Values a first figure shows at most (a heatmap's worth). */
export const PREVIEW_VALUES = 65_536;

export type TRange = { start: number; stop: number };

/** Stored time chunks a range of dates touches. */
export function timeGroups(range: TRange, chunk: number) {
  return Math.ceil(range.stop / chunk) - Math.floor(range.start / chunk);
}

/** Stored chunks of the request's own dates within `range`. */
function ownGroups(span: TRange, range: TRange, chunk: number) {
  const own =
    "runs" in span ? clipSelection(span as TTimeSelection, range) : range;
  return own ? groupsIn(own, chunk) : 0;
}

/** Stored time chunks a selection's own dates touch, slice by slice. */
export function groupsIn(time: TTimeSelection, chunk: number) {
  return (time.runs ?? [[time.start, time.stop]]).reduce(
    (n, [start, stop]) => n + timeGroups({ start, stop }, chunk),
    0
  );
}

/**
 * The dates of a first figure within `span`: whole stored chunks around
 * `anchor` (the map's date), as many as `perGroup` decoded bytes each fit
 * in PREVIEW_BYTES (at least one), then no more dates than PREVIEW_VALUES
 * values of `perDate` each, still around the anchor. Undefined when that
 * is the whole span already (nothing to preview).
 */
export function previewRange(options: {
  span: TRange;
  anchor: number;
  chunk: number;
  perGroup?: number;
  perDate?: number;
  /** Stored chunks a time group reads (a Box over several spatial ones). */
  chunksPerGroup?: number;
}): TRange | undefined {
  const { span, chunk } = options;
  const anchor = Math.min(span.stop - 1, Math.max(span.start, options.anchor));
  // Within the byte budget and a request count that starts unasked.
  const mostGroups = Math.floor(
    PREVIEW_CHUNKS / Math.max(1, options.chunksPerGroup ?? 1)
  );
  const groups =
    options.perGroup && options.perGroup > 0
      ? Math.max(
          1,
          Math.min(mostGroups, Math.floor(PREVIEW_BYTES / options.perGroup))
        )
      : 1;
  const first = Math.floor(span.start / chunk);
  const last = Math.ceil(span.stop / chunk) - 1;
  const at = Math.floor(anchor / chunk);
  const from = Math.max(
    first,
    Math.min(at - Math.floor((groups - 1) / 2), last - groups + 1)
  );
  let range = {
    start: Math.max(span.start, from * chunk),
    stop: Math.min(span.stop, (from + groups) * chunk),
  };
  const most = options.perDate
    ? Math.max(1, Math.floor(PREVIEW_VALUES / options.perDate))
    : Number.POSITIVE_INFINITY;
  if (range.stop - range.start > most) {
    const start = Math.min(
      range.stop - most,
      Math.max(range.start, anchor - Math.floor(most / 2))
    );
    range = { start, stop: start + most };
  }
  return range.start === span.start && range.stop === span.stop
    ? undefined
    : range;
}

/**
 * The next dates to read: as many again as shown, later first (earlier
 * once the end is reached), whole chunks, within `span`.
 */
export function extendedRange(
  current: TRange,
  span: TRange,
  chunk: number,
  maxDates = Number.POSITIVE_INFINITY
) {
  // As many again (a stored chunk at least), within what a plot may hold.
  const size = Math.min(
    Math.max(chunk, current.stop - current.start),
    Math.max(0, maxDates - (current.stop - current.start))
  );
  const later = Math.min(span.stop, current.stop + size);
  if (later > current.stop) {
    return { start: current.start, stop: later };
  }
  return {
    start: Math.max(span.start, current.start - size),
    stop: current.stop,
  };
}

/**
 * The stored chunks left to read of a request refused for its chunk count, when
 * Read all can still read them: the dates on either side of those shown are
 * requests of their own, each within the planning limit. Undefined when it
 * cannot.
 */
export function remainingChunks(
  refused: string | undefined,
  total: number,
  shown: number
) {
  const touched = refused && /touches ([\d,]+) stored chunks/.exec(refused);
  if (!touched || total <= 0 || shown <= 0) {
    return undefined;
  }
  const chunks = Number(touched[1].replace(/,/g, ""));
  const left = Math.ceil((chunks * (total - shown)) / total);
  return left <= MAX_PLANNED_CHUNKS ? left : undefined;
}

/**
 * Whether a planning refusal is about size (output values, stored chunks,
 * working memory), so fewer dates can answer it; and the values the full
 * request would hold, when the refusal says.
 */
export function sizeRefusal(message: string, detail?: TErrorDetail) {
  // As the planner decided it; the words only for an error that carries
  // no detail (typed errors: the message is for people).
  if (detail) {
    return detail.reason !== "size"
      ? undefined
      : detail.values !== undefined
        ? {
            values: detail.values,
            ...(detail.limit !== undefined ? { limit: detail.limit } : {}),
          }
        : {
            values: undefined,
            refused: message,
            decodedBytes: detail.decodedBytes || undefined,
          };
  }
  const n = (text: string) => Number(text.replace(/,/g, ""));
  const values = /would hold ([\d,]+) values/.exec(message);
  // A Hovmöller's own limit: "180 columns × 12,000 times is more than 2,000,000
  // values".
  const grid =
    /([\d,]+) (?:bins|columns|rows) × ([\d,]+) times is more than ([\d,]+) values/.exec(
      message
    );
  if (grid) {
    return { values: n(grid[1]) * n(grid[2]), limit: n(grid[3]) };
  }
  // Too many chunks or too much memory: some dates fit, all never do.
  const work = /touches ([\d,]+) stored chunks|of working memory/.exec(message);
  if (values) {
    return { values: n(values[1]) };
  }
  // What the stored chunks decode to, said with them: the first dates are
  // then as many as fit the preview budget, not one chunk alone.
  const each =
    /([\d,]+) stored chunks (?:of |\()about ([\d.]+) (KiB|MiB) each/.exec(
      message
    );
  const decodedBytes = each
    ? n(each[1]) * Number(each[2]) * (each[3] === "KiB" ? 1024 : 2 ** 20)
    : undefined;
  return work
    ? {
        values: undefined,
        refused: message,
        decodedBytes: decodedBytes || undefined,
      }
    : undefined;
}

/**
 * What the preview bar says: which dates are shown of how many, where they
 * sit in the whole range (as percentages for the strip), and the price of
 * the next dates and of all of them.
 */
export function previewFacts(options: {
  shown: TRange;
  span: TRange;
  chunk: number;
  perGroup?: number;
  fullBytes?: number;
  /** The most dates the plot may hold (its values limit, by row size). */
  maxDates?: number;
  /** The dates shown are not complete: Extend and Read all read them again. */
  rereadShown?: boolean;
  /** A stopped Extend's range, which Extend goes on to (no further). */
  pending?: TRange;
  /** Dates read of those shown, when fewer (a stopped or failed read). */
  read?: number;
  /**
   * Dates of the request in stored indices (a request in several stored
   * slices has fewer than its indices: timeRows.ts).
   */
  datesIn?: (range: TRange) => number;
}) {
  const { shown, span, chunk, perGroup } = options;
  const datesIn = options.datesIn ?? ((r: TRange) => r.stop - r.start);
  const total = datesIn(span);
  // The step Extend takes, in the request's own dates when it is in slices: the
  // store's.
  const next =
    options.pending ??
    ("runs" in span && span.runs
      ? nextDates(span as TTimeSelection, shown, chunk, options.maxDates)
      : extendedRange(shown, span, chunk, options.maxDates));
  // Only the new dates are read: their own stored chunks, a chunk they share
  // with those shown read again.
  const piece =
    next.stop > shown.stop
      ? { start: shown.stop, stop: next.stop }
      : { start: next.start, stop: shown.start };
  const groupsOf = (range: TRange) => ownGroups(span, range, chunk);
  const added = options.rereadShown
    ? groupsOf(next)
    : piece.stop > piece.start
      ? groupsOf(piece)
      : 0;
  // Read all reads the dates on either side of those shown, no more.
  const missing = [
    { start: span.start, stop: shown.start },
    { start: shown.stop, stop: span.stop },
  ].filter((r) => r.stop > r.start);
  const rest = missing.reduce((n, r) => n + timeGroups(r, chunk), 0);
  return {
    dates: options.read ?? datesIn(shown),
    total,
    left: (datesIn({ start: span.start, stop: shown.start }) / total) * 100,
    width: (datesIn(shown) / total) * 100,
    next,
    // The dates gained over those actually read: a preview stopped at 432 of
    // 792 that goes on to 1,584 adds 1,152.
    nextDates: datesIn(next) - (options.read ?? datesIn(shown)),
    nextBytes: perGroup ? perGroup * added : undefined,
    allBytes:
      perGroup && !options.rereadShown ? perGroup * rest : options.fullBytes,
  };
}

/**
 * A scatter partner reads the same new dates after the plot (`perDate` bytes
 * each): its share is quoted with the plot's, for Extend and for All. All reads
 * every date when the shown ones are read again, else those not shown.
 */
export function withPartnerBytes(
  own: ReturnType<typeof previewFacts>,
  perDate: number | undefined,
  rereadShown: boolean
) {
  const share = (dates: number) => (perDate && dates > 0 ? perDate * dates : 0);
  const sum = (mine: number | undefined, partner: number) =>
    mine !== undefined || partner ? (mine ?? 0) + partner : undefined;
  const partnerBytes = share(own.nextDates);
  const partnerAllBytes = share(
    rereadShown ? own.total : own.total - own.dates
  );
  return {
    facts: {
      ...own,
      nextBytes: sum(own.nextBytes, partnerBytes),
      allBytes: sum(own.allBytes, partnerAllBytes),
    },
    partnerBytes,
    partnerAllBytes,
  };
}

/**
 * The plot's prices with what its overlays read for the same dates (`next`,
 * `all`: barbs' and partner's chunks, when known) and `others` members, each
 * reading as much as the plot's own. Undefined when the overlays' prices are
 * unknown.
 */
export function withOverlayBytes(
  own: ReturnType<typeof previewFacts>,
  overlay: { next?: number; all?: number },
  others: number
) {
  const members = (mine: number | undefined) =>
    others && mine !== undefined ? mine * others : 0;
  const price = (bytes: number | undefined, mine: number | undefined) =>
    bytes === undefined && !others ? undefined : (bytes ?? 0) + members(mine);
  const partnerBytes = price(overlay.next, own.nextBytes);
  const partnerAllBytes = price(overlay.all, own.allBytes);
  if (partnerBytes === undefined || partnerAllBytes === undefined) {
    return undefined;
  }
  const add = (mine: number | undefined, more: number) =>
    mine !== undefined || more ? (mine ?? 0) + more : undefined;
  return {
    facts: {
      ...own,
      nextBytes: add(own.nextBytes, partnerBytes),
      allBytes: add(own.allBytes, partnerAllBytes),
    },
    partnerBytes,
    partnerAllBytes,
  };
}

/**
 * Extend's next dates: as many again of the request's own rows (in
 * slices: never a gap's), at most `most`.
 */
export function nextDates(
  all: TTimeSelection,
  shown: { start: number; stop: number },
  chunk: number,
  most: number | undefined
) {
  return all.runs
    ? indexRange(
        all,
        extendedRange(
          rowRange(all, shown),
          { start: 0, stop: rowCount(all) },
          chunk,
          most
        )
      )
    : extendedRange(shown, all, chunk, most);
}
