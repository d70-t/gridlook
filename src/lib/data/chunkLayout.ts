/** Indices `[start, end)` of a dimension, every `step`-th if given. */
export type TIndexRange = { start: number; end: number; step?: number };

export type TChunkDimension = {
  name: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  isSpatial: boolean;
  /** Spatial dimensions: the chunks read for one step, as sorted, merged chunk index ranges. */
  readChunks: TIndexRange[];
  /** Indices the chunks read along this dimension span per index shown. */
  overhead: number;
};

export type TChunkLayout = {
  dimensions: TChunkDimension[];
  totalChunks: number;
  chunkBytes: number;
  /** Chunks read to display one step: every chunk along the spatial dims, one along the others. */
  stepChunks: number;
  stepBytes: number;
  /** Bytes of the values that are actually displayed for one step. */
  shownBytes: number;
  /** Bytes of one step over the whole spatial extent, read by view or not. */
  levelBytes: number;
};

export function getDtypeBytes(dtype: string): number {
  if (dtype.includes("64")) {
    return 8;
  }
  if (dtype.includes("32")) {
    return 4;
  }
  if (dtype.includes("16")) {
    return 2;
  }
  if (dtype.includes("8")) {
    return 1;
  }
  return 4;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2) + " TiB";
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GiB";
  }
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
  }
  return (bytes / 1024).toFixed(2) + " KiB";
}

/**
 * The chunks holding the indices of `ranges`, as sorted, merged chunk index
 * ranges. A stride of at most one chunk reads every chunk it crosses; a
 * longer one reads a chunk per index.
 */
export function readChunkRanges(ranges: TIndexRange[], chunkSize: number) {
  const chunks: TIndexRange[] = [];
  for (const { start, end, step = 1 } of ranges) {
    if (start >= end) {
      continue;
    }
    if (step <= chunkSize) {
      const last = start + Math.floor((end - 1 - start) / step) * step;
      chunks.push({
        start: Math.floor(start / chunkSize),
        end: Math.floor(last / chunkSize) + 1,
      });
      continue;
    }
    for (let index = start; index < end; index += step) {
      const chunk = Math.floor(index / chunkSize);
      chunks.push({ start: chunk, end: chunk + 1 });
    }
  }
  chunks.sort((a, b) => a.start - b.start);
  const merged: TIndexRange[] = [];
  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (last && chunk.start <= last.end) {
      last.end = chunk.end > last.end ? chunk.end : last.end;
    } else {
      merged.push({ ...chunk });
    }
  }
  return merged;
}

function countIndices(ranges: TIndexRange[]) {
  let count = 0;
  for (const { start, end, step = 1 } of ranges) {
    if (end > start) {
      count += Math.ceil((end - start) / step);
    }
  }
  return count;
}

function chunkDimension(
  dim: { name: string; size: number; isSpatial: boolean },
  chunk: number | null,
  read: TIndexRange[]
): TChunkDimension {
  // A missing chunk size means the dimension is stored as a single chunk.
  const chunkSize = Math.min(chunk ?? dim.size, dim.size) || 1;
  const readChunks = dim.isSpatial ? readChunkRanges(read, chunkSize) : [];
  let spanned = 0;
  for (const readChunk of readChunks) {
    const end = readChunk.end * chunkSize;
    spanned += (end < dim.size ? end : dim.size) - readChunk.start * chunkSize;
  }
  const shown = countIndices(read);
  return {
    name: dim.name,
    size: dim.size,
    isSpatial: dim.isSpatial,
    chunkSize,
    chunkCount: Math.ceil(dim.size / chunkSize),
    readChunks,
    overhead: dim.isSpatial ? (shown ? spanned / shown : 1) : chunkSize,
  };
}

/**
 * Computes how an array is split into chunks and how much of it gridlook
 * reads to display a single step. Spatial dimensions are read at `ranges`
 * (a level loaded by view), else completely; all other dimensions are
 * reduced to one index, which still reads the whole chunk containing that
 * index.
 */
export function computeChunkLayout(
  dimensions: {
    name: string;
    size: number;
    isSpatial: boolean;
    ranges?: TIndexRange[];
  }[],
  chunks: readonly (number | null)[],
  bytesPerElement: number
): TChunkLayout {
  const reads = dimensions.map(
    (dim) => dim.ranges ?? [{ start: 0, end: dim.size }]
  );
  const dims = dimensions.map((dim, i) =>
    chunkDimension(dim, chunks[i], reads[i])
  );
  let totalChunks = 1;
  let chunkElements = 1;
  let stepChunks = 1;
  let shownElements = 1;
  let levelElements = 1;
  for (const [i, dim] of dims.entries()) {
    totalChunks *= dim.chunkCount;
    chunkElements *= dim.chunkSize;
    if (dim.isSpatial) {
      stepChunks *= countIndices(dim.readChunks);
      shownElements *= countIndices(reads[i]);
      levelElements *= dim.size;
    }
  }
  const chunkBytes = chunkElements * bytesPerElement;
  return {
    dimensions: dims,
    totalChunks,
    chunkBytes,
    stepChunks,
    stepBytes: stepChunks * chunkBytes,
    shownBytes: shownElements * bytesPerElement,
    levelBytes: levelElements * bytesPerElement,
  };
}
