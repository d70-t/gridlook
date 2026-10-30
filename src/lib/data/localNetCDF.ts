import { splitSourceType } from "@/lib/data/sourceType.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

const LOCAL_NETCDF_PREFIX = "netcdf://local/";

const NETCDF_FILE_EXTENSION = {
  NC: ".nc",
  NC4: ".nc4",
  CDF: ".cdf",
} as const;

let nextFileId = 0;
const files = new Map<string, File>();

export function isNetCDFFile(file: File) {
  const filename = file.name.toLowerCase();
  return Object.values(NETCDF_FILE_EXTENSION).some((extension) =>
    filename.endsWith(extension)
  );
}

export function registerLocalNetCDF(
  file: File,
  // The presenter display reuses the controller's source key.
  source = `${LOCAL_NETCDF_PREFIX}${++nextFileId}/${encodeURIComponent(file.name)}`
) {
  // Gridlook keeps one local dataset alive; stop clearing old entries if
  // browser-history navigation between multiple local files is supported.
  files.clear();
  files.set(source, file);
  return source;
}

// Remote files are recognized by a `netcdf+` prefix or by their extension,
// ignoring query and fragment.
export function isRemoteNetCDFSource(source: string) {
  const { format, url } = splitSourceType(source);
  if (format !== undefined) {
    return format === ZARR_FORMAT.NETCDF;
  }
  const path = url.split(/[?#]/)[0].toLowerCase();
  return (
    /^https?:\/\//.test(path) &&
    Object.values(NETCDF_FILE_EXTENSION).some((extension) =>
      path.endsWith(extension)
    )
  );
}

export function isLocalNetCDFSource(source: string) {
  return source.startsWith(LOCAL_NETCDF_PREFIX);
}

export function getLocalNetCDF(source: string) {
  return files.get(source);
}
