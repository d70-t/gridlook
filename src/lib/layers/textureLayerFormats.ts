export const TEXTURE_LAYER_MIME_TYPES = {
  JPEG: "image/jpeg",
  PNG: "image/png",
  TIFF_SHORT: "image/tif",
  TIFF: "image/tiff",
  TIFF_LEGACY: "image/x-tiff",
  TIFF_APPLICATION: "application/tiff",
  GEOTIFF: "image/geotiff",
  GEOTIFF_APPLICATION: "application/geotiff",
  GEOTIFF_APPLICATION_LEGACY: "application/x-geotiff",
} as const;

export type TTextureLayerMimeType =
  (typeof TEXTURE_LAYER_MIME_TYPES)[keyof typeof TEXTURE_LAYER_MIME_TYPES];

export const TEXTURE_LAYER_FILE_EXTENSIONS = {
  GEOTIFF: ".geotiff",
  TIF: ".tif",
  TIFF: ".tiff",
} as const;

export type TTextureLayerFileExtension =
  (typeof TEXTURE_LAYER_FILE_EXTENSIONS)[keyof typeof TEXTURE_LAYER_FILE_EXTENSIONS];

const SUPPORTED_TEXTURE_LAYER_MIME_TYPES = Object.values(
  TEXTURE_LAYER_MIME_TYPES
) as TTextureLayerMimeType[];

const GEOTIFF_TEXTURE_LAYER_MIME_TYPES: TTextureLayerMimeType[] = [
  TEXTURE_LAYER_MIME_TYPES.TIFF,
  TEXTURE_LAYER_MIME_TYPES.TIFF_SHORT,
  TEXTURE_LAYER_MIME_TYPES.TIFF_LEGACY,
  TEXTURE_LAYER_MIME_TYPES.TIFF_APPLICATION,
  TEXTURE_LAYER_MIME_TYPES.GEOTIFF,
  TEXTURE_LAYER_MIME_TYPES.GEOTIFF_APPLICATION,
  TEXTURE_LAYER_MIME_TYPES.GEOTIFF_APPLICATION_LEGACY,
];

const GEOTIFF_TEXTURE_LAYER_FILE_EXTENSIONS = Object.values(
  TEXTURE_LAYER_FILE_EXTENSIONS
) as TTextureLayerFileExtension[];

export const TEXTURE_LAYER_UPLOAD_ACCEPT = [
  ...SUPPORTED_TEXTURE_LAYER_MIME_TYPES,
  ...GEOTIFF_TEXTURE_LAYER_FILE_EXTENSIONS,
].join(",");

function hasExtension(
  name: string | undefined,
  extensions: readonly TTextureLayerFileExtension[]
) {
  const lowerName = name?.toLowerCase();
  return Boolean(
    lowerName && extensions.some((ext) => lowerName.endsWith(ext))
  );
}

function hasMimeType(
  type: string,
  mimeTypes: readonly TTextureLayerMimeType[]
) {
  return mimeTypes.includes(type as TTextureLayerMimeType);
}

export function isGeoTiffLayerSource(blob: Blob, name?: string) {
  return (
    hasMimeType(blob.type, GEOTIFF_TEXTURE_LAYER_MIME_TYPES) ||
    hasExtension(name, GEOTIFF_TEXTURE_LAYER_FILE_EXTENSIONS)
  );
}

export function isSupportedTextureLayerFile(file: File) {
  return (
    hasMimeType(file.type, SUPPORTED_TEXTURE_LAYER_MIME_TYPES) ||
    hasExtension(file.name, GEOTIFF_TEXTURE_LAYER_FILE_EXTENSIONS)
  );
}
