import { describe, expect, it } from "vitest";

import { SharedReads } from "@/lib/analysis/sharedRead.ts";

describe("shared reads stay within their budget", () => {
  it("keeps at most the budget after ten concurrent fills settle", async () => {
    // Ten 12-byte values into a 64-byte budget: at most five kept.
    const reads = new SharedReads(64);
    const releases: (() => void)[] = [];
    const all = Array.from({ length: 10 }, (_, at) =>
      reads.share(
        `k${at}|v`,
        12,
        () => new Promise<number>((resolve) => releases.push(() => resolve(at)))
      )
    );
    releases.forEach((release) => release());
    expect(await Promise.all(all)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const kept = Array.from({ length: 10 }, (_, at) => at).filter((at) =>
      reads.holdsUnder(`k${at}|`)
    );
    expect(kept.length).toBeLessThanOrEqual(5);
    // The most recent are the ones kept.
    expect(kept).toContain(9);
  });
});

describe("v24 review: one byte limit for every axis read", () => {
  it("six 128 MiB bounds reads run two at a time; a waiter can leave", async () => {
    const { SharedReads } = await import("@/lib/analysis/sharedRead.ts");
    const MiB = 2 ** 20;
    const reads = new SharedReads(64 * MiB, 256 * MiB);
    let running = 0;
    let most = 0;
    const finish: (() => void)[] = [];
    const read = () =>
      new Promise<number>((resolve) => {
        running++;
        most = Math.max(most, running);
        finish.push(() => {
          running--;
          resolve(1);
        });
      });
    const controllers = [...Array(6)].map(() => new AbortController());
    const pending = controllers.map((c, k) =>
      reads.share(`bounds-${k}`, 128 * MiB, read, c.signal)
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(running).toBe(2);
    // The last one leaves while it waits: it is never read.
    controllers[5].abort();
    await expect(pending[5]).rejects.toThrow();
    while (finish.length) {
      finish.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await Promise.all(pending.slice(0, 5))).toEqual([1, 1, 1, 1, 1]);
    expect(most).toBe(2);
    // A read larger than the limit runs alone.
    const alone = await reads.share("huge", 512 * MiB, async () => 7);
    expect(alone).toBe(7);
  });
});

it("independent review of interim45: a stop inside the first request stops the shared read", async () => {
  const reads = new SharedReads(64 * 2 ** 20, 256 * 2 ** 20);
  const stop = new AbortController();
  let requests = 0;
  const read = async (signal: AbortSignal) => {
    for (let i = 0; i < 128; i++) {
      requests++;
      if (i === 0) {
        // Stopped while its first request runs, before it yields.
        stop.abort(new Error("stopped"));
      }
      if (signal.aborted) {
        throw signal.reason;
      }
      await Promise.resolve();
    }
    return requests;
  };
  await expect(reads.share("lon", 8, read, stop.signal)).rejects.toThrow(
    "stopped"
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(requests).toBe(1);
});

it("interim49: a key is held by itself or below it, not by a longer name", async () => {
  const reads = new SharedReads(1024);
  await reads.share("s|time_bnds|matrix", 8, async () => 1);
  expect(reads.holds("s|time")).toBe(false);
  expect(reads.holds("s|time_bnds")).toBe(true);
  expect(reads.holds("s|time_bnds|matrix")).toBe(true);
});
