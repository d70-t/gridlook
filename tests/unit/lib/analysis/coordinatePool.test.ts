import { describe, expect, it } from "vitest";

import { inPool } from "@/lib/analysis/variableContext.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("coordinate reads in a pool", () => {
  it("starts no read after the first failure, and aborts those in flight", async () => {
    const started: number[] = [];
    const aborted: number[] = [];
    const failing = inPool(256, 8, async (at, signal) => {
      started.push(at);
      signal.addEventListener("abort", () => aborted.push(at));
      await tick();
      if (at === 0) {
        throw new Error("503 on the first chunk");
      }
      await tick();
    });
    await expect(failing).rejects.toThrow("503");
    const atFailure = started.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started.length).toBe(atFailure);
    expect(atFailure).toBeLessThanOrEqual(8);
    // The other lanes, still reading, see the abort.
    expect(aborted.filter((at) => at !== 0).length).toBe(atFailure - 1);
  });

  it("stops when the caller aborts", async () => {
    const caller = new AbortController();
    const started: number[] = [];
    const run = inPool(
      100,
      4,
      async (at) => {
        started.push(at);
        if (at === 5) {
          caller.abort(new Error("closed"));
        }
        await tick();
      },
      caller.signal
    );
    await expect(run).rejects.toThrow("closed");
    expect(started.length).toBeLessThanOrEqual(10);
  });

  it("runs every task when nothing fails", async () => {
    const done: number[] = [];
    await inPool(50, 8, async (at) => {
      await tick();
      done.push(at);
    });
    expect(done.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, k) => k)
    );
  });
});
