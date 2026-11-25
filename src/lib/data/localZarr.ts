import type * as zarr from "zarrita";

const LOCAL_ZARR_PREFIX = "zarr://local/";

// Gridlook reads consolidated stores only; `.zgroup`/`.zarray` still mark a
// Zarr v2 root, so such a store fails later with a precise error instead.
const ROOT_METADATA_FILES = new Set([
  ".zmetadata",
  ".zgroup",
  ".zarray",
  "zarr.json",
]);

export const LocalZarrSelection = {
  OK: "ok",
  // Nothing in the selection starts with ".": not a Zarr store, or the browser
  // left hidden files out (observed in WebKit, which drops Zarr v2 metadata).
  NO_HIDDEN_FILES: "no-hidden-files",
  // Hidden files exist, but no metadata at the top: not a Zarr store, or e.g.
  // the directory containing the store.
  NO_ROOT_METADATA: "no-root-metadata",
} as const;

export type TLocalZarrSelection =
  (typeof LocalZarrSelection)[keyof typeof LocalZarrSelection];

let nextStoreId = 0;
const stores = new Map<string, Map<string, File>>();

/** Name of the selected directory; browsers do not expose its full path. */
export function localZarrDirName(files: File[]) {
  return files[0].webkitRelativePath.split("/")[0];
}

export function checkLocalZarrSelection(files: File[]): TLocalZarrSelection {
  let hasHiddenFile = false;
  for (const file of files) {
    const parts = file.webkitRelativePath.split("/").slice(1);
    if (parts.length === 1 && ROOT_METADATA_FILES.has(parts[0])) {
      return LocalZarrSelection.OK;
    }
    hasHiddenFile ||= parts.some((part) => part.startsWith("."));
  }
  return hasHiddenFile
    ? LocalZarrSelection.NO_ROOT_METADATA
    : LocalZarrSelection.NO_HIDDEN_FILES;
}

export function registerLocalZarr(files: File[]) {
  const baseDir = localZarrDirName(files);
  const fileMap = new Map<string, File>();
  for (const file of files) {
    const relativePath = file.webkitRelativePath.slice(baseDir.length + 1);
    if (relativePath) {
      // Zarrita keys are absolute paths, so restore the leading slash that was
      // stripped along with the base directory name.
      fileMap.set(`/${relativePath}`, file);
    }
  }
  const source = `${LOCAL_ZARR_PREFIX}${++nextStoreId}/${encodeURIComponent(baseDir)}`;
  setLocalZarrFiles(source, fileMap);
  return source;
}

// The presenter display receives the controller's file map as-is, because
// webkitRelativePath does not survive structured cloning.
export function setLocalZarrFiles(source: string, fileMap: Map<string, File>) {
  // Gridlook keeps one local dataset alive, mirroring registerLocalNetCDF.
  stores.clear();
  stores.set(source, fileMap);
}

export function getLocalZarrFiles(source: string) {
  return stores.get(source);
}

export function isLocalZarrSource(source: string) {
  return source.startsWith(LOCAL_ZARR_PREFIX);
}

export function getLocalZarrStore(
  source: string
): zarr.AsyncReadable | undefined {
  const fileMap = stores.get(source);
  if (!fileMap) {
    return undefined;
  }
  return {
    async get(key: string) {
      const file = fileMap.get(key);
      return file ? new Uint8Array(await file.arrayBuffer()) : undefined;
    },
  };
}
