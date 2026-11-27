import { raceAbort, throwIfAborted } from "./chunkVisitor.ts";

type TEntry = {
  promise: Promise<unknown>;
  controller: AbortController;
  users: number;
  settled: boolean;
  bytes: number;
};

/**
 * Reads shared by everyone who needs the same decoded values (a time axis
 * and its bounds for six variables, mesh topology for three views), also
 * while they are running. A read stops only when every waiter that can be
 * cancelled has been; a waiter without a signal keeps it going. Finished
 * values stay within `budget` bytes (one value at most a quarter of it);
 * callers copy what they change.
 */
export class SharedReads {
  private readonly entries = new Map<string, TEntry>();
  /** Decoded bytes of the reads running now, and those waiting to. */
  private running = 0;
  private readonly waiting: { bytes: number; go: () => void }[] = [];

  constructor(
    private readonly budget: number,
    /**
     * Decoded bytes read at once, by every source together: six variables
     * each describing a 128 MiB bounds array run two at a time, not six
     * (768 MiB). A read larger than this runs alone.
     */
    private readonly inFlight = Number.POSITIVE_INFINITY
  ) {}

  /** The release of `bytes` counted as running. */
  private releaser(bytes: number) {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.running -= bytes;
      // Start the waiting reads that now fit, in order.
      while (this.waiting.length) {
        const next = this.waiting[0];
        if (this.running > 0 && this.running + next.bytes > this.inFlight) {
          break;
        }
        this.waiting.shift();
        this.running += next.bytes;
        next.go();
      }
    };
  }

  /**
   * `read`, at once when its bytes fit beside the reads running (or none
   * runs), else when a release makes room; a waiter that is aborted leaves
   * the queue unread.
   */
  private limited<T>(
    bytes: number,
    read: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    const run = async () => {
      const release = this.releaser(bytes);
      try {
        return await read(signal);
      } finally {
        release();
      }
    };
    if (
      bytes === 0 ||
      this.running === 0 ||
      this.running + bytes <= this.inFlight
    ) {
      this.running += bytes;
      return run();
    }
    return new Promise<void>((resolve, reject) => {
      // Woken by a release, which counts these bytes as running.
      const waiter = { bytes, go: resolve };
      this.waiting.push(waiter);
      signal.addEventListener(
        "abort",
        () => {
          const at = this.waiting.indexOf(waiter);
          if (at >= 0) {
            this.waiting.splice(at, 1);
            reject(signal.reason);
          }
        },
        { once: true }
      );
    }).then(run);
  }

  async share<T>(
    key: string,
    bytes: number,
    read: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    /**
     * Bytes counted as read at once: none for a read whose own pieces are
     * shared and counted.
     */
    reserve = bytes
  ): Promise<T> {
    throwIfAborted(signal);
    let entry = this.entries.get(key);
    let begin: (() => void) | undefined;
    if (!entry || entry.controller.signal.aborted) {
      ({ created: entry, begin } = this.start(key, bytes, read, reserve));
    } else {
      // Most recently used last.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    const mine = entry;
    mine.users += signal ? 1 : Number.POSITIVE_INFINITY;
    const leave = () => {
      if (--mine.users <= 0 && !mine.settled) {
        mine.controller.abort(signal?.reason);
        this.forget(key, mine);
      }
    };
    signal?.addEventListener("abort", leave, { once: true });
    // Read only once its first reader is counted and listened to: a stop inside
    // its first request stops it.
    begin?.();
    try {
      return (await raceAbort(mine.promise, signal)) as T;
    } finally {
      signal?.removeEventListener("abort", leave);
    }
  }

  /**
   * A finished value revised in its place by `update` (a few of its steps
   * read again), which readers meanwhile wait for. One still being read,
   * or a revision that fails, is let go: the next reader reads it whole.
   */
  revise<T>(
    key: string,
    update: (value: T, signal: AbortSignal) => Promise<T>,
    /** Its owner gone (a released source): the revision stops reading. */
    stop?: AbortSignal
  ): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || !entry.settled) {
      this.entries.delete(key);
      return Promise.resolve();
    }
    const controller = new AbortController();
    const signal = stop
      ? AbortSignal.any([controller.signal, stop])
      : controller.signal;
    const revised: TEntry = {
      promise: entry.promise.then((value) => update(value as T, signal)),
      controller,
      users: 0,
      settled: false,
      bytes: entry.bytes,
    };
    this.entries.set(key, revised);
    return revised.promise.then(
      () => {
        revised.settled = true;
        return undefined;
      },
      () => {
        revised.settled = true;
        this.forget(key, revised);
      }
    );
  }

  /** Let finished values under a key prefix go (they may have changed). */
  forgetPrefix(prefix: string) {
    for (const [key, entry] of [...this.entries]) {
      if (entry.settled && key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Its source released: every value under a key prefix goes, running ones too,
   * which finish for their waiters but are not kept.
   */
  release(prefix: string) {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  /** Whether finished values under a key prefix (ending in `|`) are kept. */
  holdsUnder(prefix: string) {
    for (const [key, entry] of this.entries) {
      if (entry.settled && key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether a finished value under `key` is kept: the key itself, or keys below
   * it after a `|` (a matrix kept chunk by chunk). Not any key that merely
   * starts with it.
   */
  holds(key: string) {
    if (this.entries.get(key)?.settled) {
      return true;
    }
    const below = `${key}|`;
    for (const [other, entry] of this.entries) {
      if (entry.settled && other.startsWith(below)) {
        return true;
      }
    }
    return false;
  }

  private start<T>(
    key: string,
    bytes: number,
    read: (signal: AbortSignal) => Promise<T>,
    reserve: number
  ) {
    const controller = new AbortController();
    // Begun by share once its first reader is counted, synchronously.
    let begin!: () => void;
    const promise = new Promise<T>((resolve, reject) => {
      begin = () =>
        this.limited(reserve, read, controller.signal).then(resolve, reject);
    });
    const created: TEntry = {
      promise,
      controller,
      users: 0,
      settled: false,
      bytes,
    };
    void created.promise.then(
      () => {
        created.settled = true;
        if (bytes > this.budget / 4) {
          this.forget(key, created);
        }
        // Reads that ran together may settle over the budget: trim again,
        // oldest first, now that they can be let go.
        this.trim(key);
        return undefined;
      },
      () => {
        created.settled = true;
        this.forget(key, created);
      }
    );
    this.entries.set(key, created);
    this.trim(key);
    return { created, begin };
  }

  private forget(key: string, entry: TEntry) {
    if (this.entries.get(key) === entry) {
      this.entries.delete(key);
    }
  }

  private trim(keep: string) {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.bytes;
    }
    for (const [key, entry] of this.entries) {
      if (total <= this.budget) {
        break;
      }
      if (key !== keep && entry.settled) {
        this.entries.delete(key);
        total -= entry.bytes;
      }
    }
  }
}
