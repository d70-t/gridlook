import {
  normalizePathlineVector,
  pathlineUnitVector,
  createPathlineStepper,
  type stepPathline,
  PATHLINE_WGS84,
  type TPathlinePosition,
  type TPathlineVector,
  type TPathlineSurface,
  type TPathlineVelocity,
} from "./pathlineIntegration.ts";

export type TPathlineConfig = {
  particleCount: number;
  workerCount?: number;
  randomSeed: number;
  sampleSeconds: number;
  maxStepSeconds: number;
  maxStepMetres: number;
  /** Absolute local integration error; separate from output sampling accuracy. */
  errorToleranceMetres: number;
};
export type TPathlineTrajectories = {
  positions: Float32Array;
  times: Float64Array;
  counts: Uint32Array;
  capacity: number;
  start: number;
  end: number;
};
export type TPathlineInputs = {
  sourceTimes: readonly number[];
  sample: TPathlineVelocity;
  seedPosition: (u: number, v: number) => TPathlinePosition;
  surface?: TPathlineSurface;
};
export type TPathlineIntegrationOptions = {
  /** Half-open range of global IDs; seeds and anchor times use the total count. */
  particleStart?: number;
  particleEnd?: number;
  /** Dedicated workers are cancelled by termination and need no UI timer yields. */
  yieldToUI?: boolean;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  onProgress?: (completed: number, total: number) => void;
};
const PATHLINE_LIMITS = {
  SEED_ATTEMPTS: 64,
  MIN_STEP_RATIO: 2 ** -16,
  YIELD_MS: 8,
  MAX_ARRAY_LENGTH: 2 ** 32 - 1,
  STEP_SAFETY: 0.9,
  MIN_STEP_SCALE: 0.2,
  MAX_STEP_SCALE: 2,
} as const;

// eslint-disable-next-line max-lines-per-function
export function planPathlineTrajectories(
  times: readonly number[],
  config: TPathlineConfig
) {
  if (
    times.length < 2 ||
    times.some(
      (time, i) => !Number.isFinite(time) || (i > 0 && time <= times[i - 1])
    )
  ) {
    throw new Error("Pathline integration requires increasing dataset times.");
  }
  if (
    !Number.isSafeInteger(config.particleCount) ||
    config.particleCount < 1 ||
    !Number.isSafeInteger(config.randomSeed) ||
    config.randomSeed < 0 ||
    config.randomSeed > 0xffffffff ||
    [
      config.sampleSeconds,
      config.maxStepSeconds,
      config.maxStepMetres,
      config.errorToleranceMetres,
    ].some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error(
      "Choose valid particle count, seed, sampling and integration settings."
    );
  }
  const duration = times.at(-1)! - times[0];
  const intervals = Math.ceil(duration / config.sampleSeconds);
  // Each direction rounds up its sample count: one anchor plus at most
  // ceil(duration/sampleSeconds) + 1 endpoints, including partial boundary steps.
  const capacity = intervals + 2;
  const records = capacity * config.particleCount;
  if (
    !Number.isSafeInteger(records * 3) ||
    records * 3 > PATHLINE_LIMITS.MAX_ARRAY_LENGTH ||
    times.some(
      (time) =>
        time + Math.min(config.maxStepSeconds, config.sampleSeconds) === time
    )
  ) {
    throw new Error(
      "Pathline sampling is too fine for this time range. Use fewer particles or longer sampling intervals."
    );
  }
  return {
    capacity,
    intervals,
    records,
    bytes: records * 20 + config.particleCount * 4,
    duration,
  };
}

function seedRandom(seed: number, particle: number) {
  let state = (seed + Math.imul(particle + 1, 0x9e3779b9)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
}

function findSeed(
  inputs: TPathlineInputs,
  config: TPathlineConfig,
  particle: number,
  time: number
) {
  const random = seedRandom(config.randomSeed, particle);
  for (let attempt = 0; attempt < PATHLINE_LIMITS.SEED_ATTEMPTS; attempt++) {
    const point = inputs.seedPosition(random(), random());
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) >= 90
    ) {
      continue;
    }
    const velocity = inputs.sample(point.latitude, point.longitude, time);
    if (
      velocity &&
      Number.isFinite(velocity.u) &&
      Number.isFinite(velocity.v)
    ) {
      return pathlineUnitVector(point);
    }
  }
}

