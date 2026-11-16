import * as zarr from "zarrita";

import { AnalysisInputError } from "./analysisErrors.ts";
import {
  chunkByteSize,
  MAX_STORED_CHUNK_BYTES,
  throwIfAborted,
} from "./chunkVisitor.ts";
import {
  SHARD_INDEX_BYTES,
  type TAnalysisArray,
  type TStoredChunk,
} from "./chunkVisitor.ts";

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  ZARR_FORMAT,
  type TDatasetSource,
  type TZarrFormat,
} from "@/lib/types/GlobeTypes.ts";

/** Requests seen by the analysis store wrapper, above the shared caches. */
type TStoreStats = {
  requests: number;
  bytes: number;
  metadataRequests: number;
  missing: number;
};

function emptyStoreStats(): TStoreStats {
  return { requests: 0, bytes: 0, metadataRequests: 0, missing: 0 };
}

/** The analysis view of one dataset: arrays and group attributes by path. */
export type TAnalysisDataset = {
  /** Source generation key; changes when the source is reopened. */
  key: string;
  format: TZarrFormat;
  stats: TStoreStats;
  openArray(path: string): Promise<TAnalysisArray>;
  groupAttrs(path: string): Promise<Record<string, unknown> | null>;
  /** The cancellation of the description reading through this view. */
  signal?: AbortSignal;
  /** The data store's address, when it has one (not a local file). */
  location?: string;
  /** Another store of the same format (a CMIP6 fixed field beside it). */
  openStore?(store: string): Promise<TAnalysisDataset>;
};

/**
 * One dataset read through several stores of a catalog level: an array is
 * opened from the data store, else from the first route that has it (the
 * grid store for clat/clon and their bounds, the time store). Arrays keep
 * the key of the store that owns them, so caches never confuse them, and
 * bounds and other references resolve within that store's groups.
 */
export function composeDatasets(
  primary: TAnalysisDataset,
  routes: TAnalysisDataset[]
): TAnalysisDataset & { ownerKeys: string[]; parts: TAnalysisDataset[] } {
  const parts = [primary, ...routes];
  return {
    ...primary,
    ownerKeys: parts.map((part) => part.key),
    parts,
    // Requests of every store the level reads through, each counted once.
    get stats() {
      const total = emptyStoreStats();
      for (const part of parts) {
        total.requests += part.stats.requests;
        total.bytes += part.stats.bytes;
        total.metadataRequests += part.stats.metadataRequests;
        total.missing += part.stats.missing;
      }
      return total;
    },
    async openArray(path) {
      try {
        return await primary.openArray(path);
      } catch (error) {
        // Another store only when this one has no such array: a failed
        // request (503, permission, decoding) is that store's error.
        if (!isMissing(error)) {
          throw owned(error, primary, path);
        }
        for (const route of routes) {
          try {
            return await route.openArray(path);
          } catch (inner) {
            if (!isMissing(inner)) {
              throw owned(inner, route, path);
            }
          }
        }
        throw error;
      }
    },
  };
}

/**
 * Whether opening failed because the store has no such array (zarrita's
 * NotFoundError, a 404): only then may another store of a catalog serve it.
 */
export function isMissing(error: unknown) {
  const e = error as { name?: string; message?: string } | undefined;
  return (
    e?.name === "NotFoundError" ||
    /\bnot found\b|no such|does not exist|\b404\b/i.test(e?.message ?? "")
  );
}

/**
 * Whether a read failed for now (a 5xx, a 429, the network) rather than
 * finding nothing: such a failure is not an answer to keep.
 */
function isTransient(error: unknown) {
  const e = error as { name?: string; message?: string } | undefined;
  return (
    !isMissing(error) &&
    (e?.name === "AbortError" ||
      /\b(5\d\d|429)\b|fetch|network|timed? ?out|ECONN|socket/i.test(
        e?.message ?? ""
      ))
  );
}

/**
 * Refuse a stored chunk too large to decode before any byte of it is read:
 * coordinates, bounds, areas and fixed fields as well as the field.
 */
function guardChunkSize(
  array: { dtype: string; chunks: number[] },
  path: string
) {
  const bytes = chunkByteSize(array);
  if (bytes > MAX_STORED_CHUNK_BYTES) {
    throw new AnalysisInputError(
      `One stored chunk of ${path} decodes to ${Math.round(bytes / 2 ** 20).toLocaleString("en-US")} MiB (its declared chunk shape, padding included); plots read at most ${MAX_STORED_CHUNK_BYTES / 2 ** 20} MiB per chunk. A copy with smaller chunks is needed.`
    );
  }
}

/** An error naming the store and path it came from (aborts unchanged). */
function owned(error: unknown, store: TAnalysisDataset, path: string) {
  const e = error as Error;
  if (e?.name === "AbortError") {
    return e;
  }
  const where = store.key.split("|")[1] || store.key;
  return new Error(`${path} in ${where}: ${e?.message ?? String(error)}`, {
    cause: error,
  });
}

/** Keys of every store a dataset reads from. */
export function ownerKeys(dataset: TAnalysisDataset) {
  return (dataset as { ownerKeys?: string[] }).ownerKeys ?? [dataset.key];
}

/** The store of a composed dataset that serves an array (from its key). */
function ownerOf(dataset: TAnalysisDataset, array: TAnalysisArray) {
  const parts = (dataset as { parts?: TAnalysisDataset[] }).parts ?? [dataset];
  return parts.find((part) => array.key.startsWith(`${part.key}|`));
}

