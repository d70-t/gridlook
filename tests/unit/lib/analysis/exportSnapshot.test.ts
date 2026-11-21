/* eslint-disable max-lines-per-function -- each case builds its own fixture. */

import { describe, expect, it, vi } from "vitest";
import { markRaw, reactive } from "vue";

import {
  restoreSnapshot,
  snapshotBytes,
  snapshotForExport,
  snapshotTransfer,
} from "@/lib/analysis/exportSnapshot.ts";
import type { TAnalysisResult } from "@/lib/analysis/types.ts";

describe("export snapshots (v9 review)", () => {
  it("unwraps a reactive query inside a raw result and transfers its numbers", () => {
    const query = reactive({ kind: "time-depth", fixed: { member: 0 } });
    const values = Array.from({ length: 4096 }, (_, at) =>
      at % 7 === 0 ? Number.NaN : at
    );
    const result = markRaw({
      kind: "time-depth",
      query,
      values,
      shape: [64, 64],
    }) as unknown as TAnalysisResult;
    // A reactive object inside refuses the structured clone…
    expect(() => structuredClone(result)).toThrow();
    const snapshot = snapshotForExport(result);
    // …the snapshot does not, and its numeric buffer moves without a copy.
    const transfer = snapshotTransfer(snapshot);
    const sent = structuredClone(snapshot, { transfer });
    expect(transfer[0].byteLength).toBe(0); // detached here, owned there
    expect(values).toHaveLength(4096); // the displayed result is untouched
    const restored = restoreSnapshot(sent);
    expect(restored.query).toEqual({
      kind: "time-depth",
      fixed: { member: 0 },
    });
    expect(restored.values).toHaveLength(4096);
    expect(restored.values[7]).toBeNaN();
    expect(restored.values[8]).toBe(8);
    expect(snapshot.bytes).toBeGreaterThanOrEqual(4096 * 8);
  });
});

describe("the background export queue (v9 review)", () => {
  it("one running, two waiting, the next refused; failures recover; closing cancels", async () => {
    const posted: { id: number; format: string }[] = [];
    const workers: FakeWorker[] = [];
    let terminated = 0;
    class FakeWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      constructor() {
        workers.push(this);
      }
      postMessage(
        message: { id: number; format: string },
        transfer: Transferable[]
      ) {
        // What a real worker receives: a structured clone of plain data.
        structuredClone(message, { transfer });
        posted.push(message);
      }
      reply(ok: boolean) {
        const { id } = posted[posted.length - 1];
        this.onmessage?.({
          data: ok
            ? { id, bytes: new Uint8Array([id]) }
            : { id, error: "boom" },
        });
      }
      terminate() {
        terminated++;
      }
    }
    vi.stubGlobal("Worker", FakeWorker);
    vi.resetModules();
    const client = await import("@/lib/analysis/exportClient.ts");
    const result = markRaw({
      kind: "point-series",
      query: reactive({ kind: "point-series" }),
      values: [1, 2, 3],
    }) as unknown as TAnalysisResult;
    const first = client.writeScientificFile("nc", result, "A");
    const second = client.writeScientificFile("zarr", result, "B");
    const third = client.writeScientificFile("nc", result, "C");
    await expect(client.writeScientificFile("nc", result, "D")).rejects.toThrow(
      /already waiting/
    );
    expect(posted).toHaveLength(1);
    // The first write fails; the next starts and succeeds in the background.
    workers[0].reply(false);
    await expect(first).rejects.toThrow("boom");
    expect(posted).toHaveLength(2);
    workers[0].reply(true);
    await expect(second).resolves.toMatchObject({ background: true });
    // Window C closes while its file is being written: stopped, never saved.
    client.cancelDownloads("C");
    await expect(third).rejects.toMatchObject({ name: "AbortError" });
    expect(terminated).toBe(1);
    // Later work starts a fresh worker.
    const later = client.writeScientificFile("zarr", result, "E");
    expect(workers).toHaveLength(2);
    workers[1].reply(true);
    await expect(later).resolves.toMatchObject({ background: true });
    vi.unstubAllGlobals();
  });
});

it("predicts a snapshot's bytes without building it", () => {
  const result = {
    kind: "point-series",
    values: Array.from({ length: 5000 }, (_, i) => i),
    time: { raw: Array.from({ length: 5000 }, (_, i) => i), units: "days" },
    coverage: Float64Array.from({ length: 300 }, () => 1),
    notes: ["a", "b"],
    samples: { cells: [{ id: "1" }], status: ["ok"] },
  } as never;
  expect(snapshotBytes(result)).toBe(snapshotForExport(result).bytes);
});

it("final review of interim41: copies an axis shared by two fields once, as estimated", () => {
  // Two dates × 2,048 levels; both fields name the one vertical axis.
  const levels = Array.from({ length: 2048 }, (_, k) => k * 10);
  const result = {
    values: Array.from({ length: 4096 }, (_, k) => k),
    vertical: { values: levels },
    other: { vertical: { values: levels } },
  } as never;
  const snapshot = snapshotForExport(result);
  expect(snapshot.bytes).toBe(snapshotBytes(result));
  // Restored, both paths hold the axis; its buffer is transferred once.
  expect(snapshotTransfer(snapshot)).toHaveLength(2);
  const back = restoreSnapshot(snapshot) as unknown as {
    vertical: { values: number[] };
    other: { vertical: { values: number[] } };
  };
  expect(back.other.vertical.values).toEqual(levels);
  expect(back.vertical.values).toEqual(levels);
});

it("final review of interim41: without a worker, a closed download keeps the writer until it ends", async () => {
  vi.resetModules();
  // No worker can be made: files are written on this thread.
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("no workers here");
      }
    }
  );
  let inside = 0;
  let most = 0;
  const finishes: Array<() => void> = [];
  vi.doMock("@/lib/analysis/scientificExport.ts", () => ({
    exportModel: () => ({}),
    toZarrZip: () => {
      most = Math.max(most, ++inside);
      return new Promise<Uint8Array>((resolve) =>
        finishes.push(() => {
          inside--;
          resolve(new Uint8Array(1));
        })
      );
    },
  }));
  const client = await import("@/lib/analysis/exportClient.ts");
  const result = {
    kind: "point-series",
    values: [1, 2],
    query: {},
  } as unknown as TAnalysisResult;
  const first = client.writeScientificFile("zarr", result, "A");
  const settled = first.catch((error: Error) => error.name);
  await vi.waitFor(() => expect(finishes).toHaveLength(1));
  // Closed while it writes; the next download waits for the writer.
  client.cancelDownloads("A");
  expect(await settled).toBe("AbortError");
  const second = client.writeScientificFile("zarr", result, "B");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(finishes).toHaveLength(1);
  finishes[0]();
  await vi.waitFor(() => expect(finishes).toHaveLength(2));
  finishes[1]();
  await second;
  expect(most).toBe(1);
  vi.doUnmock("@/lib/analysis/scientificExport.ts");
  vi.unstubAllGlobals();
});
