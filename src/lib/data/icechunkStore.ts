import {
  HttpStorage,
  IcechunkStore,
  NotFoundError,
  type ByteRange,
  type RequestOptions,
  type Storage,
} from "icechunk-js";
import * as zarr from "zarrita";

import { askedRange, exactRange } from "@/lib/data/rangeResponse.ts";
import { storeRequests } from "@/lib/data/requestGate.ts";
import { SOURCE_TYPE_PREFIX } from "@/lib/data/sourceType.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";
import { splitXsrfToken, withXsrfToken } from "@/utils/xsrfToken.ts";

const ICECHUNK_PREFIX = SOURCE_TYPE_PREFIX[ZARR_FORMAT.ICECHUNK];

/**
 * Chunk reads of one backing object (a virtual chunk's NetCDF file, say)
 * that are issued together are merged into one range request when the gap
 * between them is at most this many bytes. Zarrita's default of 32 KB only
 * joins neighbouring chunks; a time step of a windowed level spans rows of
 * chunks with larger gaps, so a megabyte is allowed between them. The cost
 * is the gaps themselves: at worst, wanted chunks alternating with gaps of
 * just under a megabyte, about twice the bytes. Only reads of one object
 * merge; native chunks are objects of their own and never do. Nothing in
 * gridlook passes an abort signal to a chunk read today; should one be
 * added, zarrita merges the signals of a batch with AbortSignal.any (Chrome
 * 116, Safari 17.4, Firefox 124 and later) and one aborted read aborts the
 * merged request for the whole batch.
 */
const ICECHUNK_COALESCE_GAP_BYTES = 1 << 20;

type TIcechunkStore = zarr.AsyncReadable & Pick<IcechunkStore, "listNodes">;

function normalizeStorePath(store: string) {
  return store.replace(/\/+$/, "");
}

function toIcechunkStorePath(storeUrl: string) {
  return storeUrl.startsWith(ICECHUNK_PREFIX)
    ? storeUrl
    : `${ICECHUNK_PREFIX}${storeUrl}`;
}

export function parseStorePath(storePath: string): {
  backend: "fetch" | "icechunk";
  url: string;
} {
  const normalizedStorePath = normalizeStorePath(storePath);
  if (normalizedStorePath.startsWith(ICECHUNK_PREFIX)) {
    return {
      backend: "icechunk",
      url: normalizedStorePath.slice(ICECHUNK_PREFIX.length),
    };
  }
  return { backend: "fetch", url: normalizedStorePath };
}