/** An array's path within the store that owns it, from its key. */
export function arrayPath(dataset: TAnalysisDataset, array: TAnalysisArray) {
  const owner = ownerOf(dataset, array);
  return owner && array.key.slice(owner.key.length + 1);
}

/**
 * Open an array that `from` names (CF bounds, formula terms, cell measures,
 * UGRID topology), resolved relative to `from`'s own group and looked up in
 * the store that holds `from` first: a time sidecar's `tb` is the sidecar's,
 * not a same-named array of the data store. Other stores are tried only
 * when the owner has no such array. `context` places `from` when its own
 * path is unknown.
 */
export async function openReferenced(
  dataset: TAnalysisDataset,
  from: TAnalysisArray | string,
  name: string,
  context = ""
): Promise<TAnalysisArray> {
  const array = typeof from === "string" ? undefined : from;
  const ownerKey = typeof from === "string" ? from : undefined;
  const owner = array
    ? ownerOf(dataset, array)
    : ((dataset as { parts?: TAnalysisDataset[] }).parts ?? [dataset]).find(
        (part) => ownerKey?.startsWith(`${part.key}|`)
      );
  const base = array
    ? (arrayPath(dataset, array) ?? context)
    : owner && ownerKey
      ? ownerKey.slice(owner.key.length + 1)
      : context;
  const path = ZarrDataManager.resolveVariablePath(base, name);
  if (owner && owner !== dataset) {
    try {
      return await owner.openArray(path);
    } catch (error) {
      // Elsewhere only when the owner has no such array, never after a
      // failed request: a 503 on the grid's bounds is not a reason to use
      // an unrelated array of the data store.
      if (!isMissing(error)) {
        throw owned(error, owner, path);
      }
    }
  }
  return dataset.openArray(path);
}

/** Per-read observations: absent keys, and time and bytes fetched. */
type TProbe = {
  probe?: { missing: number; fetchMs?: number; bytes?: number };
};

const METADATA_KEY = /(zarr\.json|\.zarray|\.zattrs|\.zgroup|\.zmetadata)$/;

function record(
  stats: TStoreStats,
  key: string,
  result: Uint8Array | undefined,
  options: unknown,
  started: number
) {
  stats.requests++;
  const observed = (options as TProbe | undefined)?.probe;
  if (observed) {
    observed.fetchMs = (observed.fetchMs ?? 0) + performance.now() - started;
    observed.bytes = (observed.bytes ?? 0) + (result?.byteLength ?? 0);
  }
  if (METADATA_KEY.test(key)) {
    stats.metadataRequests++;
  }
  if (result) {
    stats.bytes += result.byteLength;
  } else {
    stats.missing++;
    const probe = (options as TProbe | undefined)?.probe;
    if (probe) {
      probe.missing++;
    }
  }
  return result;
}

/** Counts requests and notices absent chunks, passing everything through. */
function observeStore(
  store: zarr.AsyncReadable,
  stats: TStoreStats
): zarr.AsyncReadable {
  const observed: zarr.AsyncReadable = {
    async get(key, options) {
      const started = performance.now();
      return record(
        stats,
        key,
        await store.get(key, options),
        options,
        started
      );
    },
  };
  if (store.getRange) {
    const getRange = store.getRange.bind(store);
    observed.getRange = async (key, range, options) => {
      const started = performance.now();
      return record(
        stats,
        key,
        await getRange(key, range, options),
        options,
        started
      );
    };
  }
  return observed;
}

const WIDE_KEYS = [
  "_FillValue",
  "missing_value",
  "valid_min",
  "valid_max",
  "valid_range",
  // Disjoint ranges, nested pairs.
  "valid_ranges",
  // Packing too: an offset beyond 2^53 unpacks exactly.
  "scale_factor",
  "add_offset",
];

/**
 * A JSON number literal: kept as a Number when that is exact, as the exact
 * integer's decimal string when it is an integer beyond 2^53 (written
 * plainly or with an exponent, e.g. 9.007199254740993e15).
 */
function exactNumber(literal: string): number | string {
  const value = Number(literal);
  if (Number.isSafeInteger(value) || !/^-?\d/.test(literal)) {
    return value;
  }
  const match = /^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!match) {
    return value;
  }
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  const digits = whole + fraction;
  const shift = Number(exponent) - fraction.length;
  let integer: string;
  if (shift >= 0) {
    integer = digits + "0".repeat(shift);
  } else {
    const kept = digits.slice(0, digits.length + shift);
    if (!/^0*$/.test(digits.slice(digits.length + shift))) {
      return value; // not an integer
    }
    integer = kept || "0";
  }
  integer = integer.replace(/^0+(?=\d)/, "");
  return Number.isSafeInteger(Number(integer))
    ? Number(sign + integer)
    : sign + integer;
}

