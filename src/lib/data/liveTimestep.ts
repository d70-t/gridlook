import axios from "axios";

import { parseStorePath } from "./icechunkStore.ts";

import type { TSources } from "@/lib/types/GlobeTypes.ts";

/**
 * "Live" datasets expose only the currently-available timestep of an otherwise
 * fully-declared Zarr store. Two HTTP endpoints, served next to the store root,
 * describe which timestep can be fetched right now:
 *
 * - `current-timestep` responds immediately with the index available now.
 * - `next-timestep` long-polls and only responds once a newer timestep becomes
 *   available.
 *
 * Both return JSON of the form `{ "timestep": <index> }`, where the index is a
 * valid index into the store's (fixed) time dimension.
 */
export const CURRENT_TIMESTEP_ENDPOINT = "current-timestep";
export const NEXT_TIMESTEP_ENDPOINT = "next-timestep";

/**
 * Resolve the base HTTP URL of the Zarr store backing a live dataset.
 * Live mode is only supported for plain HTTP (`FetchStore`) datasets, so this
 * returns `undefined` for icechunk stores.
 */
export function liveStoreBaseUrl(datasources: TSources): string | undefined {
  const level = datasources.levels[0];
  const store = level?.time?.store ?? level?.grid?.store;
  if (!store) {
    return undefined;
  }
  const { backend, url } = parseStorePath(store);
  if (backend !== "fetch") {
    return undefined;
  }
  return url.replace(/\/+$/, "");
}

/** Join the store base URL with a timestep endpoint name. */
export function timestepEndpointUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint}`;
}

type TTimestepResponse = { timestep?: unknown };

/**
 * Coerce the `timestep` field into a non-negative integer. Accepts either a
 * JSON number (`{"timestep": 42}`) or a numeric string (`{"timestep": "42"}`),
 * since servers differ in how they encode it.
 */
function parseTimestep(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

async function fetchTimestep(
  url: string,
  signal: AbortSignal
): Promise<number> {
  let body: TTimestepResponse;
  try {
    const response = await axios.get<TTimestepResponse>(url, {
      signal,
      headers: { "Cache-Control": "no-store" },
    });
    body = response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const { status } = error.response;
      throw new Error(`Timestep endpoint ${url} returned HTTP ${status}`);
    }
    throw error;
  }
  const timestep = parseTimestep(body?.timestep);
  if (timestep === null) {
    throw new Error(
      `Timestep endpoint ${url} returned an invalid payload: ${JSON.stringify(
        body
      )}`
    );
  }
  return timestep;
}

/** Fetch the currently-available timestep. Responds immediately. */
export function fetchCurrentTimestep(
  baseUrl: string,
  signal: AbortSignal
): Promise<number> {
  return fetchTimestep(
    timestepEndpointUrl(baseUrl, CURRENT_TIMESTEP_ENDPOINT),
    signal
  );
}

/** Long-poll for the next timestep. Resolves once a newer one is available. */
export function fetchNextTimestep(
  baseUrl: string,
  signal: AbortSignal
): Promise<number> {
  return fetchTimestep(
    timestepEndpointUrl(baseUrl, NEXT_TIMESTEP_ENDPOINT),
    signal
  );
}

function isAbortError(error: unknown): boolean {
  return (
    axios.isCancel(error) ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export type TLiveTimestepControllerOptions = {
  /** Base HTTP URL of the live store (see {@link liveStoreBaseUrl}). */
  baseUrl: string;
  /** Called with each timestep index that becomes available (newest first). */
  onTimestep: (timestep: number) => void;
  /** Notified when the long-poll connection is established or lost. */
  onConnectedChange?: (connected: boolean) => void;
  /** Notified about transient errors while (re)connecting. */
  onError?: (error: unknown) => void;
  /** Initial reconnect delay in ms (default 1000). */
  minBackoffMs?: number;
  /** Maximum reconnect delay in ms (default 30000). */
  maxBackoffMs?: number;
};

const DEFAULT_MIN_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30000;

/**
 * Drives auto-following of a live dataset. On {@link start} it fetches the
 * current timestep immediately, then keeps long-polling `next-timestep`,
 * emitting each new index through `onTimestep`. Transient failures are retried
 * with exponential backoff. Call {@link stop} to abort any in-flight request
 * and end the loop; pausing/resuming is modelled by stopping and creating a new
 * controller.
 */
export class LiveTimestepController {
  private readonly options: TLiveTimestepControllerOptions;
  private readonly abortController = new AbortController();
  private stopped = false;
  private started = false;

  constructor(options: TLiveTimestepControllerOptions) {
    this.options = options;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.run();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.abortController.abort();
    this.options.onConnectedChange?.(false);
  }

  private async run(): Promise<void> {
    const signal = this.abortController.signal;
    const minBackoff = this.options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    const maxBackoff = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    let backoff = minBackoff;
    // Fetch the current timestep first so we jump straight to the newest data,
    // then switch to long-polling for subsequent ones.
    let fetchCurrent = true;

    while (!this.stopped) {
      try {
        const timestep = fetchCurrent
          ? await fetchCurrentTimestep(this.options.baseUrl, signal)
          : await fetchNextTimestep(this.options.baseUrl, signal);
        if (this.stopped) {
          return;
        }
        this.options.onConnectedChange?.(true);
        backoff = minBackoff;
        fetchCurrent = false;
        this.options.onTimestep(timestep);
      } catch (error) {
        if (this.stopped || isAbortError(error)) {
          return;
        }
        this.options.onConnectedChange?.(false);
        this.options.onError?.(error);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
  }
}
