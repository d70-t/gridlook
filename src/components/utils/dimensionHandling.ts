import type { TDimensionRange } from "@/types/GlobeTypes";
import * as zarr from "zarrita";

/**
 * Creates an array of dimension range objects from a given zarray.
 *
 * The created array will have the same length as the shape of the zarray,
 * minus the last `lastToIgnore` elements. The last `lastToIgnore` elements are
 * ignored and replaced with null values. Null values are used to indicate that
 * all elements of the dimension should be loaded.
 *
 * For each dimension, the following properties are defined:
 * - name: the name of the dimension
 * - startPos: the starting position of the dimension, when loading the data for
 *   the first time
 * - minBound: the minimum bound of the dimension
 * - maxBound: the maximum bound of the dimension
 *
 * The starting position, minimum bound and maximum bound can be overridden
 * by providing preset values in the `presetStarts`, `presetMinBounds` and
 * `presetMaxBounds` objects, respectively. This is done via URL parameters
 *
 * FIXME: The dimensions catched by the lastToIgnore are those of which we
 * expect, that we need to load them completely in order to render the globe.
 * This is e.g. the case for lat and lon-dimensions of a regular grid.
 *
 * In all cases I encountered so far, these dimensions are placed at the end of
 * the dimensions array (hence the lastToIgnore). This is not according to the
 * CF standard, which would sort the dimensions by its size. This might be a
 * problem in the future.
 *
 * @param {zarr.Array<zarr.DataType, zarr.FetchStore>} datavar - the zarray to process
 * @param {Record<string, string>} presetStarts - optional preset starting positions
 * @param {Record<string, string>} presetMinBounds - optional preset minimum bounds
 * @param {Record<string, string>} presetMaxBounds - optional preset maximum bounds
 * @param {number} lastToIgnore - the number of last dimensions to ignore
 * @returns {TDimensionRange[]} an array of dimension range objects
 */
function createDimensionRanges(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  presetStarts: Record<string, string>,
  presetMinBounds: Record<string, string>,
  presetMaxBounds: Record<string, string>,
  lastToIgnore: number
) {
  const dimensions = datavar.attrs._ARRAY_DIMENSIONS as string[];
  const shape = datavar.shape;
  const indices: TDimensionRange[] = shape
    .slice(0, shape.length - lastToIgnore)
    .map((size, i) => {
      if (size === 1) {
        // Single element dimension
        return { name: dimensions[i], startPos: 0, minBound: 0, maxBound: 0 };
      } else {
        let startPos = 0;
        let minBound = 0;
        let maxBound = size - 1;
        if (
          Object.hasOwn(presetMinBounds, dimensions[i]) &&
          !isNaN(Number(presetMinBounds[dimensions[i]]))
        ) {
          minBound = Number(presetMinBounds[dimensions[i]]);
        }
        if (
          Object.hasOwn(presetMaxBounds, dimensions[i]) &&
          !isNaN(Number(presetMaxBounds[dimensions[i]]))
        ) {
          maxBound = Number(presetMaxBounds[dimensions[i]]);
        }
        if (
          Object.hasOwn(presetStarts, dimensions[i]) &&
          !isNaN(Number(presetStarts[dimensions[i]]))
        ) {
          startPos = Number(presetStarts[dimensions[i]]);
          if (startPos < minBound) {
            startPos = minBound;
          }
          if (startPos > maxBound) {
            startPos = maxBound;
          }
        }
        return {
          name: dimensions[i],
          startPos,
          minBound,
          maxBound,
        };
      }
    });

  for (let i = 0; i < lastToIgnore; i++) {
    // Add wildcard (null) for last dimension
    indices.push(null);
  }
  return indices;
}

export function getDimensionInfo(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  presetStarts: Record<string, string>,
  presetMinBounds: Record<string, string>,
  presetMaxBounds: Record<string, string>,
  sliderValues: number[] | null,
  lastToIgnore: number
) {
  let dimensionRanges: TDimensionRange[] = [];
  dimensionRanges = createDimensionRanges(
    datavar,
    presetStarts,
    presetMinBounds,
    presetMaxBounds,
    lastToIgnore
  );
  let indices: (number | null)[] = [];
  if (sliderValues === null) {
    // Initial loading
    indices = dimensionRanges.map((d) => {
      if (d === null) {
        return null;
      } else {
        return d.startPos;
      }
    });
    console.log("initial indices", indices);
  } else {
    console.log("dimslidervalues", sliderValues);
    indices = sliderValues;
  }
  return {
    dimensionRanges,
    indices,
  };
}