/** JSON.parse that keeps integers beyond 2^53 exact (as strings). */
// eslint-disable-next-line max-lines-per-function
function parseExactJson(text: string): unknown {
  let at = 0;
  const space = () => {
    while (/\s/.test(text[at] ?? "")) {
      at++;
    }
  };
  const fail = () => {
    throw new SyntaxError(`Unexpected JSON at ${at}`);
  };
  // eslint-disable-next-line max-lines-per-function
  const value = (): unknown => {
    space();
    const c = text[at];
    if (c === "{") {
      at++;
      const out: Record<string, unknown> = {};
      space();
      if (text[at] === "}") {
        at++;
        return out;
      }
      for (;;) {
        space();
        const key = value();
        if (typeof key !== "string") {
          fail();
        }
        space();
        if (text[at++] !== ":") {
          fail();
        }
        // A repeated key keeps its last value, as JSON.parse does.
        out[key as string] = value();
        space();
        const next = text[at++];
        if (next === "}") {
          return out;
        }
        if (next !== ",") {
          fail();
        }
      }
    }
    if (c === "[") {
      at++;
      const out: unknown[] = [];
      space();
      if (text[at] === "]") {
        at++;
        return out;
      }
      for (;;) {
        out.push(value());
        space();
        const next = text[at++];
        if (next === "]") {
          return out;
        }
        if (next !== ",") {
          fail();
        }
      }
    }
    if (c === '"') {
      const start = at;
      at++;
      while (at < text.length && text[at] !== '"') {
        at += text[at] === "\\" ? 2 : 1;
      }
      at++;
      return JSON.parse(text.slice(start, at));
    }
    const literal =
      /^-?(?:\d+)(?:\.\d*)?(?:[eE][+-]?\d+)?|^(?:true|false|null|NaN|-?Infinity)/.exec(
        text.slice(at, at + 400)
      );
    if (!literal) {
      fail();
    }
    at += literal![0].length;
    const word = literal![0];
    return word === "true"
      ? true
      : word === "false"
        ? false
        : word === "null"
          ? null
          : exactNumber(word);
  };
  const out = value();
  space();
  return out;
}

/** The wide integers among one attribute value (a scalar or a list). */
function wideOf(value: unknown): boolean {
  return Array.isArray(value)
    ? value.some(wideOf)
    : typeof value === "string" && /^-?\d{16,}$/.test(value);
}

/**
 * 64-bit integer markers exactly as written: JSON parsing rounds integers
 * beyond 2^53 (9007199254740993 becomes …992), so the raw metadata is
 * parsed again losslessly and read at the right level: the array's own
 * attributes and fill value, never a same-named key nested elsewhere.
 */

/** A parsed JSON document as text with its keys in order (for comparing). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

// eslint-disable-next-line max-lines-per-function
async function exactWideIntegers(
  location: zarr.Location<zarr.AsyncReadable>,
  format: TZarrFormat,
  /** Whether the first read found attributes. */
  hadAttributes: boolean,
  /**
   * The metadata bytes the array was opened from, by key: parsed exactly, they
   * are the one revision its layout and markers come from.
   */
  captured?: Map<string, Uint8Array | undefined>
) {
  const parse = (name: string, bytes: Uint8Array) => {
    try {
      return parseExactJson(new TextDecoder().decode(bytes)) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`${name} was cut short; open it again`);
      }
      throw error;
    }
  };
  const first = (name: string) => {
    const bytes = captured?.get(location.resolve(name).path);
    return bytes && parse(name, bytes);
  };
  const read = async (name: string, required: boolean) => {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await location.store.get(location.resolve(name).path as never);
    } catch (error) {
      // A failed request is no answer: rounded markers could swap a value and
      // its fill beside 2^53, so the open fails and is tried again.
      if (!isMissing(error)) {
        throw error;
      }
    }
    // Read a moment ago, so gone or cut short now is no answer either.
    if (!bytes) {
      if (required) {
        throw new Error(`${name} could not be read again; open it again`);
      }
      return undefined;
    }
    return parse(name, bytes);
  };
  const names =
    format === ZARR_FORMAT.V2
      ? ([".zarray", ".zattrs"] as const)
      : (["zarr.json"] as const);
  const reread = await Promise.all(
    names.map((name) => read(name, name !== ".zattrs" || hadAttributes))
  );
  // The reread must be the revision opened, layout and markers included,
  // compared exactly and in any key order.
  const opened = names.map(first);
  if (
    captured &&
    names.some((_, k) => canonical(opened[k]) !== canonical(reread[k]))
  ) {
    throw new Error("its metadata changed while it was read; open it again");
  }
  const documents = captured ? opened : reread;
  const metadata = documents[0];
  const attributes = (
    format === ZARR_FORMAT.V2 ? documents[1] : metadata?.attributes
  ) as Record<string, unknown> | undefined;
  const attrs: Record<string, unknown> = {};
  for (const key of WIDE_KEYS) {
    const value = attributes?.[key];
    if (wideOf(value)) {
      attrs[key] = value;
    }
  }
  const fill = metadata?.fill_value;
  return {
    attrs,
    fillValue:
      typeof fill === "string" && /^-?\d+$/.test(fill)
        ? BigInt(fill)
        : undefined,
  };
}

/** A 64-bit integer array with its markers and ranges kept exact. */
async function withExactIntegers(
  adapted: TAnalysisArray,
  location: zarr.Location<zarr.AsyncReadable>,
  format: TZarrFormat,
  captured?: Map<string, Uint8Array | undefined>
): Promise<TAnalysisArray> {
  if (!/int64/.test(adapted.dtype)) {
    return adapted;
  }
  const exact = await exactWideIntegers(
    location,
    format,
    Object.keys(adapted.attrs).length > 0,
    captured
  );
  const fill = exact.fillValue;
  return {
    ...adapted,
    attrs: { ...adapted.attrs, ...exact.attrs },
    fillValue: fill ?? adapted.fillValue,
    async readChunk(coords, signal) {
      const chunk = await adapted.readChunk(coords, signal);
      // A synthesized chunk holds the JSON-rounded fill: use the exact one.
      if (chunk.absent && fill !== undefined && /int64/.test(adapted.dtype)) {
        const data = chunk.data as BigInt64Array | BigUint64Array;
        if (data instanceof BigUint64Array) {
          data.fill(BigInt.asUintN(64, fill));
        } else {
          data.fill(BigInt.asIntN(64, fill));
        }
      }
      return chunk;
    },
  };
}

