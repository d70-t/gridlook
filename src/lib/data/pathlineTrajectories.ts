import {
  normalizePathlineVector,
  pathlineUnitVector,
  stepPathline,
  PATHLINE_WGS84,
  type TPathlinePosition,
  type TPathlineVector,
  type TPathlineSurface,
  type TPathlineVelocity,
} from "./pathlineIntegration.ts";

export type TPathlineConfig = {
  particleCount: number;
  randomSeed: number;
  sampleSeconds: number;
  maxStepSeconds: number;
  maxStepMetres: number;
  /** Absolute local integration error; separate from output sampling accuracy. */
  errorToleranceMetres: number;
  lifetimeSeconds: number;
  respawn: boolean;
};
export type TPathlineTrajectories = {
  positions: Float32Array;
  times: Float64Array;
  generations: Uint32Array;
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
type TOptions = {
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
    typeof config.respawn !== "boolean" ||
    [
      config.sampleSeconds,
      config.maxStepSeconds,
      config.maxStepMetres,
      config.errorToleranceMetres,
      config.lifetimeSeconds,
    ].some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error(
      "Choose valid particle count, seed, sampling, integration and lifetime settings."
    );
  }
  const duration = times.at(-1)! - times[0];
  const intervals = Math.ceil(duration / config.sampleSeconds);
  // One birth plus one endpoint per output interval; dead intervals use no records.
  const capacity = intervals * 2 + 1;
  const records = capacity * config.particleCount;
  if (
    !Number.isSafeInteger(records * 3) ||
    records * 3 > PATHLINE_LIMITS.MAX_ARRAY_LENGTH ||
    times[0] +
      Math.min(
        config.maxStepSeconds,
        config.sampleSeconds,
        config.lifetimeSeconds
      ) ===
      times[0]
  ) {
    throw new Error(
      "Pathline sampling is too fine for this time range. Use fewer particles or longer sampling intervals."
    );
  }
  return {
    capacity,
    intervals,
    records,
    bytes: records * 24 + config.particleCount * 4,
    duration,
  };
}

function seedRandom(seed: number, particle: number, birth: number) {
  let state =
    (seed +
      Math.imul(particle + 1, 0x9e3779b9) +
      Math.imul(birth + 1, 0x85ebca6b)) >>>
    0;
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
  birth: number,
  time: number
) {
  const random = seedRandom(config.randomSeed, particle, birth);
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
  options: TOptions = {}
): Promise<TPathlineTrajectories> {
  config = { ...config };
  const sourceTimes = [...inputs.sourceTimes];
  const plan = planPathlineTrajectories(sourceTimes, config);
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
  let deadline = performance.now() + PATHLINE_LIMITS.YIELD_MS;
  function assertCurrent() {
    if (options.signal?.aborted || options.isCurrent?.() === false) {
      throw new DOMException("Pathline integration cancelled", "AbortError");
    }
  }
  function checkpoint() {
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
    positions: new Float32Array(plan.records * 3),
    times: new Float64Array(plan.records),
    generations: new Uint32Array(plan.records),
    counts: new Uint32Array(config.particleCount),
    capacity: plan.capacity,
    start: sourceTimes[0],
    end: sourceTimes.at(-1)!,
  };
  function write(
    particle: number,
    time: number,
    point: TPathlineVector,
    generation: number
  ) {
    const count = result.counts[particle];
    const previous = particle * result.capacity + count - 1;
    if (
      count &&
      result.times[previous] === time &&
      result.generations[previous] === generation
    ) {
      return;
    }
    const index = particle * result.capacity + count;
    result.positions.set(point, index * 3);
    result.times[index] = time;
    result.generations[index] = generation;
    result.counts[particle]++;
  }
  options.onProgress?.(0, config.particleCount);
  for (let particle = 0; particle < config.particleCount; particle++) {
    let point: TPathlineVector | undefined;
    let birth = result.start,
      time = result.start,
      generation = 0,
      key = 1,
      nextStep = config.maxStepSeconds;
    for (let interval = 0; interval < plan.intervals; interval++) {
      const pause = checkpoint();
      if (pause) {
        await pause;
        assertCurrent();
      }
      const from = result.start + interval * config.sampleSeconds;
      const target = Math.min(
        result.end,
        result.start + (interval + 1) * config.sampleSeconds
      );
      if (!point) {
        if (interval && !config.respawn) {
          break;
        }
        point = findSeed(inputs, config, particle, interval, from);
        if (!point) {
          continue;
        }
        birth = time = from;
        nextStep = config.maxStepSeconds;
        generation = interval + 1;
        write(particle, time, point, generation);
      }
      const until = Math.min(target, birth + config.lifetimeSeconds);
      let stopped = false;
      while (time < until) {
        const pause = checkpoint();
        if (pause) {
          await pause;
          assertCurrent();
        }
        while (key < sourceTimes.length - 1 && sourceTimes[key] <= time) {
          key++;
        }
        let dt = Math.min(
          nextStep,
          config.maxStepSeconds,
          until - time,
          sourceTimes[key] - time
        );
        const minimum =
          Math.min(config.maxStepSeconds, until - time) *
          PATHLINE_LIMITS.MIN_STEP_RATIO;
        let step = stepPathline(point, time, dt, inputs.sample, surface);
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
          if (dt < minimum || time + dt === time) {
            if (step) {
              throw new Error(
                "Integration cannot meet the error or displacement limit. Increase the tolerance or decrease the maximum timestep."
              );
            }
            stopped = true;
            break;
          }
          step = stepPathline(point, time, dt, inputs.sample, surface);
        }
        if (stopped) {
          break;
        }
        if (time + dt === time) {
          throw new Error(
            "Pathline integration timestep is below time precision."
          );
        }
        nextStep = dt * stepScale(step!, dt, config);
        point = step!.point;
        time += dt;
      }
      write(particle, time, point, generation);
      if (stopped || time >= birth + config.lifetimeSeconds) {
        point = undefined;
      }
    }
    options.onProgress?.(particle + 1, config.particleCount);
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

/** Seeking uses stored records; respawns and the end/start of a loop never connect. */
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
  if (
    index + 1 < end &&
    data.generations[index] === data.generations[index + 1]
  ) {
    return interpolatePosition(data, index, seconds);
  }
}

/** Trail age is dataset time. Ended trails fade out naturally; births have no history. */
export function* pathlineSegments(
  data: TPathlineTrajectories,
  particle: number,
  seconds: number,
  trailSeconds: number
) {
  const last = recordAt(data, particle, seconds);
  if (
    last === undefined ||
    !Number.isFinite(trailSeconds) ||
    trailSeconds <= 0
  ) {
    return;
  }
  const start = Math.max(data.start, seconds - trailSeconds);
  const first = recordAt(data, particle, start) ?? particle * data.capacity;
  const end = particle * data.capacity + data.counts[particle] - 1;
  for (let i = first; i <= last && i < end; i++) {
    if (data.generations[i] !== data.generations[i + 1]) {
      continue;
    }
    const fromTime = Math.max(start, data.times[i]),
      toTime = Math.min(seconds, data.times[i + 1]);
    if (toTime <= fromTime) {
      continue;
    }
    yield {
      from: interpolatePosition(data, i, fromTime),
      to: interpolatePosition(data, i, toTime),
      fromTime,
      toTime,
      generation: data.generations[i],
    };
  }
}
