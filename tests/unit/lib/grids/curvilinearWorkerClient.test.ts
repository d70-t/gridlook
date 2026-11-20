import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { projectGridToLonLat } from "@/lib/data/crsInverse.ts";
import {
  buildCurvilinearHoverIndex,
  clearCurvilinearHoverIndexes,
  projectCurvilinearGrid,
  registerReusableCoordinates,
  setMaxCachedHoverBytes,
  terminateCurvilinearWorker,
} from "@/lib/grids/curvilinearWorkerClient.ts";
import {
  CurvilinearWorkerRequestType,
  type TCurvilinearWorkerRequest,
} from "@/lib/grids/curvilinearWorkerProtocol.ts";
import { GridGeometryWorkerMessageType } from "@/lib/grids/gridGeometryWorkerProtocol.ts";

class TMockWorker {
  static instances: TMockWorker[] = [];

  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  messages: TCurvilinearWorkerRequest[] = [];
  transfers: Transferable[][] = [];
  terminated = false;

  constructor() {
    TMockWorker.instances.push(this);
  }

  postMessage(message: TCurvilinearWorkerRequest, transfer: Transferable[]) {
    this.messages.push(message);
    this.transfers.push(transfer);
  }

  terminate() {
    this.terminated = true;
  }

  // Answers the last request the way the worker does: metadata without
  // batches, the result, done.
  respond(result: unknown) {
    const { requestId } = this.messages[this.messages.length - 1];
    const emit = (data: unknown) => this.onmessage?.({ data } as MessageEvent);
    emit({
      requestId,
      type: GridGeometryWorkerMessageType.METADATA,
      metadata: { totalBatches: 0 },
    });
    emit({
      requestId,
      type: GridGeometryWorkerMessageType.HOVER_INDEX,
      hoverIndexData: result,
    });
    emit({ requestId, type: GridGeometryWorkerMessageType.DONE });
  }
}

beforeEach(() => {
  TMockWorker.instances = [];
  vi.stubGlobal("Worker", TMockWorker);
});

