import {
  AnalysisInputError,
  AnalysisSizeError,
  type TErrorDetail,
} from "./analysisErrors.ts";
import { ByteLru } from "./byteLru.ts";
import { ReadContext, ReadLimiter, throwIfAborted } from "./chunkVisitor.ts";
import { forgetGeometries } from "./nativeGrid.ts";
import { type TPlannedAnalysis } from "./operations.ts";
import { planAnalysis } from "./planAnalysis.ts";
import {
  openReferenced,
  composeDatasets,
  openNetCDFAnalysisDataset,
  openZarrAnalysisDataset,
  releaseStoresOf,
  ownerKeys,
  type TAnalysisDataset,
} from "./sourceAdapter.ts";
import type {
  TAnalysisQuery,
  TAnalysisResult,
  TPartialUpdate,
  TPlanEstimate,
} from "./types.ts";
import {
  ANALYSIS_GRID_KINDS,
  releaseSharedAxes,
  resolveVariableContext,
  type TCapability,
  type TVariableContext,
} from "./variableContext.ts";

import {
  publishedLevels,
  pyramidRelativePath,
  resolveHealpixFrame,
} from "@/lib/grids/analysisGrid.ts";
import {
  ZARR_FORMAT,
  type TDatasetSource,
  type TZarrFormat,
} from "@/lib/types/GlobeTypes.ts";

/** The source of a run, serializable to the worker (no File objects). */
// At most this often a streaming plot is redrawn while parts arrive faster.
const PUBLISH_EVERY_MS = 250;

export type TRunSource = {
  /** Session-unique key: source address plus the page's source generation. */
  key: string;
  store: string;
  dataset: string;
  format: TZarrFormat;
  file?: File;
  /**
   * Further stores of the same catalog level, searched in order for what
   * the data store lacks: an ICON level keeps its grid (clat, clon and
   * their bounds) and its time axis in stores of their own.
   */
  routes?: { store: string; dataset: string }[];
  /**
   * Which level of a multi-level catalog is read, when it has several: plots
   * read one level on purpose, named in Method.
   */
  level?: {
    index: number;
    count: number;
    label: string;
    /** Every level's path (group), for the one a variable path names. */
    paths?: (string | undefined)[];
  };
};

/** What the plot windows need to know about a variable before reading. */
export type TVariableSummary = {
  /**
   * What describing it downloaded (opening the source, its metadata),
   * apart from any plot's own reads; absent when nothing was fetched.
   */
  opened?: {
    requests: number;
    bytes: number;
    unknown: number;
    /** Downloaded where it cannot be counted (a reader's own worker). */
    uncounted?: boolean;
  };
  variable: string;
  dims: string[];
  shape: number[];
  gridLabel: string;
  order?: number;
  frame?: string;
  conflicts: string[];
  indexValidation?: string;
  time?: {
    dimension: string;
    /** Decoded coordinate values; label them with timeLabelAt. */
    raw: number[];
    note?: string;
    calendar?: string;
    units?: string;
    /** Time steps per stored chunk of the field. */
    chunk?: number;
    /** Declared cells, [start, end] per step, flat. */
    bounds?: number[];
    /** The variable's CF cell_methods. */
    cellMethods?: string;
    /** Intensive or extensive: what bounds without cell_methods mean. */
    quantity?: "intensive" | "extensive";
    /** Stored chunks reading the coordinate (and bounds) whole takes. */
    reads?: number;
    readBytes?: number;
  };
  vertical?: {
    dimension: string;
    label: string;
    values: number[];
    physical: boolean;
    units?: string;
    positive?: "up" | "down";
    note?: string;
    kind: string;
    /** CF standard name of the positions, when known. */
    standardName?: string;
    /** Published layer bounds, [low, high] per level, flat. */
    bounds?: number[];
    /** The variable's cell methods and quantity: what a level's value is. */
    cellMethods?: string;
    quantity?: "intensive" | "extensive";
  };
  others: {
    dimension: string;
    size: number;
    /** Entries per stored chunk of the field along it. */
    chunk?: number;
    ensemble?: boolean;
    ids?: (string | undefined)[];
    idsUnread?: boolean;
    /** A forecast period: its leads, unit and bounds (NaN: not read). */
    forecastPeriod?: {
      values: number[];
      units?: string;
      seconds?: number;
      bounds?: number[];
      unread?: boolean;
    };
  }[];
  capabilities: Record<string, TCapability>;
  units?: string;
  longName?: string;
  decoding: string;
  overviews: { variable: string; order: number }[];
};

