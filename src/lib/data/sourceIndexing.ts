import * as zarr from "zarrita";

import {
  ZARR_FORMAT,
  type TDataSource,
  type TSourceLevel,
  type TSources,
  type TZarrFormat,
} from "../types/GlobeTypes.ts";

import {
  isLatitudeVariable,
  isLongitudeVariable,
} from "./coordinateVariables.ts";
import {
  createListableIcechunkStore,
  isIcechunkStorePath,
  splitIcechunkStoreAndGroup,
} from "./icechunkStore.ts";
import { sortFinestFirst } from "./levels.ts";
import {
  groupArrayAssets,
  levelGeometryFromGrid,
  parseMultiscales,
  type TMultiscaleEntry,
} from "./multiscales.ts";
import type { NetCDFArray } from "./netCDF.ts";
import {
  createReferenceStore,
  isReferenceStorePath,
  splitReferenceStoreAndGroup,
} from "./referenceStore.ts";
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
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable> | NetCDFArray
) {
  const EXCLUDED_VAR_PATTERNS = [
    "bnds",
    "bounds",
    "vertices",
    "latitude",
    "longitude",
    "cell_ids",
  ] as const;

  const shape = variable.shape;
  const dimensions = variable.dimensionNames as string[] | undefined;

  if (!Array.isArray(dimensions)) {
    return false;
  }

  if (variable.dtype === "string") {
    return false;
  }

  const hasTime = dimensions.includes("time");
  const shapeValid = hasTime ? shape.length >= 2 : shape.length >= 1;

  const hasExcludedName = EXCLUDED_VAR_PATTERNS.some((pattern) =>
    varname.includes(pattern)
  );
  const isLatLon =
    isLatitudeVariable(varname, variable.attrs) ||
    isLongitudeVariable(varname, variable.attrs);

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

  if (typeof variable.attrs.grid_mapping === "string") {
    for (const name of variable.attrs.grid_mapping.split(/[\s:]+/)) {
      if (name) {
        dimensions.add(ZarrDataManager.resolveVariablePath(variablePath, name));
      }
    }
  }

  if (variable.attrs.cf_role === "mesh_topology") {
    const MESH_TOPOLOGY_VAR_ATTRIBUTES = [
      "node_coordinates",
      "face_coordinates",
      "edge_coordinates",
      "face_node_connectivity",
      "edge_node_connectivity",
      "face_edge_connectivity",
      "edge_face_connectivity",
      "face_face_connectivity",
      "boundary_node_connectivity",
    ] as const;
    for (const attribute of MESH_TOPOLOGY_VAR_ATTRIBUTES) {
      const value = variable.attrs[attribute];
      if (typeof value !== "string") {
        continue;
      }
      for (const name of value.trim().split(/\s+/)) {
        dimensions.add(ZarrDataManager.resolveVariablePath(variablePath, name));
      }
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
      hidden: !isValidVariable(varname, variable),
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
  datasetPath = "",
  include: (path: string) => boolean = () => true
): Promise<{
  candidates: PromiseSettledResult<Record<string, TDataSource>>[];
  dimensions: Set<string>;
}> {
  const dimensions = new Set<string>();
  const contents = store
    .contents()
    .filter(({ kind, path }) => kind === "array" && include(path));
  const candidates: PromiseSettledResult<Record<string, TDataSource>>[] = [];

  const batchSize = 200;
  for (let offset = 0; offset < contents.length; offset += batchSize) {
    if (offset > 0) {
      // Yield a task so the browser can handle input and repaint between batches.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const batch = await Promise.allSettled(
      contents
        .slice(offset, offset + batchSize)
        .map((content) =>
          collectVariable(root, src, datasetPath, dimensions, content)
        )
    );
    candidates.push(...batch);
  }

  return { candidates, dimensions };
}

/**
 * The variables of the dataset group's arrays (those whose absolute path
 * passes `include`), keyed by their path relative to the dataset group.
 */
async function processZarrVariables(
  store: zarr.Listable<zarr.AsyncReadable>,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string,
  datasetPath = "",
  include?: (path: string) => boolean
): Promise<Record<string, TDataSource>> {
  const { candidates, dimensions } = await collectVariables(
    store,
    root,
    src,
    datasetPath,
    include
  );

  // Filter and merge datasources
  const entries = candidates
    .filter((promise) => promise.status === "fulfilled")
    .map((promise) => promise.value)
    .filter((obj) => Object.keys(obj).length > 0)
    .map((obj) => {
      // Filter out variables that are actually dimensions or coordinates
      const varname = Object.keys(obj)[0];
      return [
        varname,
        dimensions.has(varname)
          ? { ...obj[varname], hidden: true }
          : obj[varname],
      ] as const;
    });

  return Object.fromEntries(entries);
}

function createLevel(
  groupAttrs: zarr.Attributes,
  datasources: Record<string, TDataSource>,
  src: string,
  datasetPath = "",
  file?: File
): TSourceLevel {
  for (const source of Object.values(datasources)) {
    source.groupAttrs = groupAttrs;
  }
  hideFormulaTermVariablesWithoutStandardName(datasources);
  const datasetSource = {
    store: src,
    dataset: datasetPath,
    ...(file ? { file } : {}),
  };
  return {
    time: {
      ...datasetSource,
    },
    grid: {
      ...datasetSource,
    },
    datasources,
  };
}

function createIndex(
  groupAttrs: zarr.Attributes,
  datasources: Record<string, TDataSource>,
  src: string,
  zarrFormat: TZarrFormat,
  datasetPath = "",
  file?: File
): TSources {
  return {
    name: groupAttrs.title as string,
    zarr_format: zarrFormat, // eslint-disable-line camelcase
    levels: [createLevel(groupAttrs, datasources, src, datasetPath, file)],
  };
}

async function readAxisStart(
  root: zarr.Group<zarr.AsyncReadable>,
  path: string
): Promise<ArrayLike<number>> {
  const array = await zarr.open(root.resolve(`/${path}`), { kind: "array" });
  const chunk = await ZarrDataManager.getVariableDataFromArray(array, [
    zarr.slice(0, 2),
  ]);
  return chunk.data as ArrayLike<number>;
}

/**
 * One level of a pyramid: the arrays of the level group at `path`, keyed by
 * their path relative to the dataset group (`groupPath`), as for a dataset
 * without levels, so a variable's name says which level it is on.
 */
async function indexLevel(
  store: zarr.Listable<zarr.AsyncReadable>,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string,
  groupAttrs: zarr.Attributes,
  entry: TMultiscaleEntry,
  path: string,
  groupPath: string
): Promise<TSourceLevel | null> {
  const datasources = await processZarrVariables(
    store,
    root,
    src,
    groupPath,
    (arrayPath) => arrayPath.startsWith(`/${path}/`)
  );
  if (Object.keys(datasources).length === 0) {
    return null;
  }
  const levelPath = getVariablePathInGroup(path, groupPath)!;
  const levelVariables = Object.fromEntries(
    Object.entries(datasources).map(([name, source]) => [
      name.slice(levelPath.length + 1),
      source,
    ])
  );
  // The level group may describe its grid (the DGGS convention).
  const levelAttrs = await zarr
    .open(root.resolve(`/${path}`), { kind: "group" })
    .then(
      (level) => level.attrs,
      () => ({})
    );
  // The grid only has to be read when the attributes give no resolution.
  const geometry = await levelGeometryFromGrid(
    levelVariables,
    entry.resolution === undefined
      ? (name) => readAxisStart(root, `${path}/${name}`)
      : undefined,
    levelAttrs
  );
  return {
    ...createLevel(groupAttrs, datasources, src, groupPath),
    name: entry.path,
    path: levelPath,
    resolution: entry.resolution ?? geometry.resolution,
    cellCount: geometry.cellCount,
  };
}

/**
 * The metadata in a v2 store's `.zmetadata`, which zarrita has read already
 * (the store's byte cache answers), or undefined without one.
 */
async function consolidatedV2Metadata(
  store: zarr.Listable<zarr.AsyncReadable>
) {
  const bytes = await store.get("/.zmetadata").catch(() => undefined);
  return bytes
    ? (JSON.parse(new TextDecoder().decode(bytes)).metadata as Record<
        string,
        unknown
      >)
    : undefined;
}

/**
 * The group whose `multiscales` attribute declares the pyramid: the opened
 * group, else the shallowest group below it that carries one. The search
 * reads the store's listing and group attributes, which every caller holds
 * in memory (consolidated metadata, an Icechunk snapshot or a reference
 * file), so it fetches nothing: a v2 group is checked in `.zmetadata` and
 * opened only when its attributes declare a pyramid, as opening a group
 * without attributes would request its missing `.zattrs`. Groups inside a
 * pyramid found are not searched. Every group is checked so that, of several
 * pyramids, the console lists them all and says which (the shallowest) is
 * read.
 */
async function findMultiscalesGroup(
  store: zarr.Listable<zarr.AsyncReadable>,
  root: zarr.Group<zarr.AsyncReadable>,
  opened: zarr.Group<zarr.AsyncReadable>,
  groupPath: string,
  zarrFormat: TZarrFormat
) {
  if (parseMultiscales(opened.attrs).length > 0) {
    return { path: groupPath, group: opened };
  }
  const prefix = groupPath ? `${groupPath}/` : "";
  const depth = (path: string) => path.split("/").length;
  const paths = store
    .contents()
    .filter(({ kind }) => kind === "group")
    .map(({ path }) => trim(path, "/"))
    .filter((path) => path !== "" && path.startsWith(prefix))
    .sort((a, b) => depth(a) - depth(b));
  const consolidated =
    zarrFormat === ZARR_FORMAT.V2
      ? await consolidatedV2Metadata(store)
      : undefined;
  const found: { path: string; group: zarr.Group<zarr.AsyncReadable> }[] = [];
  for (const path of paths) {
    if (
      found.some((pyramid) => path.startsWith(`${pyramid.path}/`)) ||
      (consolidated &&
        parseMultiscales(
          (consolidated[`${path}/.zattrs`] ?? {}) as Record<string, unknown>
        ).length === 0)
    ) {
      continue;
    }
    const group = await zarr
      .open(root.resolve(`/${path}`), { kind: "group" })
      .catch(() => null);
    if (group && parseMultiscales(group.attrs).length > 0) {
      found.push({ path, group });
    }
  }
  if (found.length > 1) {
    console.info(
      `Several groups declare multiscales (${found.map(({ path }) => path).join(", ")}); reading the levels of "${found[0].path}".`
    );
  }
  return found[0];
}

/** The group of a declared level, from the store root. */
function levelGroupPath(pyramidPath: string, entry: TMultiscaleEntry) {
  return [pyramidPath, entry.path]
    .map((part) => trim(part, "/"))
    .filter(Boolean)
    .join("/");
}

/**
 * The levels a pyramid's `multiscales` attribute declares. Items naming an
 * array of a level (`asset: "18/b02"`) are folded into their parent group,
 * which the store's listing tells apart from a level group.
 */
function pyramidEntries(
  store: zarr.Listable<zarr.AsyncReadable>,
  pyramid: { path: string; group: zarr.Group<zarr.AsyncReadable> }
) {
  const arrays = new Set(
    store
      .contents()
      .filter(({ kind }) => kind === "array")
      .map(({ path }) => trim(path, "/"))
  );
  return groupArrayAssets(parseMultiscales(pyramid.group.attrs), (asset) =>
    arrays.has(levelGroupPath(pyramid.path, { path: asset }))
  );
}

/**
 * Keep the arrays of the dataset outside every declared level group (next
 * to the levels, or in groups that are not levels) as variables without
 * levels, in every level's variables, so they stay listed whichever level
 * is selected.
 */
async function addVariablesWithoutLevels(
  store: zarr.Listable<zarr.AsyncReadable>,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string,
  groupPath: string,
  opened: zarr.Group<zarr.AsyncReadable>,
  pyramid: {
    path: string;
    group: zarr.Group<zarr.AsyncReadable>;
    levels: TSourceLevel[];
  }
) {
  const levelPaths = pyramidEntries(store, pyramid).map((entry) =>
    levelGroupPath(pyramid.path, entry)
  );
  const others = await processZarrVariables(
    store,
    root,
    src,
    groupPath,
    (path) => !levelPaths.some((level) => path.startsWith(`/${level}/`))
  );
  for (const source of Object.values(others)) {
    source.groupAttrs = opened.attrs;
  }
  hideFormulaTermVariablesWithoutStandardName(others);
  for (const level of pyramid.levels) {
    Object.assign(level.datasources, others);
  }
}

/**
 * Index a group whose `multiscales` attribute declares a pyramid: one level
 * per declared child group that holds arrays, finest first. The attribute
 * may sit on the opened group or on a group below it (see
 * findMultiscalesGroup); its paths are relative to the group carrying it. A
 * level that fails to index is left out, and a group left with fewer than
 * two levels is indexed as a single level by the caller, as it was before
 * levels existed.
 * A zarr-conventions layout may describe the arrays of the levels instead of
 * the level groups (`asset: "18/b02"`): those are read as one level per
 * parent group (see pyramidEntries).
 */
async function indexLevels(
  store: zarr.Listable<zarr.AsyncReadable>,
  root: zarr.Group<zarr.AsyncReadable>,
  src: string,
  zarrFormat: TZarrFormat,
  groupPath = ""
): Promise<TSources | null> {
  // On failure the single-level path opens the group again and reports it.
  const opened = groupPath
    ? await zarr
        .open(root.resolve(`/${groupPath}`), { kind: "group" })
        .catch(() => null)
    : root;
  const pyramid =
    opened &&
    (await findMultiscalesGroup(store, root, opened, groupPath, zarrFormat));
  if (!pyramid) {
    return null;
  }
  const entries = pyramidEntries(store, pyramid);
  const levels: TSourceLevel[] = [];
  for (const entry of entries) {
    const level = await indexLevel(
      store,
      root,
      src,
      pyramid.group.attrs,
      entry,
      levelGroupPath(pyramid.path, entry),
      groupPath
    ).catch(() => null);
    if (level) {
      levels.push(level);
    }
  }
  if (levels.length < 2) {
    return null;
  }
  await addVariablesWithoutLevels(store, root, src, groupPath, opened!, {
    ...pyramid,
    levels,
  });
  return {
    name: (opened!.attrs.title ?? pyramid.group.attrs.title) as string,
    zarr_format: zarrFormat, // eslint-disable-line camelcase
    levels: sortFinestFirst(levels),
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
      hidden: dimensions.has(varname) || !isValidVariable(varname, array),
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
    { ...root.attrs, title: String(root.attrs.title ?? file.name) },
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
  const levels = await indexLevels(
    store,
    root,
    storePath,
    ZARR_FORMAT.ICECHUNK,
    groupPath
  );
  if (levels) {
    return levels;
  }
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
    group.attrs,
    datasources,
    storePath,
    ZARR_FORMAT.ICECHUNK,
    groupPath
  );
}

async function indexFromReference(src: string): Promise<TSources> {
  const { storePath, groupPath } = splitReferenceStoreAndGroup(src);
  const store = await createReferenceStore(storePath);
  const format = store.zarrFormat === 2 ? ZARR_FORMAT.V2 : ZARR_FORMAT.V3;
  const root = await zarr.open(store, { kind: "group" });
  const levels = await indexLevels(store, root, storePath, format, groupPath);
  if (levels) {
    return levels;
  }
  const group = groupPath
    ? await zarr.open(root.resolve(groupPath), { kind: "group" })
    : root;
  const datasources = await processZarrVariables(
    store,
    root,
    storePath,
    groupPath
  );
  return createIndex(group.attrs, datasources, storePath, format, groupPath);
}

export async function indexFromZarr(src: string): Promise<TSources> {
  if (isReferenceStorePath(src)) {
    return indexFromReference(src);
  }
  if (isIcechunkStorePath(src)) {
    return indexFromIcechunk(src);
  }
  try {
    const store = await zarr.withConsolidatedMetadata(
      await ZarrDataManager.createNewStore(src),
      { format: "v2" }
    );
    const root = await zarr.open(store, { kind: "group" });
    const levels = await indexLevels(store, root, src, ZARR_FORMAT.V2);
    if (levels) {
      return levels;
    }
    const datasources = await processZarrVariables(store, root, src);
    return createIndex(root.attrs, datasources, src, ZARR_FORMAT.V2);
  } catch {
    try {
      const store = await zarr.withConsolidatedMetadata(
        await ZarrDataManager.createNewStore(src),
        { format: "v3" }
      );
      const root = await zarr.open(store, { kind: "group" });
      const levels = await indexLevels(store, root, src, ZARR_FORMAT.V3);
      if (levels) {
        return levels;
      }
      const datasources = await processZarrVariables(store, root, src);
      return createIndex(root.attrs, datasources, src, ZARR_FORMAT.V3);
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
      datasources[varname].groupAttrs = root.attrs;
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

async function enrichLevel(
  datasources: Record<string, TDataSource>
): Promise<TZarrFormat> {
  const stores = collectStores(datasources);
  let format: TZarrFormat = ZARR_FORMAT.V3;
  try {
    await enrichMetadata(stores, datasources, "v3");
  } catch {
    await enrichMetadata(stores, datasources, "v2");
    format = ZARR_FORMAT.V2;
  }
  hideFormulaTermVariablesWithoutStandardName(datasources);
  return format;
}

export async function indexFromIndex(src: string): Promise<TSources> {
  const res = await fetch(src);
  if (!res.ok) {
    throw new Error(`Failed to fetch index from ${src}: ${res.statusText}`);
  } else if (res.status >= 400) {
    throw new Error(`Index not found at ${src}`);
  }
  const sources = (await res.json()) as TSources;
  const [base, ...finer] = sources.levels;
  sources.zarr_format = await enrichLevel(base.datasources); // eslint-disable-line camelcase
  // A further level whose stores cannot be read is left out rather than
  // failing an index whose first level loads.
  const enriched = await Promise.all(
    finer.map((level) =>
      enrichLevel(level.datasources).then(
        () => level,
        () => null
      )
    )
  );
  sources.levels = sortFinestFirst([
    base,
    ...enriched.filter((level): level is TSourceLevel => level !== null),
  ]);
  return sources;
}
