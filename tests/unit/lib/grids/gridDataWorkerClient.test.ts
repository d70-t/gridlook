import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import type * as zarr from "zarrita";

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  getGridVariableData,
  getGridVariableChunk,
  terminateGridDataWorker,
} from "@/lib/grids/gridDataWorkerClient.ts";
import {
  GridDataWorkerMessageType,
  type TGridDataWorkerRequest,
} from "@/lib/grids/gridDataWorkerProtocol.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

class TMockWorker {
  static instances: TMockWorker[] = [];
  static nextPostError: Error | null = null;

  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  messages: TGridDataWorkerRequest[] = [];
  terminated = false;

  constructor() {
    TMockWorker.instances.push(this);
  }

  postMessage(message: TGridDataWorkerRequest) {
    if (TMockWorker.nextPostError) {
      const error = TMockWorker.nextPostError;
      TMockWorker.nextPostError = null;
      throw error;
    }
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function request(selection: (number | null | zarr.Slice)[] = []) {
  return {
    source: reactive({ store: "store", dataset: "dataset", ignored: true }),
    variable: "temperature",
    format: ZARR_FORMAT.V3,
    selection,
  };
}

beforeEach(() => {
  TMockWorker.instances = [];
  TMockWorker.nextPostError = null;
  vi.stubGlobal("Worker", TMockWorker);
});

afterEach(() => {
  terminateGridDataWorker();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("grid data worker client", () => {
  it("snapshots requests and preserves chunk shape", async () => {
    const slice = reactive({ start: 1, stop: 3, step: 1, ignored: true });
    const resultPromise = getGridVariableChunk(
      request([slice as unknown as zarr.Slice])
    );
    const worker = TMockWorker.instances[0];
    const message = worker.messages[0];

    expect(message.source).toEqual({ store: "store", dataset: "dataset" });
    expect(message.selection).toEqual([{ start: 1, stop: 3, step: 1 }]);
    worker.emit({
      requestId: message.requestId,
      type: GridDataWorkerMessageType.RESULT,
      data: new Float32Array([2, 4]),
      shape: [1, 2],
    });

    await expect(resultPromise).resolves.toEqual({
      data: new Float32Array([2, 4]),
      shape: [1, 2],
    });
  });

  it("keeps the data-only convenience API", async () => {
    const dataPromise = getGridVariableData(request());
    const worker = TMockWorker.instances[0];
    const message = worker.messages[0];
    worker.emit({
      requestId: message.requestId,
      type: GridDataWorkerMessageType.RESULT,
      data: new Uint16Array([3]),
      shape: [1],
    });

    await expect(dataPromise).resolves.toEqual(new Uint16Array([3]));
  });
});

it("reads NetCDF data through the main-thread wrapper", async () => {
  const array = {} as Awaited<
    ReturnType<typeof ZarrDataManager.getVariableInfo>
  >;
  vi.spyOn(ZarrDataManager, "getVariableInfo").mockResolvedValue(array);
  vi.spyOn(ZarrDataManager, "getVariableDataFromArray").mockResolvedValue({
    data: new Float32Array([3, 5]),
    shape: [2],
    stride: [1],
  });

  await expect(
    getGridVariableChunk({
      ...request(),
      format: ZARR_FORMAT.NETCDF,
      source: {
        store: "local-file",
        dataset: "",
        file: new Blob(["netcdf"]) as File,
      },
    })
  ).resolves.toEqual({ data: new Float32Array([3, 5]), shape: [2] });
  expect(TMockWorker.instances).toHaveLength(0);
});

describe("grid data worker lifecycle", () => {
  it("terminates the worker after a synchronous post failure", async () => {
    TMockWorker.nextPostError = new Error("post failed");
    await expect(getGridVariableChunk(request())).rejects.toThrow(
      "post failed"
    );
    expect(TMockWorker.instances[0].terminated).toBe(true);

    const retry = getGridVariableChunk(request());
    const replacement = TMockWorker.instances[1];
    const message = replacement.messages[0];
    replacement.emit({
      requestId: message.requestId,
      type: GridDataWorkerMessageType.RESULT,
      data: new Float32Array([1]),
      shape: [1],
    });
    await expect(retry).resolves.toMatchObject({ shape: [1] });
  });

  it("rejects unknown and undecodable worker messages", async () => {
    const unknownMessage = getGridVariableChunk(request());
    const firstWorker = TMockWorker.instances[0];
    const firstRequest = firstWorker.messages[0];
    firstWorker.emit({ requestId: firstRequest.requestId, type: "unknown" });
    await expect(unknownMessage).rejects.toThrow("Unknown grid data worker");
    expect(firstWorker.terminated).toBe(true);

    const undecodableMessage = getGridVariableChunk(request());
    const secondWorker = TMockWorker.instances[1];
    secondWorker.onmessageerror?.({} as MessageEvent);
    await expect(undecodableMessage).rejects.toThrow("Could not deserialize");
    expect(secondWorker.terminated).toBe(true);
  });
});
