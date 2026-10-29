import { ZARR_FORMAT, type TZarrFormat } from "@/lib/types/GlobeTypes.ts";

// `<prefix><url>` forces a data type, so the source isn't probed for the others.
export const SOURCE_TYPE_PREFIX: Record<TZarrFormat, string> = {
  [ZARR_FORMAT.V2]: "zarr2+",
  [ZARR_FORMAT.V3]: "zarr3+",
  [ZARR_FORMAT.ICECHUNK]: "icechunk+",
  [ZARR_FORMAT.NETCDF]: "netcdf+",
};

export function splitSourceType(src: string): {
  format: TZarrFormat | undefined;
  url: string;
} {
  for (const format of Object.values(ZARR_FORMAT)) {
    const prefix = SOURCE_TYPE_PREFIX[format];
    if (src.startsWith(prefix)) {
      return { format, url: src.slice(prefix.length) };
    }
  }
  return { format: undefined, url: src };
}

export function withSourceType(src: string, format: TZarrFormat | undefined) {
  const { url } = splitSourceType(src);
  return format === undefined ? url : SOURCE_TYPE_PREFIX[format] + url;
}
