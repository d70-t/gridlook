import { ReferenceStore } from "@zarrita/storage";
import type * as zarr from "zarrita";

/**
 * Kerchunk reference files (https://fsspec.github.io/kerchunk/spec.html),
 * opened as `reference+<URL of the .json>[/<group>]`. The keys can be Zarr v2
 * or v3 metadata and chunk keys; inline values are served from memory and
 * the others are fetched as a byte range of the referenced URL.
 */
const REFERENCE_PREFIX = "reference+";
const REFERENCE_SUFFIX = ".json";
const ZARR_JSON = "zarr.json";

// a string (inline) or [url, offset, length]; url null = the target file
type TReference = string | (string | number | null)[];
type TReferenceSpec = {
  version?: number;
  templates?: Record<string, string>;
  gen?: unknown[];
  refs?: Record<string, TReference>;
  [key: string]: unknown;
};
type TContents = {
  path: zarr.AbsolutePath;
  kind: "array" | "group";
}[];
type TReferenceStore = ReferenceStore & {
  contents: () => TContents;
  zarrFormat: 2 | 3;
};

const stores = new Map<string, Promise<TReferenceStore>>();

export function isReferenceStorePath(storePath: string) {
  return storePath.startsWith(REFERENCE_PREFIX);
}

/** Split `reference+<url>.json/<group>` into the store path and the group. */
export function splitReferenceStoreAndGroup(src: string) {
  const end = src.indexOf(REFERENCE_SUFFIX);
  if (!isReferenceStorePath(src) || end === -1) {
    return { storePath: src, groupPath: "" };
  }
  const storeEnd = end + REFERENCE_SUFFIX.length;
  return {
    storePath: src.slice(0, storeEnd),
    groupPath: src.slice(storeEnd).replace(/^\/+/, "").replace(/\/+$/, ""),
  };
}

function refsOf(spec: TReferenceSpec): Record<string, TReference> {
  return spec.version === 1
    ? (spec.refs ?? {})
    : (spec as Record<string, TReference>);
}

const TEMPLATE = /{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g;

/**
 * Substitute plain `{{name}}` templates in the URLs. The generic template
 * renderer of reference-spec-reader takes seconds for 1e5-1e6 references;
 * a string replacement takes a fraction of that. Specs with `gen` entries,
 * or with templates this does not resolve, are left to the library.
 */
export function expandTemplates(spec: TReferenceSpec): TReferenceSpec {
  const templates = spec.templates;
  if (spec.version !== 1 || !templates || spec.gen?.length) {
    return spec;
  }
  const refs: Record<string, TReference> = {};
  for (const [key, ref] of Object.entries(spec.refs ?? {})) {
    if (
      Array.isArray(ref) &&
      typeof ref[0] === "string" &&
      ref[0].includes("{{")
    ) {
      const url = ref[0].replace(TEMPLATE, (match, name: string) =>
        name in templates ? templates[name] : match
      );
      if (url.includes("{{")) {
        return spec;
      }
      refs[key] = [url, ...ref.slice(1)];
    } else {
      refs[key] = ref;
    }
  }
  return { version: 1, refs };
}

const NODE_KEYS: Record<string, "array" | "group" | undefined> = {
  ".zarray": "array",
  ".zgroup": "group",
};

function nodeOf(key: string, value: TReference) {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const path = ("/" + key.slice(0, -name.length)).replace(/\/$/, "");
  if (name in NODE_KEYS) {
    return { path, kind: NODE_KEYS[name], zarrFormat: 2 as const };
  }
  if (name !== ZARR_JSON) {
    return null;
  }
  if (typeof value !== "string" || value.startsWith("base64:")) {
    return null;
  }
  try {
    const kind = JSON.parse(value).node_type;
    return { path, kind, zarrFormat: 3 as const };
  } catch {
    return null;
  }
}

/**
 * The groups and arrays of a reference file, from its inline metadata, and
 * its Zarr format (that of the root node, else of the first node).
 */
export function referenceContents(spec: TReferenceSpec): {
  contents: TContents;
  zarrFormat: 2 | 3;
} {
  const contents: TContents = [];
  let zarrFormat: 2 | 3 | undefined;
  for (const [key, value] of Object.entries(refsOf(spec))) {
    const node = nodeOf(key, value);
    if (!node || (node.kind !== "array" && node.kind !== "group")) {
      continue;
    }
    const path = (node.path || "/") as zarr.AbsolutePath;
    if (path === "/" || zarrFormat === undefined) {
      zarrFormat = node.zarrFormat;
    }
    contents.push({ path, kind: node.kind });
  }
  return { contents, zarrFormat: zarrFormat ?? 3 };
}

/** One download and parse of a reference file per URL. */
export function createReferenceStore(
  storePath: string
): Promise<TReferenceStore> {
  const url = splitReferenceStoreAndGroup(storePath).storePath.slice(
    REFERENCE_PREFIX.length
  );
  let store = stores.get(url);
  if (!store) {
    store = (async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Could not read the reference file ${url}: ${response.status}`
        );
      }
      const spec = expandTemplates(await response.json());
      const { contents, zarrFormat } = referenceContents(spec);
      const refStore = ReferenceStore.fromSpec(spec) as ReferenceStore;
      return Object.assign(refStore, { contents: () => contents, zarrFormat });
    })();
    store.catch(() => stores.delete(url));
    stores.set(url, store);
  }
  return store;
}
