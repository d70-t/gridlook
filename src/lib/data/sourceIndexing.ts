import * as zarr from "zarrita";

import {
  ZARR_FORMAT,
  type TDataSource,
  type TSources,
  type TZarrFormat,
  type TZarrV3RootMetadata,
} from "../types/GlobeTypes";

import { lru } from "./lruStore";

import trim from "@/utils/trim";

function isValidVariable(
  varname: string,
  shape: number[],
  dimensions?: string[]
) {
  const EXCLUDED_VAR_PATTERNS = [
    "bnds",
    "bounds",
    "vertices",
    "latitude",
    "longitude",
  ] as const;

  if (!Array.isArray(dimensions)) {
    return false;
  }

  const hasTime = dimensions.includes("time");
  const shapeValid = hasTime ? shape.length >= 2 : shape.length >= 1;

  const hasExcludedName = EXCLUDED_VAR_PATTERNS.some((pattern) =>
    varname.includes(pattern)
  );
  const isLatLon = varname === "lat" || varname === "lon";

  return shapeValid && !hasExcludedName && !isLatLon;
}

async function processZarrV2Variables(
  store: zarr.Listable<zarr.FetchStore>,
  root: zarr.Group<zarr.FetchStore>,
  src: string
): Promise<Record<string, TDataSource>> {
  const dimensions = new Set<string>();

  const candidates = await Promise.allSettled(
    store.contents().map(async ({ path, kind }) => {
      const varname = path.slice(1);
      if (kind !== "array") {
        return {};
      }

      const variable = await zarr.open(root.resolve(path), { kind: "array" });
      const arrayDimensions = variable.attrs?._ARRAY_DIMENSIONS;
      // Collect dimensions from _ARRAY_DIMENSIONS attribute
      if (Array.isArray(arrayDimensions)) {
        for (const dim of arrayDimensions) {
          dimensions.add(dim);
        }
      }

      // Collect dimensions from coordinates attribute
      if (variable.attrs.coordinates) {
        const coords = variable.attrs.coordinates as string;
        for (const coord of coords.split(" ")) {
          dimensions.add(coord);
        }
      }

      // Return valid variables
      if (
        isValidVariable(varname, variable.shape, arrayDimensions as string[])
      ) {
        return {
          [varname]: {
            store: src,
            dataset: "",
            attrs: { ...variable.attrs, dimensionNames: arrayDimensions },
          },
        };
      }

      return {};
    })
  );

  // Filter and merge datasources
  const datasources = candidates
    .filter((promise) => promise.status === "fulfilled")
    .map((promise) => promise.value)
    .filter((obj) => {
      // Filter out dimensions and coordinates
      return (
        Object.keys(obj).length > 0 && !dimensions.has(Object.keys(obj)[0])
      );
    })
    .reduce((a, b) => ({ ...a, ...b }), {});

  return datasources;
}

function processZarrV3Variables(
  group: zarr.Group<zarr.FetchStore>,
  src: string
) {
  const datasources: Record<
    string,
    { store: string; dataset: string; attrs: Record<string, unknown> }
  > = {};
  const dimensions = new Set<string>();
  const attributes = group.attrs as TZarrV3RootMetadata;
  const consolidatedMetadata = attributes.consolidated_metadata;
  const metadata = consolidatedMetadata.metadata;

  for (const node of Object.values(metadata)) {
    if (node.node_type === "array" && Array.isArray(node.dimension_names)) {
      for (const dim of node.dimension_names) {
        dimensions.add(dim);
      }
    }
  }
  for (const [name, node] of Object.entries(metadata)) {
    if (node.node_type !== "array") {
      continue;
    }
    const arrayNode = node as zarr.ArrayMetadata;
    if (
      isValidVariable(name, arrayNode.shape, arrayNode.dimension_names) &&
      !dimensions.has(name)
    ) {
      datasources[name] = {
        store: src,
        dataset: "",
        attrs: {
          ...node.attributes,
          dimensionNames: node.dimension_names,
        } as Record<string, unknown>,
      };
    }
  }
  return datasources;
}

export async function openExperimentalV3Consolidated<
  Store extends zarr.Readable,
>(store: Store): Promise<zarr.Group<Store>> {
  const location = zarr.root(store);
  const rootMetadata: TZarrV3RootMetadata = JSON.parse(
    new TextDecoder().decode(
      await store.get(location.resolve("zarr.json").path)
    )
  );
  // eslint-disable-next-line camelcase
  const { attributes, consolidated_metadata } = rootMetadata;
  return new zarr.Group(store, location.path, {
    /* eslint-disable camelcase */
    zarr_format: 3,
    node_type: "group",
    attributes: { ...attributes, consolidated_metadata },
    /* eslint-enable camelcase */
  });
}

