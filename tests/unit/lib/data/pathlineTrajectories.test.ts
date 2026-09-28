import { expect, it, vi } from "vitest";

import {
  pathlineGeographic,
  pathlineUnitVector,
  stepPathline,
  createPathlineStepper,
  PATHLINE_WGS84,
  type TPathlineVelocity,
  type TPathlineVector,
} from "@/lib/data/pathlineIntegration.ts";
import {
  integratePathlines,
  pathlinePositionAt,
  planPathlineTrajectories,
  type TPathlineConfig,
  type TPathlineInputs,
} from "@/lib/data/pathlineTrajectories.ts";

const config: TPathlineConfig = {
  particleCount: 2,
  randomSeed: 42,
  sampleSeconds: 10,
  maxStepSeconds: 2,
  maxStepMetres: 100,
  errorToleranceMetres: 1,
};
const constant =
  (u: number, v = 0): TPathlineVelocity =>
  () => ({ u, v, speed: Math.hypot(u, v) });
const inputs: TPathlineInputs = {
  sourceTimes: [0, 30, 60],
  seedPosition: () => ({ latitude: 0, longitude: 0 }),
  sample: constant(10),
};
const longitudeFor = (metres: number) =>
  ((metres / PATHLINE_WGS84.semiMajorAxis) * 180) / Math.PI;

it("evaluates velocity at RK3(2) stage times, using metres/second on the reference ellipsoid", () => {
  const sample = vi.fn<TPathlineVelocity>((_lat, _lon, t) => ({
    u: 2 * t,
    v: 0,
    speed: 2 * t,
  }));
  const step = stepPathline([1, 0, 0], 0, 10, sample)!;
  expect(sample.mock.calls.map((call) => call[2])).toEqual([0, 5, 7.5, 10]);
  expect(pathlineGeographic(step.point).longitude).toBeCloseTo(
    longitudeFor(100),
    10
  );
  expect(Math.hypot(...step.point)).toBeCloseTo(1, 14);
});

// On the equator: longitude' = longitude + 0.1 radians/s, starting from zero.
const accelerating: TPathlineVelocity = (_lat, lon) => {
  const u = PATHLINE_WGS84.semiMajorAxis * ((lon * Math.PI) / 180 + 0.1);
  return { u, v: 0, speed: Math.abs(u) };
};
const exactLongitude = 0.1 * Math.expm1(2);

it("converges at third order as the timestep shrinks", () => {
  const solve = (dt: number) => {
    let point: TPathlineVector = [1, 0, 0];
    for (let t = 0; t < 2; t += dt) {
      point = stepPathline(point, t, dt, accelerating)!.point;
    }
    return Math.abs(Math.atan2(point[1], point[0]) - exactLongitude);
  };
  const errors = [solve(0.25), solve(0.125), solve(0.0625)];
  expect(errors[0] / errors[1]).toBeGreaterThan(6);
  expect(errors[0] / errors[1]).toBeLessThan(10);
  expect(errors[1] / errors[2]).toBeGreaterThan(6);
  expect(errors[1] / errors[2]).toBeLessThan(10);
});

it("tightens adaptive error control without increasing retained trajectory storage", async () => {
  const solve = async (errorToleranceMetres: number) => {
    const sample = vi.fn(accelerating);
    const data = await integratePathlines(
      { ...inputs, sourceTimes: [0, 2], sample },
      {
        ...config,
        particleCount: 1,
        sampleSeconds: 2,
        maxStepSeconds: 2,
        maxStepMetres: 1e8,
        errorToleranceMetres,
      }
    );
    const point = pathlinePositionAt(data, 0, 2)!;
    return {
      error: Math.abs(Math.atan2(point[1], point[0]) - exactLongitude),
      calls: sample.mock.calls.length,
      data,
    };
  };
  const loose = await solve(1000),
    tight = await solve(1);
  expect(tight.error).toBeLessThan(loose.error / 100);
  expect(tight.calls).toBeGreaterThan(loose.calls);
  expect(tight.data.positions.byteLength).toBe(loose.data.positions.byteLength);
  expect(tight.data.times).toEqual(loose.data.times);
});