function stepScale(
  step: NonNullable<ReturnType<typeof stepPathline>>,
  dt: number,
  config: TPathlineConfig
) {
  return Math.min(
    PATHLINE_LIMITS.MAX_STEP_SCALE,
    step.errorMetres > 0
      ? PATHLINE_LIMITS.STEP_SAFETY *
          Math.cbrt(config.errorToleranceMetres / step.errorMetres)
      : PATHLINE_LIMITS.MAX_STEP_SCALE,
    step.maxSpeed > 0
      ? (PATHLINE_LIMITS.STEP_SAFETY * config.maxStepMetres) /
          step.maxSpeed /
          dt
      : PATHLINE_LIMITS.MAX_STEP_SCALE
  );
}

/** Prepare immutable physical trajectories; render timing never enters integration. */
// eslint-disable-next-line max-lines-per-function
export async function integratePathlines(
  inputs: TPathlineInputs,
  config: TPathlineConfig,
  options: TPathlineIntegrationOptions = {}
): Promise<TPathlineTrajectories> {
  config = { ...config };
  const sourceTimes = [...inputs.sourceTimes];
  const plan = planPathlineTrajectories(sourceTimes, config);
  const firstParticle = options.particleStart ?? 0;
  const endParticle = options.particleEnd ?? config.particleCount;
  if (
    !Number.isSafeInteger(firstParticle) ||
    !Number.isSafeInteger(endParticle) ||
    firstParticle < 0 ||
    endParticle > config.particleCount ||
    endParticle <= firstParticle
  ) {
    throw new Error("Invalid pathline particle range.");
  }
  const count = endParticle - firstParticle;
  const records = plan.capacity * count;
  const surface = inputs.surface ?? PATHLINE_WGS84;
  if (
    !Number.isFinite(surface.semiMajorAxis) ||
    surface.semiMajorAxis <= 0 ||
    !Number.isFinite(surface.flattening) ||
    surface.flattening < 0 ||
    surface.flattening >= 1
  ) {
    throw new Error("Invalid pathline reference ellipsoid.");
  }
  const stepPathline = createPathlineStepper(inputs.sample, surface);
  let deadline = performance.now() + PATHLINE_LIMITS.YIELD_MS;
  function assertCurrent() {
    if (options.signal?.aborted || options.isCurrent?.() === false) {
      throw new DOMException("Pathline integration cancelled", "AbortError");
    }
  }
  function checkpoint() {
    if (options.yieldToUI === false) {
      return;
    }
    assertCurrent();
    if (performance.now() >= deadline) {
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          deadline = performance.now() + PATHLINE_LIMITS.YIELD_MS;
          resolve();
        }, 0)
      );
    }
  }
  assertCurrent();
  const result: TPathlineTrajectories = {
    positions: new Float32Array(records * 3),
    times: new Float64Array(records),
    counts: new Uint32Array(count),
    capacity: plan.capacity,
    start: sourceTimes[0],
    end: sourceTimes.at(-1)!,
  };
  function write(particle: number, time: number, point: TPathlineVector) {
    const count = result.counts[particle];
    const index = particle * result.capacity + count;
    if (count && result.times[index - 1] === time) {
      return;
    }
    result.positions.set(point, index * 3);
    result.times[index] = time;
    result.counts[particle]++;
  }
  options.onProgress?.(0, count);
  for (let particle = 0; particle < count; particle++) {
    // Distribute the total count evenly among source keyframes. With fewer
    // particles than keyframes, spread the anchors across the selected range.
    const globalParticle = firstParticle + particle;
    const anchorIndex =
      config.particleCount >= sourceTimes.length
        ? globalParticle % sourceTimes.length
        : Math.floor(
            (globalParticle * (sourceTimes.length - 1)) /
              Math.max(1, config.particleCount - 1)
          );
    const anchor = sourceTimes[anchorIndex];
    const seed = findSeed(inputs, config, globalParticle, anchor);
    const pause = checkpoint();
    if (pause) {
      await pause;
      assertCurrent();
    }
    if (seed) {
      write(particle, anchor, seed);
      for (const direction of [-1, 1] as const) {
        let point = seed,
          time = anchor,
          key = anchorIndex;
        let nextStep = config.maxStepSeconds;
        const end = direction < 0 ? result.start : result.end;
        for (let interval = 1; direction * (end - time) > 0; interval++) {
          const target = anchor + direction * interval * config.sampleSeconds;
          const until =
            direction < 0 ? Math.max(end, target) : Math.min(end, target);
          let stopped = false;
          while (direction * (until - time) > 0) {
            const pause = checkpoint();
            if (pause) {
              await pause;
              assertCurrent();
            }
            while (direction * (sourceTimes[key] - time) <= 0) {
              key += direction;
            }
            let dt = Math.min(
              nextStep,
              config.maxStepSeconds,
              Math.abs(until - time),
              Math.abs(sourceTimes[key] - time)
            );
            const minimum =
              Math.min(config.maxStepSeconds, Math.abs(until - time)) *
              PATHLINE_LIMITS.MIN_STEP_RATIO;
            let step = stepPathline(point, time, direction * dt);
            while (
              !step ||
              step.maxSpeed * dt > config.maxStepMetres ||
              step.errorMetres > config.errorToleranceMetres
            ) {
              const pause = checkpoint();
              if (pause) {
                await pause;
                assertCurrent();
              }
              dt *= step
                ? Math.max(
                    PATHLINE_LIMITS.MIN_STEP_SCALE,
                    stepScale(step, dt, config)
                  )
                : 0.5;
              if (dt < minimum || time + direction * dt === time) {
                if (step) {
                  throw new Error(
                    "Integration cannot meet the error or displacement limit. Increase the tolerance or decrease the maximum timestep."
                  );
                }
                stopped = true;
                break;
              }
              step = stepPathline(point, time, direction * dt);
            }
            if (stopped) {
              break;
            }
            if (time + direction * dt === time) {
              throw new Error(
                "Pathline integration timestep is below time precision."
              );
            }
            nextStep = dt * stepScale(step!, dt, config);
            point = step!.point;
            time += direction * dt;
          }
          write(particle, time, point);
          if (stopped) {
            break;
          }
        }
        if (direction < 0) {
          // Reverse the backward branch in place, then append the forward branch.
          const first = particle * result.capacity;
          const last = first + result.counts[particle] - 1;
          for (let a = first, b = last; a < b; a++, b--) {
            if ((a - first) % 2048 === 0) {
              const pause = checkpoint();
              if (pause) {
                await pause;
                assertCurrent();
              }
            }
            [result.times[a], result.times[b]] = [
              result.times[b],
              result.times[a],
            ];
            for (let axis = 0; axis < 3; axis++) {
              const x = a * 3 + axis,
                y = b * 3 + axis;
              [result.positions[x], result.positions[y]] = [
                result.positions[y],
                result.positions[x],
              ];
            }
          }
        }
      }
    }
    options.onProgress?.(particle + 1, count);
  }
  assertCurrent();
  return result;
}

