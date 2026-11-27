import { ReferenceStore } from "@zarrita/storage";
import type * as zarr from "zarrita";

import {
  askedRange,
  exactRange,
  exactSuffix,
  limitedResponse,
  WHOLE_OBJECT_PREFIX,
} from "./rangeResponse.ts";
import { storeRequests } from "./requestGate.ts";

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
  const generated = spec.version === 1 ? expandGen(spec) : spec;
  if (generated !== spec) {
    return expandTemplates(generated);
  }
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

type TGen = {
  key: string;
  url: string;
  offset?: string | number;
  length?: string | number;
  dimensions: Record<
    string,
    number[] | { start?: number; stop: number; step?: number }
  >;
};

/**
 * Version-1 `gen` entries as refs, where every template is a plain `{{ name }}`
 * (a dimension or a template); else the spec as it is, left to the library.
 * Generated `[url]` entries then read as whole objects.
 */
// eslint-disable-next-line max-lines-per-function
function expandGen(spec: TReferenceSpec): TReferenceSpec {
  if (!spec.gen?.length) {
    return spec;
  }
  const refs: Record<string, TReference> = { ...(spec.refs ?? {}) };
  for (const raw of spec.gen as TGen[]) {
    const names = Object.keys(raw.dimensions ?? {});
    const values = names.map((name) => {
      const d = raw.dimensions[name];
      if (Array.isArray(d)) {
        return d;
      }
      // Python's range(start, stop, step), descending too; a zero step
      // names nothing.
      const out: number[] = [];
      const step = d.step ?? 1;
      const more = (v: number) => (step > 0 ? v < d.stop : v > d.stop);
      for (
        let v = d.start ?? 0;
        step && more(v) && out.length <= 1e6;
        v += step
      ) {
        out.push(v);
      }
      return out;
    });
    const count = values.reduce((p, v) => p * v.length, 1);
    if (!names.length || count > 1e6) {
      return spec;
    }
    for (let at = 0; at < count; at++) {
      const scope: Record<string, string> = { ...(spec.templates ?? {}) };
      let rest = at;
      for (let d = names.length - 1; d >= 0; d--) {
        scope[names[d]] = String(values[d][rest % values[d].length]);
        rest = Math.floor(rest / values[d].length);
      }
      const fill = (text: string | number | undefined) => {
        const out = String(text ?? "").replace(
          TEMPLATE,
          (match, name: string) => (name in scope ? scope[name] : match)
        );
        return out.includes("{{") ? undefined : out;
      };
      const [key, url] = [fill(raw.key), fill(raw.url)];
      const [offset, length] = [fill(raw.offset), fill(raw.length)];
      if (
        key === undefined ||
        url === undefined ||
        offset === undefined ||
        length === undefined
      ) {
        return spec;
      }
      refs[key] =
        raw.offset === undefined && raw.length === undefined
          ? [url]
          : [url, Number(offset), Number(length)];
    }
  }
  return {
    version: 1,
    refs,
    ...(spec.templates ? { templates: spec.templates } : {}),
  };
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

// Plots fetch referenced byte ranges past the browser cache, as the map does
// otherwise (`s3://` and `gc://` translated): a plot's read of a file the
// map is also reading would wait for the map's whole queue on its cache
// entry.

/**
 * A referenced byte range, through this context's request gate. `whole` holds
 * this store's `[url]` references.
 */
async function fetchReferenced(
  request: Request,
  whole: Set<string>,
  init?: RequestInit
) {
  const href = ReferenceStore.resolveUri(request.url);
  let asked = href === request.url ? request : new Request(href, request);
  const range = askedRange(asked.headers.get("Range"));
  const wholeRef =
    range?.end === WHOLE_OBJECT - 1 && whole.has(normalized(href));
  // A HEAD of a reference (a shard's index is at its end): its length is the
  // reference's own, not the object's, and nothing is fetched for it. A `[url]`
  // one asks the object's.
  if (asked.method === "HEAD") {
    if (range && !wholeRef) {
      return new Response(null, {
        status: 200,
        headers: { "Content-Length": String(range.end - range.start + 1) },
      });
    }
    asked = new Request(asked);
    asked.headers.delete("Range");
    // A store without HEAD (405) or without a length: no length given, so the
    // reader asks for the suffix by GET.
    const head = await storeRequests.fetch(asked, init);
    if (!head.ok || head.headers.get("Content-Length") === null) {
      void head.body?.cancel().catch(() => undefined);
      return new Response(null, { status: 200 });
    }
    return head;
  }
  if (range && wholeRef) {
    asked = new Request(asked);
    if (range.start > 0) {
      // A suffix of a `[url]` object of unknown length: asked as one.
      const n = WHOLE_OBJECT - range.start;
      asked.headers.set("Range", `bytes=-${n}`);
      return exactSuffix(href, n, await storeRequests.fetch(asked, init));
    }
    // A `[url]` reference: the whole object (kerchunk spec), bounded.
    asked.headers.delete("Range");
    return wholeObject(href, await storeRequests.fetch(asked, init));
  }
  const response = await storeRequests.fetch(asked, init);
  return range ? exactRange(href, range.start, range.end, response) : response;
}

/**
 * The length given to a `[url]` reference: the library asks for a range, so a
 * whole-object reference names one past any object it would read.
 */
const WHOLE_OBJECT = 2 ** 52;

function wholeObject(url: string, response: Response) {
  if (!response.ok) {
    return response;
  }
  const length = Number(response.headers.get("Content-Length") ?? Number.NaN);
  if (length > WHOLE_OBJECT_PREFIX) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(
      `${url} is referenced whole and is ${length} bytes, more than ${WHOLE_OBJECT_PREFIX} read for one chunk.`
    );
  }
  // Limited as it streams, its size declared or not.
  return limitedResponse(
    new Response(response.body, { status: 200, headers: response.headers }),
    WHOLE_OBJECT_PREFIX,
    () => `${url} is referenced whole and`
  );
}

