import type { TExportRequest, TExportResponse } from "./export.worker.ts";
import {
  restoreSnapshot,
  snapshotBytes,
  snapshotForExport,
  snapshotTransfer,
  type TExportSnapshot,
} from "./exportSnapshot.ts";
import type { TAnalysisResult } from "./types.ts";

/**
 * Background NetCDF-4 and Zarr ZIP exports. One file is written at a time;
 * waiting files are admitted by their bytes (copied once, at the click, then
 * transferred to the worker), so repeated clicks cannot pile up copies of
 * large results. A window's downloads are cancelled when it closes. Only
 * when no worker can be started is a file written on this thread, and the
 * caller is told so.
 */
const MAX_QUEUED_BYTES = 256 * 2 ** 20;
const MAX_QUEUED = 2;

export type TExportOutcome = { bytes: Uint8Array; background: boolean };

type TJob = {
  owner: string;
  format: "nc" | "zarr";
  snapshot: TExportSnapshot;
  resolve: (outcome: TExportOutcome) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let workerBroken = false;
let running:
  | {
      id: number;
      job: TJob;
      /** Written on this thread: its slot is held until the write ends. */
      here?: boolean;
      cancelled?: boolean;
    }
  | undefined;
const queue: TJob[] = [];
let nextId = 0;

const aborted = () => new DOMException("Download cancelled", "AbortError");

function finish(id: number, response: TExportResponse) {
  const done = running;
  if (!done || done.id !== id) {
    return;
  }
  running = undefined;
  if ("bytes" in response) {
    done.job.resolve({ bytes: response.bytes, background: true });
  } else {
    done.job.reject(new Error(response.error));
  }
  pump();
}

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./export.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<TExportResponse>) =>
      finish(event.data.id, event.data);
    worker.onerror = (event) => {
      const done = running;
      running = undefined;
      stopWorker();
      done?.job.reject(
        new Error(event.message || "The background writer failed.")
      );
      pump();
    };
  }
  return worker;
}

function stopWorker() {
  worker?.terminate();
  worker = undefined;
}

async function onThisThread(job: TJob) {
  const result = restoreSnapshot(job.snapshot);
  const exporter = await import("./scientificExport.ts");
  const model = exporter.exportModel(result);
  if (job.format === "zarr") {
    return exporter.toZarrZip(model);
  }
  const netcdf = await import("./netcdfWriter.ts");
  try {
    return netcdf.writeNetCDF(await netcdf.loadNetCDFModule(), model);
  } catch (error) {
    netcdf.resetNetCDFModule();
    throw error;
  }
}

async function runHere(id: number, job: TJob) {
  const live = () => running?.id === id && !running.cancelled;
  try {
    const bytes = await onThisThread(job);
    if (live()) {
      job.resolve({ bytes, background: false });
    }
  } catch (error) {
    if (live()) {
      job.reject(error as Error);
    }
  }
  if (running?.id === id) {
    running = undefined;
  }
  pump();
}

function pump() {
  if (running || !queue.length) {
    return;
  }
  const job = queue.shift()!;
  const id = ++nextId;
  running = { id, job };
  if (!workerBroken) {
    try {
      const message: TExportRequest = {
        id,
        format: job.format,
        snapshot: job.snapshot,
      };
      getWorker().postMessage(message, snapshotTransfer(job.snapshot));
      return;
    } catch {
      // No worker can be made here: say so, and write on this thread.
      workerBroken = true;
      stopWorker();
    }
  }
  running.here = true;
  void runHere(id, job);
}

/** The file's bytes, written in the background (one at a time). */
export function writeScientificFile(
  format: "nc" | "zarr",
  result: TAnalysisResult,
  owner: string
): Promise<TExportOutcome> {
  // Admitted from the predicted size, before the snapshot is built.
  const refusal = exportRefusal(result);
  if (refusal) {
    return Promise.reject(new Error(refusal));
  }
  const snapshot = snapshotForExport(result);
  return new Promise((resolve, reject) => {
    queue.push({ owner, format, snapshot, resolve, reject });
    pump();
  });
}

/**
 * Why a download of `result` cannot be queued now, before anything is
 * copied for it (the click-time copy and the snapshot are both its size).
 */
export function exportRefusal(result: TAnalysisResult): string | undefined {
  if (queue.length >= MAX_QUEUED) {
    return "Two downloads are already waiting; try again shortly.";
  }
  const waiting = queue.reduce((sum, job) => sum + job.snapshot.bytes, 0);
  return waiting + snapshotBytes(result) > MAX_QUEUED_BYTES
    ? "Downloads already waiting hold too much data; try again when they finish."
    : undefined;
}

/** Cancel a window's waiting and running downloads (it is closing). */
export function cancelDownloads(owner: string) {
  for (let at = queue.length - 1; at >= 0; at--) {
    if (queue[at].owner === owner) {
      queue.splice(at, 1)[0].reject(aborted());
    }
  }
  if (running?.job.owner === owner && running.here) {
    // Written on this thread, it cannot be stopped: said cancelled now, its
    // slot freed when the write ends.
    if (!running.cancelled) {
      running.cancelled = true;
      running.job.reject(aborted());
    }
  } else if (running?.job.owner === owner) {
    const { job } = running;
    running = undefined;
    // The worker is mid-write: stop it and free its memory.
    stopWorker();
    job.reject(aborted());
    pump();
  }
}
