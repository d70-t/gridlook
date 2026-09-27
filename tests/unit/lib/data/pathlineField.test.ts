import { Grid } from "healpix-geo";
import proj4 from "proj4";
import { expect, it } from "vitest";

import {
  createPathlineGrid,
  PATHLINE_GRID,
  samplePathlineTime,
} from "@/lib/data/pathlineField.ts";

const axis = new Float32Array([0, 1]);
const regular = () =>
  createPathlineGrid({ kind: PATHLINE_GRID.REGULAR, x: axis, y: axis });

it("samples physical bilinear velocities and irregular dataset times without visual speed normalization", () => {
  const grid = regular();
  const a = grid.field(
    new Float32Array([0, 2, 4, 6]),
    new Float32Array(4).fill(8),
    false
  );
  const b = grid.field(
    new Float32Array(4).fill(10),
    new Float32Array(4),
    false
  );
  expect(a.sample(0.5, 0.5)).toEqual({ u: 3, v: 8, speed: Math.hypot(3, 8) });
  expect(samplePathlineTime([0, 7200], [a, b], 0.5, 0.5, 1800)).toEqual({
    u: 4.75,
    v: 6,
    speed: Math.hypot(4.75, 6),
  });
  expect(samplePathlineTime([0, 7200], [a, b], 0, 0, 7200)?.u).toBe(10);
  for (const t of [-1, 7201, NaN]) {
    expect(samplePathlineTime([0, 7200], [a, b], 0, 0, t)).toBeUndefined();
  }
});

it("preserves holes and samples exact keyframes without requiring the next field", () => {
  const grid = regular();
  const a = grid.field(
    new Float32Array([3, NaN, 3, 3]),
    new Float32Array(4),
    false
  );
  const missing = grid.field(
    new Float32Array(4).fill(NaN),
    new Float32Array(4),
    false
  );
  expect(a.sample(0, 0)?.u).toBe(3);
  expect(a.sample(0.5, 0.5)).toBeUndefined();
  expect(samplePathlineTime([0, 1], [a, missing], 0, 0, 0)?.u).toBe(3);
  expect(samplePathlineTime([0, 1], [a, missing], 0, 0, 0.5)).toBeUndefined();
  expect(a.sample(NaN, 0)).toBeUndefined();
  expect(a.sample(2, 0)).toBeUndefined();
});

it("supports descending axes and the global longitude seam", () => {
  const grid = createPathlineGrid({
    kind: PATHLINE_GRID.REGULAR,
    x: new Float32Array([270, 180, 90, 0]),
    y: new Float32Array([1, 0]),
  });
  const field = grid.field(
    new Float32Array([6, 4, 2, 0, 6, 4, 2, 0]),
    new Float32Array(8),
    false
  );
  expect(field.sample(0.5, -45)?.u).toBe(3);
  expect(field.sample(0.5, 405)?.u).toBe(1);
});

it("shares an unstructured index, retaining missing native samples", () => {
  const grid = createPathlineGrid({
    kind: PATHLINE_GRID.POINTS,
    latitudes: new Float32Array([0, 0, 1, 1]),
    longitudes: new Float32Array([0, 1, 0, 1]),
  });
  const field = grid.field(
    new Float32Array([2, 4, 6, NaN]),
    new Float32Array(4).fill(1),
    false
  );
  expect(field.sample(0, 0)?.u).toBe(2);
  expect(field.sample(1, 1)).toBeUndefined();
  expect(field.sample(0.5, 0.5)).toBeUndefined();
  expect(field.sample(-1, 0)).toBeUndefined();
  expect(grid.buffers.length).toBe(3);
});

it("rotates projected grid-relative winds into geographic east/north", () => {
  const crs = "+proj=lcc +lat_1=56 +lat_0=56 +lon_0=10 +datum=WGS84 +units=m";
  const projection = proj4(crs, "EPSG:4326");
  const [x, y] = projection.inverse([15, 56]);
  const grid = createPathlineGrid({
    kind: PATHLINE_GRID.PROJECTED,
    crs,
    x: new Float64Array([x - 1000, x + 1000]),
    y: new Float64Array([y - 1000, y + 1000]),
  });
  const field = grid.field(
    new Float32Array(4).fill(10),
    new Float32Array(4),
    true
  );
  const sample = field.sample(56, 15)!;
  const convergence = ((5 * Math.PI) / 180) * Math.sin((56 * Math.PI) / 180);
  expect(sample.u).toBeCloseTo(10 * Math.cos(convergence), 3);
  expect(sample.v).toBeCloseTo(-10 * Math.sin(convergence), 3);
  expect(sample.speed).toBeCloseTo(10, 5);
  expect(
    grid
      .field(new Float32Array(4).fill(10), new Float32Array(4), false)
      .sample(56, 15)?.u
  ).toBe(10);
});

it.each(["nested", "ring", "zuniq"] as const)(
  "maps sparse high-resolution %s HEALPix cells without dropping ID precision",
  (scheme) => {
    using hp = new Grid({ level: 20, scheme });
    const pixels = hp.lonLatToHealpix(new Float64Array([10, 20, -10, -20]));
    const grid = createPathlineGrid({
      kind: PATHLINE_GRID.HEALPIX,
      grid: hp,
      cells: [Number(pixels[1]), Number(pixels[0])],
    });
    const field = grid.field(
      new Float32Array([2, 8]),
      new Float32Array(2),
      false
    );
    expect(field.sample(20, 10)?.u).toBe(8);
    expect(field.sample(-20, -10)?.u).toBe(2);
    expect(field.sample(0, 0)).toBeUndefined();
  }
);

it("rejects malformed axes, component shapes and unknown grid orientation", () => {
  expect(() =>
    createPathlineGrid({
      kind: PATHLINE_GRID.REGULAR,
      x: new Float32Array([0, 1, 0]),
      y: axis,
    })
  ).toThrow(/monotonic/);
  expect(() =>
    regular().field(new Float32Array(3), new Float32Array(4), false)
  ).toThrow(/match/);
  expect(() =>
    regular().field(new Float32Array(4), new Float32Array(4), true)
  ).toThrow(/projection/);
});

it("rotates winds and wraps longitude on a rotated-pole grid", () => {
  const crs =
    "+proj=ob_tran +o_proj=longlat +o_lat_p=0 +o_lon_p=0 +lon_0=0 +datum=WGS84";
  const transform = proj4(crs, "EPSG:4326");
  const [lon, lat] = transform.forward([90, 0]);
  const local = createPathlineGrid({
    kind: PATHLINE_GRID.PROJECTED,
    crs,
    x: new Float32Array([89, 91]),
    y: new Float32Array([-1, 1]),
  });
  const wind = local
    .field(new Float32Array(4).fill(5), new Float32Array(4), true)
    .sample(lat, lon)!;
  expect(wind.u).toBeCloseTo(0, 5);
  // Here increasing rotated longitude points south: (89, 0) -> (90, 1).
  expect(wind.v).toBeCloseTo(-5, 5);
  const global = createPathlineGrid({
    kind: PATHLINE_GRID.PROJECTED,
    crs,
    x: new Float32Array([-180, -90, 0, 90]),
    y: new Float32Array([-30, 30]),
  });
  const [seamLon, seamLat] = transform.forward([135, 0]);
  expect(
    global
      .field(
        new Float32Array([0, 2, 4, 6, 0, 2, 4, 6]),
        new Float32Array(8),
        false
      )
      .sample(seamLat, seamLon)?.u
  ).toBeCloseTo(3);
});
