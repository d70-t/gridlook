/**
 * The bytes a byte-range request asked for, checked against what the server
 * says it sent. Shared by Kerchunk references and Icechunk objects.
 *
 * - HTTP 206 must cover exactly the asked bytes: a visible Content-Range naming
 *   other bytes, or a body of another length, is refused.
 * - HTTP 200 (a server that ignores Range) is read up to the asked end and
 *   cancelled, keeping only the asked bytes: the skipped prefix is dropped
 *   as it streams (two bytes near the end of an 8 MiB object allocated
 *   8 MiB). Such a read still transfers its prefix, so each file has a
 *   budget of skipped bytes per context; past it the read is refused,
 *   saying why, instead of multiplying the prefix across dates.
 */

/** The most of one object read through to reach a range. */
export const WHOLE_OBJECT_PREFIX = 64 * 2 ** 20;

/** Skipped bytes allowed per file in one context before reads are refused. */
export const SKIPPED_BYTES_PER_FILE = 256 * 2 ** 20;

const skipped = new Map<string, number>();

/** Adds `bytes` to a file's skipped tally; a zero balance keeps no entry. */
function charge(url: string, bytes: number) {
  const now = (skipped.get(url) ?? 0) + bytes;
  if (now > 0) {
    skipped.set(url, now);
  } else {
    skipped.delete(url);
  }
}

/** Forget the skipped-byte tallies (tests). */
export function resetSkippedBytes() {
  skipped.clear();
}

/** `bytes=a-b` of a request, or undefined for any other form. */
export function askedRange(header: string | null) {
  const range = /^bytes=(\d+)-(\d+)$/.exec(header ?? "");
  return range ? { start: Number(range[1]), end: Number(range[2]) } : undefined;
}

