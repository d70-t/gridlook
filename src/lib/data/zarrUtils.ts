import * as zarr from "zarrita";

import { ZarrDataManager } from "./ZarrDataManager";

import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes";
import trim from "@/utils/trim";

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
  if (!contextSymbol) {
    return NaN;
  }
  // FIXME
  // @ts-expect-error This context symbol is not publicly exposed in the documentation
  const obj = datavar[contextSymbol];
  return Number(obj.fill_value);
}

/**
 * Create a predicate that returns true when a value equals the dataset's
 * missing or fill value (or is NaN).
 */
export function createMissingOrFillPredicate(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  const missingValue = getMissingValue(datavar);
  const fillValue = getFillValue(datavar);
  return (value: number) => {
    if (Number.isNaN(value)) {
      return true;
    }
    if (!Number.isNaN(missingValue) && value === missingValue) {
      return true;
    }
    if (!Number.isNaN(fillValue) && value === fillValue) {
      return true;
    }
    return false;
  };
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

function findLatLonNames(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  isRotated = false
) {
  // Try to find standard names first
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
  } else {
    (datavar.attrs._ARRAY_DIMENSIONS as string[]).forEach((dimName: string) => {
      if (isLatitude(dimName)) {
        latitudeName = dimName;
      } else if (isLongitude(dimName)) {
        longitudeName = dimName;
      }
    });
  }
  // Fallback to standard names
  if (!latitudeName) {
    latitudeName = "lat";
  }
  if (!longitudeName) {
    longitudeName = "lon";
  }
  return { latitudeName, longitudeName };
}

async function getZarrV3Attributes(
  storeName: string,
  varname: string
): Promise<zarr.Attributes> {
  const store = new zarr.FetchStore(trim(storeName) + "/" + trim(varname));
  const group = await ZarrDataManager.openZarrV3Metadata(store);
  const v3Attributes = group.attrs;
  if (v3Attributes.dimension_names) {
    v3Attributes._ARRAY_DIMENSIONS = v3Attributes.dimension_names;
  }
  return v3Attributes;
}

export async function getLatLonData(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  datasources: TSources | undefined,
  isRotated = false
) {
  const { latitudeName, longitudeName } = findLatLonNames(datavar, isRotated);
  const gridsource = datasources!.levels[0].grid;

  let latV3Attributes: zarr.Attributes = {};
  let lonV3Attributes: zarr.Attributes = {};
  if (datasources?.zarr_format === ZARR_FORMAT.V3) {
    latV3Attributes = await getZarrV3Attributes(gridsource.store, latitudeName);
    lonV3Attributes = await getZarrV3Attributes(
      gridsource.store,
      longitudeName
    );
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
    latitudesAttrs: { ...latitudesVar.attrs, ...latV3Attributes },
    latitudes,
    longitudesAttrs: { ...longitudesVar.attrs, ...lonV3Attributes },
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
    if (v === missingValue || v === fillValue) {
      continue;
    }
    if (v < min) {
      min = v;
    }
    if (v > max) {
      max = v;
    }
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