afterEach(() => {
  terminateCurvilinearWorker();
  clearCurvilinearHoverIndexes();
  setMaxCachedHoverBytes();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const dataset = {};

// A build left unanswered is cancelled by terminateCurvilinearWorker in
// afterEach; the grid handles that rejection, these tests ignore it.
function dangling<T>(promise: Promise<T>) {
  promise.catch(() => {});
  return promise;
}

function reusable(cells: number) {
  const coordinates = [
    new Float32Array(cells),
    new Float32Array(cells),
  ] as const;
  registerReusableCoordinates(dataset, ...coordinates);
  return coordinates;
}

it("projects a grid in its own worker and transfers copies of the axes", async () => {
  const x = new Float32Array([0, 1000]);
  const y = new Float32Array([0, -1000, -2000]);
  const projection = projectCurvilinearGrid(x, y, "+proj=longlat");
  const worker = TMockWorker.instances[0];
  const message = worker.messages[0];
  expect(message.type).toBe(CurvilinearWorkerRequestType.PROJECT);
  if (message.type !== CurvilinearWorkerRequestType.PROJECT) {
    return;
  }
  expect(message.crs).toBe("+proj=longlat");
  expect(message.x).toEqual(x);
  expect(message.x).not.toBe(x);
  expect(worker.transfers[0]).toEqual([message.x.buffer, message.y.buffer]);

  const result = {
    latitudes: new Float32Array(6),
    longitudes: new Float32Array(6),
  };
  worker.respond(result);
  await expect(projection).resolves.toEqual(result);
  // The projection worker is not the hover index worker.
  dangling(
    buildCurvilinearHoverIndex(new Float32Array(1), new Float32Array(1))
  );
  expect(TMockWorker.instances).toHaveLength(2);
  expect(TMockWorker.instances[1].messages[0].type).toBe(
    CurvilinearWorkerRequestType.HOVER_INDEX
  );
});

function hoverIndexResult(samples: number) {
  return {
    indexData: new ArrayBuffer(8),
    latitudes: new Float64Array(samples),
    longitudes: new Float64Array(samples),
    values: new Float32Array(0),
    sampleIds: new Uint32Array(samples),
  };
}

it("reuses the hover indexes of registered coordinates, within the byte bound", async () => {
  const coarse = reusable(2);
  const fine = reusable(3);
  const first = buildCurvilinearHoverIndex(...coarse);
  TMockWorker.instances[0].respond(hoverIndexResult(2));
  await expect(first).resolves.toEqual(hoverIndexResult(2));
  expect(buildCurvilinearHoverIndex(...coarse)).toBe(first);

  const second = buildCurvilinearHoverIndex(...fine);
  // The worker is not kept alive between builds: a new one gets the request.
  expect(TMockWorker.instances).toHaveLength(2);
  TMockWorker.instances[1].respond(hoverIndexResult(3));
  await second;
  expect(buildCurvilinearHoverIndex(...coarse)).toBe(first);
  expect(buildCurvilinearHoverIndex(...fine)).toBe(second);
  // The cache outlives the grid: a variable change remounts it.
  terminateCurvilinearWorker();
  expect(buildCurvilinearHoverIndex(...fine)).toBe(second);

  // Past the bound (48 bytes a cell) the least recently used index goes.
  setMaxCachedHoverBytes(3 * 48);
  expect(buildCurvilinearHoverIndex(...fine)).toBe(second);
  expect(dangling(buildCurvilinearHoverIndex(...coarse))).not.toBe(first);
  expect(TMockWorker.instances).toHaveLength(3);
});

it("builds unregistered coordinates (lat/lon read from the store) without caching", async () => {
  const latitudes = new Float32Array(2);
  const longitudes = new Float32Array(2);
  const first = buildCurvilinearHoverIndex(latitudes, longitudes);
  TMockWorker.instances[0].respond(hoverIndexResult(2));
  await first;
  expect(dangling(buildCurvilinearHoverIndex(latitudes, longitudes))).not.toBe(
    first
  );
  expect(TMockWorker.instances).toHaveLength(2);
});

it("takes other longitudes for the same latitudes as other coordinates", async () => {
  const latitudes = new Float32Array(2);
  registerReusableCoordinates(dataset, latitudes, new Float32Array(2));
  const first = buildCurvilinearHoverIndex(latitudes, new Float32Array(2));
  expect(TMockWorker.instances).toHaveLength(1);
  TMockWorker.instances[0].respond(hoverIndexResult(2));
  await first;
  expect(
    dangling(buildCurvilinearHoverIndex(latitudes, new Float32Array(2)))
  ).not.toBe(first);
});

it("empties the hover indexes when another dataset is opened", async () => {
  const coordinates = reusable(2);
  const first = buildCurvilinearHoverIndex(...coordinates);
  TMockWorker.instances[0].respond(hoverIndexResult(2));
  await first;
  registerReusableCoordinates({}, new Float32Array(1), new Float32Array(1));
  expect(dangling(buildCurvilinearHoverIndex(...coordinates))).not.toBe(first);
});

it("projects on the main thread when the worker cannot start, but not when cancelled", async () => {
  const x = new Float32Array([0, 1000]);
  const y = new Float32Array([0, -1000]);
  const expected = projectGridToLonLat(x, y, "+proj=longlat");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("blocked by CSP");
      }
    }
  );
  await expect(projectCurvilinearGrid(x, y, "+proj=longlat")).resolves.toEqual(
    expected
  );
  expect(console.warn).toHaveBeenCalledTimes(1);

  vi.stubGlobal("Worker", TMockWorker);
  const cancelled = projectCurvilinearGrid(x, y, "+proj=longlat");
  const superseding = projectCurvilinearGrid(x, y, "+proj=longlat");
  await expect(cancelled).rejects.toThrow("terminated");
  TMockWorker.instances[TMockWorker.instances.length - 1].respond(expected);
  await expect(superseding).resolves.toEqual(expected);
});

it("forgets a hover index build that was cancelled", async () => {
  const latitudes = new Float32Array([1]);
  const longitudes = new Float32Array([2]);
  const cancelled = buildCurvilinearHoverIndex(latitudes, longitudes);
  terminateCurvilinearWorker();
  await expect(cancelled).rejects.toThrow("terminated");
  const retried = dangling(buildCurvilinearHoverIndex(latitudes, longitudes));
  expect(retried).not.toBe(cancelled);
});
