import axios from "axios";

export type TCatalogEntry = {
  url: string;
  title?: string;
  tags?: Record<string, string>;
  description?: string;
  params?: Record<string, string>;
};

export type TCatalog = {
  type: "gridlook_catalog";
  title?: string;
  datasets: TCatalogEntry[];
};

function isCatalog(data: unknown): data is TCatalog {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as { type: unknown }).type === "gridlook_catalog" &&
    "datasets" in data &&
    Array.isArray((data as TCatalog).datasets)
  );
}

// Keeps only string values, so a malformed catalog can't break rendering.
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    ([, v]) => typeof v === "string"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function parseCatalog(data: unknown): TCatalog | null {
  if (!isCatalog(data)) {
    return null;
  }
  const datasets: TCatalogEntry[] = [];
  for (const raw of data.datasets as unknown[]) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.url !== "string") {
      continue;
    }
    // Legacy single `tag` becomes a tag with the key "tag".
    const tags =
      stringRecord(entry.tags) ??
      (typeof entry.tag === "string" ? { tag: entry.tag } : undefined);
    datasets.push({
      url: entry.url,
      title: typeof entry.title === "string" ? entry.title : undefined,
      description:
        typeof entry.description === "string" ? entry.description : undefined,
      tags,
      // A string is a copied hash, e.g. "varname=tas::colormap=viridis", parsed
      // like HashGlobeView parses the hash.
      params:
        typeof entry.params === "string"
          ? Object.fromEntries(
              new URLSearchParams(entry.params.split("::").join("&"))
            )
          : stringRecord(entry.params),
    });
  }
  return { type: data.type, title: data.title, datasets };
}

function newAbortSignal(timeoutMs: number) {
  const abortController = new AbortController();
  setTimeout(() => abortController.abort(), timeoutMs || 0);

  return abortController.signal;
}

export async function fetchCatalog(url: string): Promise<TCatalog | null> {
  try {
    const response = await axios.get(url, {
      signal: newAbortSignal(5000), //Aborts request after 5 seconds
    });
    return parseCatalog(response.data);
  } catch {
    return null;
  }
}

export const CatalogSort = {
  DEFAULT: "default",
  TITLE: "title",
} as const;

// Sorting by a tag uses this prefix plus the tag key, e.g. "tag:grid".
export const TAG_SORT_PREFIX = "tag:";

export function tagLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// Gridlook hash parameters, e.g. "::varname=tas::colormap=viridis"
export function hashParams(params: Record<string, string> = {}): string {
  return Object.entries(params)
    .map(([k, v]) => `::${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("");
}
