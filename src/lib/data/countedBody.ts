/**
 * `response` with each body chunk counted by `add` as it is read: what a
 * reader consumed, so a cancelled body counts only what arrived.
 */
export function countedBody(
  response: Response,
  add: (bytes: number) => void
): Response {
  if (!response.body) {
    return response;
  }
  const reader = response.body.getReader();
  // A body that arrives longer than its declared length was decoded on the way
  // (HTTP gzip): its transfer is at most the declared length, not what came out
  // of the decoder.
  const header = response.headers.get("Content-Length");
  const declared = header === null ? Number.NaN : Number(header);
  let seen = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
          } else {
            // Never more than declared: a decoded body's extra is not sent.
            const cap = Number.isSafeInteger(declared) ? declared : Infinity;
            const before = Math.min(seen, cap);
            seen += value.byteLength;
            add(Math.min(seen, cap) - before);
            controller.enqueue(value);
          }
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
  const out = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  if (response.url) {
    Object.defineProperty(out, "url", { value: response.url });
  }
  return out;
}
