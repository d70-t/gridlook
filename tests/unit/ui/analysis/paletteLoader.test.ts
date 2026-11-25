import { expect, it } from "vitest";

import { paletteLoader } from "@/ui/analysis/paletteLoader.ts";

it("keeps the latest palette chosen when an earlier one loads last (review of interim37)", async () => {
  const pending = new Map<string, (data: Uint8ClampedArray) => void>();
  const loader = paletteLoader(
    (name) => new Promise((resolve) => pending.set(name, resolve))
  );
  const reds = loader.load("Reds");
  const blues = loader.load("Blues");
  pending.get("Blues")!(new Uint8ClampedArray([106, 175, 211, 255]));
  await blues;
  pending.get("Reds")!(new Uint8ClampedArray([250, 105, 72, 255]));
  await reds;
  expect(loader.name).toBe("Blues");
  expect(Array.from(loader.data!.slice(0, 3))).toEqual([106, 175, 211]);
});

it("final review of interim41: returning to the shown palette drops a request for another", async () => {
  const { paletteLoader } = await import("@/ui/analysis/paletteLoader.ts");
  const pending = new Map<string, (data: Uint8ClampedArray) => void>();
  const loader = paletteLoader(
    (name) =>
      new Promise((resolve) => pending.set(name, resolve)) as Promise<
        Uint8ClampedArray | undefined
      >
  );
  const blues = loader.load("Blues");
  pending.get("Blues")!(new Uint8ClampedArray([0, 0, 255, 255]));
  await blues;
  // Reds asked for, then Blues again before Reds arrives.
  const reds = loader.load("Reds");
  await loader.load("Blues");
  pending.get("Reds")!(new Uint8ClampedArray([255, 0, 0, 255]));
  await reds;
  expect(loader.name).toBe("Blues");
  expect(Array.from(loader.data!)).toEqual([0, 0, 255, 255]);
});

it("final review of interim41: a heatmap pointer finds samples a minute apart in Unix milliseconds", async () => {
  const { pointerTime } = await import("@/ui/analysis/heatmapRaster.ts");
  const origin = Date.UTC(2026, 0, 1);
  const raw = [origin, origin + 60_000, origin + 120_000];
  // The axis as drawn: 800 px across the three minutes and a half margin.
  const [low, high] = [origin - 30_000, origin + 150_000];
  const time = (t: number) => ((t - low) / (high - low)) * 800;
  for (const t of raw) {
    const at = pointerTime(time, raw, time(t))!;
    expect(Math.abs(at.t - t)).toBeLessThanOrEqual(at.tolerance);
  }
});