function cancel(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * `bytes a-b/size` of a response: undefined when the header is not there (or
 * not visible), "malformed" when it is there and says nothing usable.
 */
function sentRange(response: Response) {
  const header = response.headers.get("Content-Range");
  if (header === null) {
    return undefined;
  }
  const range = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  // An end past a known total cannot be the object's (bytes 0-1/1).
  if (
    !range ||
    Number(range[2]) < Number(range[1]) ||
    (range[3] !== "*" && Number(range[2]) >= Number(range[3]))
  ) {
    return "malformed" as const;
  }
  return {
    start: Number(range[1]),
    end: Number(range[2]),
    total: range[3] === "*" ? undefined : Number(range[3]),
  };
}

/** A declared body length, when visible. */
function declaredLength(response: Response) {
  const header = response.headers.get("Content-Length");
  const n = header === null ? Number.NaN : Number(header);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * The body checked as it streams: exactly `length` bytes, or an error the
 * moment it runs past them or ends short. Nothing is copied whole here: the
 * reader gets the chunks as they arrive.
 */
function checkedBody(
  body: ReadableStream<Uint8Array>,
  length: number,
  what: () => string,
  /** `length` is a limit, not the size. */
  atMost = false
) {
  const reader = body.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            if (seen !== length && !atMost) {
              controller.error(new Error(`${what()} with ${seen} bytes.`));
            } else {
              controller.close();
            }
            return;
          }
          seen += value.byteLength;
          if (seen > length) {
            void reader.cancel().catch(() => undefined);
            controller.error(
              new Error(`${what()} with more than ${length} bytes.`)
            );
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
}

/** A checked 206 for bytes start..end, its body streamed through. */
function partial(url: string, start: number, end: number, response: Response) {
  const sent = sentRange(response);
  const asked = `${url} answered a request for bytes ${start}–${end}`;
  if (sent === "malformed") {
    cancel(response);
    throw new Error(
      `${asked} with an unreadable Content-Range (${response.headers.get("Content-Range")}).`
    );
  }
  if (sent && (sent.start !== start || sent.end !== end)) {
    cancel(response);
    throw new Error(`${asked} with bytes ${sent.start}–${sent.end}.`);
  }
  const length = end - start + 1;
  // A declared length that is not the range's: refused before any byte.
  const declared = declaredLength(response);
  if (declared !== undefined && declared !== length) {
    cancel(response);
    throw new Error(`${asked} with ${declared} bytes declared.`);
  }
  if (!response.body) {
    if (length === 0) {
      return asPartial(new Uint8Array(0), start, end);
    }
    throw new Error(`${asked} with no body.`);
  }
  return new Response(
    checkedBody(response.body, length, () => asked),
    {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/*` },
    }
  );
}

/** Bytes start..end of a whole-object body, the rest dropped as it streams. */
async function cut(
  body: ReadableStream<Uint8Array>,
  start: number,
  end: number,
  /** Bytes taken so far, kept current if the stream fails part way. */
  progress: { read: number }
) {
  const reader = body.getReader();
  const out = new Uint8Array(end - start + 1);
  let at = 0;
  let filled = 0;
  try {
    while (at <= end) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const from = Math.max(start - at, 0);
      const to = Math.min(value.length, end + 1 - at);
      if (to > from) {
        out.set(value.subarray(from, to), at + from - start);
        filled += to - from;
      }
      at += value.length;
      progress.read = Math.min(at, end + 1);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return { out, filled, read: Math.min(at, end + 1) };
}

/**
 * The asked bytes start..end (inclusive) of `response`, as a 206 response,
 * or an error naming the file and what it sent.
 */
export async function exactRange(
  url: string,
  start: number,
  end: number,
  response: Response
): Promise<Response> {
  if (response.status === 206) {
    return partial(url, start, end, response);
  }
  if (response.status !== 200) {
    return response;
  }
  const whole = `${url} answered bytes ${start}–${end} with HTTP 200 (the whole file)`;
  if (end + 1 > WHOLE_OBJECT_PREFIX || !response.body) {
    cancel(response);
    throw new Error(
      `${whole}; reading ${end + 1} bytes of it to find the range is more than ${WHOLE_OBJECT_PREFIX} allowed.`
    );
  }
  // The prefix reserved before the body is awaited: reads at once share the
  // file's budget.
  const before = skipped.get(url) ?? 0;
  if (before + start > SKIPPED_BYTES_PER_FILE) {
    cancel(response);
    throw new Error(
      `${whole}; this file's server ignores range requests, and its reads have already skipped ${before} bytes to reach their ranges (at most ${SKIPPED_BYTES_PER_FILE}).`
    );
  }
  charge(url, start);
  // What a failed or cancelled read took counts too.
  const progress = { read: 0 };
  try {
    const cutOut = await cut(response.body, start, end, progress);
    if (cutOut.filled < cutOut.out.length) {
      throw new Error(`${whole} and only ${cutOut.read} bytes.`);
    }
    return asPartial(cutOut.out, start, end);
  } finally {
    charge(url, Math.min(start, progress.read) - start);
  }
}

/**
 * The last `n` bytes of `response` to a suffix request (`bytes=-n`),
 * checked: a 206 must name the end of the object and as many bytes as it
 * has up to `n`; a 200 is the whole object, its end kept.
 */
export async function exactSuffix(
  url: string,
  n: number,
  response: Response
): Promise<Response> {
  const asked = `${url} answered a request for its last ${n} bytes`;
  if (response.status === 206) {
    const sent = sentRange(response);
    // A header not visible (CORS): the body, at most the bytes asked.
    if (sent === undefined && response.body) {
      return new Response(
        checkedBody(response.body, n, () => asked, true),
        { status: 206 }
      );
    }
    if (sent === "malformed" || !sent) {
      cancel(response);
      throw new Error(
        `${asked} with an unreadable Content-Range (${response.headers.get("Content-Range")}).`
      );
    }
    // Size unspecified (`bytes 2-37/*`, RFC 9110): its end cannot be
    // checked, its length can (a shard index checks its own bytes).
    if (sent.total === undefined) {
      if (sent.end - sent.start + 1 > n) {
        cancel(response);
        throw new Error(`${asked} with bytes ${sent.start}–${sent.end}.`);
      }
      return partial(url, sent.start, sent.end, response);
    }
    if (
      sent.end !== sent.total - 1 ||
      sent.end - sent.start + 1 !== Math.min(n, sent.total)
    ) {
      cancel(response);
      throw new Error(
        `${asked} with bytes ${sent.start}–${sent.end} of ${sent.total}.`
      );
    }
    return partial(url, sent.start, sent.end, response);
  }
  if (response.status !== 200 || !response.body) {
    return response;
  }
  return lastBytes(url, n, response, asked);
}

/**
 * The last `n` bytes of a whole-object reply, kept in a ring as the body
 * streams: never more than `n` bytes (nor more than the object) in memory, each
 * block copied in at most two pieces, and what passes is charged to the file's
 * skipped tally.
 */
async function lastBytes(
  url: string,
  n: number,
  response: Response,
  asked: string
) {
  // Under a content coding (gzip) the length is the coded body's: the
  // decoded object's is known only as it streams.
  const coding = response.headers.get("Content-Encoding")?.trim().toLowerCase();
  const declared =
    coding && coding !== "identity" ? undefined : declaredLength(response);
  if (declared !== undefined) {
    return streamedTail(url, n, response, asked, declared);
  }
  // Of unknown size, charged as it streams: one at a time per file, so the
  // allowance is spent on reads that finish, not shared out among readers
  // that all run out.
  const previous = unsizedReads.get(url) ?? Promise.resolve();
  const turn = previous.then(() =>
    streamedTail(url, n, response, asked, undefined)
  );
  const settled = turn.then(
    () => undefined,
    () => undefined
  );
  unsizedReads.set(url, settled);
  void settled.then(() => {
    if (unsizedReads.get(url) === settled) {
      unsizedReads.delete(url);
    }
    return undefined;
  });
  return turn;
}

/** Per file, the last whole-file suffix of unknown size being read. */
const unsizedReads = new Map<string, Promise<void>>();

// eslint-disable-next-line max-lines-per-function
async function streamedTail(
  url: string,
  n: number,
  response: Response,
  asked: string,
  declared: number | undefined
) {
  const whole = `${asked} with HTTP 200 (the whole file`;
  if (declared !== undefined && declared > WHOLE_OBJECT_PREFIX) {
    cancel(response);
    throw new Error(`${whole}, ${declared} bytes).`);
  }
  // Reserved before the body is taken: reads at once cannot each pass on
  // the same balance. An unknown size is charged as it streams.
  const before = skipped.get(url) ?? 0;
  const reserved = declared === undefined ? 0 : Math.max(0, declared - n);
  if (before + reserved > SKIPPED_BYTES_PER_FILE) {
    cancel(response);
    throw new Error(
      `${whole}); this file's server ignores range requests, and its reads have already skipped ${before} bytes (at most ${SKIPPED_BYTES_PER_FILE}).`
    );
  }
  charge(url, reserved);
  let charged = reserved;
  const ring = suffixRing(Math.min(n, declared ?? n));
  const reader = response.body!.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > WHOLE_OBJECT_PREFIX) {
        throw new Error(`${whole}, past ${WHOLE_OBJECT_PREFIX} bytes).`);
      }
      ring.add(value);
      const due = Math.max(0, total - n) - charged;
      if (declared === undefined && due > 0) {
        charge(url, due);
        charged += due;
        if ((skipped.get(url) ?? 0) > SKIPPED_BYTES_PER_FILE) {
          throw new Error(
            `${whole}); this file's server ignores range requests, and its reads have skipped more than ${SKIPPED_BYTES_PER_FILE} bytes.`
          );
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    // What was skipped in the end: a shorter body gives back the rest.
    charge(url, Math.max(0, total - n) - charged);
  }
  const out = ring.last(Math.min(n, total));
  const kept = out.length;
  return new Response(out, {
    status: 206,
    headers: {
      "Content-Range": `bytes ${total - kept}-${total - 1}/${total}`,
    },
  });
}

/**
 * The last `size` bytes added, in a buffer grown by doubling (a short body
 * holds only itself) and then written round: each block in at most two copies.
 */
function suffixRing(size: number) {
  let buffer = new Uint8Array(Math.min(Math.max(1, size), 64 * 2 ** 10));
  let end = 0;
  let filled = 0;
  return {
    add(block: Uint8Array) {
      const keep = block.subarray(Math.max(0, block.length - size));
      // Grown while the body is still shorter than the ring will be.
      if (buffer.length < size && filled + keep.length > buffer.length) {
        const grown = new Uint8Array(
          Math.min(size, Math.max(2 * buffer.length, filled + keep.length))
        );
        grown.set(this.last(filled));
        [buffer, end] = [grown, filled % grown.length];
      }
      const first = Math.min(keep.length, buffer.length - end);
      buffer.set(keep.subarray(0, first), end);
      buffer.set(keep.subarray(first), 0);
      end = (end + keep.length) % buffer.length;
      filled = Math.min(buffer.length, filled + keep.length);
    },
    /** The last `k` bytes added (at most what is held), as a new array. */
    last(k: number) {
      const count = Math.min(k, filled);
      const out = new Uint8Array(count);
      const start = (end - count + buffer.length) % buffer.length;
      const first = Math.min(count, buffer.length - start);
      out.set(buffer.subarray(start, start + first));
      out.set(buffer.subarray(0, count - first), first);
      return out;
    },
  };
}

/**
 * `response` with its body limited to `limit` bytes as it streams: past them
 * the read fails at once, before the rest is taken.
 */
export function limitedResponse(
  response: Response,
  limit: number,
  what: () => string
) {
  if (!response.body) {
    return response;
  }
  return new Response(checkedBody(response.body, limit, what, true), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function asPartial(bytes: Uint8Array<ArrayBuffer>, start: number, end: number) {
  return new Response(bytes, {
    status: 206,
    headers: { "Content-Range": `bytes ${start}-${end}/*` },
  });
}

/**
 * A store fetch's response checked against its own Range header: an explicit
 * range exactly, a suffix as the object's end; others as sent.
 */
export async function checkedRange(
  request: Request,
  pending: Promise<Response>
) {
  const response = await pending;
  // Only partial replies are checked here: the reader's own handling of a
  // whole-object 200 stays as it was.
  if (response.status !== 206) {
    return response;
  }
  const header = request.headers.get("Range");
  const range = askedRange(header);
  if (range) {
    return exactRange(request.url, range.start, range.end, response);
  }
  const suffix = /^bytes=-(\d+)$/.exec(header ?? "");
  return suffix
    ? exactSuffix(request.url, Number(suffix[1]), response)
    : response;
}
