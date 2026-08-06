import { IcechunkStore } from "icechunk-js";
import * as zarr from "zarrita";

const ICECHUNK_PREFIX = "icechunk+";

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

export async function createIcechunkStore(
  storePath: string
): Promise<TIcechunkStore> {
  return await IcechunkStore.open(parseStorePath(storePath).url);
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
  src: string
): Promise<{ storePath: string; groupPath: string }> {
  const rawUrl = src.startsWith(ICECHUNK_PREFIX)
    ? src.slice(ICECHUNK_PREFIX.length)
    : src;
  const normalizedUrl = normalizeStorePath(rawUrl);
  const urlParts = normalizedUrl.split("/");
  let minSegments = urlParts.length;

  if (urlParts.length > 2 && urlParts[0].endsWith(":") && urlParts[1] === "") {
    minSegments = 3;
  }

  for (let i = urlParts.length; i >= minSegments; i--) {
    const storeUrl = urlParts.slice(0, i).join("/");
    const groupPath = urlParts.slice(i).join("/");
    const storePath = toIcechunkStorePath(storeUrl);
    try {
      await createIcechunkStore(storePath);
      return { storePath, groupPath };
    } catch {
      // Not an Icechunk repository root at this path; try the parent URL.
    }
  }

  return {
    storePath: toIcechunkStorePath(normalizedUrl),
    groupPath: "",
  };
}
