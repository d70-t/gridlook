// Geometry belongs to a bake job; clear this cache when the job is released.
type TScalarBuffer = ArrayBufferView | ArrayBuffer;
export type TScalarGeometryCache = Map<string, TScalarBuffer>;
export type TScalarFrameMemory = {
  buffers: ArrayBufferLike[];
  extraBytes: number;
  gpuBytes: number;
};

/** Share only byte-identical static attributes; data values remain frame-owned. */
export function shareScalarGeometry<T extends { batchIndex: number }>(
  batch: T,
  cache?: TScalarGeometryCache
): T {
  return shareScalarBuffers(`batch:${batch.batchIndex}`, batch, cache);
}

/** Deduplicate static arrays, including hover indexes, without sharing field values. */
export function shareScalarBuffers<T extends object>(
  prefix: string,
  batch: T,
  cache?: TScalarGeometryCache
): T {
  if (!cache) {
    return batch;
  }
  for (const [name, value] of Object.entries(batch)) {
    if (
      name === "dataValues" ||
      name === "values" ||
      !(ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    ) {
      continue;
    }
    const key = `${prefix}:${name}`;
    const previous = cache.get(key);
    if (previous && equalBytes(previous, value)) {
      Object.assign(batch, { [name]: previous });
    } else {
      cache.set(key, value);
    }
  }
  return batch;
}

function equalBytes(a: TScalarBuffer, b: TScalarBuffer) {
  if (a.constructor !== b.constructor || a.byteLength !== b.byteLength) {
    return false;
  }
  const left =
    a instanceof ArrayBuffer
      ? new Uint8Array(a)
      : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const right =
    b instanceof ArrayBuffer
      ? new Uint8Array(b)
      : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

/** Count retained backing allocations once, including views into shared arrays. */
export function scalarFrameMemory(
  gpuData: unknown,
  ...retained: unknown[]
): TScalarFrameMemory {
  const buffers = new Set<ArrayBufferLike>();
  const visited = new Set<object>();
  let extraBytes = 0;
  function visit(value: unknown) {
    if (!value || typeof value !== "object" || visited.has(value)) {
      return;
    }
    visited.add(value);
    if (ArrayBuffer.isView(value)) {
      buffers.add(value.buffer);
    } else if (value instanceof ArrayBuffer) {
      buffers.add(value);
    } else if (Array.isArray(value) && typeof value[0] === "number") {
      extraBytes += value.length * 8;
    } else if (
      Array.isArray(value) ||
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      Object.values(value).forEach(visit);
    }
  }
  visit(gpuData);
  let gpuBytes = extraBytes;
  for (const buffer of buffers) {
    gpuBytes += buffer.byteLength;
  }
  retained.forEach(visit);
  return { buffers: [...buffers], extraBytes, gpuBytes };
}

export function scalarMemoryBytes(memory: TScalarFrameMemory) {
  let bytes = memory.extraBytes;
  for (const buffer of memory.buffers) {
    bytes += buffer.byteLength;
  }
  return bytes;
}