it("clips integration at source knots and reproduces time-dependent analytic advection", async () => {
  const data = await integratePathlines(
    {
      ...inputs,
      sourceTimes: [0, 3, 10],
      sample: (_lat, _lon, t) => ({
        u: Math.min(t, 3),
        v: 0,
        speed: Math.min(t, 3),
      }),
    },
    { ...config, sampleSeconds: 10, maxStepSeconds: 5 }
  );
  const end = pathlineGeographic(pathlinePositionAt(data, 0, 10)!);
  expect(end.longitude).toBeCloseTo(longitudeFor(25.5), 9);
  expect(end.latitude).toBe(0);
  const start = pathlineGeographic(pathlinePositionAt(data, 1, 0)!);
  expect(start.longitude).toBeCloseTo(longitudeFor(-25.5), 9);
});

it("stores only numerical samples; physical seeking are repeatable in any order", async () => {
  const data = await integratePathlines(inputs, config);
  const bytes =
    data.positions.byteLength + data.times.byteLength + data.counts.byteLength;
  expect(bytes).toBe(
    planPathlineTrajectories(inputs.sourceTimes, config).bytes
  );
  for (const t of [45, 10, 60, 0, 45]) {
    expect(
      pathlineGeographic(pathlinePositionAt(data, 0, t)!).longitude
    ).toBeCloseTo(longitudeFor(10 * t), 7);
  }
  expect(pathlinePositionAt(data, 0, 61)).toBeUndefined();
  expect(pathlinePositionAt(data, 0, -1)).toBeUndefined();
});

it("wraps geographic longitude while keeping Cartesian traces continuous", async () => {
  const data = await integratePathlines(
    { ...inputs, seedPosition: () => ({ latitude: 0, longitude: 179.999 }) },
    config
  );
  const end = pathlineGeographic(pathlinePositionAt(data, 0, 60)!);
  expect(end.longitude).toBeCloseTo(-180.001 + longitudeFor(600), 5);
  for (const t of [0, 15, 30, 60]) {
    const point = pathlinePositionAt(data, 0, t)!;
    expect(Math.hypot(...point)).toBeCloseTo(1);
    expect(point[0]).toBeLessThan(-0.99);
  }
});

it("respects an explicit spherical dataset surface", async () => {
  const data = await integratePathlines(
    { ...inputs, surface: { semiMajorAxis: 1000000, flattening: 0 } },
    config
  );
  expect(
    pathlineGeographic(pathlinePositionAt(data, 0, 60)!).longitude
  ).toBeCloseTo(((600 / 1000000) * 180) / Math.PI, 7);
});

it("stops at unavailable data and records the last valid position, without extrapolating", async () => {
  const edge = longitudeFor(250);
  const data = await integratePathlines(
    {
      ...inputs,
      sample: (_lat, lon) =>
        lon <= edge ? { u: 10, v: 0, speed: 10 } : undefined,
    },
    config
  );
  expect(pathlinePositionAt(data, 0, 24)).toBeDefined();
  expect(pathlinePositionAt(data, 0, 26)).toBeUndefined();
  const last = data.counts[0] - 1;
  expect(data.times[last]).toBeCloseTo(25, 3);
});

it("bounds displacement so a resolved missing band is not skipped", async () => {
  const sample: TPathlineVelocity = (_lat, lon) =>
    lon >= longitudeFor(100) && lon <= longitudeFor(300)
      ? undefined
      : { u: 100, v: 0, speed: 100 };
  const data = await integratePathlines(
    { ...inputs, sample },
    { ...config, maxStepSeconds: 10, maxStepMetres: 50 }
  );
  expect(pathlinePositionAt(data, 0, 5)).toBeUndefined();
  expect(data.times[data.counts[0] - 1]).toBeCloseTo(1, 3);
});

