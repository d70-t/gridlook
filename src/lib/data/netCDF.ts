import {
  NetCDF4,
  resolveDim,
  type DimSelection,
} from "@earthyscience/netcdf4-wasm";
import type * as zarr from "zarrita";

import netCDFWasmPath from "../../../node_modules/@earthyscience/netcdf4-wasm/dist/netcdf4-wasm.wasm?url";

import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

const NETCDF_DTYPE = {
  i1: "int8",
  i2: "int16",
  i4: "int32",
  i8: "int64",
  u1: "uint8",
  u2: "uint16",
  u4: "uint32",
  u8: "uint64",
  f4: "float32",
  f8: "float64",
  S1: "string",
  str: "string",
} as const;

type TNetCDFDtype = keyof typeof NETCDF_DTYPE;

type TNetCDFVariableMetadata = {
  name: string;
  dtype: string;
  dtype_base?: string;
  shape: number[];
  dimensions: string[];
  attributes: Record<string, unknown>;
  chunks?: number[];
};

type TNetCDFGroupTree = Record<string, { subgroups: TNetCDFGroupTree }>;

type TNetCDFContext = {
  dataset: NetCDF4;
  groups: Map<string, Promise<NetCDFGroup>>;
  arrays: Map<string, Promise<NetCDFArray>>;
  variableNames: Map<string, Promise<Set<string>>>;
};

let activeStore: string | null = null;
let pendingContext: Promise<TNetCDFContext> | null = null;

function normalizePath(path: string) {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `/${normalized}` : "/";
}

function resolvePath(parent: string, child: string) {
  if (child.startsWith("/")) {
    return normalizePath(child);
  }
  return normalizePath(`${parent}/${child}`);
}

function splitVariablePath(path: string) {
  const normalized = normalizePath(path);
  const separator = normalized.lastIndexOf("/");
  return {
    groupPath: separator === 0 ? "/" : normalized.slice(0, separator),
    variable: normalized.slice(separator + 1),
  };
}

function normalizeAttribute(value: unknown): unknown {
  if (ArrayBuffer.isView(value) && "length" in value) {
    const values = Array.from(value as unknown as ArrayLike<unknown>);
    return values.length === 1 ? values[0] : values;
  }
  if (Array.isArray(value) && value.length === 1) {
    return value[0];
  }
  return value;
}

function normalizeAttributes(attributes: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(attributes).map(([name, value]) => [
      name,
      normalizeAttribute(value),
    ])
  );
}

function getDtype(metadata: TNetCDFVariableMetadata): zarr.DataType {
  const dtype =
    metadata.dtype_base ?? metadata.dtype.replace(/^enum\((.*)\)$/, "$1");
  if (!Object.hasOwn(NETCDF_DTYPE, dtype)) {
    throw new Error(`Unsupported NetCDF data type: ${metadata.dtype}`);
  }
  return NETCDF_DTYPE[dtype as TNetCDFDtype];
}

function getSelectionShape(
  shape: readonly number[],
  selection: DimSelection[]
) {
  const selectedShape: number[] = [];
  for (let i = 0; i < shape.length; i++) {
    const resolved = resolveDim(selection[i] ?? null, shape[i]);
    if (!resolved.collapsed) {
      selectedShape.push(resolved.count);
    }
  }
  return selectedShape;
}

function getStride(shape: readonly number[]) {
  const stride = new Array<number>(shape.length);
  let value = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    stride[i] = value;
    value *= shape[i];
  }
  return stride;
}

async function createContext(file: File): Promise<TNetCDFContext> {
  const dataset = await NetCDF4.fromBlob(file, "r", {
    wasmPath: netCDFWasmPath,
  });
  return {
    dataset,
    groups: new Map(),
    arrays: new Map(),
    variableNames: new Map(),
  };
}

async function getContext(file: File, store: string) {
  if (!pendingContext || activeStore !== store) {
    const previousContext = pendingContext;
    activeStore = store;
    pendingContext = createContext(file).catch((error) => {
      if (activeStore === store) {
        activeStore = null;
        pendingContext = null;
      }
      throw error;
    });
    // Gridlook displays one local dataset at a time. Close the previous WASM
    // file here; use a keyed map if multi-file local indexes are added later.
    void previousContext
      ?.then(({ dataset }) => dataset.close())
      .catch(() => {});
  }
  return await pendingContext;
}

export class NetCDFGroup {
  readonly kind = "group";
  readonly format = ZARR_FORMAT.NETCDF;

  constructor(
    readonly context: TNetCDFContext,
    readonly path: string,
    readonly attrs: zarr.Attributes
  ) {}
}

export class NetCDFArray {
  readonly kind = "array";
  readonly format = ZARR_FORMAT.NETCDF;
  readonly fillValue: zarr.Scalar<zarr.DataType> | null;

