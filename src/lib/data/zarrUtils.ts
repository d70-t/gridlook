import * as zarr from "zarrita";

import { ZarrDataManager } from "./ZarrDataManager";

import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes";
import trim from "@/utils/trim";

export function getMissingValue(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  const attributes = datavar.attrs;
  if (Object.hasOwn(attributes, "missingValue")) {
    return new Float32Array([Number(attributes.missingValue)])[0];
  }
  if (Object.hasOwn(attributes, "missing_value")) {
    return new Float32Array([Number(attributes.missing_value)])[0];
  }
  return NaN;
}

/**
 * Retrieves the fill value from a Zarr array, normalizing across different
 * naming conventions ("fillValue", "fill_value", "_FillValue", "_fillvalue")
 * that various tools and conventions (Zarr v2, CF conventions, xarray, etc.)
 * may use to store it in the metadata attributes.
 *
 * If no fill value is found in the attributes, we fall back to the internal
 * Zarr context object (not publicly documented) which always holds the
 * canonical fill_value. The result is cast through Float32Array to reproduce
 * the float32 rounding artifact (e.g. -1e30 → -1.0000000150474662e+30),
 * ensuring the value matches what is actually stored in the binary data.
 */
export function getFillValue(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  const attributes = datavar.attrs;
  if (Object.hasOwn(attributes, "fillValue")) {
    return new Float32Array([Number(attributes.fillValue)])[0];
  }
  if (Object.hasOwn(attributes, "fill_value")) {
    return new Float32Array([Number(attributes.fill_value)])[0];
  }
  if (Object.hasOwn(attributes, "_FillValue")) {
    return new Float32Array([Number(attributes._FillValue)])[0];
  }
  if (Object.hasOwn(attributes, "_fillvalue")) {
    return new Float32Array([Number(attributes._fillvalue)])[0];
  }
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
  return new Float32Array([Number(obj.fill_value)])[0];
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

export function hasUnits(
  maybeHasUnits: unknown
): maybeHasUnits is { units: string } {
  if (typeof maybeHasUnits !== "object" || maybeHasUnits === null) {
    return false;
  }
  return typeof (maybeHasUnits as { units: string }).units === "string";
}

export function isLongitudeVariable(name: string, attrs: unknown) {
  return (
    (hasUnits(attrs) && !!attrs.units.match(/degrees?_?(E|east)/)) ||
    name === "lon" ||
    name === "longitude"
  );
}

export function isLongitudeName(name: string) {
  // FIXME: Need to check for unit later
  // having "rlon" here is a workaround to catch rotated regular grids if the have no CRS-var
  return name === "lon" || name === "longitude" || name === "rlon";
}

export function isLatitudeVariable(name: string, attrs: unknown) {
  return (
    (hasUnits(attrs) && !!attrs.units.match(/degrees?_?(N|north)/)) ||
    name === "lat" ||
    name === "latitude"
  );
}
export function isLatitudeName(name: string) {
  // FIXME: Need to check for unit later
  // having "rlat" here is a workaround to catch rotated regular grids if the have no CRS-var
  return name === "lat" || name === "latitude" || name === "rlat";
}

function lonPriority(name: string) {
  if (name === "rlon") {
    return 0;
  }
  if (name === "lon") {
    return 1;
  }
  if (name === "longitude") {
    return 2;
  }
  return 3;
}

function latPriority(name: string) {
  if (name === "rlat") {
    return 0;
  }
  if (name === "lat") {
    return 1;
  }
  if (name === "latitude") {
    return 2;
  }
  return 3;
}

function resolveLatLonFromCoordinates(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  isRotated: boolean
): { latitudeName: string | null; longitudeName: string | null } {
  const coordinates = isRotated
    ? "rlon rlat"
    : (datavar.attrs.coordinates as string);
  let latitudeName: string | null = null;
  let longitudeName: string | null = null;
  if (coordinates) {
    for (const coordName of coordinates.split(" ")) {
      if (isLatitudeName(coordName)) {
        latitudeName = coordName;
      } else if (isLongitudeName(coordName)) {
        longitudeName = coordName;
      }
    }
  } else {
    (datavar.attrs._ARRAY_DIMENSIONS as string[]).forEach((dimName: string) => {
      if (isLatitudeName(dimName)) {
        latitudeName = dimName;
      } else if (isLongitudeName(dimName)) {
        longitudeName = dimName;
      }
    });
  }
  return { latitudeName, longitudeName };
}

function refineLatLonFromSources(
  sources: TSources["levels"][0]["datasources"],
  latitudeName: string | null,
  longitudeName: string | null
): { latitudeName: string | null; longitudeName: string | null } {
  for (const sourceKey in sources) {
    if (isLatitudeVariable(sourceKey, sources[sourceKey].attrs)) {
      if (
        latitudeName === null ||
        latPriority(sourceKey) < latPriority(latitudeName)
      ) {
        latitudeName = sourceKey;
      }
    } else if (isLongitudeVariable(sourceKey, sources[sourceKey].attrs)) {
      if (
        longitudeName === null ||
        lonPriority(sourceKey) < lonPriority(longitudeName)
      ) {
        longitudeName = sourceKey;
      }
    }
  }
  return { latitudeName, longitudeName };
}

/**
 * This function search for the names of the latitude and longitude variables based on the following behaviour:
 * 1. Get the "coordinates" attribute of the data variable. If the grid is rotated,
 * we enforce "rlon rlat" as the coordinates
 * 2. If 1. failed, use the "_ARRAY_DIMENSIONS" attribute of the data variable
 * 3. We search for variables with longitude/latitude-like names found in the steps 1. and 2. and take
 * 4. If we still don't have lat/lon names, we search for any variable with
 * longitude/latitude-like names and the appropriate unit. If multiple
 * candidates are found (e.g. a variable "lat_vertices" and a variable "lat",
 * both having "degrees_north" as units), we prioritize based on the variable
 * name (e.g., "lat" is preferred over "lat_vertices")
 *
 * FIXME: This function is a heuristic and may fail in some edge cases.
 */
function findLatLonNames(
  datasources: TSources,
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  isRotated = false
) {
  let { latitudeName, longitudeName } = resolveLatLonFromCoordinates(
    datavar,
    isRotated
  );

  // (re-)assign lat/lon names from sources using priority ordering:
  // Longitude: rlon > lon > longitude > anything else
  // Latitude:  rlat > lat > latitude  > anything else
  if (!latitudeName || !longitudeName) {
    ({ latitudeName, longitudeName } = refineLatLonFromSources(
      datasources.levels[0].datasources,
      latitudeName,
      longitudeName
    ));
  }

  return {
    latitudeName: latitudeName ?? "lat",
    longitudeName: longitudeName ?? "lon",
  };
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

function applyScaleFactor(
  data?: zarr.Chunk<zarr.DataType>,
  attributes?: zarr.Attributes
) {
  if (data && attributes?.scale_factor) {
    const scaleFactor = Number(attributes.scale_factor);
    data.data = (data.data as Float32Array).map((v) => v * scaleFactor);
  }
}

async function fetchLatLonVariables(
  datasources: TSources,
  latitudeName: string,
  longitudeName: string
) {
  const gridsource = datasources.levels[0].grid;

  let latV3Attributes: zarr.Attributes = {};
  let lonV3Attributes: zarr.Attributes = {};
  if (datasources.zarr_format === ZARR_FORMAT.V3) {
    latV3Attributes = await getZarrV3Attributes(gridsource.store, latitudeName);
    try {
      lonV3Attributes = await getZarrV3Attributes(
        gridsource.store,
        longitudeName
      );
    } catch {
      // Longitude may not exist for lat-only datasets
    }
  }

  const latitudesVar = await ZarrDataManager.getVariableInfo(
    gridsource,
    latitudeName
  );

  let longitudesVar: zarr.Array<zarr.DataType, zarr.FetchStore> | null = null;
  try {
    longitudesVar = await ZarrDataManager.getVariableInfo(
      gridsource,
      longitudeName
    );
  } catch {
    // Longitude variable doesn't exist - this is a lat-only dataset
  }

  return { latitudesVar, longitudesVar, latV3Attributes, lonV3Attributes };
}

export async function getLatLonData(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  datasources: TSources | undefined,
  isRotated = false
) {
  const { latitudeName, longitudeName } = findLatLonNames(
    datasources!,
    datavar,
    isRotated
  );

  const { latitudesVar, longitudesVar, latV3Attributes, lonV3Attributes } =
    await fetchLatLonVariables(datasources!, latitudeName, longitudeName);

  const latitudes =
    await ZarrDataManager.getVariableDataFromArray(latitudesVar);

  let longitudes: zarr.Chunk<zarr.DataType> | null = null;
  if (longitudesVar) {
    longitudes = await ZarrDataManager.getVariableDataFromArray(longitudesVar);
  }

  const returnObject = {
    latitudesAttrs: { ...latitudesVar.attrs, ...latV3Attributes },
    latitudes,
    longitudesAttrs: longitudesVar
      ? { ...longitudesVar.attrs, ...lonV3Attributes }
      : null,
    longitudes,
  };

  applyScaleFactor(returnObject.latitudes, returnObject.latitudesAttrs);
  applyScaleFactor(
    returnObject.longitudes ?? undefined,
    returnObject.longitudesAttrs ?? undefined
  );

  return returnObject;
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
    if (v === missingValue || v === fillValue || !Number.isFinite(v)) {
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
    rawData instanceof Int8Array ||
    rawData instanceof Uint16Array ||
    rawData instanceof Uint8Array
  ) {
    return Float32Array.from(rawData);
  }
  return rawData as Float32Array;
}
