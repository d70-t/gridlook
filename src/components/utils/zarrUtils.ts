import type { TSources } from "@/types/GlobeTypes";
import * as zarr from "zarrita";
import { ZarrDataManager } from "./ZarrDataManager";

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
  datasources: TSources | undefined,
  isRotated = false
) {
  const gridsource = datasources!.levels[0].grid;

  // we simply hardcode rlon and rlat if we know it's rotated
  const coordinates = isRotated
    ? "rlon rlat"
    : (datavar.attrs.coordinates as string);
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

  const latitudesVar = await ZarrDataManager.getVariableInfo(
    gridsource,
    latitudeName
  );
  const longitudesVar = await ZarrDataManager.getVariableInfo(
    gridsource,
    longitudeName
  );

  const latitudes =
    await ZarrDataManager.getVariableDataFromArray(latitudesVar);
  const longitudes =
    await ZarrDataManager.getVariableDataFromArray(longitudesVar);

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
