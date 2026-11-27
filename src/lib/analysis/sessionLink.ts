/**
 * The plots of a session in the link: each plot's query (on the map's
 * dataset), how its window shows it, its place on screen, and Compare.
 * Compressed (raw DEFLATE, base64url) and versioned: "2.<payload>". Links
 * of version 1 (the queries alone, uncompressed) still open. Nothing
 * computed is in it: a recipient's browser reads and computes again.
 */
import { deflateSync, Inflate, strFromU8, strToU8 } from "fflate";

import {
  decodeQueriesFromUrl,
  validateRestoredQuery,
} from "./analysisExport.ts";
import { shapeIdentity } from "./shapeImport.ts";
import {
  GEOMETRY_KINDS,
  geometryKey,
  type TAnalysisQuery,
  type TGeometry,
} from "./types.ts";

type TQuery = Omit<TAnalysisQuery, "source">;

/** How a window shows its plot: the settings a link keeps. */
const VIEW_VALUES = {
  spread: ["std", "range"],
  pathAxis: ["latitude"],
  members: ["plume", "fan", "both", "chance"],
  timeView: [
    "anomaly",
    "annual",
    "diurnal",
    "running",
    "cumulative",
    "count",
    "boxes",
    "spectrum",
    "return",
  ],
  curve: ["density", "both", "none", "cdf"],
  figure: ["rose", "hodograph", "scatter"],
  wind: "boolean",
  trend: "boolean",
  followMapTime: "boolean",
  followMapLevel: "boolean",
  minimized: "boolean",
  showTable: "boolean",
  memberThreshold: "number",
  displayUnits: "string",
  chartStyle: ["line", "bars", "points"],
  timeWindow: "number",
  timeThreshold: "number",
  centralRange: "number",
  shareAbove: "number",
  pairWith: "string",
  // The dates shown of a larger request (a preview grown by Extend): they open
  // again, not only its first dates.
  shownRange: "range",
  windChoice: "pair",
} as const;

export type TSessionView = Record<string, unknown>;

export type TSessionPlot = {
  query: TQuery;
  view?: TSessionView;
  /** The window's rectangle, in pixels of `screen`. */
  rect?: { x: number; y: number; w: number; h: number };
};

export type TSession = {
  plots: TSessionPlot[];
  /** The screen the rectangles were laid out on (CSS pixels). */
  screen?: { w: number; h: number };
  /** Compare: plots by their order in `plots`. */
  compare?: { ids: number[]; reference: number };
};

const VERSION = "2";
/** With shapes shared by several plots stored once (`geometries`). */
const SHARED_VERSION = "3";
/**
 * With a date range in several stored slices (`time.runs`, 25 Nov): an
 * older build would read the dates between them too, so it opens none.
 */
const SLICES_VERSION = "4";
/** Plots a link holds: the same limit writing and reading it. */
export const MAX_SESSION_PLOTS = 64;

/**
 * A session's text, decompressed, is at most this large: a few kilobytes of
 * link can inflate a thousandfold, and the plot limit only applies after the
 * whole text is parsed. Sessions as large as 64 imported outlines at the point
 * limit do not fit a link anyway.
 */
export const MAX_SESSION_TEXT_BYTES = 64 * 2 ** 20;

/**
 * Inflate within `limit` bytes: the compressed input goes in small slices
 * (each can grow at most about a thousandfold), and decoding stops as soon
 * as the output passes the limit, before it is all held.
 */