type TPending = {
  sourceKey: string;
  /**
   * Live publications of every source the run reads (a regional vector's
   * partner may be another) when it was planned.
   */
  generations: Map<string, number>;
  controller: AbortController;
  planned?: TPlannedAnalysis;
  /** Settles when planning or execution of this run has stopped. */
  work?: Promise<unknown>;
  paused?: boolean;
  resume?: () => void;
};

/**
 * The dataset as context creation sees it: once `signal` aborts, no further
 * metadata or chunk read starts (reads in flight are told through their own
 * signal). Arrays keep the guard, which never aborts after creation.
 */
function guardDataset(
  dataset: TAnalysisDataset,
  signal: AbortSignal
): TAnalysisDataset {
  return {
    ...dataset,
    // Shared coordinate reads use the arrays without this guard and stop
    // only when every description using them has (see shareRead).
    signal,
    async openArray(path) {
      throwIfAborted(signal);
      const array = await dataset.openArray(path);
      return {
        ...array,
        unguarded: array,
        readChunk(coords, readSignal) {
          throwIfAborted(signal);
          throwIfAborted(readSignal);
          return array.readChunk(
            coords,
            readSignal ? AbortSignal.any([readSignal, signal]) : signal
          );
        },
      };
    },
    groupAttrs(path) {
      throwIfAborted(signal);
      return dataset.groupAttrs(path);
    },
  };
}