  constructor(
    readonly context: TNetCDFContext,
    readonly path: string,
    readonly attrs: zarr.Attributes,
    readonly shape: number[],
    readonly chunks: number[],
    readonly dtype: zarr.DataType,
    readonly dimensionNames: string[]
  ) {
    this.fillValue = (attrs._FillValue as zarr.Scalar<zarr.DataType>) ?? null;
  }
}

export async function openNetCDFGroup(file: File, store: string, path = "/") {
  const context = await getContext(file, store);
  const groupPath = normalizePath(path);
  let group = context.groups.get(groupPath);
  if (!group) {
    group = context.dataset
      .getGlobalAttributes(groupPath)
      .then(
        (attrs) =>
          new NetCDFGroup(context, groupPath, normalizeAttributes(attrs))
      );
    context.groups.set(groupPath, group);
  }
  return await group;
}

export async function resolveNetCDFGroup(group: NetCDFGroup, path: string) {
  const groupPath = resolvePath(group.path, path);
  let child = group.context.groups.get(groupPath);
  if (!child) {
    child = group.context.dataset
      .getGlobalAttributes(groupPath)
      .then(
        (attrs) =>
          new NetCDFGroup(group.context, groupPath, normalizeAttributes(attrs))
      );
    group.context.groups.set(groupPath, child);
  }
  return await child;
}

async function getVariableNames(context: TNetCDFContext, groupPath: string) {
  let names = context.variableNames.get(groupPath);
  if (!names) {
    names = context.dataset.getFullMetadata(groupPath).then((variables) => {
      const result = new Set<string>();
      for (const value of variables) {
        const name = (value as Partial<TNetCDFVariableMetadata>).name;
        if (typeof name === "string") {
          result.add(name);
        }
      }
      return result;
    });
    context.variableNames.set(groupPath, names);
  }
  return await names;
}

export async function openNetCDFArray(
  group: NetCDFGroup,
  variablePath: string
) {
  const path = resolvePath(group.path, variablePath);
  let array = group.context.arrays.get(path);
  if (!array) {
    const { groupPath, variable } = splitVariablePath(path);
    array = (async () => {
      const names = await getVariableNames(group.context, groupPath);
      if (!names.has(variable)) {
        throw new Error(`NetCDF variable not found: ${path}`);
      }
      const value = await group.context.dataset.getVariableInfo(
        variable,
        groupPath
      );
      const metadata = value as TNetCDFVariableMetadata;
      const attrs = normalizeAttributes(metadata.attributes ?? {});
      return new NetCDFArray(
        group.context,
        path,
        attrs,
        [...metadata.shape],
        [...(metadata.chunks ?? metadata.shape)],
        getDtype(metadata),
        [...metadata.dimensions]
      );
    })();
    group.context.arrays.set(path, array);
  }
  return await array;
}

export async function getNetCDFArray(
  array: NetCDFArray,
  selection: (number | null | zarr.Slice)[] = []
) {
  if (selection.length > array.shape.length) {
    throw new Error(
      `Selection has ${selection.length} dimensions but variable has ${array.shape.length}.`
    );
  }
  const fullSelection = new Array<DimSelection>(array.shape.length).fill(null);
  for (let i = 0; i < selection.length; i++) {
    fullSelection[i] = selection[i] as DimSelection;
  }
  const { groupPath, variable } = splitVariablePath(array.path);
  const shape = getSelectionShape(array.shape, fullSelection);
  const data = await array.context.dataset.get(
    variable,
    fullSelection,
    groupPath
  );
  return {
    data: data as zarr.TypedArray<zarr.DataType>,
    shape,
    stride: getStride(shape),
  };
}

function collectGroupPaths(
  groups: TNetCDFGroupTree,
  parentPath: string,
  paths: string[]
) {
  for (const [name, group] of Object.entries(groups)) {
    const path = resolvePath(parentPath, name);
    paths.push(path);
    collectGroupPaths(group.subgroups, path, paths);
  }
}

export async function listNetCDFArrays(file: File, store: string) {
  const root = await openNetCDFGroup(file, store);
  const groups =
    (await root.context.dataset.getGroupsRecursive()) as TNetCDFGroupTree;
  const groupPaths = ["/"];
  collectGroupPaths(groups, "/", groupPaths);

  const arrays: NetCDFArray[] = [];
  for (const groupPath of groupPaths) {
    const group = await resolveNetCDFGroup(root, groupPath);
    const variableNames = await getVariableNames(root.context, groupPath);
    for (const variable of variableNames) {
      arrays.push(await openNetCDFArray(group, variable));
    }
  }
  return arrays;
}

export async function invalidateNetCDFCache() {
  const context = pendingContext;
  activeStore = null;
  pendingContext = null;
  if (context) {
    await context.then(({ dataset }) => dataset.close()).catch(() => {});
  }
}

export type TNetCDFBackend = {
  getArray: typeof getNetCDFArray;
  invalidateCache: typeof invalidateNetCDFCache;
  openArray: typeof openNetCDFArray;
  openGroup: typeof openNetCDFGroup;
  resolveGroup: typeof resolveNetCDFGroup;
};
