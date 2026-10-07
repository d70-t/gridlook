type TCellChunk = ArrayLike<number | bigint>;

/**
 * An ascending `cell` coordinate read chunk by chunk, so that a deep sparse
 * level is searched and sliced without holding its whole coordinate. Every
 * chunk is checked as it is read: once one is found out of order, searches
 * throw and `isAscending` answers false.
 */
// ponytail: decoded chunks are kept for as long as the reader lives. Give
// the map an LRU bound if coordinates with very many chunks get panned over.
// eslint-disable-next-line max-lines-per-function
export function createSortedCells(
  length: number,
  chunkLength: number,
  readChunk: (start: number, end: number) => Promise<TCellChunk>
) {
  const chunks = new Map<number, Promise<Float64Array>>();
  // first and last id of every chunk read so far
  const bounds = new Map<number, [number, number]>();
  let ascending = true;

  /** Ascending within itself, and against every chunk already read. */
  function check(index: number, values: Float64Array) {
    for (let at = 1; at < values.length; at++) {
      if (values[at] <= values[at - 1]) {
        return false;
      }
    }
    const first = values[0];
    const last = values[values.length - 1];
    for (const [other, [otherFirst, otherLast]] of bounds) {
      if (other < index ? otherLast >= first : otherFirst <= last) {
        return false;
      }
    }
    bounds.set(index, [first, last]);
    return true;
  }

  function chunk(index: number) {
    let loaded = chunks.get(index);
    if (!loaded) {
      const start = index * chunkLength;
      loaded = readChunk(start, Math.min(start + chunkLength, length)).then(
        (values) => {
          const cells = Float64Array.from(values as ArrayLike<number>, Number);
          ascending &&= check(index, cells);
          return cells;
        }
      );
      chunks.set(index, loaded);
    }
    return loaded;
  }

  async function valueAt(index: number) {
    const values = await chunk(Math.floor(index / chunkLength));
    if (!ascending) {
      throw new Error("The cell coordinate is not in ascending order.");
    }
    return values[index % chunkLength];
  }

  /** Index of the first cell with an id of at least `target`. */
  async function lowerBound(target: number) {
    let lo = 0;
    let hi = length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((await valueAt(mid)) < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** The cell ids at indices `[start, end)`. */
  async function slice(start: number, end: number) {
    const cells: number[] = [];
    for (let index = start; index < end;) {
      const chunkIndex = Math.floor(index / chunkLength);
      const values = await chunk(chunkIndex);
      const stop = Math.min(end, (chunkIndex + 1) * chunkLength);
      for (; index < stop; index++) {
        cells.push(values[index % chunkLength]);
      }
    }
    if (!ascending) {
      throw new Error("The cell coordinate is not in ascending order.");
    }
    return cells;
  }

  /**
   * Whether the coordinate is ascending as far as it has been read; reads the
   * first and the last chunk if nothing has been read yet.
   */
  async function isAscending() {
    if (length > 0) {
      await chunk(0);
      await chunk(Math.floor((length - 1) / chunkLength));
    }
    return ascending;
  }

  return { lowerBound, slice, isAscending };
}