function recordAt(
  data: TPathlineTrajectories,
  particle: number,
  seconds: number
) {
  if (
    !Number.isSafeInteger(particle) ||
    particle < 0 ||
    particle >= data.counts.length ||
    !Number.isFinite(seconds) ||
    seconds < data.start ||
    seconds > data.end ||
    !data.counts[particle]
  ) {
    return;
  }
  let low = particle * data.capacity,
    high = low + data.counts[particle];
  const first = low;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (data.times[middle] <= seconds) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low > first ? low - 1 : undefined;
}

function positionAt(
  data: TPathlineTrajectories,
  index: number
): TPathlineVector {
  return [
    data.positions[index * 3],
    data.positions[index * 3 + 1],
    data.positions[index * 3 + 2],
  ];
}
function interpolatePosition(
  data: TPathlineTrajectories,
  index: number,
  seconds: number
) {
  const alpha =
    (seconds - data.times[index]) / (data.times[index + 1] - data.times[index]);
  const a = positionAt(data, index),
    b = positionAt(data, index + 1);
  // ponytail: normalized linear interpolation between numerical samples. Shorten
  // sampleSeconds for curved tracks; video FPS does not increase trajectory detail.
  return normalizePathlineVector(
    a.map((value, i) => value * (1 - alpha) + b[i] * alpha) as TPathlineVector
  );
}

/** Seeking uses the same stored trajectory in either playback direction. */
export function pathlinePositionAt(
  data: TPathlineTrajectories,
  particle: number,
  seconds: number
) {
  const index = recordAt(data, particle, seconds);
  if (index === undefined) {
    return;
  }
  if (data.times[index] === seconds) {
    return normalizePathlineVector(positionAt(data, index));
  }
  const end = particle * data.capacity + data.counts[particle];
  if (index + 1 < end) {
    return interpolatePosition(data, index, seconds);
  }
}
