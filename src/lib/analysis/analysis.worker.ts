// / <reference lib="webworker" />

import {
  AnalysisRunner,
  classifyError,
  type TRunSource,
} from "./analysisRunner.ts";
import {
  AnalysisMessageType,
  type TAnalysisPayload,
  type TAnalysisWorkerRequest,
  type TAnalysisWorkerResponse,
} from "./analysisWorkerProtocol.ts";

import { countedBody } from "@/lib/data/countedBody.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const runner = new AnalysisRunner();
/** Descriptions still running, by id, so a closed window can stop them. */
const descriptions = new Map<string, AbortController>();

// Every fetch in this worker is an analysis read: count physical requests and
// the body bytes that actually arrive, not a declared length. Counts cover the
// whole worker while a run executes; runs that overlap it are reported in the
// run's counters.
const fetches = { count: 0, bytes: 0, unknown: 0 };
const baseFetch = workerScope.fetch.bind(workerScope);
workerScope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  fetches.count++;
  return countedBody(await baseFetch(input, init), (n) => {
    fetches.bytes += n;
  });
};

async function describe(
  source: TRunSource,
  variable: string,
  describeId?: string
) {
  const controller = new AbortController();
  if (describeId) {
    descriptions.set(describeId, controller);
  }
  const before = { ...fetches };
  try {
    const summary = await runner.describe(source, variable, controller.signal);
    // What opening the source cost, said apart from the plot's reads.
    const requests = fetches.count - before.count;
    return requests
      ? {
          ...summary,
          opened: {
            requests,
            bytes: fetches.bytes - before.bytes,
            unknown: fetches.unknown - before.unknown,
          },
        }
      : summary;
  } finally {
    if (describeId) {
      descriptions.delete(describeId);
    }
  }
}

/** Country lookups and outlines, off the page (the atlas lives here). */
async function countries(
  message: Extract<
    TAnalysisWorkerRequest,
    { type: "country-at" | "country-outline" | "country-borders" }
  >
): Promise<TAnalysisPayload> {
  if (message.type === AnalysisMessageType.COUNTRY_BORDERS) {
    const { countryBorders } = await import("./countryGeoJSON.ts");
    return countryBorders();
  }
  const { countryAt, getCountryRings } = await import("./countryAtlas.ts");
  if (message.type === AnalysisMessageType.COUNTRY_AT) {
    return (
      (await countryAt(message.lat, message.lon, message.resolution)) ?? null
    );
  }
  const { countryOutline } = await import("./countryOutline.ts");
  return countryOutline(await getCountryRings(message.id, message.resolution));
}

async function handle(
  message: TAnalysisWorkerRequest
): Promise<TAnalysisPayload> {
  switch (message.type) {
    case AnalysisMessageType.DESCRIBE:
      return describe(message.source, message.variable, message.describeId);
    case AnalysisMessageType.CANCEL_DESCRIBE:
      descriptions
        .get(message.describeId)
        ?.abort(new DOMException("Description cancelled", "AbortError"));
      return null;
    case AnalysisMessageType.PLAN:
      return await runner.plan(
        message.runId,
        message.source,
        message.query,
        message.geometryConfirmed
      );
    case AnalysisMessageType.EXECUTE:
      return await runner.execute(message.runId, (partial) => {
        const response: TAnalysisWorkerResponse = {
          requestId: message.requestId,
          type: AnalysisMessageType.PARTIAL,
          payload: partial,
        };
        workerScope.postMessage(response);
      });
    case AnalysisMessageType.CANCEL:
      runner.cancel(message.runId);
      return null;
    case AnalysisMessageType.PAUSE:
      runner.pause(message.runId);
      return null;
    case AnalysisMessageType.RESUME:
      runner.resume(message.runId);
      return null;
    case AnalysisMessageType.RELEASE:
      await runner.release(message.sourceKey);
      return null;
    case AnalysisMessageType.COUNTRY_AT:
    case AnalysisMessageType.COUNTRY_OUTLINE:
    case AnalysisMessageType.COUNTRY_BORDERS:
      return countries(message);
    case AnalysisMessageType.PUBLISHED:
      await runner.forgetPublished(message.sourceKey, message.from, message.to);
      return null;
  }
}

// This module waits (top-level await) for HEALPix WebAssembly before it
// runs, and a message arriving during that wait finds no handler and is
// dropped. The client therefore posts nothing until READY below.
workerScope.onmessage = async (event: MessageEvent<TAnalysisWorkerRequest>) => {
  const message = event.data;
  ZarrDataManager.setRequestSettings(message.requestSettings);
  const before = { ...fetches };
  try {
    const payload = await handle(message);
    const response: TAnalysisWorkerResponse = {
      requestId: message.requestId,
      type: AnalysisMessageType.RESULT,
      payload,
      fetches: {
        count: fetches.count - before.count,
        bytes: fetches.bytes - before.bytes,
        unknown: fetches.unknown - before.unknown,
      },
    };
    workerScope.postMessage(response);
  } catch (error) {
    const { kind, message: text, detail } = classifyError(error);
    const response: TAnalysisWorkerResponse = {
      requestId: message.requestId,
      type: AnalysisMessageType.ERROR,
      kind,
      message: text,
      ...(detail ? { detail } : {}),
    };
    workerScope.postMessage(response);
  }
};
workerScope.postMessage({ type: AnalysisMessageType.READY });
