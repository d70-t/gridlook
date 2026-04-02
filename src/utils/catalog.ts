import axios from "axios";

export type TCatalogEntry = {
  url: string;
  title?: string;
  tag?: string;
  description?: string;
};

export type TCatalog = {
  type: "gridlook_catalog";
  title?: string;
  datasets: TCatalogEntry[];
};

export function isCatalog(data: unknown): data is TCatalog {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as { type: unknown }).type === "gridlook_catalog" &&
    "datasets" in data &&
    Array.isArray((data as TCatalog).datasets)
  );
}

export async function fetchCatalog(url: string): Promise<TCatalog | null> {
  try {
    const response = await axios.get(url);
    const data = response.data;
    if (isCatalog(data)) {
      return data;
    }
  } catch {
    return null;
  }
  return null;
}