/**
 * A sharded v3 array's index size, from the metadata it was opened from: 16
 * bytes per inner chunk of a shard, and a CRC32C if the index has one.
 */
function shardIndexOf(captured: Map<string, Uint8Array | undefined>) {
  for (const [key, bytes] of captured) {
    if (!key.endsWith("zarr.json") || !bytes) {
      continue;
    }
    try {
      const meta = JSON.parse(new TextDecoder().decode(bytes)) as {
        chunk_grid?: { configuration?: { chunk_shape?: number[] } };
        codecs?: {
          name?: string;
          configuration?: {
            chunk_shape?: number[];
            index_codecs?: { name?: string }[];
          };
        }[];
      };
      const shard = meta.codecs?.[0];
      const outer = meta.chunk_grid?.configuration?.chunk_shape;
      const inner = shard?.configuration?.chunk_shape;
      if (shard?.name !== "sharding_indexed" || !outer || !inner) {
        continue;
      }
      const chunksPerShard = outer.map((n, d) =>
        Math.max(1, Math.round(n / inner[d]))
      );
      const crc = shard.configuration?.index_codecs?.some(
        (c) => c.name === "crc32c"
      );
      return {
        shardIndex: {
          bytes: 16 * chunksPerShard.reduce((p, n) => p * n, 1) + (crc ? 4 : 0),
          chunksPerShard,
        },
      };
    } catch {
      continue;
    }
  }
  return {};
}

/**
 * A chunk's values as an indexable array: zarrita's fixed-width text (`<U3`,
 * `|S8`) and boolean arrays answer `get(i)`, not `[i]`.
 */
function plainData(data: unknown): ArrayLike<number | bigint> {
  if (ArrayBuffer.isView(data) || Array.isArray(data)) {
    return data as ArrayLike<number | bigint>;
  }
  const items = data as { length: number; get?: (at: number) => unknown };
  if (typeof items?.get === "function") {
    return Array.from({ length: items.length }, (_, at) =>
      items.get!(at)
    ) as unknown as ArrayLike<number | bigint>;
  }
  return data as ArrayLike<number | bigint>;
}

const ARRAY_METADATA_KEY = /(^|\/)(\.zarray|\.zattrs|zarr\.json)$/;

/** A store that keeps the metadata documents it is asked for, as read. */
function capturingStore(
  store: zarr.AsyncReadable,
  captured: Map<string, Uint8Array | undefined>
): zarr.AsyncReadable {
  return {
    async get(key, options) {
      const bytes = await store.get(key, options);
      if (ARRAY_METADATA_KEY.test(key)) {
        captured.set(key, bytes);
      }
      return bytes;
    },
    ...(store.getRange
      ? {
          getRange: (
            key: zarr.AbsolutePath,
            range: zarr.RangeQuery,
            options?: unknown
          ) => store.getRange!(key, range, options as never),
        }
      : {}),
  } as zarr.AsyncReadable;
}

function normalize(path: string) {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

async function openNode<K extends "array" | "group">(
  location: zarr.Location<zarr.AsyncReadable>,
  kind: K,
  format: TZarrFormat
) {
  if (format === ZARR_FORMAT.V2) {
    return await zarr.open.v2(location, { kind } as { kind: K });
  }
  if (format === ZARR_FORMAT.V3) {
    return await zarr.open.v3(location, { kind } as { kind: K });
  }
  return await zarr.open(location, { kind } as { kind: K });
}

type TShardedContext = {
  kind: "sharded";
  chunkShape: number[];
  TypedArray: new (length: number) => {
    fill: (value: unknown) => unknown;
  };
  fillValue: unknown;
  getChunkBytes: (
    coords: number[],
    options: unknown
  ) => Promise<Uint8Array | undefined>;
  codec: {
    decode: (bytes: Uint8Array) => Promise<{
      data: unknown;
      shape: number[];
      stride: number[];
    }>;
  };
};

/** zarrita's internal chunk context, when the array is sharded. */
function shardedContext(array: object): TShardedContext | undefined {
  const marker = Object.getOwnPropertySymbols(array).find(
    (symbol) => symbol.description === "zarrita.context"
  );
  const context = marker
    ? (array as Record<symbol, unknown>)[marker]
    : undefined;
  return (context as { kind?: string } | undefined)?.kind === "sharded"
    ? (context as TShardedContext)
    : undefined;
}

/**
 * An inner chunk the shard omits: the array's logical fill, typed like
 * stored data, so coordinate and ID readers see the same values as a
 * written chunk would give (a 64-bit fill is made exact by the wrapper).
 */
function absentChunk(sharded: TShardedContext) {
  const shape = sharded.chunkShape;
  const data = new sharded.TypedArray(shape.reduce((p, n) => p * n, 1));
  if (sharded.fillValue !== null && sharded.fillValue !== undefined) {
    data.fill(sharded.fillValue);
  }
  return {
    data,
    shape,
    stride: shape.map((_, d) => shape.slice(d + 1).reduce((p, n) => p * n, 1)),
  };
}

/**
 * One inner chunk of a shard, or null when the shard omits it: it is then
 * absent, and its exact typed logical fill applies (not zarrita's
 * synthetic chunk, filled with a fill value rounded through JSON).
 */
async function readInner(
  sharded: TShardedContext,
  coords: number[],
  options: unknown
) {
  const bytes = await sharded.getChunkBytes(coords, options);
  if (!bytes) {
    return null;
  }
  return sharded.codec.decode(bytes);
}

/** Identifies each array's readers (indexGroups' keys). */
let readerCount = 0;

/**
 * Which zarrita shard reader serves each shard. zarrita keeps every shard index
 * it read for its reader's life: a publication that repacks a shard would be
 * read through its old offsets and omissions. So shards are read through
 * readers of their own, each for a group of shards, opened from the metadata
 * read once; a publication's groups, and past SHARD_INDEX_BYTES the least
 * recently used group on the page, are let go and read afresh.
 */
/**
 * Every group of shard indices held on the page, least recently used first: the
 * index budget is the page's, not each array's, and what goes past it is one
 * group, not an array's every index. Weakly held, so an array let go is not
 * kept by this list.
 */
const indexGroups = new Map<
  string,
  {
    ref: WeakRef<ShardReaders>;
    /** The group's bytes and its owner's: uncounted if the owner went. */
    group: { bytes: number };
    owner: { bytes: number };
  }
>();
/** A group holds at most this share of the budget: 1/64 of it. */
const GROUPS_PER_BUDGET = 64;

/**
 * Index bytes every live array's readers hold now: a running count, kept as
 * groups gain shards or go.
 */
const indexHeld = { bytes: 0 };
/**
 * Index bytes still on their way for groups let go meanwhile: no longer held,
 * still arriving, so they count until they do.
 */
/** Until an index arrives (or is let go), or `signal` aborts. */
function abortableWait(signal?: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    };
    const aborted = () => {
      const at = indexOrphaned.waiters.indexOf(done);
      if (at >= 0) {
        indexOrphaned.waiters.splice(at, 1);
      }
      reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", aborted, { once: true });
    indexOrphaned.waiters.push(done);
  });
}