export function inflateWithin(bytes: Uint8Array, limit: number) {
  const parts: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate((chunk) => {
    total += chunk.length;
    if (total > limit) {
      throw new RangeError(
        `The session is larger than ${limit / 2 ** 20} MiB when unpacked.`
      );
    }
    parts.push(chunk);
  });
  const SLICE = 4096;
  for (let at = 0; at < bytes.length; at += SLICE) {
    inflater.push(bytes.subarray(at, at + SLICE), at + SLICE >= bytes.length);
  }
  if (bytes.length === 0) {
    inflater.push(bytes, true);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * A restored query whose shape's identity is computed from its outline; once
 * per shared outline and pole flags in one decode.
 */
function withIdentity<T extends { geometry: TGeometry }>(
  query: T,
  known = new WeakMap<object, Map<string, string>>()
): T {
  const g = query.geometry;
  if (g.kind === GEOMETRY_KINDS.SHAPE) {
    // With the drawing view, as at creation: a framed Box and an unframed
    // outline of the same rings are two shapes.
    const poles = g.poles ? `${g.poles.north} ${g.poles.south}` : "";
    const view = g.frame ? JSON.stringify(g.frame) : "";
    const byPoles =
      known.get(g.polygons) ??
      known.set(g.polygons, new Map()).get(g.polygons)!;
    let digest = byPoles.get(`${poles}|${view}`);
    if (digest === undefined) {
      digest = shapeIdentity(g.polygons, g.poles, g.frame);
      byPoles.set(`${poles}|${view}`, digest);
    }
    g.digest = digest;
  }
  return query;
}

/** The view settings that are known and well formed; the rest dropped. */
export function cleanView(value: unknown): TSessionView | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const out: TSessionView = {};
  for (const [key, rule] of Object.entries(VIEW_VALUES)) {
    const v = (value as Record<string, unknown>)[key];
    const ok =
      rule === "range"
        ? typeof v === "object" &&
          v !== null &&
          Number.isSafeInteger((v as { start?: unknown }).start) &&
          Number.isSafeInteger((v as { stop?: unknown }).stop) &&
          (v as { start: number }).start >= 0 &&
          (v as { stop: number }).stop > (v as { start: number }).start
        : rule === "pair"
          ? typeof v === "object" &&
            v !== null &&
            typeof (v as { u?: unknown }).u === "string" &&
            typeof (v as { v?: unknown }).v === "string"
          : rule === "number"
            ? typeof v === "number" && Number.isFinite(v)
            : typeof rule === "string"
              ? typeof v === rule
              : (rule as readonly string[]).includes(v as string);
    if (ok) {
      out[key] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

const validRect = (r: unknown): r is TSessionPlot["rect"] =>
  typeof r === "object" &&
  r !== null &&
  ["x", "y", "w", "h"].every((k) =>
    Number.isFinite((r as Record<string, unknown>)[k])
  );

/**
 * The session within the plot limit: the first MAX_SESSION_PLOTS plots,
 * Compare following them (a reference past the limit drops Compare).
 */
function limitSession(session: TSession): TSession {
  if (session.plots.length <= MAX_SESSION_PLOTS) {
    return session;
  }
  const kept = (at: number) => at < MAX_SESSION_PLOTS;
  const compare = session.compare;
  const ids = compare?.ids.filter(kept) ?? [];
  return {
    ...session,
    plots: session.plots.slice(0, MAX_SESSION_PLOTS),
    compare:
      compare && kept(compare.reference) && ids.length
        ? { ids, reference: compare.reference }
        : undefined,
  };
}

/**
 * The link value of a session (at most MAX_SESSION_PLOTS plots). A shape
 * used by several plots is written once (version 3); otherwise version 2,
 * which older builds also read.
 */
export function encodeSession(whole: TSession) {
  return encodedSession(whole).value;
}

/**
 * The link value and how many plots it holds: the first ones whose text fits
 * what a reader unpacks (MAX_SESSION_TEXT_BYTES), so a saved or shared session
 * always opens.
 */
export function encodedSession(
  whole: TSession,
  budget = MAX_SESSION_TEXT_BYTES
) {
  const session = limitSession(whole);
  const at = (count: number) =>
    sessionText({
      ...session,
      plots: session.plots.slice(0, count),
      compare:
        session.compare &&
        session.compare.reference < count &&
        session.compare.ids.some((id) => id < count)
          ? {
              ids: session.compare.ids.filter((id) => id < count),
              reference: session.compare.reference,
            }
          : undefined,
    });
  // In UTF-8 bytes, as the reader counts them.
  const bytes = (json: string) => strToU8(json).length;
  let kept = session.plots.length;
  let text = at(kept);
  if (bytes(text.json) > budget) {
    let [low, high] = [0, kept];
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (bytes(at(mid).json) <= budget) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    kept = low;
    text = at(kept);
  }
  return {
    value: `${sliced(session) ? SLICES_VERSION : text.repeated ? SHARED_VERSION : VERSION}.${toBase64Url(deflateSync(strToU8(text.json), { level: 9 }))}`,
    kept,
  };
}

/** Whether any plot reads dates in several stored slices. */
function sliced(session: TSession) {
  return session.plots.some((plot) => plot.query.time?.runs?.length);
}

/** A session's JSON text, its repeated outlines written once. */
function sessionText(session: TSession) {
  // Shapes, and drawn outlines of many points, are shared when repeated.
  const keys = session.plots.map((plot) => {
    const g = plot.query.geometry;
    if (g.kind === "shape") {
      return geometryKey(g);
    }
    const text = JSON.stringify(g);
    return text.length > 256 ? text : "";
  });
  const repeated = keys.some((key, at) => key && keys.indexOf(key) !== at);
  let payload: unknown = session;
  if (repeated) {
    const geometries: TGeometry[] = [];
    const index = new Map<string, number>();
    payload = {
      ...session,
      plots: session.plots.map((plot, at) => {
        if (!keys[at]) {
          return plot;
        }
        if (!index.has(keys[at])) {
          index.set(keys[at], geometries.length);
          geometries.push(plot.query.geometry);
        }
        // The outline is shared; each plot keeps its own name (two surveys
        // of the same coordinates stay two names).
        const g = plot.query.geometry;
        return {
          ...plot,
          query: {
            ...plot.query,
            geometry: {
              ref: index.get(keys[at]),
              // Its name, and whether it was drawn (a box's footprint) or
              // imported: the same coordinates can be either.
              // Written either way: a reference without it (older links)
              // keeps what the shared outline says.
              ...(g.kind === "shape"
                ? { name: g.name, drawn: Boolean(g.drawn) }
                : {}),
            },
          },
        };
      }),
      geometries,
    };
  }
  return { json: JSON.stringify(payload), repeated };
}

/** A version 3 plot's shared shape put back in its query. */
function withGeometry(plot: unknown, geometries: unknown[], stated = false) {
  const query = (
    plot as {
      query?: { geometry?: { ref?: unknown; name?: unknown; drawn?: unknown } };
    }
  )?.query;
  const ref = query?.geometry?.ref;
  const name = query?.geometry?.name;
  const drawn = query?.geometry?.drawn;
  const shared = typeof ref === "number" ? geometries[ref] : undefined;
  if (!shared) {
    return plot;
  }
  // A plot's own name of a shared shape.
  let geometry = shared;
  if (
    typeof name === "string" &&
    (shared as { kind?: unknown }).kind === "shape"
  ) {
    const own: Record<string, unknown> = { ...(shared as object), name };
    // Unsaid in a link where others say it: imported. Unsaid everywhere
    // (older links): as the shared outline says.
    if (drawn === true) {
      own.drawn = true;
    } else if (drawn === false || stated) {
      delete own.drawn;
    }
    geometry = own;
  }
  return { ...(plot as object), query: { ...query, geometry } };
}

/**
 * A session from a link value: version 2, or version 1 (queries only).
 * Each plot is checked on its own; a malformed one never discards the rest.
 */
// eslint-disable-next-line max-lines-per-function
export function decodeSession(value: string): TSession {
  const [version, payload] = value.split(".");
  if (version === "1") {
    // The same identity step as every version.
    return {
      plots: decodeQueriesFromUrl(value).map((query) => ({
        query: withIdentity(query),
      })),
    };
  }
  if (
    ![VERSION, SHARED_VERSION, SLICES_VERSION].includes(version) ||
    !payload
  ) {
    return { plots: [] };
  }
  try {
    const parsed = JSON.parse(
      strFromU8(inflateWithin(fromBase64Url(payload), MAX_SESSION_TEXT_BYTES))
    ) as Partial<TSession> & { geometries?: unknown[] };
    const geometries = Array.isArray(parsed.geometries)
      ? parsed.geometries
      : [];
    const kept: number[] = [];
    const identities = new WeakMap<object, Map<string, string>>();
    const checkedShapes = new WeakSet<object>();
    const listed = Array.isArray(parsed.plots) ? parsed.plots : [];
    // Some links write "drawn" only on drawn plots: where any plot says it,
    // one that does not was imported.
    const stated = (listed as unknown[]).some(
      (plot) =>
        typeof (plot as { query?: { geometry?: { drawn?: unknown } } })?.query
          ?.geometry?.drawn === "boolean"
    );
    const plots = listed
      .slice(0, MAX_SESSION_PLOTS)
      .map(
        (plot: unknown) =>
          withGeometry(plot, geometries, stated) as TSessionPlot
      )
      .flatMap((plot, at) => {
        let valid = false;
        try {
          valid = validateRestoredQuery(plot?.query, checkedShapes);
        } catch {
          valid = false;
        }
        if (!valid) {
          return [];
        }
        plot.query = withIdentity(plot.query, identities);
        kept.push(at);
        return [
          {
            query: plot.query,
            ...(cleanView(plot.view) ? { view: cleanView(plot.view) } : {}),
            ...(validRect(plot.rect) ? { rect: plot.rect } : {}),
          },
        ];
      });
    // Compare follows the plots that were kept.
    const index = (at: unknown) => kept.indexOf(at as number);
    const compare = parsed.compare;
    const ids = Array.isArray(compare?.ids)
      ? compare.ids.map(index).filter((at) => at >= 0)
      : [];
    return {
      plots,
      ...(validRect({ x: 0, y: 0, ...parsed.screen })
        ? { screen: parsed.screen }
        : {}),
      ...(compare && index(compare.reference) >= 0 && ids.length
        ? { compare: { ids, reference: index(compare.reference) } }
        : {}),
    };
  } catch {
    return { plots: [] };
  }
}
