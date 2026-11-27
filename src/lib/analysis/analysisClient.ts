import type { TErrorDetail } from "./analysisErrors.ts";
import type {
  TRunErrorKind,
  TRunSource,
  TVariableSummary,
} from "./analysisRunner.ts";
import {
  AnalysisMessageType,
  type TAnalysisPayload,
  type TAnalysisWorkerRequest,
  type TAnalysisWorkerResponse,
} from "./analysisWorkerProtocol.ts";
import { createPartialAssembler } from "./partialUpdates.ts";
import { createSlots } from "./slots.ts";
import type { TLatLon } from "./sphere.ts";
import type {
  TAnalysisQuery,
  TAnalysisResult,
  TCountryGeometry,
  TCountryResolution,
  TPartialUpdate,
  TPlanEstimate,
} from "./types.ts";

import { isLocalZarrSource } from "@/lib/data/localZarr.ts";
import { splitSourceType } from "@/lib/data/sourceType.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

export class AnalysisRunError extends Error {
  constructor(
    message: string,
    readonly kind: TRunErrorKind,
    /** What the failure is, as decided where it happened. */
    readonly detail?: TErrorDetail
  ) {
    super(message);
  }
}

type TFetches = { count: number; bytes: number; unknown: number };

type TPending = {
  resolve: (reply: { payload: TAnalysisPayload; fetches: TFetches }) => void;
  reject: (error: Error) => void;
  onPartial?: (update: TPartialUpdate) => void;
};

type TDistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type TRequestBody = TDistributiveOmit<
  TAnalysisWorkerRequest,
  "requestId" | "requestSettings"
>;

let worker: Worker | undefined;
/** Resolves when the current worker has installed its message handler. */
let workerReady: Promise<void> = Promise.resolve();
let nextRequestId = 0;
const pending = new Map<number, TPending>();

function getWorker() {
  if (worker) {
    return worker;
  }
  const created = new Worker(new URL("./analysis.worker.ts", import.meta.url), {
    type: "module",
  });
  let ready!: () => void;
  workerReady = new Promise<void>((resolve) => (ready = resolve));
  created.onmessage = (event: MessageEvent<TAnalysisWorkerResponse>) => {
    const response = event.data;
    if (response.type === AnalysisMessageType.READY) {
      ready();
      return;
    }
    const entry = pending.get(response.requestId);
    if (!entry) {
      return;
    }
    if (response.type === AnalysisMessageType.PARTIAL) {
      entry.onPartial?.(response.payload);
      return;
    }
    pending.delete(response.requestId);
    if (response.type === AnalysisMessageType.ERROR) {
      entry.reject(
        new AnalysisRunError(response.message, response.kind, response.detail)
      );
    } else {
      entry.resolve({ payload: response.payload, fetches: response.fetches });
    }
  };
  created.onerror = (event) => {
    for (const entry of pending.values()) {
      entry.reject(
        new AnalysisRunError(
          event.message || "The analysis worker failed.",
          "failure"
        )
      );
    }
    pending.clear();
    created.terminate();
    worker = undefined;
  };
  worker = created;
  return created;
}

function postWithFetches(
  body: TRequestBody,
  onPartial?: (update: TPartialUpdate) => void
) {
  const requestId = ++nextRequestId;
  // Requests come from reactive store state; workers only take plain data.
  const message = {
    ...(JSON.parse(JSON.stringify(body)) as TRequestBody),
    requestId,
    requestSettings: ZarrDataManager.getRequestSettings(),
  } as TAnalysisWorkerRequest;
  return new Promise<{ payload: TAnalysisPayload; fetches: TFetches }>(
    (resolve, reject) => {
      pending.set(requestId, { resolve, reject, onPartial });
      // Posted only once the worker listens (in order: promise callbacks run
      // first come, first served); a worker that fails rejects `pending`.
      const target = getWorker();
      void workerReady.then(() => {
        if (worker === target && pending.has(requestId)) {
          target.postMessage(message);
        }
        return undefined;
      });
    }
  );
}

async function post(body: TRequestBody) {
  return (await postWithFetches(body)).payload;
}

type TMainRunner = import("./analysisRunner.ts").AnalysisRunner;
let mainRunner: Promise<TMainRunner> | undefined;

