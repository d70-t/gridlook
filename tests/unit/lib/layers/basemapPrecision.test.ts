// Mirrors the offset paths of basemap.frag.glsl with every operation rounded
// to float32, to check that they place tiles to within a fraction of a pixel
// at the highest zoom, where absolute coordinates would not.
import { expect, it } from "vitest";

import {
  BasemapZoom,
  EXPANSION_VIEW_RADIUS,
  getFlatMercatorExpansion,
  latToMercatorY,
  lonToMercatorX,
  TILE_SIZE,
} from "@/lib/layers/basemapTiles.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

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

/** The flat path's expansion branch, in float32. */
function shaderExpansionOffset(
  mapOffset: [number, number],
  expansion: NonNullable<ReturnType<typeof getFlatMercatorExpansion>>
) {
  const [a, b, c, d] = expansion.jacobian.map(f);
  const u = [
    f(f(a * mapOffset[0]) + f(b * mapOffset[1])),
    f(f(c * mapOffset[0]) + f(d * mapOffset[1])),
  ];
  const uu = [f(u[0] * u[0]), f(2 * f(u[0] * u[1])), f(u[1] * u[1])];
  const curvature = (q: number[]) =>
    f(f(f(f(q[0]) * uu[0]) + f(f(q[1]) * uu[1])) + f(f(q[2]) * uu[2]));
  return [
    f(u[0] - curvature(expansion.curvatureX)),
    f(u[1] - curvature(expansion.curvatureY)),
  ];
}

it.each([
  PROJECTION_TYPES.ROBINSON,
  PROJECTION_TYPES.MOLLWEIDE,
  PROJECTION_TYPES.AZIMUTHAL_EQUIDISTANT,
  PROJECTION_TYPES.MERCATOR,
])("expands %s flat maps precisely enough for zoom 19", (type) => {
  const helper = new ProjectionHelper(type, { lat: 40, lon: 20 });
  const refLat = 54.321;
  const refLon = 10.123;
  const mercatorX = lonToMercatorX(refLon);
  const mercatorY = latToMercatorY(refLat);
  const expansion = getFlatMercatorExpansion(
    (lat, lon) => helper.project(lat, lon),
    mercatorX,
    mercatorY
  )!;
  expect(expansion).toBeDefined();

  const tiles = 2 ** BasemapZoom.MAX;
  for (const [dLat, dLon] of [
    [0.002, -0.003],
    [-0.004, 0.001],
    [0.0001, 0.0042],
  ]) {
    const [x, y] = helper.project(refLat + dLat, refLon + dLon);
    // The shader gets the map offset precisely from the camera ray.
    const offset = shaderExpansionOffset(
      [f(x - expansion.projected[0]), f(y - expansion.projected[1])],
      expansion
    );
    const exactX = lonToMercatorX(refLon + dLon) - mercatorX;
    const exactY = latToMercatorY(refLat + dLat) - mercatorY;
    expect(Math.abs(f(offset[0] * tiles) - exactX * tiles)).toBeLessThan(
      0.25 / TILE_SIZE
    );
    expect(Math.abs(f(offset[1] * tiles) - exactY * tiles)).toBeLessThan(
      0.25 / TILE_SIZE
    );
  }
});

it.each([
  [54.321, 10.123],
  [72.5, -40],
  [-5, 120],
])(
  "keeps whole flat views up to the expansion radius aligned (ref %f, %f)",
  (refLat, refLon) => {
    // Views that wide show about zoom 12; zoom 13 covers larger screens.
    const pixelsPerMercator = 2 ** 13 * TILE_SIZE;
    for (const type of [
      PROJECTION_TYPES.ROBINSON,
      PROJECTION_TYPES.MOLLWEIDE,
      PROJECTION_TYPES.AZIMUTHAL_HYBRID,
      PROJECTION_TYPES.MERCATOR,
    ]) {
      const helper = new ProjectionHelper(type, { lat: 40, lon: 20 });
      const mercatorX = lonToMercatorX(refLon);
      const mercatorY = latToMercatorY(refLat);
      const expansion = getFlatMercatorExpansion(
        (lat, lon) => helper.project(lat, lon),
        mercatorX,
        mercatorY
      )!;
      for (let step = 0; step < 16; step++) {
        const angle = (step / 16) * 2 * Math.PI;
        const mapOffset: [number, number] = [
          EXPANSION_VIEW_RADIUS * Math.cos(angle),
          EXPANSION_VIEW_RADIUS * Math.sin(angle),
        ];
        const [lon, lat] = helper.getD3Projection()!.invert!([
          expansion.projected[0] + mapOffset[0],
          -(expansion.projected[1] + mapOffset[1]),
        ])!;
        const offset = shaderExpansionOffset(mapOffset, expansion);
        const exactX = lonToMercatorX(lon) - mercatorX;
        const exactY = latToMercatorY(lat) - mercatorY;
        expect(Math.abs(offset[0] - exactX) * pixelsPerMercator).toBeLessThan(
          0.25
        );
        expect(Math.abs(offset[1] - exactY) * pixelsPerMercator).toBeLessThan(
          0.25
        );
      }
    }
  }
);
