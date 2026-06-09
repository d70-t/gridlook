import proj4 from "proj4";
import * as zarr from "zarrita";

import { decodeVariableChunkInPlace } from "./variableDecoding.ts";
import { ZarrDataManager } from "./ZarrDataManager.ts";

import { type TSources } from "@/lib/types/GlobeTypes.ts";

const WGS84 = "EPSG:4326";
const WEB_MERCATOR = "EPSG:3857";

export const ProjectedCoordinateName = {
  X: "x",
  Y: "y",
} as const;

export type TProjectedCoordinateName =
  (typeof ProjectedCoordinateName)[keyof typeof ProjectedCoordinateName];

export const CrsWktAttributeName = {
  CRS_WKT: "crs_wkt",
  SPATIAL_REF: "spatial_ref",
  PROJECTION: "projection",
} as const;

export type TCrsWktAttributeName =
  (typeof CrsWktAttributeName)[keyof typeof CrsWktAttributeName];

export function isWebMercatorCRS(crsWkt: string): boolean {
  return (
    crsWkt.includes('AUTHORITY["EPSG","3857"]') ||
    crsWkt.includes("AUTHORITY['EPSG','3857']") ||
    crsWkt.toLowerCase().includes("pseudo-mercator") ||
    crsWkt.includes("+proj=merc")
  );
}

export function isProjectedXName(name: string): boolean {
  return getVariableLocalName(name) === ProjectedCoordinateName.X;
}

export function isProjectedYName(name: string): boolean {
  return getVariableLocalName(name) === ProjectedCoordinateName.Y;
}

function transformProjectedAxesToLonLat(
  x: Float64Array,
  y: Float64Array,
  crsWkt: string
): {
  longitudes: Float64Array;
  latitudes: Float64Array;
} {
  const transformer = proj4(crsWkt, WGS84);
  const longitudes = new Float64Array(x.length);
  const latitudes = new Float64Array(y.length);

  for (let i = 0; i < x.length; i++) {
    const [lon] = transformer.forward([x[i], 0]);
    longitudes[i] = lon;
  }
  for (let i = 0; i < y.length; i++) {
    const [, lat] = transformer.forward([0, y[i]]);
    latitudes[i] = lat;
  }

  return { longitudes, latitudes };
}

export function webMercatorToLonLat(
  x: Float64Array,
  y: Float64Array
): {
  longitudes: Float64Array;
  latitudes: Float64Array;
} {
  return transformProjectedAxesToLonLat(x, y, WEB_MERCATOR);
}

export function projectedAxisCoordinatesToLonLat(
  x: Float64Array,
  y: Float64Array,
  crsWkt: string | null
): {
  longitudes: Float64Array;
  latitudes: Float64Array;
} {
  if (!crsWkt) {
    return {
      longitudes: new Float64Array(x),
      latitudes: new Float64Array(y),
    };
  }
  if (isWebMercatorCRS(crsWkt)) {
    return transformProjectedAxesToLonLat(x, y, crsWkt);
  }
  return {
    longitudes: new Float64Array(x),
    latitudes: new Float64Array(y),
  };
}

function getStringAttribute(
  attrs: zarr.Attributes,
  name: TCrsWktAttributeName
) {
  const value = attrs[name];
  return typeof value === "string" ? value : null;
}

function getWktFromAttrs(attrs: zarr.Attributes) {
  return (
    getStringAttribute(attrs, CrsWktAttributeName.CRS_WKT) ??
    getStringAttribute(attrs, CrsWktAttributeName.SPATIAL_REF) ??
    getStringAttribute(attrs, CrsWktAttributeName.PROJECTION)
  );
}

async function getGroupCRSWkt(datasources: TSources, variable: string) {
  const group = await ZarrDataManager.getDatasetGroup(
    ZarrDataManager.getDatasetSource(datasources, variable)
  );
  return getWktFromAttrs(group.attrs);
}

export async function getCRSWkt(
  datasources: TSources,
  variable: string
): Promise<string | null> {
  try {
    const crs = await ZarrDataManager.getCRSInfo(datasources, variable);
    const wkt = getWktFromAttrs(crs.attrs);
    if (wkt) {
      return wkt;
    }
  } catch {
    // Fall through to group attrs.
  }
  try {
    return await getGroupCRSWkt(datasources, variable);
  } catch {
    return null;
  }
}

