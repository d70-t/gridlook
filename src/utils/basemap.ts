import axios from "axios";

// Pixel size of a provider's tiles; 256 when not given.
export const BasemapTileSize = {
  STANDARD: 256,
  LARGE: 512,
} as const;

type TBasemapTileSize = (typeof BasemapTileSize)[keyof typeof BasemapTileSize];

// Raster tiles are images; vector tiles (Shortbread schema) are drawn here.
export const BasemapTileType = {
  RASTER: "raster",
  VECTOR: "vector",
} as const;

type TBasemapTileType = (typeof BasemapTileType)[keyof typeof BasemapTileType];

export type TBasemapEntry = {
  id: string;
  name: string;
  url: string;
  attribution: string;
  tileSize?: TBasemapTileSize;
  type?: TBasemapTileType;
  // Deepest zoom the provider serves; deeper tiles are cut from it.
  maxZoom?: number;
};

// What basemaps show; only vector basemaps have labels.
export type TBasemapOptions = {
  water: boolean;
  land: boolean;
  labels: boolean;
};

export const DEFAULT_BASEMAP_OPTIONS: TBasemapOptions = {
  water: true,
  land: true,
  labels: false,
};

export type TBasemapCatalog = {
  type: "gridlook_basemaps";
  basemaps: TBasemapEntry[];
};

function isBasemapCatalog(data: unknown): data is TBasemapCatalog {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as { type: unknown }).type === "gridlook_basemaps" &&
    "basemaps" in data &&
    Array.isArray((data as TBasemapCatalog).basemaps)
  );
}

function newAbortSignal(timeoutMs: number) {
  const abortController = new AbortController();
  setTimeout(() => abortController.abort(), timeoutMs || 0);

  return abortController.signal;
}

export async function fetchBasemapCatalog(
  url: string
): Promise<TBasemapCatalog | null> {
  try {
    const response = await axios.get<TBasemapCatalog>(url, {
      signal: newAbortSignal(5000), //Aborts request after 5 seconds
    });
    const data = response.data;
    if (isBasemapCatalog(data)) {
      return data;
    }
  } catch {
    return null;
  }
  return null;
}