const indexOrphaned = {
  bytes: 0,
  /** Index fetches under way, page-wide. */
  fetches: 0,
  waiters: [] as (() => void)[],
};
function shardIndexTotal() {
  return indexHeld.bytes + indexOrphaned.bytes;
}
/** An index arrived (or failed): those waiting may go. */
function indexArrived(orphaned: number) {
  indexOrphaned.bytes -= orphaned;
  indexOrphaned.fetches--;
  const waiters = indexOrphaned.waiters.splice(0);
  for (const wake of waiters) {
    wake();
  }
}
/** The keys of each reader's groups in indexGroups, by reader id. */
const keysOf = new Map<number, Set<string>>();
/**
 * An array's readers let go: what they held no longer counts, and their records
 * leave the page's list.
 */
const heldBy = new FinalizationRegistry<{
  tally: { bytes: number };
  id: number;
}>(({ tally, id }) => {
  indexHeld.bytes -= tally.bytes;
  tally.bytes = 0;
  for (const key of keysOf.get(id) ?? []) {
    indexGroups.delete(key);
  }
  keysOf.delete(id);
});

type TGroup = {
  reader: TShardedContext["getChunkBytes"];
  /** Linear numbers of the shards whose index it holds. */
  seen: Set<number>;
  /** Their index bytes, as counted in `indexHeld`. */
  count: { bytes: number };
  /** Per axis, the lowest and highest shard it holds (publications). */
  low: number[];
  high: number[];
  /** Its index bytes still being fetched. */
  fetching: { bytes: number; gone: boolean };
};

class ShardReaders {
  private readonly ref = new WeakRef(this);
  private readonly id = ++readerCount;
  private perShard: number[] = [];
  /** Shards along each axis, and shards per reader. */
  private shardGrid: number[] = [];
  private perGroup = 1;
  private indexBytes = 0;
  private known?: Promise<void>;
  private readonly groups = new Map<number, TGroup>();
  private pending?: Promise<void>;
  /** Index bytes its groups hold, in `indexHeld` too. */
  private readonly tally = { bytes: 0 };

  /** The array's metadata as read by ready, reused to reopen it. */
  private metadata?: Uint8Array;

  constructor(
    private readonly array: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
    private readonly sharded: TShardedContext
  ) {
    heldBy.register(this, { tally: this.tally, id: this.id });
  }

  /** A group let go, its bytes uncounted. */
  private removeGroup(number: number) {
    const group = this.groups.get(number);
    if (group) {
      this.tally.bytes -= group.count.bytes;
      indexHeld.bytes -= group.count.bytes;
      group.count.bytes = 0;
      ShardReaders.orphan(group);
      this.groups.delete(number);
    }
  }

  /** A group's fetches still arriving count as orphaned until they do. */
  private static orphan(group: TGroup) {
    if (!group.fetching.gone) {
      group.fetching.gone = true;
      indexOrphaned.bytes += group.fetching.bytes;
    }
  }

  private clearGroups() {
    indexHeld.bytes -= this.tally.bytes;
    this.tally.bytes = 0;
    for (const group of this.groups.values()) {
      group.count.bytes = 0;
      ShardReaders.orphan(group);
    }
    this.groups.clear();
  }

