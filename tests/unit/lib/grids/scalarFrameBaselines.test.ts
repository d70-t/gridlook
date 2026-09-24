import { expect, it } from "vitest";

import { buildCurvilinearBatch } from "@/lib/grids/curvilinearCalculations.ts";
import {
  buildGaussianReducedBatch,
  buildGaussianReducedRows,
} from "@/lib/grids/gaussianReducedCalculations.ts";
import { buildHealpixTexture } from "@/lib/grids/healpixCalculations.ts";
import {
  buildIrregularBatch,
  buildIrregularGridData,
} from "@/lib/grids/irregularCalculations.ts";
import {
  buildIrregularDelaunayGeometryBatch,
  buildIrregularDelaunayGrid,
} from "@/lib/grids/irregularDelaunayCalculations.ts";
import { buildTriangularDataBatch } from "@/lib/grids/triangularCalculations.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

const projection = new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
  lat: 0,
  lon: 0,
});

type TScalarCase = {
  name: string;
  values: number[];
  expected: number[];
  prepare: (data: Float32Array) => Float32Array;
};

const cases: TScalarCase[] = [
  {
    name: "HEALPix",
    values: [1, NaN, 3, 4],
    expected: [1, NaN, 3, 4],
    prepare: (data) => buildHealpixTexture(data, 0, 2).dataValues,
  },
  {
    name: "curvilinear",
    values: [1, NaN, 3, 4],
    expected: [1, 1, 1, 1, NaN, NaN, NaN, NaN],
    prepare: (data) =>
      buildCurvilinearBatch(
        {
          latitudes: new Float32Array([0, 0, 1, 1]),
          longitudes: new Float32Array([0, 1, 0, 1]),
          data,
          nj: 2,
          ni: 2,
          shouldFlipLongitude: false,
          isPeriodicI: false,
        },
        0,
        10,
        projection
      ).dataValues,
  },
  {
    name: "Gaussian reduced",
    values: [1, NaN, 3, 4],
    expected: [1, 1, 1, 1, NaN, NaN, NaN, NaN],
    prepare: (data) =>
      buildGaussianReducedBatch(
        buildGaussianReducedRows(
          new Float64Array([10, 10, 0, 0]),
          new Float64Array([0, 180, 0, 180]),
          data
        ),
        0,
        10,
        0.002,
        projection
      ).dataValues,
  },
  {
    name: "irregular points",
    values: [1, NaN, 3, 4],
    expected: [1, NaN, 3, 4],
    prepare: (data) =>
      buildIrregularBatch(
        buildIrregularGridData(
          new Float32Array([0, 0, 1, 1]),
          new Float32Array([0, 1, 1, 0]),
          [4],
          [4],
          data,
          projection
        ),
        0,
        10
      ).dataValues,
  },
  {
    name: "irregular Delaunay",
    values: [1, NaN, 3],
    expected: [2, 2, 2],
    prepare: (data) =>
      buildIrregularDelaunayGeometryBatch(
        buildIrregularDelaunayGrid(
          new Float32Array([0, 0, 1]),
          new Float32Array([0, 1, 0]),
          [3],
          [3],
          3
        ),
        data,
        0,
        10
      ).dataValues,
  },
  {
    name: "triangular cells",
    values: [1, NaN],
    expected: [1, 1, 1, NaN, NaN, NaN],
    prepare: (data) => buildTriangularDataBatch(data, 0, 10).dataValues,
  },
];

it.each(cases)(
  "keeps $name scalar values independent across a timestep round trip",
  ({ values, expected, prepare }) => {
    // Retain earlier outputs while preparing later frames, as a bake will do.
    const frames = [0, 10, 0].map((offset) => {
      const input = Float32Array.from(values, (value) => value + offset);
      const original = input.slice();
      const output = prepare(input);
      expect(input).toEqual(original);
      return {
        output,
        expected: Float32Array.from(expected, (value) => value + offset),
      };
    });
    for (const frame of frames) {
      expect(frame.output).toEqual(frame.expected);
    }
  }
);
