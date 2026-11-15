/**
 * A least-recently-used cache bounded by bytes rather than entries. Entries
 * are recomputable (decoded chunks, index chunks), so eviction is always
 * safe; a single entry larger than the budget is never stored.
 */
export class ByteLru<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private usedBytes = 0;
  hits = 0;
  misses = 0;

  constructor(private maxBytes: number) {}

  get budget() {
    return this.maxBytes;
  }

  get bytes() {
    return this.usedBytes;
  }

  get size() {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, bytes: number) {
    this.delete(key);
    if (bytes > this.maxBytes) {
      return false;
    }
    this.entries.set(key, { value, bytes });
    this.usedBytes += bytes;
    this.evictTo(this.maxBytes);
    return true;
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.usedBytes -= entry.bytes;
    }
  }

  /** Evict least recently used entries until at most `bytes` remain. */
  evictTo(bytes: number) {
    for (const [key, entry] of this.entries) {
      if (this.usedBytes <= bytes) {
        break;
      }
      this.entries.delete(key);
      this.usedBytes -= entry.bytes;
    }
  }

  /** Delete the entries under a prefix (only those `matches` accepts). */
  deletePrefix(prefix: string, matches?: (value: T, key: string) => boolean) {
    for (const [key, entry] of [...this.entries]) {
      if (key.startsWith(prefix) && (!matches || matches(entry.value, key))) {
        this.delete(key);
      }
    }
  }

  clear() {
    this.entries.clear();
    this.usedBytes = 0;
  }
}