export function isIcechunkStorePath(storePath: string) {
  if (normalizeStorePath(storePath).startsWith(ICECHUNK_PREFIX)) {
    return true;
  }
  return normalizeStorePath(storePath.split(/[?#]/)[0]).endsWith(".icechunk");
}

/**
 * `withXsrfToken` for a store path, including the `icechunk+<url>` form, whose
 * scheme would otherwise hide the URL's origin.
 */
export function withStoreXsrfToken(
  storePath: string,
  cookie: string,
  pageHref: string
): string {
  const { backend, url } = parseStorePath(storePath);
  return backend === "icechunk"
    ? `${ICECHUNK_PREFIX}${withXsrfToken(url, cookie, pageHref)}`
    : withXsrfToken(storePath, cookie, pageHref);
}

/**
 * Icechunk's objects and virtual chunks through this context's request gate, as
 * direct Zarr's are. A byte range of an HTTP object is read here, through the
 * same check as a reference's: one byte of a 4 MiB object from a server
 * ignoring Range read all 4 MiB, and a reply naming other bytes is refused.
 */
function gatedStorage(inner: Storage, http?: THttpObjects): Storage {
  // The storage itself beneath (its URL and options stay readable).
  return Object.assign(Object.create(inner) as Storage, {
    getObject: (path: string, range?: ByteRange, options?: RequestOptions) =>
      range && http
        ? rangeOf(http, path, range, options)
        : storeRequests.run(
            () => inner.getObject(path, range, options),
            options?.signal
          ),
    exists: (path: string, options?: RequestOptions) =>
      storeRequests.run(() => inner.exists(path, options), options?.signal),
  });
}

/** How the repository's objects are requested (as HttpStorage does). */
type THttpObjects = {
  url: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  cache?: RequestCache;
};

/** Bytes range.start..range.end-1 of an HTTP storage object. */
async function rangeOf(
  http: THttpObjects,
  path: string,
  range: ByteRange,
  options?: RequestOptions
) {
  const url = `${http.url.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  const response = await storeRequests.fetch(
    new Request(url, {
      headers: {
        ...http.headers,
        Range: `bytes=${range.start}-${range.end - 1}`,
      },
      credentials: http.credentials,
      cache: options?.cache ?? http.cache,
      signal: options?.signal,
    })
  );
  if (response.status === 404) {
    void response.body?.cancel().catch(() => undefined);
    throw new NotFoundError(path);
  }
  if (response.status !== 200 && response.status !== 206) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(
      `HTTP ${response.status} ${response.statusText} for ${url}`
    );
  }
  const exact = await exactRange(url, range.start, range.end - 1, response);
  return new Uint8Array(await exact.arrayBuffer());
}

export async function createIcechunkStore(
  storePath: string,
  /** Plots: objects past the browser cache (see referenceStore's fetchFresh). */
  { fresh = false }: { fresh?: boolean } = {}
): Promise<TIcechunkStore> {
  // icechunk-js joins paths onto the repo URL, so a Jupyter `_xsrf` token
  // can't stay in its query; it goes in a header instead. Virtual chunks are
  // fetched separately and don't get it.
  const { url, token } = splitXsrfToken(parseStorePath(storePath).url);
  const { headers, withCredentials } = ZarrDataManager.getRequestSettings();
  const http: THttpObjects = {
    url,
    headers: token
      ? { ...headers, "X-XSRFToken": decodeURIComponent(token) }
      : headers,
    credentials: withCredentials ? "include" : undefined,
    ...(fresh ? { cache: "no-store" as const } : {}),
  };
  return await IcechunkStore.open(
    gatedStorage(new HttpStorage(url, http), http),
    {
      fetchClient: {
        fetch: async (url: string, init?: RequestInit) => {
          const request = new Request(url, init);
          const response = await storeRequests.fetch(
            request,
            fresh ? { cache: "no-store" } : undefined
          );
          const range = askedRange(request.headers.get("Range"));
          return range
            ? exactRange(url, range.start, range.end, response)
            : response;
        },
      },
      withRangeCoalescing: (store, options) =>
        zarr.withRangeCoalescing(store, {
          ...options,
          coalesceSize: ICECHUNK_COALESCE_GAP_BYTES,
        }),
    }
  );
}

export async function createListableIcechunkStore(storePath: string) {
  const store = await createIcechunkStore(storePath);
  const contents = store.listNodes().map((node) => ({
    path: node.path as zarr.AbsolutePath,
    kind: node.nodeData.type,
  }));
  return Object.assign(store, { contents: () => contents });
}

export async function splitIcechunkStoreAndGroup(
  src: string,
  pageHref?: string
): Promise<{ storePath: string; groupPath: string }> {
  const rawUrl = src.startsWith(ICECHUNK_PREFIX)
    ? src.slice(ICECHUNK_PREFIX.length)
    : src;
  // Each parent is probed for a repo root, so a Jupyter `_xsrf` token is taken
  // off first and put back on each candidate; on a hub, a probe without it is
  // bounced into the OAuth flow. The walk climbs past the user's server to the
  // hub and the origin root, so a candidate gets the token back only where
  // `withXsrfToken` would add it, i.e. while it is under the page's Jupyter base.
  const { url, token } = splitXsrfToken(rawUrl);
  const withToken = (candidate: string) =>
    token
      ? withXsrfToken(
          candidate,
          `_xsrf=${decodeURIComponent(token)}`,
          pageHref ?? location.href
        )
      : candidate;
  // Walk the normalized URL, the one the base check sees: a raw `user/bob/..`
  // would otherwise be probed as `user/bob`.
  const normalizedUrl = normalizeStorePath(
    URL.canParse(url) ? new URL(url).href : url
  );
  const urlParts = normalizedUrl.split("/");
  let minSegments = urlParts.length;

  if (urlParts.length > 2 && urlParts[0].endsWith(":") && urlParts[1] === "") {
    minSegments = 3;
  }

  for (let i = urlParts.length; i >= minSegments; i--) {
    const storeUrl = urlParts.slice(0, i).join("/");
    const groupPath = urlParts.slice(i).join("/");
    const storePath = toIcechunkStorePath(withToken(storeUrl));
    try {
      await createIcechunkStore(storePath);
      return { storePath, groupPath };
    } catch {
      // Not an Icechunk repository root at this path; try the parent URL.
    }
  }

  return {
    storePath: toIcechunkStorePath(withToken(normalizedUrl)),
    groupPath: "",
  };
}