it("spreads random anchors evenly across keyframes and integrates each in both directions", async () => {
  const anchors: number[] = [];
  const settings = { ...config, particleCount: 8, sampleSeconds: 13 };
  const seeded = {
    ...inputs,
    sourceTimes: [0, 7, 60],
    seedPosition: (u: number, v: number) => ({
      latitude: v * 10,
      longitude: u * 10,
    }),
    sample: vi.fn(constant(10)),
  };
  const a = await integratePathlines(seeded, settings, {
    onProgress: (done) => {
      if (done) {
        anchors.push(seeded.sample.mock.calls.at(-1)![2]);
      }
    },
  });
  const b = await integratePathlines(seeded, settings);
  const c = await integratePathlines(seeded, { ...settings, randomSeed: 43 });
  expect(a.positions).toEqual(b.positions);
  expect(a.times).toEqual(b.times);
  expect(a.positions).not.toEqual(c.positions);
  for (let particle = 0; particle < settings.particleCount; particle++) {
    const first = particle * a.capacity,
      count = a.counts[particle];
    const times = Array.from(a.times.subarray(first, first + count));
    expect(count).toBeLessThanOrEqual(a.capacity);
    expect(times[0]).toBe(0);
    expect(times.at(-1)).toBe(60);
    expect(times).toContain(seeded.sourceTimes[particle % 3]);
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);
    const start = pathlineGeographic(pathlinePositionAt(a, particle, 0)!);
    const end = pathlineGeographic(pathlinePositionAt(a, particle, 60)!);
    const lat = (start.latitude * Math.PI) / 180;
    const e2 = PATHLINE_WGS84.flattening * (2 - PATHLINE_WGS84.flattening);
    expect(end.longitude - start.longitude).toBeCloseTo(
      (longitudeFor(600) * Math.sqrt(1 - e2 * Math.sin(lat) ** 2)) /
        Math.cos(lat),
      5
    );
  }
  // Backward-only end anchors finish at the selection start; all other
  // anchors finish their forward branch at the selection end.
  expect(anchors).toEqual([60, 60, 0, 60, 60, 0, 60, 60]);
});

it("splits backward steps at source knots and stops at missing data in either direction", async () => {
  const sample = vi.fn<TPathlineVelocity>((_lat, _lon, t) =>
    t >= 5 && t <= 45
      ? { u: Math.min(t, 30), v: 0, speed: Math.min(t, 30) }
      : undefined
  );
  const data = await integratePathlines(
    { ...inputs, sample },
    { ...config, particleCount: 3, sampleSeconds: 60, maxStepSeconds: 10 }
  );
  // Only the middle keyframe can seed a particle. Its anchor remains at (0, 0).
  expect(Array.from(data.counts)).toEqual([0, 3, 0]);
  expect(pathlineGeographic(pathlinePositionAt(data, 1, 30)!).longitude).toBe(
    0
  );
  const first = data.capacity,
    last = first + data.counts[1] - 1;
  expect(data.times[first]).toBeCloseTo(5, 3);
  expect(data.times[last]).toBeCloseTo(45, 3);
  expect(
    pathlineGeographic(
      Array.from(
        data.positions.subarray(first * 3, first * 3 + 3)
      ) as TPathlineVector
    ).longitude
  ).toBeCloseTo(longitudeFor(-437.5), 7);
  expect(
    pathlineGeographic(
      Array.from(
        data.positions.subarray(last * 3, last * 3 + 3)
      ) as TPathlineVector
    ).longitude
  ).toBeCloseTo(longitudeFor(450), 7);
  expect(pathlinePositionAt(data, 1, 4)).toBeUndefined();
  expect(pathlinePositionAt(data, 1, 46)).toBeUndefined();
});