function createFloat64Chunk(
  data: Float64Array,
  shape: number[]
): zarr.Chunk<"float64"> {
  let strideValue = 1;
  const stride = new Array<number>(shape.length);
  for (let i = shape.length - 1; i >= 0; i--) {
    stride[i] = strideValue;
    strideValue *= shape[i];
  }
  return { data, shape, stride };
}

function toFloat64Array(data: zarr.TypedArray<zarr.DataType>) {
  if (data instanceof Float64Array) {
    return data;
  }
  return Float64Array.from(data as ArrayLike<number>);
}

function projectXYGridToLonLat(
  x: Float64Array,
  y: Float64Array,
  crsWkt: string | null
) {
  const shape = [y.length, x.length];
  const longitudes = new Float64Array(x.length * y.length);
  const latitudes = new Float64Array(x.length * y.length);
  const transformer = crsWkt ? proj4(crsWkt, WGS84) : null;

  for (let j = 0; j < y.length; j++) {
    for (let i = 0; i < x.length; i++) {
      const index = j * x.length + i;
      if (transformer) {
        const [lon, lat] = transformer.forward([x[i], y[j]]);
        longitudes[index] = lon;
        latitudes[index] = lat;
      } else {
        longitudes[index] = x[i];
        latitudes[index] = y[j];
      }
    }
  }

  return {
    latitudes: createFloat64Chunk(latitudes, shape),
    longitudes: createFloat64Chunk(longitudes, shape),
  };
}

function getProjectedXYNames(dimensionNames: string[]) {
  const xName = dimensionNames.find(isProjectedXName);
  const yName = dimensionNames.find(isProjectedYName);
  if (!xName || !yName) {
    throw new Error("Projected x/y dimensions not found");
  }
  return { xName, yName };
}

async function fetchProjectedXYVariables(
  datasources: TSources,
  variable: string,
  xName: string,
  yName: string
) {
  const gridsource = datasources.levels[0].grid;
  const [xVar, yVar] = await Promise.all([
    ZarrDataManager.getVariableInfo(
      gridsource,
      ZarrDataManager.resolveVariablePath(variable, xName)
    ),
    ZarrDataManager.getVariableInfo(
      gridsource,
      ZarrDataManager.resolveVariablePath(variable, yName)
    ),
  ]);
  return { xVar, yVar };
}

export async function getProjectedXYLonLatData(
  variable: string,
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  datasources: TSources | undefined,
  dimensionNames = datavar.dimensionNames ?? []
) {
  const { xName, yName } = getProjectedXYNames(dimensionNames);
  const { xVar, yVar } = await fetchProjectedXYVariables(
    datasources!,
    variable,
    xName,
    yName
  );
  const [xCoordinates, yCoordinates] = await Promise.all([
    ZarrDataManager.getVariableDataFromArray(xVar),
    ZarrDataManager.getVariableDataFromArray(yVar),
  ]);
  decodeVariableChunkInPlace(xCoordinates, xVar.attrs);
  decodeVariableChunkInPlace(yCoordinates, yVar.attrs);

  const crsWkt = await getCRSWkt(datasources!, variable);
  const { latitudes, longitudes } = projectXYGridToLonLat(
    toFloat64Array(xCoordinates.data),
    toFloat64Array(yCoordinates.data),
    crsWkt
  );
  const geographicDimensionNames = [yName, xName];

  return {
    latitudesAttrs: {
      dimensionNames: geographicDimensionNames,
      units: "degrees_north",
    },
    latitudes,
    longitudesAttrs: {
      dimensionNames: geographicDimensionNames,
      units: "degrees_east",
    },
    longitudes,
  };
}

type TLatLonNames = {
  latitudeName: string | null;
  longitudeName: string | null;
};

function getVariableGroup(variable: string) {
  const lastSlashIndex = variable.lastIndexOf("/");
  return lastSlashIndex === -1 ? "" : variable.slice(0, lastSlashIndex);
}

function getVariableLocalName(variable: string) {
  const lastSlashIndex = variable.lastIndexOf("/");
  return lastSlashIndex === -1 ? variable : variable.slice(lastSlashIndex + 1);
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
  const variableName = getVariableLocalName(name);
  return (
    (hasUnits(attrs) && !!attrs.units.match(/degrees?_?(E|east)/)) ||
    variableName === "lon" ||
    variableName === "longitude"
  );
}