  /** The shard shape, from the array's metadata (zarrita reports inner chunks). */
  private ready() {
    // A failed metadata read is tried again next time, not kept.
    this.known ??= (async () => {
      const key = `${this.array.path.replace(/\/$/, "")}/zarr.json`;
      const bytes = await this.array.store.get(key as zarr.AbsolutePath);
      this.metadata = bytes ?? undefined;
      const meta = bytes
        ? (JSON.parse(new TextDecoder().decode(bytes)) as {
            chunk_grid?: { configuration?: { chunk_shape?: number[] } };
          })
        : undefined;
      const shape =
        meta?.chunk_grid?.configuration?.chunk_shape ?? this.array.chunks;
      this.perShard = shape.map((n, d) => n / this.sharded.chunkShape[d]);
      const grid = shape.map((n, d) =>
        Math.max(1, Math.ceil(this.array.shape[d] / n))
      );
      // Shards numbered otherwise: no group's list holds any more.
      if (grid.join() !== this.shardGrid.join()) {
        this.clearGroups();
      }
      this.shardGrid = grid;
      this.indexBytes = 16 * this.perShard.reduce((p, n) => p * n, 1);
      this.perGroup = Math.max(
        1,
        Math.floor(SHARD_INDEX_BYTES / GROUPS_PER_BUDGET / this.indexBytes)
      );
    })().catch((error) => {
      this.known = undefined;
      throw error;
    });
    return this.known;
  }

  /**
   * A reader of the array as it is now, opened on its first read and opened
   * again after a failure: a publication's shards are never read through the
   * old offsets again, even when reopening fails once.
   */
  private lazyFresh(): TShardedContext["getChunkBytes"] {
    let opened: Promise<TShardedContext["getChunkBytes"]> | undefined;
    return async (coords, options) => {
      opened ??= this.fresh().catch((error) => {
        opened = undefined;
        throw error;
      });
      return (await opened)(coords, options);
    };
  }

  /** A reader of the array, from the metadata read already if any. */
  private async fresh() {
    await this.ready().catch(() => undefined);
    const store = this.array.store;
    const key = `${this.array.path.replace(/\/$/, "")}/zarr.json`;
    const metadata = this.metadata;
    // The metadata known already: no request for it; chunks and shard indices
    // from the store itself.
    const reading = metadata
      ? (new Proxy(store, {
          get: (target, name, receiver) =>
            name === "get"
              ? (path: string, ...rest: unknown[]) =>
                  path === key
                    ? Promise.resolve(metadata)
                    : (
                        target.get as (
                          p: string,
                          ...r: unknown[]
                        ) => Promise<Uint8Array | undefined>
                      ).call(target, path, ...rest)
              : Reflect.get(target, name, receiver),
        }) as typeof store)
      : store;
    const reopened = await zarr.open.v3(
      zarr.root(reading).resolve(this.array.path),
      { kind: "array" }
    );
    return (
      shardedContext(reopened)?.getChunkBytes ?? this.sharded.getChunkBytes
    );
  }

  // eslint-disable-next-line max-lines-per-function
  readonly get = async (coords: number[], options: unknown) => {
    await this.ready().catch(() => undefined);
    await this.pending;
    // Any array's index, before its range is asked for: a coordinate, a bound
    // or a measure read by a grid as well as a field.
    if (this.indexBytes > SHARD_INDEX_BYTES) {
      throw new AnalysisInputError(
        `Each shard of ${this.array.path.split("/").pop()} has an index of ${Math.round(this.indexBytes / 2 ** 20)} MiB, read before any of its values; plots keep at most ${SHARD_INDEX_BYTES / 2 ** 20} MiB of shard indexes.`
      );
    }
    const shard = coords.map((c, d) => Math.floor(c / (this.perShard[d] || 1)));
    let linear = 0;
    for (let d = 0; d < shard.length; d++) {
      linear = linear * (this.shardGrid[d] ?? 1) + shard[d];
    }
    const number = Math.floor(linear / this.perGroup);
    const key = `${this.id}|${number}`;
    let group = this.groups.get(number);
    const fetching = !group?.seen.has(linear);
    // Past the budget with indexes still on their way, this one waits for them
    // first: one let go for it would still be arriving. A cancel ends the wait,
    // and nothing is asked for after one.
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    while (
      fetching &&
      indexOrphaned.fetches > 0 &&
      shardIndexTotal() + this.indexBytes > SHARD_INDEX_BYTES
    ) {
      await abortableWait(signal);
    }
    throwIfAborted(signal);
    group = this.groups.get(number);
    if (!group?.seen.has(linear)) {
      // Every index any reader on the page holds counts. Past the budget
      // the least recently used groups go, one at a time.
      for (const [other, entry] of indexGroups) {
        if (shardIndexTotal() + this.indexBytes <= SHARD_INDEX_BYTES) {
          break;
        }
        if (other !== key) {
          const owner = entry.ref.deref();
          if (owner) {
            owner.drop(Number(other.split("|")[1]));
          } else {
            // Its readers let go: its bytes go now, unless the owner's
            // finalizer already took them all.
            const take = Math.min(entry.group.bytes, entry.owner.bytes);
            indexHeld.bytes -= take;
            entry.owner.bytes -= take;
            entry.group.bytes = 0;
          }
          indexGroups.delete(other);
          keysOf.get(Number(other.split("|")[0]))?.delete(other);
        }
      }
      if (shardIndexTotal() + this.indexBytes > SHARD_INDEX_BYTES) {
        // One index past the budget on its own: its group starts over.
        this.removeGroup(number);
      }
      group = this.groups.get(number);
      if (!group) {
        group = {
          reader: this.lazyFresh(),
          seen: new Set(),
          count: { bytes: 0 },
          low: shard.slice(),
          high: shard.slice(),
          fetching: { bytes: 0, gone: false },
        };
        this.groups.set(number, group);
      }
      group.seen.add(linear);
      group.count.bytes += this.indexBytes;
      this.tally.bytes += this.indexBytes;
      indexHeld.bytes += this.indexBytes;
      shard.forEach((at, d) => {
        group!.low[d] = Math.min(group!.low[d], at);
        group!.high[d] = Math.max(group!.high[d], at);
      });
    }
    // Most recently used last.
    indexGroups.delete(key);
    indexGroups.set(key, {
      ref: this.ref,
      group: group.count,
      owner: this.tally,
    });
    let keys = keysOf.get(this.id);
    if (!keys) {
      keys = new Set();
      keysOf.set(this.id, keys);
    }
    keys.add(key);
    if (!fetching) {
      return group.reader(coords, options);
    }
    // Its index on the way until the read returns: orphaned if its group
    // is let go meanwhile.
    const bytes = this.indexBytes;
    const tracked = group.fetching;
    tracked.bytes += bytes;
    indexOrphaned.fetches++;
    try {
      return await group.reader(coords, options);
    } finally {
      tracked.bytes -= bytes;
      indexArrived(tracked.gone ? bytes : 0);
    }
  };

