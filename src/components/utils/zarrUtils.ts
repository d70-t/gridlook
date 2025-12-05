import type { TSources } from "@/types/GlobeTypes";
import * as zarr from "zarrita";

export function getDataSourceStore(datasources: TSources, varname: string) {
  const datasource = datasources.levels[0].datasources[varname];
  return zarr.root(
    new zarr.FetchStore(
      (datasource.store.endsWith("/")
        ? datasource.store.slice(0, -1)
        : datasource.store) +
        "/" +
        datasource.dataset
    )
  );
}

export async function findCRSVar(root: zarr.FetchStore, varname: string) {
  const datavar = await zarr.open(root.resolve(varname), {
    kind: "array",
  });
  if (datavar.attrs?.grid_mapping) {
    return String(datavar.attrs.grid_mapping).split(":")[0];
  }
  const group = await zarr.open(root, { kind: "group" });
  if (group.attrs?.grid_mapping) {
    return String(group.attrs.grid_mapping).split(":")[0];
  }
  return "crs";
}

export async function getArrayInfo(root: zarr.FetchStore, varname: string) {
  const array = await zarr.open(root.resolve(varname), { kind: "array" });
  const obje = {
    shape: array.shape,
    dimensions: array.attrs._ARRAY_DIMENSIONS,
  };
  return obje;
}

export function getMissingValue(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  const attributes = datavar.attrs;
  if (Object.hasOwn(attributes, "missingValue")) {
    return Number(attributes.missingValue);
  }
  if (Object.hasOwn(attributes, "missing_value")) {
    return Number(attributes.missing_value);
  }
  return NaN;
}

export function getFillValue(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  const symbols = Object.getOwnPropertySymbols(datavar);
  const contextSymbol = symbols.find(
    (sym) => sym.toString() === "Symbol(zarrita.context)"
  );
  if (!contextSymbol) return NaN;
  // FIXME
  // @ts-expect-error This context symbol is not publicly exposed in the documentation
  const obj = datavar[contextSymbol];
  return Number(obj.fill_value);
}

export function isLongitude(name: string) {
  // FIXME: Need to check for unit later
  // having "rlon" here is a workaround to catch rotated regular grids if the have no CRS-var
  return name === "lon" || name === "longitude" || name === "rlon";
}

export function isLatitude(name: string) {
  // FIXME: Need to check for unit later
  // having "rlat" here is a workaround to catch rotated regular grids if the have no CRS-var
  return name === "lat" || name === "latitude" || name === "rlat";
}

export async function getLatLonData(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  datasources: TSources | undefined
) {
  const gridsource = datasources!.levels[0].grid;
  const gridRoot = zarr.root(new zarr.FetchStore(gridsource.store));
  const grid = await zarr.open(gridRoot.resolve(gridsource.dataset), {
    kind: "group",
  });
  const coordinates = datavar.attrs.coordinates as string;
  let latitudeName: string | null = null;
  let longitudeName: string | null = null;
  if (coordinates) {
    const coordNames = coordinates.split(" ");
    for (const coordName of coordNames) {
      if (isLatitude(coordName)) {
        latitudeName = coordName;
      } else if (isLongitude(coordName)) {
        longitudeName = coordName;
      }
    }
  }
  // Fallback to standard names
  if (!latitudeName) {
    latitudeName = "lat";
  }
  if (!longitudeName) {
    longitudeName = "lon";
  }
  const latitudesVar = await zarr.open(grid.resolve(latitudeName), {
    kind: "array",
  });
  const latitudes = await zarr.get(latitudesVar);

  const longitudesVar = await zarr.open(grid.resolve(longitudeName), {
    kind: "array",
  });
  const longitudes = await zarr.get(longitudesVar);

  return {
    latitudesAttrs: latitudesVar.attrs,
    latitudes,
    longitudesAttrs: longitudesVar.attrs,
    longitudes,
  };
}

export function getDataBounds(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  data: Float32Array<ArrayBufferLike>
) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  const missingValue = getMissingValue(datavar);
  const fillValue = getFillValue(datavar);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === missingValue || v === fillValue) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (min === Number.POSITIVE_INFINITY) {
    min = NaN;
  }
  if (max === Number.NEGATIVE_INFINITY) {
    max = NaN;
  }
  return {
    min: min,
    max: max,
    fillValue: fillValue,
    missingValue: missingValue,
  };
}
/**
 * Gridlook cannot handle Float64 and integer types in textures, so cast to Float32
 */
export function castDataVarToFloat32(
  rawData:
    | unknown[]
    | Int8Array<ArrayBufferLike>
    | Int16Array<ArrayBufferLike>
    | Int32Array<ArrayBufferLike>
    | BigInt64Array<ArrayBufferLike>
    | Uint8Array<ArrayBufferLike>
    | Uint16Array<ArrayBufferLike>
    | Uint32Array<ArrayBufferLike>
    | BigUint64Array<ArrayBufferLike>
    | Float32Array<ArrayBufferLike>
    | Float64Array<ArrayBufferLike>
    | zarr.BoolArray
    | zarr.UnicodeStringArray
    | zarr.ByteStringArray
    | zarr.Chunk<zarr.DataType>
) {
  if (
    rawData instanceof Float64Array ||
    rawData instanceof Int32Array ||
    rawData instanceof Int16Array ||
    rawData instanceof Uint16Array ||
    rawData instanceof Uint8Array
  ) {
    return Float32Array.from(rawData);
  }
  return rawData as Float32Array;
}
