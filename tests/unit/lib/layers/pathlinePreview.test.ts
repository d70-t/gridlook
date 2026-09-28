import { expect, it } from "vitest";

import { pathlineUnitVector } from "@/lib/data/pathlineIntegration.ts";
import {
  pathlinePositionAt,
  type TPathlineTrajectories,
} from "@/lib/data/pathlineTrajectories.ts";
import {
  packPathlinePreview,
  pathlinePreviewLayout,
} from "@/lib/layers/pathlinePreview.ts";

it("packs time-major keyframes, clamps to actual endpoints and leaves missing particles invisible", async () => {
  const data: TPathlineTrajectories = {
    positions: new Float32Array(3 * 3 * 3),
    times: new Float64Array(9),
    counts: new Uint32Array([3, 0, 1]),
    capacity: 3,
    start: 0,
    end: 100,
  };
  data.times.set([10, 20, 30]);
  for (const [i, latitude, longitude] of [
    [0, 0, 170],
    [1, 20, 180],
    [2, 0, -170],
  ]) {
    data.positions.set(pathlineUnitVector({ latitude, longitude }), i * 3);
  }
  const times = [0, 25, 100];
  const layout = pathlinePreviewLayout(3, times.length, 64)!;
  const preview = await packPathlinePreview(
    data,
    times,
    layout,
    async () => {}
  );
  expect(preview.positions.byteLength + preview.lifetimes.byteLength).toBe(
    layout.bytes
  );
  expect([...preview.lifetimes.slice(0, 4)]).toEqual([10, 0, 30, 0]);
  for (const [frame, time] of [10, 25, 30].entries()) {
    const index = frame * 3 * 4;
    expect(preview.positions.slice(index, index + 3)).toEqual(
      new Float32Array(pathlinePositionAt(data, 0, time)!)
    );
    expect([...preview.positions.slice(index + 4, index + 12)]).toEqual(
      new Array(8).fill(0)
    );
  }
  expect([...preview.lifetimes.slice(4)]).toEqual(
    new Array(preview.lifetimes.length - 4).fill(0)
  );
  expect([...data.times.slice(0, 3)]).toEqual([10, 20, 30]);
});

it("retains fractional birth/death times and propagates cancellation during packing", async () => {
  const data: TPathlineTrajectories = {
    positions: new Float32Array([1, 0, 0, 1, 0, 0]),
    times: new Float64Array([1e9 + 0.1, 1e9 + 0.2]),
    counts: new Uint32Array([2]),
    capacity: 2,
    start: 0,
    end: 1e9 + 1,
  };
  const times = [0, data.end],
    layout = pathlinePreviewLayout(1, 2, 64)!;
  const preview = await packPathlinePreview(
    data,
    times,
    layout,
    async () => {}
  );
  const [a, alow, b, blow] = preview.lifetimes;
  expect(a + alow).toBeCloseTo(data.times[0], 6);
  expect(b + blow).toBeCloseTo(data.times[1], 6);
  await expect(
    packPathlinePreview(data, times, layout, async () => {
      throw new DOMException("Cancelled", "AbortError");
    })
  ).rejects.toMatchObject({ name: "AbortError" });
});