/** A URL as a request names it (dot segments resolved). */
function normalized(url: string) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** `[url]` references as a range the library can compose. */
function withWholeObjects(
  spec: TReferenceSpec,
  wholeObjects: Set<string>
): TReferenceSpec {
  const refs = refsOf(spec);
  let changed: Record<string, TReference> | undefined;
  for (const [key, ref] of Object.entries(refs)) {
    if (Array.isArray(ref) && ref.length === 1 && typeof ref[0] === "string") {
      changed ??= { ...refs };
      changed[key] = [ref[0], 0, WHOLE_OBJECT];
      // As the fetch names it (`a/../0.bin` is `0.bin`).
      wholeObjects.add(normalized(ReferenceStore.resolveUri(ref[0])));
    }
  }
  if (!changed) {
    return spec;
  }
  return spec.version === 1 ? { ...spec, refs: changed } : changed;
}

/**
 * One download and parse of a reference file per URL. `fresh` (plots): the
 * manifest is read again on every open, past the browser cache, and so are its
 * byte ranges.
 */
export function createReferenceStore(
  storePath: string,
  { fresh = false }: { fresh?: boolean } = {}
): Promise<TReferenceStore> {
  const url = splitReferenceStoreAndGroup(storePath).storePath.slice(
    REFERENCE_PREFIX.length
  );
  let store = fresh ? undefined : stores.get(url);
  if (!store) {
    store = (async () => {
      const response = await fetch(
        url,
        fresh ? { cache: "no-store" } : undefined
      );
      if (!response.ok) {
        throw new Error(
          `Could not read the reference file ${url}: ${response.status}`
        );
      }
      const whole = new Set<string>();
      const spec = withWholeObjects(
        expandTemplates(await response.json()),
        whole
      );
      const { contents, zarrFormat } = referenceContents(spec);
      const refStore = ReferenceStore.fromSpec(spec, {
        fetch: fresh
          ? (request) => fetchReferenced(request, whole, { cache: "no-store" })
          : (request) => fetchReferenced(request, whole),
      }) as ReferenceStore;
      return Object.assign(refStore, { contents: () => contents, zarrFormat });
    })();
    if (!fresh) {
      store.catch(() => stores.delete(url));
      stores.set(url, store);
    }
  }
  return store;
}
