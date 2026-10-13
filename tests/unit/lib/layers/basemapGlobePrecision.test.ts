// Mirrors the globe path of basemap.frag.glsl with every operation rounded to
// float32, to check that its offset formulas place tiles to within a fraction
// of a pixel at the highest zoom, where absolute coordinates would not.
import { expect, it } from "vitest";

import {
  BasemapZoom,
  latToMercatorY,
  lonToMercatorX,
  TILE_SIZE,
} from "@/lib/layers/basemapTiles.ts";

type TVec3 = [number, number, number];

const f = Math.fround;
const add = (a: TVec3, b: TVec3): TVec3 => [
  f(a[0] + b[0]),
  f(a[1] + b[1]),
  f(a[2] + b[2]),
];
const scale = (a: TVec3, s: number): TVec3 => [
  f(a[0] * s),
  f(a[1] * s),
  f(a[2] * s),
];
const dot = (a: TVec3, b: TVec3) =>
  f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));

function offsetSeries(x: number, sign: number) {
  const x2 = f(x * x);
  return f(x * f(1 + sign * f(x2 * f(1 / 3 + sign * f(x2 * 0.2)))));
}

function unitVector(latDeg: number, lonDeg: number): TVec3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];
}

type TUniforms = {
  sinLat: number;
  cosLat: number;
  sinLon: number;
  cosLon: number;
  cameraOffset: TVec3;
  heightTerm: number;
};

/** getMercatorOffset() of the globe shader, in float32. */
function shaderMercatorOffset(direction: TVec3, u: TUniforms) {
  const reference: TVec3 = [
    f(u.cosLat * u.cosLon),
    f(u.cosLat * u.sinLon),
    u.sinLat,
  ];
  const b = dot(add(reference, u.cameraOffset), direction);
  const discriminant = f(f(b * b) - u.heightTerm);
  const t = f(u.heightTerm / f(-b + f(Math.sqrt(discriminant))));
  const offset = add(u.cameraOffset, scale(direction, t));

  const y = dot(offset, [-u.sinLon, u.cosLon, 0]);
  const x = f(u.cosLat + dot(offset, [u.cosLon, u.sinLon, 0]));
  const lonOffset = offsetSeries(f(y / x), -1);
  const hitSinLat = f(u.sinLat + offset[2]);
  const psiOffset = offsetSeries(
    f(offset[2] / f(1 - f(hitSinLat * u.sinLat))),
    1
  );
  return [f(lonOffset / f(2 * Math.PI)), f(-psiOffset / f(2 * Math.PI))];
}

/** Uniforms as the CPU computes them in double, uploaded as float32. */
function getUniforms(refLat: number, refLon: number, camera: TVec3) {
  const reference = unitVector(refLat, refLon);
  const lat = (refLat * Math.PI) / 180;
  const lon = (refLon * Math.PI) / 180;
  const cameraOffset = camera.map((v, i) => v - reference[i]);
  return {
    sinLat: f(Math.sin(lat)),
    cosLat: f(Math.cos(lat)),
    sinLon: f(Math.sin(lon)),
    cosLon: f(Math.cos(lon)),
    cameraOffset: cameraOffset.map(f) as TVec3,
    heightTerm: f(
      2 * reference.reduce((sum, v, i) => sum + v * cameraOffset[i], 0) +
        cameraOffset.reduce((sum, v) => sum + v * v, 0)
    ),
  };
}

it("places zoom-19 tiles within a quarter pixel from 7 km altitude", () => {
  const refLat = 54.321;
  const refLon = 10.123;
  // Straight above the reference point.
  const exactCamera = unitVector(refLat, refLon).map(
    (v) => v * (1 + 7000 / 6_371_008.8)
  ) as TVec3;
  const uniforms = getUniforms(refLat, refLon, exactCamera);

  const tiles = 2 ** BasemapZoom.MAX;
  for (const [dLat, dLon] of [
    [0.002, -0.003],
    [-0.004, 0.001],
    [0.0001, 0.0042],
  ]) {
    const target = unitVector(refLat + dLat, refLon + dLon);
    const ray = target.map((v, i) => v - exactCamera[i]);
    const length = Math.hypot(...ray);
    const direction = ray.map((v) => f(v / length)) as TVec3;

    const [offsetX, offsetY] = shaderMercatorOffset(direction, uniforms);
    const pixelX = f(offsetX * tiles) * TILE_SIZE;
    const pixelY = f(offsetY * tiles) * TILE_SIZE;

    const exactX =
      (lonToMercatorX(refLon + dLon) - lonToMercatorX(refLon)) *
      tiles *
      TILE_SIZE;
    const exactY =
      (latToMercatorY(refLat + dLat) - latToMercatorY(refLat)) *
      tiles *
      TILE_SIZE;
    expect(Math.abs(pixelX - exactX)).toBeLessThan(0.25);
    expect(Math.abs(pixelY - exactY)).toBeLessThan(0.25);
  }
});