  /** A group's reader and indices let go: its next read opens afresh. */
  private drop(number: number) {
    this.removeGroup(number);
  }

  /** zarrita's sharded context, read through these readers. */
  get context(): TShardedContext {
    return { ...this.sharded, getChunkBytes: this.get };
  }

  readonly forget = (axis: number, from: number, to: number) => {
    this.pending = this.renew(axis, from, to).catch(() => undefined);
  };

  /**
   * The groups holding shards a publication touched are let go: their shards
   * are read afresh, the others' indices kept. Checked against each group's
   * span, never by listing the shards.
   */
  private async renew(axis: number, from: number, to: number) {
    // Readers opened from now on read the metadata as published.
    this.known = undefined;
    this.metadata = undefined;
    try {
      await this.ready();
    } catch {
      // Its shard shape unknown for now: every shard reads afresh.
      this.clearGroups();
      return;
    }
    const size = this.array.chunks[axis] * this.perShard[axis];
    const [first, last] = [Math.floor(from / size), Math.floor(to / size)];
    for (const [number, group] of this.groups) {
      if (group.high[axis] >= first && group.low[axis] <= last) {
        this.removeGroup(number);
      }
    }
  }
}

function zarrArrayAdapter(
  key: string,
  array: zarr.Array<zarr.DataType, zarr.AsyncReadable>
): TAnalysisArray {
  const sharded = shardedContext(array);
  const readers = sharded && new ShardReaders(array, sharded);
  return {
    key,
    shape: array.shape,
    chunks: array.chunks,
    dtype: String(array.dtype),
    attrs: array.attrs as Record<string, unknown>,
    dimensionNames:
      array.dimensionNames ??
      (Array.isArray(array.attrs._ARRAY_DIMENSIONS)
        ? (array.attrs._ARRAY_DIMENSIONS as string[])
        : []),
    fillValue: array.fillValue,
    async readChunk(coords, signal): Promise<TStoredChunk> {
      guardChunkSize(array, key.split("|").pop() ?? key);
      const options = {
        signal,
        probe: { missing: 0, fetchMs: 0, bytes: 0 },
      };
      const inner = readers
        ? await readInner(readers.context, coords, options)
        : undefined;
      const missingInner = inner === null;
      const chunk = inner
        ? inner
        : missingInner
          ? absentChunk(sharded!)
          : await array.getChunk(coords, options as zarr.GetOptions);
      return {
        data: plainData(chunk.data),
        shape: chunk.shape,
        stride: chunk.stride,
        absent: missingInner || options.probe.missing > 0,
        fetchMs: options.probe.fetchMs,
        fetchedBytes: options.probe.bytes,
      };
    },
    ...(readers ? { forgetShards: readers.forget } : {}),
  };
}

let generation = 0;

/** An analysis dataset over any zarrita-readable store (also in-memory). */
// eslint-disable-next-line max-lines-per-function
export function zarrAnalysisDatasetFromStore(
  store: zarr.AsyncReadable,
  datasetPath: string,
  format: TZarrFormat,
  label: string
): TAnalysisDataset {
  const stats = emptyStoreStats();
  const root = zarr.root(observeStore(store, stats));
  const normalizedDataset = normalize(datasetPath);
  const group = normalizedDataset ? root.resolve(normalizedDataset) : root;
  const key = `${label}|${datasetPath}|${++generation}`;
  const arrays = new Map<string, Promise<TAnalysisArray>>();
  return {
    key,
    format,
    stats,
    openArray(path) {
      const normalized = normalize(path);
      let opened = arrays.get(normalized);
      if (!opened) {
        const location = group.resolve(normalized);
        // The metadata bytes this open reads, kept for the exact markers.
        const captured = new Map<string, Uint8Array | undefined>();
        const capturing = capturingStore(location.store, captured);
        opened = openNode(
          new zarr.Location(capturing, location.path),
          "array",
          format
        ).then((array) =>
          withExactIntegers(
            {
              ...zarrArrayAdapter(
                `${key}|${normalized}`,
                array as zarr.Array<zarr.DataType, zarr.AsyncReadable>
              ),
              ...shardIndexOf(captured),
            },
            location,
            format,
            captured
          )
        );
        arrays.set(normalized, opened);
        opened.catch(() => arrays.delete(normalized));
      }
      return opened;
    },
    async groupAttrs(path) {
      try {
        const normalized = normalize(path);
        const node = await openNode(
          normalized ? group.resolve(normalized) : group,
          "group",
          format
        );
        return node.attrs as Record<string, unknown>;
      } catch (error) {
        // No group there is no attributes; a failed read is not.
        if (isTransient(error)) {
          throw error;
        }
        return null;
      }
    },
  };
}

