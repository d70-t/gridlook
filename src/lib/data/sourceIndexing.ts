import * as zarr from "zarrita";

import {
  ZARR_FORMAT,
  type TDataSource,
  type TSources,
  type TZarrFormat,
} from "../types/GlobeTypes.ts";

import { ZarrDataManager } from "./ZarrDataManager.ts";

import trim from "@/utils/trim.ts";

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

function searchDimensionsAndCoordinates(
  dimensions: Set<string>,
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  if (Array.isArray(variable.dimensionNames)) {
    for (const dim of variable.dimensionNames) {
      dimensions.add(dim);
    }
  }

  if (variable.attrs.coordinates) {
    const coords = variable.attrs.coordinates as string;
    for (const coord of coords.split(" ")) {
      dimensions.add(coord);
    }
  }
}

async function collectVariables(
  store: zarr.Listable<zarr.AsyncReadable>,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string
): Promise<{
  candidates: PromiseSettledResult<Record<string, TDataSource>>[];
  dimensions: Set<string>;
}> {
  const dimensions = new Set<string>();
  const candidates = await Promise.allSettled(
    store
      .contents()
      .map(
        async ({
          path,
          kind,
        }: {
          path: zarr.AbsolutePath;
          kind: "array" | "group";
        }) => {
          if (kind !== "array") {
            return {};
          }
          const variable = await zarr.open(root.resolve(path), {
            kind: "array",
          });
          searchDimensionsAndCoordinates(dimensions, variable);

          const varname = path.slice(1);
          return {
            [varname]: {
              store: src,
              dataset: "",
              hidden: !isValidVariable(
                varname,
                variable.shape,
                variable.dimensionNames as string[]
              ),
              attrs: {
                ...variable.attrs,
                dimensionNames: variable.dimensionNames,
              },
            },
          };
        }
      )
  );

  return { candidates, dimensions };
}

async function processZarrVariables(
  store: zarr.Listable<zarr.AsyncReadable>,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string
): Promise<Record<string, TDataSource>> {
  const { candidates, dimensions } = await collectVariables(store, root, src);

  // Filter and merge datasources
  const datasources = candidates
    .filter((promise) => promise.status === "fulfilled")
    .map((promise) => promise.value)
    .filter((obj) => Object.keys(obj).length > 0)
    .map((obj) => {
      // Filter out variables that are actually dimensions or coordinates
      const varname = Object.keys(obj)[0];
      if (dimensions.has(varname)) {
        const hiddenObject = { [varname]: { ...obj[varname], hidden: true } };
        return hiddenObject;
      }
      return obj;
    })
    .reduce((a, b) => ({ ...a, ...b }), {});

  return datasources;
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
    const store = await zarr.withConsolidatedMetadata(
      await ZarrDataManager.createNewStore(src),
      { format: "v2" }
    );
    const root = await zarr.open(store, { kind: "group" });
    const datasources = await processZarrVariables(store, root, src);
    return createIndex(
      root.attrs?.title as string,
      datasources,
      src,
      ZARR_FORMAT.V2
    );
  } catch {
    const store = await zarr.withConsolidatedMetadata(
      await ZarrDataManager.createNewStore(src),
      { format: "v3" }
    );
    const root = await zarr.open(store, { kind: "group" });
    const datasources = await processZarrVariables(store, root, src);
    return createIndex(
      root.attrs?.title as string,
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
async function enrichMetadata(
  stores: Record<string, Set<string>>,
  datasources: Record<string, TDataSource>,
  format: "v2" | "v3"
) {
  for (const [store, vars] of Object.entries(stores)) {
    const zarrStore = await zarr.withConsolidatedMetadata(
      await ZarrDataManager.createNewStore(store),
      { format: format }
    );
    const root = await zarr.open(zarrStore, { kind: "group" });

    for (const varname of vars) {
      try {
        const variable = await zarr.open(root.resolve(`/${varname}`), {
          kind: "array",
        });
        const arrayDimensions = variable.dimensionNames ?? [];
        datasources[varname].attrs = {
          ...datasources[varname].attrs,
          ...variable.attrs,
          dimensionNames: arrayDimensions,
        } as Record<string, unknown>;
      } catch {
        // ignore
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
    await enrichMetadata(stores, datasources, "v3");
    sources.zarr_format = ZARR_FORMAT.V3; // eslint-disable-line camelcase
  } catch {
    await enrichMetadata(stores, datasources, "v2");
    sources.zarr_format = ZARR_FORMAT.V2; // eslint-disable-line camelcase
  }
  return sources;
}
