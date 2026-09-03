import * as zarr from "zarrita";

import {
  ZARR_FORMAT,
  type TDataSource,
  type TSources,
  type TZarrFormat,
} from "../types/GlobeTypes.ts";

import {
  createListableIcechunkStore,
  isIcechunkStorePath,
  splitIcechunkStoreAndGroup,
} from "./icechunkStore.ts";
import { ZarrDataManager } from "./ZarrDataManager.ts";

import trim from "@/utils/trim.ts";

/*
  Matches strings like "a: foo b: bar" and rewrites them into a map {a: foo, b: bar}
  Returns an empty Map if strings does not match this pattern
 */
function parseFormulaTerms(value: unknown): Map<string, string> {
  if (typeof value !== "string") {
    return new Map();
  }

  const normalised = value.replace(/\s*:\s*/g, ":").trim();
  if (normalised === "") {
    return new Map();
  }

  const terms = new Map<string, string>();

  for (const token of normalised.split(/\s+/)) {
    const parts = token.split(":");

    // Exactly one colon, and neither side empty.
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      continue; // malformed pair - skip it, keep the rest
    }

    const [term, variableName] = parts;
    terms.set(term, variableName);
  }

  return terms;
}

export function hideFormulaTermVariablesWithoutStandardName(
  datasources: Record<string, TDataSource>
) {
  const collectedFormulaTerms = new Set<string>();
  for (const [contextVariable, datasource] of Object.entries(datasources)) {
    const formulaTermVariables = parseFormulaTerms(
      datasource.attrs?.formula_terms
    );
    for (const formulaTermVariable of formulaTermVariables.values()) {
      if (collectedFormulaTerms.has(formulaTermVariable)) {
        continue;
      }
      collectedFormulaTerms.add(formulaTermVariable);
      const variablePath = ZarrDataManager.resolveVariablePath(
        contextVariable,
        formulaTermVariable
      );
      const formulaTermDatasource = datasources[variablePath];
      if (
        formulaTermDatasource &&
        !formulaTermDatasource.attrs?.standard_name
      ) {
        formulaTermDatasource.hidden = true;
      }
    }
  }
}

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
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  variablePath: string
) {
  if (Array.isArray(variable.dimensionNames)) {
    for (const dim of variable.dimensionNames) {
      dimensions.add(ZarrDataManager.resolveVariablePath(variablePath, dim));
    }
  }

  if (variable.attrs.coordinates) {
    const coords = variable.attrs.coordinates as string;
    for (const coord of coords.split(" ")) {
      dimensions.add(ZarrDataManager.resolveVariablePath(variablePath, coord));
    }
  }
}

function getVariablePathInGroup(path: string, datasetPath: string) {
  const normalizedPath = path.replace(/^\/+/, "");
  if (!datasetPath) {
    return normalizedPath;
  }

  const datasetPrefix = `${datasetPath}/`;
  if (!normalizedPath.startsWith(datasetPrefix)) {
    return null;
  }
  return normalizedPath.slice(datasetPrefix.length);
}

type TStoreContent = {
  path: zarr.AbsolutePath;
  kind: "array" | "group";
};

async function collectVariable(
  root: zarr.Group<zarr.AsyncReadable>,
  src: string,
  datasetPath: string,
  dimensions: Set<string>,
  { path, kind }: TStoreContent
) {
  if (kind !== "array") {
    return {};
  }

  const varname = getVariablePathInGroup(path, datasetPath);
  if (!varname) {
    return {};
  }

  const variable = await zarr.open(root.resolve(path), {
    kind: "array",
  });

  searchDimensionsAndCoordinates(dimensions, variable, varname);
  return {
    [varname]: {
      store: src,
      dataset: datasetPath,
      hidden: !isValidVariable(
        varname,
        variable.shape,
        variable.dimensionNames as string[]
      ),
      attrs: {
        ...variable.attrs,
        dimensionNames: variable.dimensionNames,
      },
      shape: variable.shape,
      dtype: String(variable.dtype),
    },
  };
}

