import { describe, expect, it } from "vitest";

import { createSlots } from "@/lib/analysis/slots.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((_resolve) => (resolve = _resolve));
  return { promise, resolve };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a few at a time", () => {
  it("runs at most its size at once, the rest in order as slots free", async () => {
    const slots = createSlots(2);
    const gates = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    const all = gates.map((gate, k) =>
      slots.run(async () => {
        started.push(k);
        await gate.promise;
        return k;
      })
    );
    await flush();
    expect(started).toEqual([0, 1]);
    expect(slots.load).toEqual({ running: 2, waiting: 3 });
    gates[1].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);
    gates.forEach((gate) => gate.resolve());
    expect(await Promise.all(all)).toEqual([0, 1, 2, 3, 4]);
    expect(slots.load).toEqual({ running: 0, waiting: 0 });
  });

  it("drops a waiting task whose signal aborts; it never starts", async () => {
    const slots = createSlots(1);
    const gate = deferred();
    const started: string[] = [];
    const first = slots.run(async () => {
      started.push("first");
      await gate.promise;
    });
    const controller = new AbortController();
    const second = slots.run(async () => {
      started.push("second");
    }, controller.signal);
    const third = slots.run(async () => {
      started.push("third");
    });
    await flush();
    controller.abort(new Error("closed"));
    await expect(second).rejects.toThrow("closed");
    gate.resolve();
    await Promise.all([first, third]);
    expect(started).toEqual(["first", "third"]);
    expect(slots.load).toEqual({ running: 0, waiting: 0 });
  });
});

describe("priority", () => {
  it("lets windows on screen go before minimized ones", async () => {
    const slots = createSlots(1);
    const gate = deferred();
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(name);
    };
    const first = slots.run(async () => {
      order.push("running");
      await gate.promise;
    });
    const later = [
      slots.run(task("minimized 1"), undefined, 1),
      slots.run(task("shown 1")),
      slots.run(task("minimized 2"), undefined, 1),
      slots.run(task("shown 2")),
    ];
    gate.resolve();
    await Promise.all([first, ...later]);
    expect(order).toEqual([
      "running",
      "shown 1",
      "shown 2",
      "minimized 1",
      "minimized 2",
    ]);
  });
});
