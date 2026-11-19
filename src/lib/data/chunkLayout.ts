export type TChunkDimension = {
  name: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  isSpatial: boolean;
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
 * Computes how an array is split into chunks and how much of it gridlook
 * reads to display a single step. Spatial dimensions are loaded completely,
 * all other dimensions are reduced to one index, which still reads the whole
 * chunk containing that index.
 */
export function computeChunkLayout(
  dimensions: { name: string; size: number; isSpatial: boolean }[],
  chunks: readonly (number | null)[],
  bytesPerElement: number
): TChunkLayout {
  const dims = dimensions.map((dim, i) => {
    // A missing chunk size means the dimension is stored as a single chunk.
    const chunkSize = Math.min(chunks[i] ?? dim.size, dim.size) || 1;
    return {
      ...dim,
      chunkSize,
      chunkCount: Math.ceil(dim.size / chunkSize),
    };
  });
  let totalChunks = 1;
  let chunkElements = 1;
  let stepChunks = 1;
  let shownElements = 1;
  for (const dim of dims) {
    totalChunks *= dim.chunkCount;
    chunkElements *= dim.chunkSize;
    if (dim.isSpatial) {
      stepChunks *= dim.chunkCount;
      shownElements *= dim.size;
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
  };
}