export function isLongitudeName(name: string) {
  const variableName = getVariableLocalName(name);
  // FIXME: Need to check for unit later
  // having "rlon" here is a workaround to catch rotated regular grids if the have no CRS-var
  return (
    variableName === "lon" ||
    variableName === "longitude" ||
    variableName === "rlon"
  );
}

export function isLatitudeVariable(name: string, attrs: unknown) {
  const variableName = getVariableLocalName(name);
  return (
    (hasUnits(attrs) && !!attrs.units.match(/degrees?_?(N|north)/)) ||
    variableName === "lat" ||
    variableName === "latitude"
  );
}

export function isLatitudeName(name: string) {
  const variableName = getVariableLocalName(name);
  // FIXME: Need to check for unit later
  // having "rlat" here is a workaround to catch rotated regular grids if the have no CRS-var
  return (
    variableName === "lat" ||
    variableName === "latitude" ||
    variableName === "rlat"
  );
}

function lonPriority(name: string) {
  const variableName = getVariableLocalName(name);
  if (variableName === "rlon") {
    return 0;
  }
  if (variableName === "lon") {
    return 1;
  }
  if (variableName === "longitude") {
    return 2;
  }
  return 3;
}

function latPriority(name: string) {
  const variableName = getVariableLocalName(name);
  if (variableName === "rlat") {
    return 0;
  }
  if (variableName === "lat") {
    return 1;
  }
  if (variableName === "latitude") {
    return 2;
  }
  return 3;
}

function resolveLatLonFromCoordinates(
  variable: string,
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
        latitudeName = ZarrDataManager.resolveVariablePath(variable, coordName);
      } else if (isLongitudeName(coordName)) {
        longitudeName = ZarrDataManager.resolveVariablePath(
          variable,
          coordName
        );
      }
    }
  } else {
    (datavar.dimensionNames as string[]).forEach((dimName: string) => {
      if (isLatitudeName(dimName)) {
        latitudeName = ZarrDataManager.resolveVariablePath(variable, dimName);
      } else if (isLongitudeName(dimName)) {
        longitudeName = ZarrDataManager.resolveVariablePath(variable, dimName);
      }
    });
  }
  return { latitudeName, longitudeName };
}

function refineLatLonFromSources(
  sources: TSources["levels"][0]["datasources"],
  variable: string,
  latitudeName: string | null,
  longitudeName: string | null
): TLatLonNames {
  const variableGroup = getVariableGroup(variable);
  for (const sourceKey in sources) {
    if (getVariableGroup(sourceKey) !== variableGroup) {
      continue;
    }
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
  variable: string,
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  isRotated = false
) {
  let { latitudeName, longitudeName } = resolveLatLonFromCoordinates(
    variable,
    datavar,
    isRotated
  );

  // (re-)assign lat/lon names from sources using priority ordering:
  // Longitude: rlon > lon > longitude > anything else
  // Latitude:  rlat > lat > latitude  > anything else
  if (!latitudeName || !longitudeName) {
    ({ latitudeName, longitudeName } = refineLatLonFromSources(
      datasources.levels[0].datasources,
      variable,
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
  longitudeName: string,
  variable: string
) {
  const gridsource = datasources.levels[0].grid;

  const [latitudesVar, longitudesVar] = await Promise.all([
    ZarrDataManager.getVariableInfo(
      gridsource,
      ZarrDataManager.resolveVariablePath(variable, latitudeName)
    ),
    ZarrDataManager.getVariableInfo(
      gridsource,
      ZarrDataManager.resolveVariablePath(variable, longitudeName)
    ).catch(() => null),
  ]);

  return { latitudesVar, longitudesVar };
}

export async function getLatLonData(
  variable: string,
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  datasources: TSources | undefined,
  isRotated = false
) {
  const { latitudeName, longitudeName } = findLatLonNames(
    datasources!,
    variable,
    datavar,
    isRotated
  );

  const { latitudesVar, longitudesVar } = await fetchLatLonVariables(
    datasources!,
    latitudeName,
    longitudeName,
    variable
  );

  const [latitudes, longitudes] = await Promise.all([
    ZarrDataManager.getVariableDataFromArray(latitudesVar),
    longitudesVar
      ? ZarrDataManager.getVariableDataFromArray(longitudesVar)
      : Promise.resolve(null),
  ]);

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
