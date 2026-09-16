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

export function registerLocalNetCDF(file: File) {
  const source = `${LOCAL_NETCDF_PREFIX}${++nextFileId}/${encodeURIComponent(file.name)}`;
  // Gridlook keeps one local dataset alive; stop clearing old entries if
  // browser-history navigation between multiple local files is supported.
  files.clear();
  files.set(source, file);
  return source;
}

export function isLocalNetCDFSource(source: string) {
  return source.startsWith(LOCAL_NETCDF_PREFIX);
}

export function getLocalNetCDF(source: string) {
  return files.get(source);
}