/** Settle with the promise, or reject at once when the signal aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
  });
}

/** Waits while a run is paused; a cancel ends the wait. */
async function waitWhilePaused(entry: TPending, signal?: AbortSignal) {
  while (entry.paused && !signal?.aborted) {
    await new Promise<void>((resolve) => {
      entry.resume = resolve;
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Cancelled", "AbortError");
  }
}

export type TRunErrorKind = "input" | "cancelled" | "failure";

export function classifyError(error: unknown): {
  kind: TRunErrorKind;
  message: string;
  detail?: TErrorDetail;
} {
  if (error instanceof AnalysisSizeError) {
    return { kind: "input", message: error.message, detail: error.detail };
  }
  if (error instanceof AnalysisInputError) {
    return { kind: "input", message: error.message };
  }
  if ((error as { name?: string })?.name === "AbortError") {
    return { kind: "cancelled", message: "Cancelled" };
  }
  const message = error instanceof Error ? error.message : String(error);
  // Decided here, by the error itself, where its kind is known: the help
  // offers Retry for a store that did not answer, fewer dates for memory.
  const detail: TErrorDetail | undefined =
    error instanceof RangeError
      ? { reason: "memory" }
      : (error instanceof TypeError && /fetch|network/i.test(message)) ||
          /\bHTTP \d{3}\b|status \d{3}/.test(message)
        ? { reason: "unreachable" }
        : undefined;
  return { kind: "failure", message, ...(detail ? { detail } : {}) };
}

/** One per page or worker: caches, the read limiter and pending runs. */
/**
 * The formula terms of a context's vertical axis that vary along its time
 * dimension, as chunk prefixes to forget (their shard indices forgotten).
 */
async function timeTerms(context: TVariableContext, from: number, to: number) {
  const vertical = context.vertical;
  // Its time axis, even while its timestamps are unusable.
  const dimension =
    context.time?.dimension ??
    (context.timeProblemAxis !== undefined
      ? context.dims[context.timeProblemAxis]
      : undefined);
  const found: TPublishedArray[] = [];
  if (!vertical?.terms || !dimension) {
    return found;
  }
  for (const path of Object.values(vertical.terms)) {
    const term = await openReferenced(
      context.dataset,
      vertical.termsOwner ?? context.array,
      path,
      context.variable
    ).catch(() => undefined);
    const axis = term?.dimensionNames.indexOf(dimension) ?? -1;
    if (term && axis >= 0) {
      found.push({ prefix: `${term.key}|`, axis, size: term.chunks[axis] });
      term.forgetShards?.(axis, from, to);
    }
  }
  return found;
}

/** An array along time whose published chunks go (key prefix, axis, steps a chunk). */
type TPublishedArray = { prefix: string; axis: number; size: number };

export class AnalysisRunner {
  readonly read = new ReadContext();
  readonly indexCache = new ByteLru<BigInt64Array>(32 * 2 ** 20);
  private readonly datasets = new Map<string, Promise<TAnalysisDataset>>();
  private readonly contexts = new Map<string, Promise<TVariableContext>>();
  /**
   * Descriptions a publication dropped, until the variable is described again:
   * a second publication before then still knows its arrays.
   */
  private readonly retired = new Map<string, Promise<TVariableContext>>();
  private readonly creations = new WeakMap<
    Promise<TVariableContext>,
    { waiters: number; settled: boolean; controller: AbortController }
  >();
  private readonly pending = new Map<string, TPending>();
  private executing = 0;
  /** Executions started, for runs overlapping a run's lifetime. */
  private runsStarted = 0;
  // Planning reads metadata, coordinates and indexes: two plans at a time.
  private readonly planning = new ReadLimiter(2);
  /** Everything still using a source's readers, awaited before release. */
  private readonly borrowers = new Map<string, Set<Promise<unknown>>>();
  /** Live publications seen per dataset: a plan records the count. */
  private readonly generation = new Map<string, number>();
  /** Variables (`dataset|variable`) a publication is still refreshing. */
  private readonly publishing = new Map<string, Promise<unknown>>();

  /** Aborted when a source is released: descriptions stop reading. */
  private readonly sourceAborts = new Map<string, AbortController>();

  private sourceSignal(sourceKey: string) {
    let controller = this.sourceAborts.get(sourceKey);
    if (!controller) {
      controller = new AbortController();
      this.sourceAborts.set(sourceKey, controller);
    }
    return controller.signal;
  }

  /** Register work on a source; a release waits until it has settled. */
  private borrow<T>(sourceKey: string, work: Promise<T>) {
    let set = this.borrowers.get(sourceKey);
    if (!set) {
      set = new Set();
      this.borrowers.set(sourceKey, set);
    }
    const settled = work.catch(() => undefined);
    set.add(settled);
    void settled.finally(() => set.delete(settled));
    return work;
  }

  /** Register a run's work on every source it reads. */
  private borrowAll<T>(entry: TPending, work: Promise<T>) {
    for (const key of entry.generations.keys()) {
      this.borrow(key, work);
    }
    return work;
  }

  private dataset(source: TRunSource) {
    let dataset = this.datasets.get(source.key);
    if (!dataset) {
      const datasetSource: TDatasetSource = {
        store: source.store,
        dataset: source.dataset,
        file: source.file,
      };
      const own =
        source.format === ZARR_FORMAT.NETCDF
          ? Promise.resolve(openNetCDFAnalysisDataset(datasetSource))
          : openZarrAnalysisDataset(datasetSource, source.format);
      const routes = (source.routes ?? []).filter(
        (route) =>
          route.store !== source.store || route.dataset !== source.dataset
      );
      dataset =
        routes.length && source.format !== ZARR_FORMAT.NETCDF
          ? (async () =>
              composeDatasets(
                await own,
                await Promise.all(
                  routes.map((route) =>
                    openZarrAnalysisDataset(route, source.format)
                  )
                )
              ))()
          : own;
      this.datasets.set(source.key, dataset);
      dataset.catch(() => this.datasets.delete(source.key));
    }
    return dataset;
  }

  /**
   * A variable's context, created once and shared. While it is being
   * created, each waiter with a signal is counted; when the last one leaves,
   * creation stops issuing reads and the entry is dropped (no orphan work).
   */
  // eslint-disable-next-line max-lines-per-function
  context(
    source: TRunSource,
    variable: string,
    signal?: AbortSignal,
    published = false
  ): Promise<TVariableContext> {
    const key = `${source.key}|${variable}`;
    // A publication refreshing this variable: its description follows it.
    const publishing = this.publishing.get(key);
    if (publishing && !published) {
      // A cancel ends the wait.
      const waited = signal ? untilAborted(publishing, signal) : publishing;
      return waited.then(() => this.context(source, variable, signal, true));
    }
    let context = this.contexts.get(key);
    if (!context) {
      const controller = new AbortController();
      const creation = { waiters: 0, settled: false, controller };
      context = this.dataset(source).then((dataset) =>
        resolveVariableContext(
          guardDataset(dataset, controller.signal),
          variable,
          this.indexCache
        )
      );
      this.contexts.set(key, context);
      this.creations.set(context, creation);
      const created = context;
      // Kept unless it failed, or a read in it failed: the next description
      // reads that again. A dropped description still says which arrays a
      // publication changes, until one is usable.
      const settle = (keep: boolean, usable = keep) => {
        creation.settled = true;
        if (usable) {
          this.retired.delete(key);
        }
        if (!keep && this.contexts.get(key) === created) {
          this.contexts.delete(key);
          if (!usable) {
            this.retired.set(key, created);
          }
        }
      };
      void created.then(
        (resolved) =>
          settle(
            !resolved.time?.boundsFailed &&
              // Areas whose store was down: asked again.
              !(
                "areasUnreachable" in resolved.grid &&
                resolved.grid.areasUnreachable
              )
          ),
        () => {
          creation.settled = true;
          if (this.contexts.get(key) === created) {
            this.contexts.delete(key);
          }
        }
      );
    }
    const creation = this.creations.get(context);
    if (!signal && creation) {
      // A waiter that cannot cancel keeps creation going.
      creation.waiters = Number.POSITIVE_INFINITY;
    }
    if (signal && creation && !creation.settled) {
      creation.waiters++;
      const created = context;
      const onAbort = () => {
        creation.waiters--;
        if (creation.waiters <= 0 && !creation.settled) {
          creation.controller.abort(signal.reason);
          if (this.contexts.get(key) === created) {
            this.contexts.delete(key);
          }
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // Gone once the description is made: a listener left on a signal that
      // lives as long as its source kept each replaced timestamp array
      // reachable.
      void created.then(
        () => signal.removeEventListener("abort", onAbort),
        () => signal.removeEventListener("abort", onAbort)
      );
    }
    return context;
  }

  private async overviews(
    source: TRunSource,
    variable: string,
    signal: AbortSignal
  ) {
    // Every overview open goes through the release signal.
    const dataset = guardDataset(await this.dataset(source), signal);
    const assets = publishedLevels(await dataset.groupAttrs(""));
    // The path below the most specific published level (`levels/17`),
    // so another level's field is the same subgroup's, never an unrelated
    // field with the same leaf name.
    const relative = pyramidRelativePath(variable, assets) ?? variable;
    const found: { variable: string; order: number }[] = [];
    for (const asset of assets) {
      const candidate = `${asset}/${relative}`;
      if (candidate === variable) {
        continue;
      }
      throwIfAborted(signal);
      try {
        const array = await dataset.openArray(candidate);
        const group = await dataset.groupAttrs(asset);
        const crs = await dataset.openArray(`${asset}/crs`).catch((error) => {
          if ((error as Error)?.name === "AbortError") {
            throw error;
          }
          return undefined;
        });
        throwIfAborted(signal);
        const frame = resolveHealpixFrame({
          crsAttrs: crs?.attrs,
          dggs: (group?.dggs as Record<string, unknown> | undefined) ?? null,
          cellCount: array.shape[array.shape.length - 1],
        });
        found.push({ variable: candidate, order: frame.options.level });
      } catch (error) {
        if ((error as Error)?.name === "AbortError") {
          throw error;
        }
        // not a level of this variable
      }
    }
    throwIfAborted(signal);
    return found.sort((a, b) => b.order - a.order);
  }

  /**
   * A variable's summary. `signal` belongs to the one waiting window: when
   * it aborts (its last subscriber closed), the description stops reading,
   * unless another description shares the same context creation.
   */
  describe(source: TRunSource, variable: string, signal?: AbortSignal) {
    return this.borrow(source.key, this.describeNow(source, variable, signal));
  }

  // eslint-disable-next-line max-lines-per-function
  private async describeNow(
    source: TRunSource,
    variable: string,
    own?: AbortSignal
  ): Promise<TVariableSummary> {
    const released = this.sourceSignal(source.key);
    const signal = own ? AbortSignal.any([released, own]) : released;
    const context = await this.context(source, variable, signal);
    const { grid, time, vertical } = context;
    const overviews =
      grid.kind === ANALYSIS_GRID_KINDS.HEALPIX
        ? await this.overviews(source, variable, signal)
        : [];
    return {
      variable,
      dims: context.dims,
      shape: context.array.shape,
      gridLabel:
        grid.kind === ANALYSIS_GRID_KINDS.HEALPIX
          ? `HEALPix order ${grid.order}, ${grid.layout}`
          : grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR
            ? `latitude/longitude ${grid.lat.values.length} × ${grid.lon.values.length}${grid.lat.bounds ? ", with bounds" : ", no bounds"}`
            : grid.kind === ANALYSIS_GRID_KINDS.NATIVE
              ? `${grid.label}; ${grid.method}`
              : "unsupported",
      order: grid.kind === ANALYSIS_GRID_KINDS.HEALPIX ? grid.order : undefined,
      frame:
        grid.kind === ANALYSIS_GRID_KINDS.HEALPIX
          ? grid.frame.ellipsoidLabel
          : undefined,
      conflicts:
        grid.kind === ANALYSIS_GRID_KINDS.HEALPIX ? grid.frame.conflicts : [],
      indexValidation:
        grid.kind === ANALYSIS_GRID_KINDS.HEALPIX
          ? grid.index.validation
          : undefined,
      time: time && {
        dimension: time.dimension,
        raw: time.raw,
        note: time.note,
        calendar: time.calendar,
        units: time.units,
        // Steps per stored chunk: a first preview reads whole chunks.
        chunk: context.array.chunks[time.axis],
        // What each step is (an instant, or a statistic over its cell):
        // partners are matched by it before reading.
        ...(time.bounds ? { bounds: time.bounds } : {}),
        // Published valid times and their cells: partners pair by them.
        ...(time.valid ? { valid: time.valid } : {}),
        ...(time.validBounds ? { validBounds: time.validBounds } : {}),
        ...(time.validBoundsUnread
          ? { validBoundsUnread: time.validBoundsUnread }
          : {}),
        ...(context.cellMethods ? { cellMethods: context.cellMethods } : {}),
        ...(context.quantity ? { quantity: context.quantity } : {}),
        // Its own reads (stamps and bounds), said apart in Method.
        ...(context.timeArrays?.length
          ? {
              reads: context.timeArrays.reduce((n, a) => n + a.reads, 0),
              readBytes: context.timeArrays.reduce((n, a) => n + a.bytes, 0),
            }
          : {}),
      },
      // The level selector lists the dimension's own coordinate: physical
      // values with units, or a formula's model coordinate without them
      // (its pressure or height differs by column).
      vertical: vertical && {
        dimension: vertical.dimension,
        label:
          vertical.kind === "formula"
            ? `${vertical.dimension} (model coordinate)`
            : vertical.label,
        values: vertical.values,
        physical: vertical.kind === "physical",
        units: vertical.kind === "physical" ? vertical.units : undefined,
        positive: vertical.positive,
        note: vertical.note,
        kind: vertical.kind,
        // What the positions are of (altitude or height above the surface):
        // equal numbers of two such quantities are no common level.
        ...(vertical.positionStandardName
          ? { standardName: vertical.positionStandardName }
          : {}),
        // A level's layer, matched before any partner read.
        ...(vertical.bounds ? { bounds: vertical.bounds } : {}),
        ...(context.cellMethods ? { cellMethods: context.cellMethods } : {}),
        ...(context.quantity ? { quantity: context.quantity } : {}),
      },
      others: context.others.map(
        ({
          axis,
          dimension,
          size,
          ensemble,
          ids,
          idsUnread,
          forecastPeriod,
        }) => ({
          dimension,
          size,
          chunk: context.array.chunks[axis],
          ...(ensemble ? { ensemble } : {}),
          ...(ids ? { ids } : {}),
          ...(idsUnread ? { idsUnread } : {}),
          // Its leads travel with the summary: a partner query made on the page
          // matched leads by position without them.
          ...(forecastPeriod
            ? {
                forecastPeriod: {
                  values: forecastPeriod.values.slice(),
                  ...(forecastPeriod.units
                    ? { units: forecastPeriod.units }
                    : {}),
                  ...(forecastPeriod.seconds !== undefined
                    ? { seconds: forecastPeriod.seconds }
                    : {}),
                  ...(forecastPeriod.bounds
                    ? { bounds: forecastPeriod.bounds.slice() }
                    : {}),
                  ...(forecastPeriod.lazy || forecastPeriod.lazyBounds
                    ? { unread: true }
                    : {}),
                },
              }
            : {}),
        })
      ),
      capabilities: context.capabilities,
      units: context.units,
      longName: context.longName,
      decoding: context.codec.rule,
      overviews,
    };
  }

  /**
   * Plan a run. Its entry exists before the first await, so a cancel at any
   * point stops metadata, lookup and covering work; a failed or cancelled
   * plan leaves no pending state.
   */
  // eslint-disable-next-line max-lines-per-function
  async plan(
    runId: string,
    source: TRunSource,
    query: TAnalysisQuery,
    geometryConfirmed = false
  ): Promise<TPlanEstimate> {
    this.cancel(runId);
    const controller = new AbortController();
    const sources = new Set([source.key]);
    if (query.jointWith) {
      sources.add((query.jointSource ?? source).key);
    }
    const entry: TPending = {
      controller,
      sourceKey: source.key,
      generations: new Map(
        [...sources].map((key) => [key, this.generation.get(key) ?? 0])
      ),
    };
    this.pending.set(runId, entry);
    const work = this.planning.run(async () => {
      // A publication of this variable's dates is forgotten first.
      await untilAborted(
        Promise.all([
          this.publishing.get(`${source.key}|${query.variable}`),
          query.jointWith &&
            this.publishing.get(
              `${(query.jointSource ?? source).key}|${query.jointWith}`
            ),
        ]),
        controller.signal
      );
      const context = await untilAborted(
        this.context(source, query.variable, controller.signal),
        controller.signal
      );
      // The other vector component, from its own store when it has one.
      const partner = query.jointWith
        ? await untilAborted(
            this.context(
              query.jointSource ?? source,
              query.jointWith,
              controller.signal
            ).catch((error) => {
              if ((error as Error)?.name === "AbortError") {
                throw error;
              }
              return undefined;
            }),
            controller.signal
          )
        : undefined;
      throwIfAborted(controller.signal);
      const started = performance.now();
      const planned = await planAnalysis(
        context,
        query,
        this.read,
        controller.signal,
        geometryConfirmed,
        partner
      );
      throwIfAborted(controller.signal);
      planned.estimate.notes.push(
        `Planning took ${Math.round(performance.now() - started)} ms.`
      );
      return planned;
    }, controller.signal);
    entry.work = this.borrowAll(entry, work);
    try {
      entry.planned = await work;
      return entry.planned.estimate;
    } catch (error) {
      if (this.pending.get(runId) === entry) {
        this.pending.delete(runId);
      }
      throw error;
    }
  }

  // eslint-disable-next-line max-lines-per-function
  async execute(
    runId: string,
    onPartial?: (update: TPartialUpdate) => void
  ): Promise<TAnalysisResult> {
    const entry = this.pending.get(runId);
    if (!entry?.planned) {
      throw new Error("The run was not planned or was cancelled.");
    }
    // Planned before a live publication: its reads and estimate may be of
    // data that changed. The caller plans it again.
    if (
      [...entry.generations].some(
        ([key, generation]) => (this.generation.get(key) ?? 0) !== generation
      )
    ) {
      this.pending.delete(runId);
      throw new Error(
        "The source published new data since this plot was planned; plan it again."
      );
    }
    // Store counters of this run's own source; overlapping runs are flagged.
    const dataset = await this.datasets
      .get(entry.sourceKey)
      ?.catch(() => undefined);
    const before = dataset && { ...dataset.stats };
    const overlapAtStart = this.executing;
    // Runs started while this one reads overlap it too, even one that starts
    // and finishes while a chunk of this one is waiting.
    const startedBefore = this.runsStarted++;
    this.executing++;
    let overlapSeen = overlapAtStart;
    const watchOverlap = () => {
      overlapSeen = Math.max(overlapSeen, this.executing - 1);
    };
    const work = entry.planned.execute(entry.controller.signal, {
      onPartial: (update) => {
        watchOverlap();
        onPartial?.(update);
      },
      waitIfPaused: (signal) => waitWhilePaused(entry, signal),
      // One time chunk per part: coalesce updates while parts arrive fast.
      publishEveryMs: PUBLISH_EVERY_MS,
    });
    entry.work = this.borrowAll(entry, work);
    try {
      const result = await work;
      watchOverlap();
      if (dataset && before) {
        const after = dataset.stats;
        result.counters.storeRequests += after.requests - before.requests;
        result.counters.storeBytes += after.bytes - before.bytes;
        result.counters.metadataReads +=
          after.metadataRequests - before.metadataRequests;
      }
      const startedSince = this.runsStarted - 1 - startedBefore;
      result.counters.overlappingRuns = Math.max(overlapSeen, startedSince);
      return result;
    } finally {
      this.executing--;
      if (this.pending.get(runId) === entry) {
        this.pending.delete(runId);
      }
    }
  }

  /** Stop after the part being read; the run keeps its place. */
  pause(runId: string) {
    const entry = this.pending.get(runId);
    if (entry) {
      entry.paused = true;
    }
  }

  resume(runId: string) {
    const entry = this.pending.get(runId);
    if (entry) {
      entry.paused = false;
      entry.resume?.();
    }
  }

  cancel(runId: string) {
    const entry = this.pending.get(runId);
    if (entry) {
      entry.controller.abort(new DOMException("Cancelled", "AbortError"));
      this.pending.delete(runId);
    }
  }

  /**
   * Forget a source: cancel its runs, wait until they have stopped using
   * its readers, then free grids and caches.
   */
  // eslint-disable-next-line max-lines-per-function
  async release(sourceKey: string) {
    this.sourceAborts
      .get(sourceKey)
      ?.abort(new DOMException("Source released", "AbortError"));
    this.sourceAborts.delete(sourceKey);
    const stopping: Promise<unknown>[] = [];
    for (const [runId, entry] of [...this.pending]) {
      if (entry.generations.has(sourceKey)) {
        this.cancel(runId);
        if (entry.work) {
          stopping.push(entry.work.catch(() => undefined));
        }
      }
    }
    await Promise.all(stopping);
    // Variable contexts still being created for this source stop issuing
    // reads (a description of a released source has no one to tell).
    for (const [key, context] of this.contexts) {
      const creation = this.creations.get(context);
      if (key.startsWith(`${sourceKey}|`) && creation && !creation.settled) {
        creation.controller.abort(
          new DOMException("Source released", "AbortError")
        );
      }
    }
    // Descriptions and any other work still holding the source finish first.
    await Promise.all(
      [...(this.borrowers.get(sourceKey) ?? [])].map((work) =>
        Promise.resolve(work).catch(() => undefined)
      )
    );
    const dataset = await this.datasets.get(sourceKey)?.catch(() => undefined);
    for (const key of [...this.contexts.keys()]) {
      if (key.startsWith(`${sourceKey}|`)) {
        const context = await this.contexts.get(key)?.catch(() => undefined);
        if (context?.grid.kind === ANALYSIS_GRID_KINDS.HEALPIX) {
          context.grid.grid.free();
        }
        this.contexts.delete(key);
      }
    }
    for (const key of [...this.retired.keys()]) {
      if (key.startsWith(`${sourceKey}|`)) {
        this.retired.delete(key);
      }
    }
    this.datasets.delete(sourceKey);
    if (dataset) {
      // Its native geometries go with it (a split store's grid included).
      forgetGeometries(dataset.key);
      // Every store the source reads through (data, grid and time routes).
      for (const key of ownerKeys(dataset)) {
        this.read.clearSource(key);
        releaseSharedAxes(key);
        // The key and its separator: generation 1 never matches 10.
        this.indexCache.deletePrefix(`${key}|`);
      }
      // Fixed-field stores it alone used: their area tiles and reads too.
      for (const user of new Set([dataset.key, ...ownerKeys(dataset)])) {
        for (const sibling of await releaseStoresOf(user)) {
          forgetGeometries(sibling.key);
          this.read.clearSource(sibling.key);
          releaseSharedAxes(sibling.key);
          this.indexCache.deletePrefix(`${sibling.key}|`);
        }
      }
    }
  }

  /**
   * A live source published time steps `from`..`to`. Every dataset opened for
   * it (one per variable's store, `base|store|dataset`) forgets the chunks that
   * may have changed, in each store it reads through. Plans priced before are
   * stale at once, and each variable is refreshed on its own: one still being
   * described does not hold up another's.
   */
  // eslint-disable-next-line max-lines-per-function
  forgetPublished(base: string, from: number, to: number): Promise<void> {
    const mine = (key: string) => key === base || key.startsWith(`${base}|`);
    const refreshed = new Map<string, Promise<boolean>>();
    const work: Promise<unknown>[] = [];
    for (const [key, pending] of [...this.datasets]) {
      if (!mine(key)) {
        continue;
      }
      // Plans priced before this publication are replanned before they run.
      this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
      const forget = (arrays: TPublishedArray[], gaps: boolean) =>
        pending.then((dataset) => {
          for (const owner of ownerKeys(dataset)) {
            this.read.forgetPublished(owner, arrays, from, to, gaps);
          }
          return undefined;
        });
      const known: TPublishedArray[] = [];
      const described: Promise<void>[] = [];
      const current = [...this.contexts];
      // Every description that read this variable, also one retired while its
      // replacement is still being made.
      const dropped = [...this.retired].filter(
        ([contextKey, created]) => this.contexts.get(contextKey) !== created
      );
      for (const [contextKey, created] of [...current, ...dropped]) {
        if (!contextKey.startsWith(`${key}|`)) {
          continue;
        }
        const own = created
          .then((context) =>
            this.publishedArrays(
              contextKey,
              created,
              context,
              refreshed,
              from,
              to,
              // The field's chunks go at once, not after its timestamps.
              (arrays) => forget(arrays, false),
              // Stopped by a release of the source.
              this.sourceSignal(key)
            )
          )
          .then(async (arrays) => {
            known.push(...arrays);
            await forget(arrays, false);
            return undefined;
          })
          .catch(() => undefined);
        // A description asked for now waits for every publication still
        // refreshing this variable, not just the latest.
        const earlier = this.publishing.get(contextKey);
        const settled = earlier
          ? Promise.all([earlier, own]).then(() => undefined)
          : own;
        this.publishing.set(contextKey, settled);
        void settled.finally(() => {
          if (this.publishing.get(contextKey) === settled) {
            this.publishing.delete(contextKey);
          }
        });
        described.push(this.borrow(key, settled));
      }
      // Then the gaps of arrays no variable describes along time.
      work.push(
        ...described,
        Promise.all(described).then(() => forget(known, true))
      );
    }
    return Promise.all(work.map((w) => w.catch(() => undefined))).then(
      () => undefined
    );
  }

  /**
   * One variable's arrays along time that a publication of `from`..`to`
   * changes; its time coordinate and bounds are refreshed on the way.
   */
  // eslint-disable-next-line max-lines-per-function
  private async publishedArrays(
    contextKey: string,
    created: Promise<TVariableContext>,
    context: TVariableContext,
    refreshed: Map<string, Promise<boolean>>,
    from: number,
    to: number,
    forgetNow?: (arrays: TPublishedArray[]) => Promise<unknown>,
    stop?: AbortSignal
  ) {
    const arrays: TPublishedArray[] = [];
    // The field along time first, even while its time coordinate is unusable or
    // cannot be refreshed now: its chunks go whatever the timestamps do.
    const timeAxis = context.time?.axis ?? context.timeProblemAxis;
    if (timeAxis !== undefined) {
      arrays.push({
        prefix: `${context.array.key}|`,
        axis: timeAxis,
        size: context.array.chunks[timeAxis],
      });
      // Repacked shards: their indices are read again.
      context.array.forgetShards?.(timeAxis, from, to);
      // A formula's terms along time (a hybrid level's surface pressure) change
      // with the field: their chunks and shard indices go too.
      for (const term of await timeTerms(context, from, to).catch(
        () => [] as TPublishedArray[]
      )) {
        arrays.push(term);
      }
      await forgetNow?.([...arrays]);
    }
    // The published steps' timestamps and bounds may be new or corrected (or
    // complete metadata that was not): their chunks and shard indices go, and
    // the variable is described again.
    if (context.timeArrays?.length) {
      for (const array of context.timeArrays) {
        arrays.push({
          prefix: `${array.key}|`,
          axis: 0,
          size: array.size,
        });
      }
      // Once each, however many variables share it; described again
      // when a value changed (or was incomplete, or could not be read),
      // else kept: no metadata read for each step published.
      const changed = await Promise.all(
        context.timeArrays.map((array) => {
          const once =
            refreshed.get(array.key) ??
            array.refresh(
              from,
              to,
              array.matrix ? context.time?.bounds : context.time?.raw,
              stop
            );
          refreshed.set(array.key, once);
          return once;
        })
      ).catch(() => [true]);
      if (
        (changed.some(Boolean) ||
          context.timeProblem ||
          context.time?.boundsUnread) &&
        this.contexts.get(contextKey) === created
      ) {
        this.contexts.delete(contextKey);
        this.retired.set(contextKey, created);
      }
    }
    return arrays;
  }

  memory() {
    return {
      chunkCacheBytes: this.read.chunkCache.bytes,
      indexCacheBytes: this.indexCache.bytes,
      pendingRuns: this.pending.size,
    };
  }
}
