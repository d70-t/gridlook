import { expect, it, vi } from "vitest";

import {
  pathlineGeographic,
  pathlineUnitVector,
  stepPathline,
  PATHLINE_WGS84,
  type TPathlineVelocity,
  type TPathlineVector,
} from "@/lib/data/pathlineIntegration.ts";
import {
  integratePathlines,
  pathlinePositionAt,
  pathlineSegments,
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
  lifetimeSeconds: 100,
  respawn: false,
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
});

it("stores only numerical samples; physical seeking and trails are repeatable in any order", async () => {
  const data = await integratePathlines(inputs, config);
  const bytes =
    data.positions.byteLength +
    data.times.byteLength +
    data.generations.byteLength +
    data.counts.byteLength;
  expect(bytes).toBe(
    planPathlineTrajectories(inputs.sourceTimes, config).bytes
  );
  for (const t of [45, 10, 60, 0, 45]) {
    expect(
      pathlineGeographic(pathlinePositionAt(data, 0, t)!).longitude
    ).toBeCloseTo(longitudeFor(10 * t), 7);
  }
  const segments = [...pathlineSegments(data, 0, 35, 12)];
  expect(segments.map(({ fromTime, toTime }) => [fromTime, toTime])).toEqual([
    [23, 30],
    [30, 35],
  ]);
  expect([...pathlineSegments(data, 0, 0, 12)]).toEqual([]);
  expect(pathlinePositionAt(data, 0, 61)).toBeUndefined();
  expect([...pathlineSegments(data, 0, 0, 100)]).toEqual([]); // Loop restart has no previous-cycle history.
});

it("wraps geographic longitude while keeping Cartesian traces continuous", async () => {
  const data = await integratePathlines(
    { ...inputs, seedPosition: () => ({ latitude: 0, longitude: 179.999 }) },
    config
  );
  const end = pathlineGeographic(pathlinePositionAt(data, 0, 60)!);
  expect(end.longitude).toBeCloseTo(-180.001 + longitudeFor(600), 5);
  for (const segment of pathlineSegments(data, 0, 60, 60)) {
    expect(Math.hypot(...segment.from)).toBeCloseTo(1);
    expect(segment.from[0]).toBeLessThan(-0.99);
    expect(segment.to[0]).toBeLessThan(-0.99);
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
  expect([...pathlineSegments(data, 0, 30, 10)].at(-1)!.toTime).toBeCloseTo(
    25,
    3
  );
  expect([...pathlineSegments(data, 0, 50, 10)]).toEqual([]);
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

it("reseeds deterministically with explicit lifetime gaps and separate trail generations", async () => {
  const seeded = {
    ...inputs,
    seedPosition: (u: number, v: number) => ({
      latitude: v * 10,
      longitude: u * 10,
    }),
  };
  const settings = { ...config, lifetimeSeconds: 12, respawn: true };
  const a = await integratePathlines(seeded, settings);
  const b = await integratePathlines(seeded, settings);
  const c = await integratePathlines(seeded, { ...settings, randomSeed: 43 });
  expect(a.positions).toEqual(b.positions);
  expect(a.times).toEqual(b.times);
  expect(a.generations).toEqual(b.generations);
  expect(a.positions).not.toEqual(c.positions);
  expect(pathlinePositionAt(a, 0, 15)).toBeUndefined();
  expect(pathlinePositionAt(a, 0, 20)).toBeDefined();
  expect(pathlinePositionAt(a, 0, 0)).not.toEqual(pathlinePositionAt(a, 1, 0));
  expect(
    [...pathlineSegments(a, 0, 25, 25)].map(
      ({ fromTime, toTime, generation }) => [fromTime, toTime, generation]
    )
  ).toEqual([
    [0, 10, 1],
    [10, 12, 1],
    [20, 25, 3],
  ]);
});

it("bounds unsuccessful seeding and responds to cancellation during integration", async () => {
  const empty = await integratePathlines(
    { ...inputs, sample: () => undefined },
    { ...config, respawn: true }
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
