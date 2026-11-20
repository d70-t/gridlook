import { isProxy, toRaw } from "vue";

import type { TAnalysisResult } from "./types.ts";

/**
 * A result as plain, cloneable data owned by the export: every level is
 * unwrapped from Vue's reactivity (a committed query inside a result can be
 * reactive, which the structured clone refuses), and long numeric lists
 * become Float64Arrays whose buffers can be transferred to the writer
 * without copying, while the displayed result keeps its own.
 */
export type TExportSnapshot = {
  result: TAnalysisResult;
  /** Numeric lists moved into typed arrays, by path, for the worker. */
  typed: { path: (string | number)[]; data: Float64Array }[];
  bytes: number;
};

const TYPED_MIN_LENGTH = 1024;

function isNumberList(value: unknown[]) {
  // A sample of the list decides; a mixed list stays as it is.
  for (let at = 0; at < value.length; at += Math.max(1, value.length >> 4)) {
    if (typeof value[at] !== "number") {
      return false;
    }
  }
  return typeof value[value.length - 1] === "number";
}

export function snapshotForExport(result: TAnalysisResult): TExportSnapshot {
  const typed: TExportSnapshot["typed"] = [];
  let bytes = 0;
  const seen = new Map<object, unknown>();
  const lists = new Map<object, Float64Array>();
  const copy = (value: unknown, path: (string | number)[]): unknown => {
    const raw = isProxy(value) ? toRaw(value) : value;
    if (raw === null || typeof raw !== "object") {
      return raw;
    }
    if (seen.has(raw)) {
      return seen.get(raw);
    }
    if (ArrayBuffer.isView(raw)) {
      const view = raw as unknown as { slice: () => ArrayBufferView };
      const owned = view.slice();
      bytes += owned.byteLength;
      seen.set(raw, owned);
      return owned;
    }
    if (Array.isArray(raw)) {
      if (raw.length >= TYPED_MIN_LENGTH && isNumberList(raw)) {
        // A list shared by several fields (one vertical axis) is copied once,
        // as the estimate counts it.
        const data = lists.get(raw) ?? Float64Array.from(raw as number[]);
        bytes += lists.has(raw) ? 0 : data.byteLength;
        lists.set(raw, data);
        typed.push({ path, data });
        return null; // restored from `typed` in the worker
      }
      const out: unknown[] = [];
      seen.set(raw, out);
      raw.forEach((item, at) => out.push(copy(item, [...path, at])));
      bytes += raw.length * 8;
      return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(raw, out);
    for (const [key, item] of Object.entries(raw)) {
      if (typeof item !== "function") {
        out[key] = copy(item, [...path, key]);
      }
    }
    return out;
  };
  return {
    result: copy(result, []) as TAnalysisResult,
    typed,
    bytes,
  };
}

/**
 * The bytes `snapshotForExport` would allocate, without allocating: an
 * export is admitted (or refused) before anything is copied.
 */
export function snapshotBytes(result: TAnalysisResult): number {
  let bytes = 0;
  const seen = new Set<object>();
  const walk = (value: unknown) => {
    const raw = isProxy(value) ? toRaw(value) : value;
    if (raw === null || typeof raw !== "object" || seen.has(raw)) {
      return;
    }
    seen.add(raw);
    if (ArrayBuffer.isView(raw)) {
      bytes += raw.byteLength;
    } else if (Array.isArray(raw)) {
      bytes += raw.length * 8;
      if (!(raw.length >= TYPED_MIN_LENGTH && isNumberList(raw))) {
        raw.forEach(walk);
      }
    } else {
      Object.values(raw).forEach(walk);
    }
  };
  walk(result);
  return bytes;
}

/** The result again, with its numeric lists restored (in the worker). */
export function restoreSnapshot(snapshot: TExportSnapshot): TAnalysisResult {
  const { result, typed } = snapshot;
  for (const { path, data } of typed) {
    let target = result as unknown as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) {
      target = target[key] as Record<string | number, unknown>;
    }
    target[path[path.length - 1]] = Array.from(data);
  }
  return result;
}

/** Buffers to transfer with a snapshot (owned by it alone). */
export function snapshotTransfer(snapshot: TExportSnapshot) {
  // Each once: a shared list's buffer serves several paths.
  return [
    ...new Set(snapshot.typed.map(({ data }) => data.buffer as ArrayBuffer)),
  ];
}
