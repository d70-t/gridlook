import axios from "axios";

export type TBasemapEntry = {
  id: string;
  name: string;
  url: string;
  attribution: string;
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
