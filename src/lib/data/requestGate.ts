/**
 * At most `limit` HTTP requests of one JavaScript context in flight, each held
 * until its body has arrived (or is cancelled). A map read of a whole GEFS
 * globe asked for 3,902 byte ranges at once; Chrome refused 2,520 of them and
 * then the plot's own worker script and chart files. Queued requests start in
 * order; one whose signal aborts while queued leaves without a request.
 */
export class RequestGate {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  /** How many requests are in flight now (for tests). */
  get inFlight() {
    return this.active;
  }

  async fetch(request: Request, init?: RequestInit): Promise<Response> {
    // fetch(request, init) obeys init's signal over the request's own.
    const signal = init?.signal ?? request.signal ?? undefined;
    await this.enter(signal);
    let response: Response;
    try {
      response = await fetch(request, init);
    } catch (error) {
      this.leave();
      throw error;
    }
    return this.streamed(response);
  }

  /**
   * The response as it arrives, its headers at once: a reader can refuse it by
   * its status or length and cancel its body. The request is held until its
   * body ends, fails or is cancelled; an error body is short and read here, so
   * a reader that never looks at it holds nothing.
   */
  // eslint-disable-next-line max-lines-per-function
  private async streamed(response: Response) {
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.leave();
      }
    };
    const body = response.body;
    if (!body || [204, 205, 304].includes(response.status)) {
      release();
      return response;
    }
    if (!response.ok) {
      try {
        const text = await readSome(body, ERROR_BODY_BYTES);
        return withUrl(
          new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }),
          response
        );
      } finally {
        release();
      }
    }
    const reader = body.getReader();
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              release();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            release();
            controller.error(error);
          }
        },
        cancel(reason) {
          release();
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 }
    );
    const out = withUrl(
      new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      response
    );
    // A body dropped unread gives its request back when the stream is
    // collected. The stream, not the response: a held body reader keeps the
    // stream alive after its response wrapper is gone.
    unread.register(stream, release);
    return out;
  }

  /**
   * A request made by a library that fetches on its own (Icechunk's
   * storage), held for as long as it runs: its whole object arrives within.
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.enter(signal);
    try {
      return await task();
    } finally {
      this.leave();
    }
  }

  private enter(signal?: AbortSignal) {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    signal?.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener("abort", abort);
        this.active++;
        resolve();
      };
      const abort = () => {
        const at = this.queue.indexOf(start);
        if (at >= 0) {
          this.queue.splice(at, 1);
        }
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(start);
    });
  }

  private leave() {
    this.active--;
    this.queue.shift()?.();
  }
}

/** What an error response keeps of its body (a message, not a payload). */
const ERROR_BODY_BYTES = 64 * 1024;

const unread = new FinalizationRegistry<() => void>((release) => release());

/** At most `limit` bytes of a body, the rest cancelled. */
async function readSome(body: ReadableStream<Uint8Array>, limit: number) {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parts.push(value.subarray(0, limit - size));
      size += Math.min(value.length, limit - size);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A rebuilt response names its request's URL, for errors that cite it. */
function withUrl(out: Response, from: Response) {
  if (from.url) {
    Object.defineProperty(out, "url", { value: from.url });
  }
  return out;
}

/**
 * The gate of this context's store requests. Browsers keep about six
 * connections per host over HTTP/1.1 and multiplex more over HTTP/2; 24 in
 * flight keeps either busy without piling thousands into the network stack.
 */
export const storeRequests = new RequestGate(24);