async function collectVariables(
  store: zarr.Listable<zarr.AsyncReadable>,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string,
  datasetPath = ""
): Promise<{
  candidates: PromiseSettledResult<Record<string, TDataSource>>[];
  dimensions: Set<string>;
}> {
  const dimensions = new Set<string>();
  const candidates = await Promise.allSettled(
    store
      .contents()
      .map((content) =>
        collectVariable(root, src, datasetPath, dimensions, content)
      )
  );

  return { candidates, dimensions };
}

async function processZarrVariables(
  store: zarr.Listable<zarr.AsyncReadable>,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string,
  datasetPath = ""
): Promise<Record<string, TDataSource>> {
  const { candidates, dimensions } = await collectVariables(
    store,
    root,
    src,
    datasetPath
  );

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
  zarrFormat: TZarrFormat,
  datasetPath = "",
  file?: File
): TSources {
  hideFormulaTermVariablesWithoutStandardName(datasources);
  const datasetSource = {
    store: src,
    dataset: datasetPath,
    ...(file ? { file } : {}),
  };
  return {
    name: title,
    zarr_format: zarrFormat, // eslint-disable-line camelcase
    levels: [
      {
        time: {
          ...datasetSource,
        },
        grid: {
          ...datasetSource,
        },
        datasources,
      },
    ],
  };
}

type TNetCDFModule = typeof import("./netCDF.ts");

function registerNetCDFBackend(netCDF: TNetCDFModule) {
  ZarrDataManager.registerNetCDFBackend({
    getArray: netCDF.getNetCDFArray,
    invalidateCache: netCDF.invalidateNetCDFCache,
    openArray: netCDF.openNetCDFArray,
    openGroup: netCDF.openNetCDFGroup,
    resolveGroup: netCDF.resolveNetCDFGroup,
  });
}

export async function indexFromNetCDF(
  file: File,
  src: string
): Promise<TSources> {
  const netCDF = await import("./netCDF.ts");
  registerNetCDFBackend(netCDF);
  const { listNetCDFArrays } = netCDF;
  const arrays = await listNetCDFArrays(file, src);
  const dimensions = new Set<string>();
  for (const array of arrays) {
    const varname = array.path.replace(/^\/+/, "");
    searchDimensionsAndCoordinates(
      dimensions,
      array as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>,
      varname
    );
  }

  const datasources: Record<string, TDataSource> = {};
  for (const array of arrays) {
    const varname = array.path.replace(/^\/+/, "");
    datasources[varname] = {
      store: src,
      dataset: "",
      file,
      hidden:
        dimensions.has(varname) ||
        !isValidVariable(varname, array.shape, array.dimensionNames),
      attrs: {
        ...array.attrs,
        dimensionNames: array.dimensionNames,
      },
      shape: array.shape,
      dtype: String(array.dtype),
    };
  }

  const root = await ZarrDataManager.getDatasetGroup({
    store: src,
    dataset: "",
    file,
  });
  return createIndex(
    String(root.attrs.title ?? file.name),
    datasources,
    src,
    ZARR_FORMAT.NETCDF,
    "",
    file
  );
}

async function indexFromIcechunk(src: string): Promise<TSources> {
  const { storePath, groupPath } = await splitIcechunkStoreAndGroup(src);
  const store = await createListableIcechunkStore(storePath);
  const root = await zarr.open.v3(store, { kind: "group" });
  const group = groupPath
    ? await zarr.open.v3(root.resolve(groupPath), { kind: "group" })
    : root;
  const datasources = await processZarrVariables(
    store,
    root,
    storePath,
    groupPath
  );
  return createIndex(
    group.attrs?.title as string,
    datasources,
    storePath,
    ZARR_FORMAT.ICECHUNK,
    groupPath
  );
}

export async function indexFromZarr(src: string): Promise<TSources> {
  if (isIcechunkStorePath(src)) {
    return indexFromIcechunk(src);
  }
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
    try {
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
    } catch {
      // Some icechunk datasets do not use `.icechunk` suffix, so we try to detect
      // and read them with the icechunk reader as a fallback before giving up and
      // trying the JSON index.
      return indexFromIcechunk(src);
    }
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
        datasources[varname].dtype = String(variable.dtype);
        datasources[varname].shape = variable.shape;
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
  hideFormulaTermVariablesWithoutStandardName(datasources);
  return sources;
}
