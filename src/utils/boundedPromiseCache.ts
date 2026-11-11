/**
 * Promises by key, kept up to a total weight (cells, samples, bytes) with
 * the least recently used dropped first; the newest entry is kept even when
 * it exceeds the bound alone. A promise still in flight is shared, and a
 * rejected one is forgotten so that the next request computes again.
 */
type TEntry<TValue> = { promise: Promise<TValue>; weight: number };

function totalWeight<TKey, TValue>(entries: Map<TKey, TEntry<TValue>>) {
  let total = 0;
  for (const entry of entries.values()) {
    total += entry.weight;
  }
  return total;
}

function evictLeastRecent<TKey, TValue>(
  entries: Map<TKey, TEntry<TValue>>,
  bound: number
) {
  while (entries.size > 1 && totalWeight(entries) > bound) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    entries.delete(oldest);
  }
}

export function createBoundedPromiseCache<TKey, TValue>(maxWeight: number) {
  // Insertion order is the recency order: a hit re-inserts its entry.
  const entries = new Map<TKey, TEntry<TValue>>();
  let bound = maxWeight;

  function get(
    key: TKey,
    weight: number,
    compute: () => Promise<TValue>
  ): Promise<TValue> {
    const hit = entries.get(key);
    if (hit) {
      entries.delete(key);
      entries.set(key, hit);
      return hit.promise;
    }
    const promise = compute();
    entries.set(key, { promise, weight });
    promise.catch(() => {
      if (entries.get(key)?.promise === promise) {
        entries.delete(key);
      }
    });
    evictLeastRecent(entries, bound);
    return promise;
  }

  return {
    get,
    delete: (key: TKey) => entries.delete(key),
    clear: () => entries.clear(),
    /** Keys from least to most recently used. */
    keys: () => [...entries.keys()],
    setMaxWeight(weight = maxWeight) {
      bound = weight;
      evictLeastRecent(entries, bound);
    },
  };
}
