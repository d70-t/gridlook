import type * as zarr from "zarrita";

const LOCAL_ZARR_PREFIX = "zarr://local/";

let nextStoreId = 0;
const stores = new Map<string, Map<string, File>>();

export function registerLocalZarr(files: File[]) {
  const baseDir = files[0].webkitRelativePath.split("/")[0];
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
