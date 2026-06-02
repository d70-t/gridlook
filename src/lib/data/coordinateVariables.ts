import * as zarr from "zarrita";

import { decodeVariableChunkInPlace } from "./variableDecoding.ts";
import { ZarrDataManager } from "./ZarrDataManager.ts";

import { type TSources } from "@/lib/types/GlobeTypes.ts";

type TLatLonNames = {
  latitudeName: string | null;
  longitudeName: string | null;
};

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
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  isRotated: boolean
): TLatLonNames {
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
    (datavar.dimensionNames as string[]).forEach((dimName: string) => {
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
): TLatLonNames {
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
 * 2. If 1. failed, use the "dimensionNames" attribute of the data variable
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
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
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

async function fetchLatLonVariables(
  datasources: TSources,
  latitudeName: string,
  longitudeName: string
) {
  const gridsource = datasources.levels[0].grid;

  const latitudesVar = await ZarrDataManager.getVariableInfo(
    gridsource,
    latitudeName
  );

  let longitudesVar: zarr.Array<zarr.DataType, zarr.AsyncReadable> | null =
    null;
  try {
    longitudesVar = await ZarrDataManager.getVariableInfo(
      gridsource,
      longitudeName
    );
  } catch {
    // Longitude variable doesn't exist - this is a lat-only dataset
  }

  return { latitudesVar, longitudesVar };
}

export async function getLatLonData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  datasources: TSources | undefined,
  isRotated = false
) {
  const { latitudeName, longitudeName } = findLatLonNames(
    datasources!,
    datavar,
    isRotated
  );

  const { latitudesVar, longitudesVar } = await fetchLatLonVariables(
    datasources!,
    latitudeName,
    longitudeName
  );

  const latitudes =
    await ZarrDataManager.getVariableDataFromArray(latitudesVar);

  let longitudes: zarr.Chunk<zarr.DataType> | null = null;
  if (longitudesVar) {
    longitudes = await ZarrDataManager.getVariableDataFromArray(longitudesVar);
  }

  const returnObject = {
    latitudesAttrs: {
      dimensionNames: latitudesVar.dimensionNames,
      ...latitudesVar.attrs,
    },
    latitudes,
    longitudesAttrs: longitudesVar
      ? { dimensionNames: longitudesVar.dimensionNames, ...longitudesVar.attrs }
      : null,
    longitudes,
  };

  decodeVariableChunkInPlace(
    returnObject.latitudes,
    returnObject.latitudesAttrs
  );
  decodeVariableChunkInPlace(
    returnObject.longitudes ?? undefined,
    returnObject.longitudesAttrs ?? undefined
  );

  return returnObject;
}