function createIndex(
  title: string,
  datasources: Record<string, TDataSource>,
  src: string,
  zarrFormat: TZarrFormat
): TSources {
  return {
    name: title,
    zarr_format: zarrFormat, // eslint-disable-line camelcase
    levels: [
      {
        time: {
          store: src,
          dataset: "",
        },
        grid: {
          store: src,
          dataset: "",
        },
        datasources,
      },
    ],
  };
}

export async function indexFromZarr(src: string): Promise<TSources> {
  try {
    const store = await zarr.withConsolidated(lru(new zarr.FetchStore(src)));
    const root = await zarr.open(store, { kind: "group" });
    const datasources = await processZarrV2Variables(store, root, src);
    return createIndex(
      root.attrs?.title as string,
      datasources,
      src,
      ZARR_FORMAT.V2
    );
  } catch {
    const group = await openExperimentalV3Consolidated(
      new zarr.FetchStore(src)
    );
    const datasources = processZarrV3Variables(group, src);
    return createIndex(
      group.attrs?.title as string,
      datasources,
      src,
      ZARR_FORMAT.V3
    );
  }
}

/**
 * JSON-based index may contain variables which belong to different dataset.
 * This function collects variable names by their dataset combination, so
 * that we can fetch metadata for each store only once.
 */
function collectStores(
  datasources: Record<string, TDataSource>
): Record<string, Set<string>> {
  const stores: Record<string, Set<string>> = {};
  for (const varname in datasources) {
    const variable = datasources[varname];
    const store = trim(variable.store, "/") + "/" + trim(variable.dataset, "/");
    if (!stores[store]) {
      stores[store] = new Set();
    }
    stores[store].add(varname);
  }
  return stores;
}

/**
 * Enrich the index with dimension names and attributes from Zarr V2
 * consolidated metadata.
 */
async function enrichMetadataWithZarrV2(
  stores: Record<string, Set<string>>,
  datasources: Record<string, TDataSource>
) {
  for (const [store, vars] of Object.entries(stores)) {
    const zarrStore = await zarr.withConsolidated(
      lru(new zarr.FetchStore(store))
    );
    const root = await zarr.open(zarrStore, { kind: "group" });

    for (const varname of vars) {
      const variable = await zarr.open(root.resolve(`/${varname}`), {
        kind: "array",
      });
      const arrayDimensions = variable.attrs?._ARRAY_DIMENSIONS;
      datasources[varname].attrs = {
        ...datasources[varname].attrs,
        ...variable.attrs,
        dimensionNames: arrayDimensions,
      } as Record<string, unknown>;
    }
  }
}

/**
 * Zarrita does not provide a proper way to get dimension names for Zarr V3
 * arrays, so we need to fetch metadata for each store and enrich the index with
 * dimension names and attributes.
 */
async function enrichMetadataWithZarrV3(
  stores: Record<string, Set<string>>,
  datasources: Record<string, TDataSource>
) {
  for (const [store, vars] of Object.entries(stores)) {
    const group = await openExperimentalV3Consolidated(
      new zarr.FetchStore(store)
    );
    if (group.attrs) {
      const rootMetadata = group.attrs as TZarrV3RootMetadata;
      const metadata = rootMetadata.consolidated_metadata.metadata;
      if (metadata) {
        for (const varname of vars) {
          const node = metadata[varname];
          if (node && node.node_type === "array") {
            const arrayNode = node as zarr.ArrayMetadata;
            datasources[varname].attrs = {
              ...datasources[varname].attrs,
              ...arrayNode.attributes,
              dimensionNames: arrayNode.dimension_names,
            } as Record<string, unknown>;
          }
        }
      }
    }
  }
}

export async function indexFromIndex(src: string): Promise<TSources> {
  const res = await fetch(src);
  if (!res.ok) {
    throw new Error(`Failed to fetch index from ${src}: ${res.statusText}`);
  } else if (res.status >= 400) {
    throw new Error(`Index not found at ${src}`);
  }
  const sources = (await res.json()) as TSources;
  const datasources = sources.levels[0].datasources;
  const stores = collectStores(datasources);
  try {
    await enrichMetadataWithZarrV3(stores, datasources);
    sources.zarr_format = ZARR_FORMAT.V3; // eslint-disable-line camelcase
  } catch {
    await enrichMetadataWithZarrV2(stores, datasources);
    sources.zarr_format = ZARR_FORMAT.V2; // eslint-disable-line camelcase
  }
  return sources;
}
