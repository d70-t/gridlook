import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  buildCurvilinearHoverIndex,
  projectCurvilinearGrid,
  setMaxCachedHoverSamples,
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
  setMaxCachedHoverSamples();
  vi.unstubAllGlobals();
});

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
  buildCurvilinearHoverIndex(new Float32Array(1), new Float32Array(1));
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

it("reuses the hover indexes of coordinates built before, within the sample bound", async () => {
  const coarse = [new Float32Array(2), new Float32Array(2)] as const;
  const fine = [new Float32Array(3), new Float32Array(3)] as const;
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

  // Past the bound the least recently used index, the coarse one, goes.
  setMaxCachedHoverSamples(3);
  expect(buildCurvilinearHoverIndex(...fine)).toBe(second);
  expect(buildCurvilinearHoverIndex(...coarse)).not.toBe(first);
  expect(TMockWorker.instances).toHaveLength(3);
});

it("takes other longitudes for the same latitudes as other coordinates", async () => {
  const latitudes = new Float32Array(2);
  const first = buildCurvilinearHoverIndex(latitudes, new Float32Array(2));
  TMockWorker.instances[0].respond(hoverIndexResult(2));
  await first;
  const relabelled = buildCurvilinearHoverIndex(latitudes, new Float32Array(2));
  expect(relabelled).not.toBe(first);
  expect(TMockWorker.instances).toHaveLength(2);
});

it("forgets a hover index build that was cancelled", async () => {
  const latitudes = new Float32Array([1]);
  const longitudes = new Float32Array([2]);
  const cancelled = buildCurvilinearHoverIndex(latitudes, longitudes);
  terminateCurvilinearWorker();
  await expect(cancelled).rejects.toThrow("terminated");
  const retried = buildCurvilinearHoverIndex(latitudes, longitudes);
  expect(retried).not.toBe(cancelled);
});