/** A Zarr (v2, v3, Icechunk, reference or local) dataset for analysis. */
export async function openZarrAnalysisDataset(
  source: TDatasetSource,
  format: TZarrFormat
): Promise<TAnalysisDataset> {
  // No byte cache: the runner's decoded-chunk cache is the one a live
  // publication updates (a byte cache would keep a half-written chunk and
  // a "no such chunk" answer).
  const base = await ZarrDataManager.createNewStore(
    source.store.replace(/\/+$/, ""),
    format === ZARR_FORMAT.ICECHUNK,
    { byteCache: false }
  );
  const dataset: TAnalysisDataset = {
    ...zarrAnalysisDatasetFromStore(base, source.dataset, format, source.store),
    location: source.store,
  };
  dataset.openStore = (store) => openStoreOnce(store, format, dataset.key);
  return dataset;
}

/** Stores opened for their fixed fields, once per address and format. */
const otherStores = new Map<string, Promise<TAnalysisDataset>>();
/** Per such store, the datasets that opened it: it goes with the last. */
const storeUsers = new Map<string, Set<string>>();

function openStoreOnce(store: string, format: TZarrFormat, user: string) {
  const key = `${format}|${store}`;
  let opened = otherStores.get(key);
  if (!opened) {
    opened = openZarrAnalysisDataset({ store, dataset: "" }, format);
    otherStores.set(key, opened);
    opened.catch(() => otherStores.delete(key));
  }
  const users = storeUsers.get(key) ?? new Set();
  storeUsers.set(key, users.add(user));
  return opened;
}

/**
 * A released dataset's fixed-field stores no other dataset uses: let go,
 * returned so their tiles and reads go too.
 */
export async function releaseStoresOf(user: string) {
  const released: TAnalysisDataset[] = [];
  for (const [key, users] of [...storeUsers]) {
    if (users.delete(user) && users.size === 0) {
      storeUsers.delete(key);
      const opened = otherStores.get(key);
      otherStores.delete(key);
      const dataset = await opened?.catch(() => undefined);
      if (dataset) {
        released.push(dataset);
      }
    }
  }
  return released;
}

// NetCDF has no chunk reads in its backend; bounded selections stand in.
const NETCDF_BLOCK_BYTES = 8 * 2 ** 20;

function virtualChunks(shape: number[], chunks: number[]) {
  const block = shape.map((size, d) =>
    Math.max(1, Math.min(size, chunks[d] || size))
  );
  const bytes = () => block.reduce((product, size) => product * size, 8);
  while (bytes() > NETCDF_BLOCK_BYTES) {
    let largest = 0;
    for (let d = 1; d < block.length; d++) {
      if (block[d] > block[largest]) {
        largest = d;
      }
    }
    if (block[largest] === 1) {
      break;
    }
    block[largest] = Math.ceil(block[largest] / 2);
  }
  return block;
}

/** A NetCDF dataset (local file or remote), read on the thread owning it. */
// eslint-disable-next-line max-lines-per-function
export function openNetCDFAnalysisDataset(
  source: TDatasetSource
): TAnalysisDataset {
  const stats = emptyStoreStats();
  const key = `${source.store}|${source.dataset}|${++generation}`;
  return {
    key,
    format: ZARR_FORMAT.NETCDF,
    stats,
    async openArray(path) {
      const array = await ZarrDataManager.getVariableInfo(
        source,
        path,
        ZARR_FORMAT.NETCDF
      );
      stats.metadataRequests++;
      const shape = array.shape;
      const chunks = virtualChunks(shape, array.chunks);
      return {
        key: `${key}|${path}`,
        shape,
        chunks,
        dtype: String(array.dtype),
        attrs: array.attrs as Record<string, unknown>,
        dimensionNames: array.dimensionNames ?? [],
        fillValue: array.fillValue,
        async readChunk(coords, signal) {
          // The NetCDF reader cannot be interrupted: a cancelled read does
          // not start, and its result is not used once cancelled.
          throwIfAborted(signal);
          guardChunkSize({ dtype: String(array.dtype), chunks }, path);
          const selection = coords.map((chunk, d) =>
            zarr.slice(
              chunk * chunks[d],
              Math.min(shape[d], (chunk + 1) * chunks[d])
            )
          );
          stats.requests++;
          const result = await ZarrDataManager.getVariableDataFromArray(
            array,
            selection
          );
          throwIfAborted(signal);
          return {
            data: result.data as ArrayLike<number | bigint>,
            shape: result.shape,
            stride: result.stride,
            absent: false,
          };
        },
      };
    },
    async groupAttrs(path) {
      try {
        const group = await ZarrDataManager.getGroup(
          source,
          path,
          ZARR_FORMAT.NETCDF
        );
        return group.attrs as Record<string, unknown>;
      } catch (error) {
        // No group there is no attributes; a failed read is not.
        if (isTransient(error)) {
          throw error;
        }
        return null;
      }
    },
  };
}