it("evaluates negative RK3(2) stages in actual decreasing dataset time", () => {
  const sample = vi.fn<TPathlineVelocity>((_lat, _lon, t) => ({
    u: 2 * t,
    v: 0,
    speed: 2 * t,
  }));
  const step = stepPathline([1, 0, 0], 10, -10, sample)!;
  expect(sample.mock.calls.map((call) => call[2])).toEqual([10, 5, 2.5, 0]);
  expect(pathlineGeographic(step.point).longitude).toBeCloseTo(
    longitudeFor(-100),
    10
  );
});

it("bounds unsuccessful seeding and responds to cancellation during integration", async () => {
  const empty = await integratePathlines(
    { ...inputs, sample: () => undefined },
    config
  );
  expect([...empty.counts]).toEqual([0, 0]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 0);
  await expect(
    integratePathlines(
      inputs,
      { ...config, maxStepSeconds: 0.00001 },
      { signal: controller.signal }
    )
  ).rejects.toMatchObject({ name: "AbortError" });
  await expect(
    integratePathlines(inputs, config, { isCurrent: () => false })
  ).rejects.toMatchObject({ name: "AbortError" });
});

it.each([0, -1, NaN, Infinity])(
  "rejects invalid integration settings (%s) before allocation",
  (value) => {
    expect(() =>
      planPathlineTrajectories([0, 60], { ...config, maxStepSeconds: value })
    ).toThrow();
    expect(() =>
      planPathlineTrajectories([0, 60], { ...config, sampleSeconds: value })
    ).toThrow();
    expect(() =>
      planPathlineTrajectories([0, 60], {
        ...config,
        errorToleranceMetres: value,
      })
    ).toThrow();
  }
);

it("rejects incompatible times and unrepresentable trajectory arrays", () => {
  expect(() => planPathlineTrajectories([0, 0], config)).toThrow();
  expect(() =>
    planPathlineTrajectories([0, 60], { ...config, particleCount: 2 ** 32 })
  ).toThrow();
  expect(pathlineUnitVector({ latitude: 0, longitude: 0 })).toEqual([1, 0, 0]);
});

it("reuses RK start/endpoint derivatives without changing accepted or retried steps", () => {
  const sample = vi.fn(accelerating);
  const step = createPathlineStepper(sample);
  const point: TPathlineVector = [1, 0, 0];
  const first = step(point, 0, 1)!;
  expect(first).toEqual(stepPathline(point, 0, 1, accelerating));
  expect(sample).toHaveBeenCalledTimes(4);
  const retry = step(point, 0, 0.5)!;
  expect(retry).toEqual(stepPathline(point, 0, 0.5, accelerating));
  expect(sample).toHaveBeenCalledTimes(7);
  const next = step(retry.point, 0.5, 0.5)!;
  expect(next).toEqual(stepPathline(retry.point, 0.5, 0.5, accelerating));
  expect(sample).toHaveBeenCalledTimes(10);
});

it.each([2, 7])(
  "preserves global seeds and anchor times across partitions (%i particles)",
  async (particleCount) => {
    const settings = { ...config, particleCount };
    const source = {
      ...inputs,
      seedPosition: (u: number, v: number) => ({
        latitude: u * 40 - 20,
        longitude: v * 100,
      }),
    };
    const all = await integratePathlines(source, settings);
    const split = Math.floor(particleCount / 2);
    for (const [start, end] of [
      [0, split],
      [split, particleCount],
    ]) {
      const part = await integratePathlines(source, settings, {
        particleStart: start,
        particleEnd: end,
        yieldToUI: false,
      });
      expect(part.counts).toEqual(all.counts.slice(start, end));
      expect(part.times).toEqual(
        all.times.slice(start * all.capacity, end * all.capacity)
      );
      expect(part.positions).toEqual(
        all.positions.slice(start * all.capacity * 3, end * all.capacity * 3)
      );
    }
    await expect(
      integratePathlines(source, settings, { particleStart: -1 })
    ).rejects.toThrow(/range/);
  }
);