/** Local files are registered only on this thread, so they run here. */
/**
 * Whether what opening a source downloads is unseen here: a remote NetCDF file,
 * read by the map's reader in a worker of its own. The address as reached, its
 * format prefix aside.
 */
export function transferUnseen(
  source: Pick<TRunSource, "format" | "store" | "file">
) {
  return (
    source.format === ZARR_FORMAT.NETCDF &&
    !source.file &&
    /^https?:/i.test(splitSourceType(source.store).url)
  );
}

function runsOnMainThread(source: TRunSource) {
  return (
    source.format === ZARR_FORMAT.NETCDF ||
    Boolean(source.file) ||
    isLocalZarrSource(source.store)
  );
}

function getMainRunner() {
  mainRunner ??= import("./analysisRunner.ts").then(
    (module) => new module.AnalysisRunner()
  );
  return mainRunner;
}

async function onMain<T>(task: (runner: TMainRunner) => Promise<T>) {
  const runner = await getMainRunner();
  try {
    return await task(runner);
  } catch (error) {
    const { classifyError } = await import("./analysisRunner.ts");
    const { kind, message, detail } = classifyError(error);
    throw new AnalysisRunError(message, kind, detail);
  }
}

// File objects stay on the main thread; remote runs never need them.
function withoutFile(source: TRunSource): TRunSource {
  return {
    key: source.key,
    store: source.store,
    dataset: source.dataset,
    format: source.format,
    ...(source.routes ? { routes: source.routes } : {}),
  };
}

let nextDescribeId = 0;

/**
 * Descriptions in flight at once, across sources: a restored session of
 * 64 plots asks a few at a time (as many as a browser opens to one host),
 * in the order the windows asked.
 */
const DESCRIBE_SLOTS = 6;
const describeSlots = createSlots(DESCRIBE_SLOTS);

/**
 * A variable's summary. When `signal` aborts (the window waiting for it
 * closed), the description stops reading and this rejects at once; one
 * still waiting for a slot never starts.
 */
export function describeVariable(
  source: TRunSource,
  variable: string,
  signal?: AbortSignal,
  /** 0 for a window on screen; higher waits (a minimized window). */
  priority = 0
) {
  return describeSlots
    .run(() => describeNow(source, variable, signal), signal, priority)
    .catch((error: unknown) => {
      throw signal?.aborted
        ? new AnalysisRunError("Cancelled", "cancelled")
        : error;
    });
}

async function describeNow(
  source: TRunSource,
  variable: string,
  signal?: AbortSignal
) {
  if (runsOnMainThread(source)) {
    const summary = await onMain((runner) =>
      runner.describe(source, variable, signal)
    );
    // A remote NetCDF file is opened by the map's reader in a worker of its
    // own: what that downloads is not seen here, and is said to be unknown, not
    // zero.
    return transferUnseen(source)
      ? {
          ...summary,
          opened: { requests: 0, bytes: 0, unknown: 0, uncounted: true },
        }
      : summary;
  }
  const describeId = `d${++nextDescribeId}`;
  const answer = post({
    type: AnalysisMessageType.DESCRIBE,
    source: withoutFile(source),
    variable,
    describeId,
  }) as Promise<TVariableSummary>;
  if (!signal) {
    return answer;
  }
  return new Promise<TVariableSummary>((resolve, reject) => {
    const stop = () => {
      void post({ type: AnalysisMessageType.CANCEL_DESCRIBE, describeId });
      reject(new AnalysisRunError("Cancelled", "cancelled"));
    };
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
    const settle = async () => {
      try {
        resolve(await answer);
      } catch (error) {
        reject(error);
      } finally {
        signal.removeEventListener("abort", stop);
      }
    };
    void settle();
  });
}

export async function planRun(
  runId: string,
  source: TRunSource,
  query: TAnalysisQuery,
  geometryConfirmed = false
) {
  if (runsOnMainThread(source)) {
    return onMain((runner) =>
      runner.plan(runId, source, query, geometryConfirmed)
    );
  }
  return (await post({
    type: AnalysisMessageType.PLAN,
    runId,
    source: withoutFile(source),
    query,
    geometryConfirmed,
  })) as TPlanEstimate;
}

