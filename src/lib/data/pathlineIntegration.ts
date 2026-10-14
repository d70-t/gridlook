import type { TVectorSample } from "./vectorField.ts";

export type TPathlinePosition = { latitude: number; longitude: number };
export type TPathlineVector = [number, number, number];
export type TPathlineVelocity = (
  latitude: number,
  longitude: number,
  seconds: number
) => TVectorSample | undefined;
export type TPathlineSurface = { semiMajorAxis: number; flattening: number };
export const PATHLINE_WGS84 = {
  semiMajorAxis: 6378137,
  flattening: 1 / 298.257223563,
} as const;
const RAD = Math.PI / 180;

export function pathlineUnitVector(point: TPathlinePosition): TPathlineVector {
  const lat = point.latitude * RAD,
    lon = point.longitude * RAD;
  return [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];
}

export function pathlineGeographic(point: TPathlineVector): TPathlinePosition {
  return {
    latitude: Math.atan2(point[2], Math.hypot(point[0], point[1])) / RAD,
    longitude: Math.atan2(point[1], point[0]) / RAD,
  };
}

export function normalizePathlineVector(
  point: TPathlineVector
): TPathlineVector {
  const length = Math.hypot(...point);
  return [point[0] / length, point[1] / length, point[2] / length];
}

/** Bogacki–Shampine RK3(2), reusing the endpoint derivative and retry's start. */
// eslint-disable-next-line max-lines-per-function
export function createPathlineStepper(
  sample: TPathlineVelocity,
  surface: TPathlineSurface = PATHLINE_WGS84
) {
  type TDerivative = {
    point: TPathlineVector;
    time: number;
    value: TPathlineVector;
    speed: number;
  };
  let first: TDerivative | undefined;
  let last: TDerivative | undefined;
  function derivative(
    position: TPathlineVector,
    time: number
  ): TDerivative | undefined {
    const { latitude, longitude } = pathlineGeographic(position);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return;
    }
    const velocity = sample(latitude, longitude, time);
    if (
      !velocity ||
      !Number.isFinite(velocity.u) ||
      !Number.isFinite(velocity.v)
    ) {
      return;
    }
    const speed = Math.hypot(velocity.u, velocity.v);
    if (!Number.isFinite(speed)) {
      return;
    }

    const lat = latitude * RAD,
      lon = longitude * RAD;
    const e2 = surface.flattening * (2 - surface.flattening);
    const factor = 1 - e2 * Math.sin(lat) ** 2;
    const eastRadius = surface.semiMajorAxis / Math.sqrt(factor);
    const northRadius = (eastRadius * (1 - e2)) / factor;
    const u = velocity.u / eastRadius,
      v = velocity.v / northRadius;
    const value: TPathlineVector = [
      -u * Math.sin(lon) - v * Math.sin(lat) * Math.cos(lon),
      u * Math.cos(lon) - v * Math.sin(lat) * Math.sin(lon),
      v * Math.cos(lat),
    ];
    return { point: position, time, value, speed };
  }
  // Point identity is safe: accepted points are immutable. A retry keeps its
  // start; an accepted step reuses its normalized endpoint (FSAL).
  // eslint-disable-next-line max-lines-per-function
  return function step(
    point: TPathlineVector,
    seconds: number,
    stepSeconds: number
  ) {
    const offset = (d: TPathlineVector, dt: number): TPathlineVector => [
      point[0] + d[0] * dt,
      point[1] + d[1] * dt,
      point[2] + d[2] * dt,
    ];
    first =
      first?.point === point && first.time === seconds
        ? first
        : last?.point === point && last.time === seconds
          ? last
          : derivative(point, seconds);
    if (!first) {
      return;
    }
    const a = first.value;
    const stageB = derivative(
      offset(a, stepSeconds / 2),
      seconds + stepSeconds / 2
    );
    const b = stageB?.value;
    if (!b) {
      return;
    }
    const stageC = derivative(
      offset(b, (3 * stepSeconds) / 4),
      seconds + (3 * stepSeconds) / 4
    );
    const c = stageC?.value;
    if (!c) {
      return;
    }
    const result = normalizePathlineVector(
      point.map(
        (value, i) =>
          value + stepSeconds * ((2 * a[i]) / 9 + b[i] / 3 + (4 * c[i]) / 9)
      ) as TPathlineVector
    );
    // The fourth stage validates the accepted endpoint and completes the embedded pair.
    last = derivative(result, seconds + stepSeconds);
    const d = last?.value;
    if (!d) {
      return;
    }
    const error = a.map(
      (value, i) =>
        stepSeconds * ((5 * value) / 72 - b[i] / 12 - c[i] / 9 + d[i] / 8)
    ) as TPathlineVector;
    // Upper bound on ellipsoid curvature radii; includes radial error before projection.
    const errorMetres =
      (Math.hypot(...error) * surface.semiMajorAxis) / (1 - surface.flattening);
    return {
      point: result,
      maxSpeed: Math.max(
        first.speed,
        stageB!.speed,
        stageC!.speed,
        last!.speed
      ),
      errorMetres,
    };
  };
}

export function stepPathline(
  point: TPathlineVector,
  seconds: number,
  stepSeconds: number,
  sample: TPathlineVelocity,
  surface: TPathlineSurface = PATHLINE_WGS84
) {
  return createPathlineStepper(sample, surface)(point, seconds, stepSeconds);
}
