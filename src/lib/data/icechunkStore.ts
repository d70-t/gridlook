import { HttpStorage, IcechunkStore } from "icechunk-js";
import * as zarr from "zarrita";

import { SOURCE_TYPE_PREFIX } from "@/lib/data/sourceType.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";
import { splitXsrfToken, withXsrfToken } from "@/utils/xsrfToken.ts";

const ICECHUNK_PREFIX = SOURCE_TYPE_PREFIX[ZARR_FORMAT.ICECHUNK];

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

export async function createIcechunkStore(
  storePath: string
): Promise<TIcechunkStore> {
  // icechunk-js joins paths onto the repo URL, so a Jupyter `_xsrf` token
  // can't stay in its query; it goes in a header instead. Virtual chunks are
  // fetched separately and don't get it.
  const { url, token } = splitXsrfToken(parseStorePath(storePath).url);
  const { headers, withCredentials } = ZarrDataManager.getRequestSettings();
  return await IcechunkStore.open(
    new HttpStorage(url, {
      headers: token
        ? { ...headers, "X-XSRFToken": decodeURIComponent(token) }
        : headers,
      credentials: withCredentials ? "include" : undefined,
    })
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