export async function executeRun(
  runId: string,
  source: TRunSource,
  onPartial?: (result: TAnalysisResult) => void
) {
  // Streamed updates carry only new values; rebuild whole partial results.
  const assemble = onPartial && createPartialAssembler(onPartial);
  if (runsOnMainThread(source)) {
    return onMain((runner) => runner.execute(runId, assemble));
  }
  const { payload, fetches } = await postWithFetches(
    { type: AnalysisMessageType.EXECUTE, runId },
    assemble
  );
  const result = payload as TAnalysisResult;
  // Concurrent runs share the worker: counters.overlappingRuns says so.
  result.counters.physicalRequests = fetches.count;
  result.counters.physicalBytes = fetches.bytes;
  result.counters.physicalUnknownSizes = fetches.unknown;
  return result;
}

export function cancelRun(runId: string, source: TRunSource) {
  if (runsOnMainThread(source)) {
    void getMainRunner().then((runner) => runner.cancel(runId));
    return;
  }
  void post({ type: AnalysisMessageType.CANCEL, runId }).catch(() => {});
}

/** Pause or resume a streamed run between its parts. */
export function setRunPaused(
  runId: string,
  source: TRunSource,
  paused: boolean
) {
  if (runsOnMainThread(source)) {
    void getMainRunner().then((runner) =>
      paused ? runner.pause(runId) : runner.resume(runId)
    );
    return;
  }
  void post({
    type: paused ? AnalysisMessageType.PAUSE : AnalysisMessageType.RESUME,
    runId,
  }).catch(() => {});
}

/**
 * The country at a map click, at a boundary detail. Looked up in the
 * analysis worker, which also holds the atlas for masks, so preparing a
 * fine boundary does not stall the page; on the page only without one.
 */
export async function countryAtPoint(
  lat: number,
  lon: number,
  resolution: TCountryResolution
): Promise<TCountryGeometry | undefined> {
  if (typeof Worker === "undefined") {
    const { countryAt } = await import("./countryAtlas.ts");
    return countryAt(lat, lon, resolution);
  }
  const found = await post({
    type: AnalysisMessageType.COUNTRY_AT,
    lat,
    lon,
    resolution,
  });
  return (found as TCountryGeometry | null) ?? undefined;
}

/** A country's map outline at a boundary detail, prepared like the pick. */
export async function countryOutlineOf(
  id: string,
  resolution: TCountryResolution
): Promise<TLatLon[][]> {
  if (typeof Worker === "undefined") {
    const [{ getCountryRings }, { countryOutline }] = await Promise.all([
      import("./countryAtlas.ts"),
      import("./countryOutline.ts"),
    ]);
    return countryOutline(await getCountryRings(id, resolution));
  }
  return (await post({
    type: AnalysisMessageType.COUNTRY_OUTLINE,
    id,
    resolution,
  })) as TLatLon[][];
}

/** The borders between countries (coarse scale), for the country picker. */
export async function countryBordersOf(): Promise<TLatLon[][]> {
  if (typeof Worker === "undefined") {
    const { countryBorders } = await import("./countryGeoJSON.ts");
    return countryBorders();
  }
  return (await post({
    type: AnalysisMessageType.COUNTRY_BORDERS,
  })) as TLatLon[][];
}

/**
 *  A live source published time steps `from`..`to`: cached reads of them
 * may be stale. `source` is the dataset's base source.
 */
export function sourcePublished(source: TRunSource, from: number, to: number) {
  if (runsOnMainThread(source)) {
    void getMainRunner().then((runner) =>
      runner.forgetPublished(source.key, from, to)
    );
    return;
  }
  if (worker) {
    void post({
      type: AnalysisMessageType.PUBLISHED,
      sourceKey: source.key,
      from,
      to,
    }).catch(() => {});
  }
}

export function releaseSource(source: TRunSource) {
  if (runsOnMainThread(source)) {
    void getMainRunner().then((runner) => runner.release(source.key));
    return;
  }
  if (worker) {
    void post({
      type: AnalysisMessageType.RELEASE,
      sourceKey: source.key,
    }).catch(() => {});
  }
}
