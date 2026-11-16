import proj4 from "proj4";
import * as zarr from "zarrita";

import { isTimeCoordinate } from "./timeHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableChunkInPlace,
  decodeVariableDataAndGetBounds,
} from "./variableDecoding.ts";
import { ZarrDataManager } from "./ZarrDataManager.ts";

import { type TSources } from "@/lib/types/GlobeTypes.ts";

const WGS84 = "EPSG:4326";

const ProjectedCoordinateName = {
  X: "x",
  Y: "y",
} as const;

const ProjectedCoordinateStandardName = {
  X: "projection_x_coordinate",
  Y: "projection_y_coordinate",
} as const;

type TProjectedCoordinateStandardName =
  (typeof ProjectedCoordinateStandardName)[keyof typeof ProjectedCoordinateStandardName];

const ProjectedCoordinateAxis = {
  X: "X",
  Y: "Y",
} as const;

type TProjectedCoordinateAxis =
  (typeof ProjectedCoordinateAxis)[keyof typeof ProjectedCoordinateAxis];

// Geographic axes carry axis X/Y too, so an axis only counts as projected
// with a length unit.
const LengthUnit = {
  M: "m",
  KM: "km",
  METER: "meter",
  METERS: "meters",
  METRE: "metre",
  METRES: "metres",
} as const;

// Idealized domains (e.g. LES) have Cartesian x/y without any georeference.
// They are drawn true to scale with their x/y origin at 0°N 0°E.
export const DEFAULT_ANCHOR_CRS = "+proj=aeqd +lat_0=0 +lon_0=0 +datum=WGS84";

const CrsWktAttributeName = {
  CRS_WKT: "crs_wkt",
  PROJ4_PARAMS: "proj4_params",
  SPATIAL_REF: "spatial_ref",
  PROJECTION: "projection",
} as const;

type TCrsWktAttributeName =
  (typeof CrsWktAttributeName)[keyof typeof CrsWktAttributeName];

export function isWebMercatorCRS(crsWkt: string): boolean {
  try {
    return new proj4.Proj(crsWkt).names.includes("merc");
  } catch {
    return false;
  }
}

export function isPolarStereographicCRS(crsWkt: string): boolean {
  try {
    return new proj4.Proj(crsWkt).names.includes("stere");
  } catch {
    return false;
  }
}

function isRotatedPoleCRS(crsWkt: string): boolean {
  try {
    return new proj4.Proj(crsWkt).names.includes("ob_tran");
  } catch {
    return false;
  }
}

export function isProjectedXName(name: string): boolean {
  return getVariableLocalName(name) === ProjectedCoordinateName.X;
}

export function isProjectedYName(name: string): boolean {
  return getVariableLocalName(name) === ProjectedCoordinateName.Y;
}

export function transformProjectedAxesToLonLat(
  x: Float32Array,
  y: Float32Array,
  crsWkt: string
): {
  longitudes: Float32Array;
  latitudes: Float32Array;
} {
  const transformer = proj4(crsWkt, WGS84);
  const longitudes = new Float32Array(x.length);
  const latitudes = new Float32Array(y.length);

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

export function projectedAxisCoordinatesToLonLat(
  x: Float32Array,
  y: Float32Array,
  crsWkt: string | null
): {
  longitudes: Float32Array;
  latitudes: Float32Array;
} {
  if (!crsWkt) {
    return {
      longitudes: new Float32Array(x),
      latitudes: new Float32Array(y),
    };
  }
  if (isWebMercatorCRS(crsWkt)) {
    return transformProjectedAxesToLonLat(x, y, crsWkt);
  }
  return {
    longitudes: new Float32Array(x),
    latitudes: new Float32Array(y),
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
    getStringAttribute(attrs, CrsWktAttributeName.PROJ4_PARAMS) ??
    getStringAttribute(attrs, CrsWktAttributeName.SPATIAL_REF) ??
    getStringAttribute(attrs, CrsWktAttributeName.PROJECTION)
  );
}

export function getRotatedPoleCRS(attrs: zarr.Attributes) {
  if (attrs.grid_mapping_name !== "rotated_latitude_longitude") {
    return undefined;
  }
  const latitude = Number(attrs.grid_north_pole_latitude ?? NaN);
  const longitude = Number(attrs.grid_north_pole_longitude ?? NaN);
  const gridLongitude = Number(attrs.north_pole_grid_longitude ?? 0);
  if (
    ![latitude, longitude, gridLongitude].every(Number.isFinite) ||
    Math.abs(latitude) > 90
  ) {
    return undefined;
  }
  return `+proj=ob_tran +o_proj=longlat +o_lat_p=${latitude} +o_lon_p=${gridLongitude} +lon_0=${longitude + 180} +datum=WGS84`;
}

export function getLambertAzimuthalEqualAreaCRS(attrs: zarr.Attributes) {
  if (attrs.grid_mapping_name !== "lambert_azimuthal_equal_area") {
    return undefined;
  }
  const latitude = Number(attrs.latitude_of_projection_origin ?? NaN);
  const longitude = Number(attrs.longitude_of_projection_origin ?? NaN);
  const falseEasting = Number(attrs.false_easting ?? 0);
  const falseNorthing = Number(attrs.false_northing ?? 0);
  if (
    ![latitude, longitude, falseEasting, falseNorthing].every(
      Number.isFinite
    ) ||
    Math.abs(latitude) > 90
  ) {
    return undefined;
  }
  // ponytail: ignores the CF earth shape attributes (semi_major_axis,
  // inverse_flattening, earth_radius) and assumes WGS84. Map them to
  // +a/+rf/+R once a dataset needs a different ellipsoid.
  return `+proj=laea +lat_0=${latitude} +lon_0=${longitude} +x_0=${falseEasting} +y_0=${falseNorthing} +datum=WGS84`;
}

export function getCRSFromAttrs(attrs: zarr.Attributes) {
  return (
    getWktFromAttrs(attrs) ??
    getRotatedPoleCRS(attrs) ??
    getLambertAzimuthalEqualAreaCRS(attrs) ??
    null
  );
}

async function getGroupCRSWkt(datasources: TSources, variable: string) {
  const group = await ZarrDataManager.getDatasetGroup(
    ZarrDataManager.getDatasetSource(datasources, variable)
  );
  return getCRSFromAttrs(group.attrs);
}

export async function getCRSWkt(
  datasources: TSources,
  variable: string
): Promise<string | null> {
  try {
    const crs = await ZarrDataManager.getCRSInfo(datasources, variable);
    const wkt = getCRSFromAttrs(crs.attrs);
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

function createFloat32Chunk(
  data: Float32Array,
  shape: number[]
): zarr.Chunk<"float32"> {
  let strideValue = 1;
  const stride = new Array<number>(shape.length);
  for (let i = shape.length - 1; i >= 0; i--) {
    stride[i] = strideValue;
    strideValue *= shape[i];
  }
  return { data, shape, stride };
}

export function projectXYGridToLonLat(
  x: Float32Array,
  y: Float32Array,
  crsWkt: string | null
) {
  const shape = [y.length, x.length];
  const longitudes = new Float32Array(x.length * y.length);
  const latitudes = new Float32Array(x.length * y.length);
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
    latitudes: createFloat32Chunk(latitudes, shape),
    longitudes: createFloat32Chunk(longitudes, shape),
  };
}

// Attributes of each dimension's coordinate variable.
async function getDimensionCoordinateAttrs(
  datasources: TSources,
  variable: string,
  dimensions: string[]
) {
  const level = datasources.levels[0];
  return await Promise.all(
    dimensions.map(async (name): Promise<zarr.Attributes> => {
      const path = ZarrDataManager.resolveVariablePath(variable, name);
      try {
        const coordinate = await ZarrDataManager.getVariableInfo(
          level.datasources[path] ?? level.grid,
          path,
          datasources.zarr_format
        );
        return coordinate.attrs;
      } catch {
        // Dimensions without a coordinate variable have no attributes.
        return {};
      }
    })
  );
}

function isProjectedCoordinate(
  attrs: zarr.Attributes,
  standardName: TProjectedCoordinateStandardName,
  axis: TProjectedCoordinateAxis
) {
  return (
    attrs.standard_name === standardName ||
    (attrs.axis === axis &&
      (Object.values(LengthUnit) as unknown[]).includes(attrs.units))
  );
}

// Projected x/y dimensions, recognized by their name or by the CF
// standard_name or axis (with a length unit) of their coordinate variable.
// Null if either is missing.
export async function findProjectedXYNames(
  datasources: TSources,
  variable: string,
  dimensions: string[]
) {
  const attrs = await getDimensionCoordinateAttrs(
    datasources,
    variable,
    dimensions
  );
  const xName = dimensions.find(
    (name, i) =>
      isProjectedXName(name) ||
      isProjectedCoordinate(
        attrs[i],
        ProjectedCoordinateStandardName.X,
        ProjectedCoordinateAxis.X
      )
  );
  const yName = dimensions.find(
    (name, i) =>
      isProjectedYName(name) ||
      isProjectedCoordinate(
        attrs[i],
        ProjectedCoordinateStandardName.Y,
        ProjectedCoordinateAxis.Y
      )
  );
  return xName && yName ? { xName, yName } : null;
}

// True if all given dimensions have coordinate variables in a length unit,
// i.e. x/y in metres rather than degrees.
export async function hasLengthUnitCoordinates(
  datasources: TSources,
  variable: string,
  dimensions: string[]
) {
  const attrs = await getDimensionCoordinateAttrs(
    datasources,
    variable,
    dimensions
  );
  return attrs.every((value) =>
    (Object.values(LengthUnit) as unknown[]).includes(value.units)
  );
}

// Time dimensions of the data variable that its lat/lon coordinates also
// depend on, e.g. a box moving with a storm: latitude(time, ny).
export async function findCoordinateTimeDimensions(
  datasources: TSources,
  variable: string,
  dataDimensions: string[],
  coordinateDimensions: string[]
) {
  const candidates = [...new Set(coordinateDimensions)].filter((name) =>
    dataDimensions.includes(name)
  );
  const attrs = await getDimensionCoordinateAttrs(
    datasources,
    variable,
    candidates
  );
  return candidates.filter((name, i) => isTimeCoordinate(name, attrs[i]));
}

export async function hasTrailingProjectedXYDimensions(
  datasources: TSources,
  variable: string,
  dimensions: string[]
) {
  if (dimensions.length < 2) {
    return false;
  }
  const [yName, xName] = dimensions.slice(-2);
  const names = await findProjectedXYNames(datasources, variable, [
    yName,
    xName,
  ]);
  return names?.xName === xName && names.yName === yName;
}

export async function loadGridAxes(
  datasources: TSources,
  variable: string,
  dimensions: string[]
) {
  const level = datasources.levels[0];
  const [y, x] = await Promise.all(
    dimensions.slice(-2).map(async (name) => {
      const path = ZarrDataManager.resolveVariablePath(variable, name);
      const coordinate = await ZarrDataManager.getVariableInfo(
        level.datasources[path] ?? level.grid,
        path,
        datasources.zarr_format
      );
      if (coordinate.shape.length !== 1) {
        throw new Error(`${name} is not a one-dimensional coordinate.`);
      }
      const values = castDataVarToFloat32(
        (await ZarrDataManager.getVariableDataFromArray(coordinate)).data
      );
      decodeVariableDataAndGetBounds(coordinate, values);
      return values;
    })
  );
  return { x, y };
}

export async function getProjectedXYLonLatData(
  variable: string,
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  datasources: TSources | undefined,
  dimensionNames = datavar.dimensionNames ?? []
) {
  const names = await findProjectedXYNames(
    datasources!,
    variable,
    dimensionNames
  );
  if (!names) {
    throw new Error("Projected x/y dimensions not found");
  }
  const { xName, yName } = names;
  const [{ x, y }, crsWkt] = await Promise.all([
    loadGridAxes(datasources!, variable, [yName, xName]),
    getCRSWkt(datasources!, variable),
  ]);
  return gridAxesToLonLatData(x, y, yName, xName, crsWkt);
}

// One lat/lon pair per cell of a (y, x) grid with 1-D axes, reprojected
// with the CRS (or taken as-is without one).
function gridAxesToLonLatData(
  x: Float32Array,
  y: Float32Array,
  yName: string,
  xName: string,
  crsWkt: string | null
) {
  const { latitudes, longitudes } = projectXYGridToLonLat(x, y, crsWkt);
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

function hasUnits(maybeHasUnits: unknown): maybeHasUnits is { units: string } {
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

function projectXYPointsToLonLat(
  x: Float32Array,
  y: Float32Array,
  crsWkt: string
) {
  const transformer = proj4(crsWkt, WGS84);
  const latitudes = new Float32Array(x.length);
  const longitudes = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const [lon, lat] = transformer.forward([x[i], y[i]]);
    longitudes[i] = lon;
    latitudes[i] = lat;
  }
  return { latitudes, longitudes };
}

// Point/station data: projected x/y variables along one shared dimension of
// the data variable, e.g. x(index) and y(index), reprojected point by point.
async function getProjectedPointLonLatData(
  variable: string,
  datasources: TSources
) {
  const [dataDimensions, xDimensions, yDimensions, crsWkt] = await Promise.all([
    ZarrDataManager.getDimensionNames(datasources, variable),
    ZarrDataManager.getDimensionNames(
      datasources,
      ZarrDataManager.resolveVariablePath(variable, ProjectedCoordinateName.X)
    ),
    ZarrDataManager.getDimensionNames(
      datasources,
      ZarrDataManager.resolveVariablePath(variable, ProjectedCoordinateName.Y)
    ),
    getCRSWkt(datasources, variable),
  ]);
  const pointDimension = xDimensions[0];
  if (
    !crsWkt ||
    xDimensions.length !== 1 ||
    yDimensions.length !== 1 ||
    yDimensions[0] !== pointDimension ||
    !dataDimensions.includes(pointDimension)
  ) {
    return null;
  }

  const { x, y } = await loadGridAxes(datasources, variable, [
    ProjectedCoordinateName.Y,
    ProjectedCoordinateName.X,
  ]);
  const { latitudes, longitudes } = projectXYPointsToLonLat(x, y, crsWkt);

  return {
    latitudesAttrs: {
      dimensionNames: [pointDimension],
      units: "degrees_north",
    },
    latitudes: createFloat32Chunk(latitudes, [x.length]),
    longitudesAttrs: {
      dimensionNames: [pointDimension],
      units: "degrees_east",
    },
    longitudes: createFloat32Chunk(longitudes, [x.length]),
  };
}

export async function getLatLonData(
  variable: string,
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  datasources: TSources | undefined,
  isRotated = false
) {
  try {
    return await getGeographicLatLonData(
      variable,
      datavar,
      datasources,
      isRotated
    );
  } catch (error) {
    const points = await getProjectedPointLonLatData(
      variable,
      datasources!
    ).catch(() => null);
    if (!points) {
      throw error;
    }
    return points;
  }
}

/**
 * True if a rotated grid's own 2-D lat/lon disagree with its rotated pole by
 * more than one grid cell, i.e. the file contradicts itself (e.g. iris
 * small_rotPole_precipitation.nc). False without 2-D lat/lon or on any error:
 * this only feeds a warning.
 */
export async function hasRotatedLatLonMismatch(
  datasources: TSources,
  variable: string,
  rlon: Float32Array,
  rlat: Float32Array,
  crsWkt: string
) {
  try {
    const datavar = await ZarrDataManager.getVariableInfoByDatasetSources(
      datasources,
      variable
    );
    // ponytail: reads the full 2-D lat/lon to compare five cells; read only
    // those cells if this gets slow for large grids.
    const { latitudes, longitudes } = await getLatLonData(
      variable,
      datavar,
      datasources
    );
    const [ny, nx] = latitudes.shape;
    if (
      !longitudes ||
      latitudes.shape.length !== 2 ||
      ny !== rlat.length ||
      nx !== rlon.length ||
      ny < 2 ||
      nx < 2
    ) {
      return false;
    }
    const transform = proj4(crsWkt, WGS84);
    const tolerance = Math.hypot(rlat[1] - rlat[0], rlon[1] - rlon[0]);
    const cells = [
      [0, 0],
      [0, nx - 1],
      [ny - 1, 0],
      [ny - 1, nx - 1],
      [ny >> 1, nx >> 1],
    ];
    const latData = latitudes.data as ArrayLike<number>;
    const lonData = longitudes.data as ArrayLike<number>;
    return cells.some(([j, i]) => {
      const [lon, lat] = transform.forward([rlon[i], rlat[j]]);
      return (
        getLonLatDistance(lonData[j * nx + i], latData[j * nx + i], lon, lat) >
        tolerance
      );
    });
  } catch {
    return false;
  }
}

// Approximate distance in degrees, enough to tell matching positions apart
// from mismatching ones.
function getLonLatDistance(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
) {
  const deltaLon = ((((lon1 - lon2) % 360) + 540) % 360) - 180;
  return Math.hypot(lat1 - lat2, deltaLon * Math.cos((lat1 * Math.PI) / 180));
}

// Grids without lat/lon variables whose last two dimensions are 1-D axes of
// a CRS, e.g. rotated-pole grid_latitude/grid_longitude or Lambert x/y.
async function getReprojectedAxesLonLatData(
  variable: string,
  datasources: TSources
) {
  const dimensions = await ZarrDataManager.getDimensionNames(
    datasources,
    variable
  );
  const crsWkt = await getCRSWkt(datasources, variable);
  if (dimensions.length < 2 || !crsWkt) {
    return null;
  }
  const [yName, xName] = dimensions.slice(-2);
  const [yAttrs, xAttrs] = await getDimensionCoordinateAttrs(
    datasources,
    variable,
    [yName, xName]
  );
  // ponytail: only the CF order (..., y, x). Axes that say otherwise, e.g.
  // surface_altitude(grid_longitude, grid_latitude), are rejected instead of
  // transposed; transpose the lat/lon arrays if such data needs to work.
  if (
    (yAttrs.axis ?? ProjectedCoordinateAxis.Y) !== ProjectedCoordinateAxis.Y ||
    (xAttrs.axis ?? ProjectedCoordinateAxis.X) !== ProjectedCoordinateAxis.X
  ) {
    return null;
  }
  const { x, y } = await loadGridAxes(datasources, variable, [yName, xName]);
  return gridAxesToLonLatData(x, y, yName, xName, crsWkt);
}

type TLatLonData = Awaited<ReturnType<typeof getLatLonData>>;

// Two separate 1-D lat/lon axes on a rotated-pole grid are the rotated axes
// (e.g. rlat/rlon found via the dimension names), not geographic coordinates.
async function isRotatedAxesLatLon(
  coordinates: TLatLonData,
  datasources: TSources,
  variable: string
) {
  const [latitudeDimension] = coordinates.latitudesAttrs.dimensionNames ?? [];
  const [longitudeDimension] =
    coordinates.longitudesAttrs?.dimensionNames ?? [];
  if (
    coordinates.latitudes.shape.length !== 1 ||
    coordinates.longitudes?.shape.length !== 1 ||
    latitudeDimension === longitudeDimension
  ) {
    return false;
  }
  const crsWkt = await getCRSWkt(datasources, variable);
  return crsWkt !== null && isRotatedPoleCRS(crsWkt);
}

async function getLatLonOrReprojectedAxesData(
  variable: string,
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  datasources: TSources | undefined
) {
  let coordinates: TLatLonData;
  try {
    coordinates = await getLatLonData(variable, datavar, datasources);
  } catch (error) {
    const cells = await getReprojectedAxesLonLatData(
      variable,
      datasources!
    ).catch(() => null);
    if (!cells) {
      throw error;
    }
    return cells;
  }
  if (await isRotatedAxesLatLon(coordinates, datasources!, variable)) {
    // Keeps the rotated axes if they cannot be reprojected, e.g. (x, y) order.
    const cells = await getReprojectedAxesLonLatData(
      variable,
      datasources!
    ).catch(() => null);
    return cells ?? coordinates;
  }
  return coordinates;
}

/**
 * Lat/lon for the irregular grids: like getLatLonData, but grids with a CRS
 * and only 1-D axes get one reprojected lat/lon pair per cell. Grid detection
 * keeps using getLatLonData, which would otherwise call such grids
 * curvilinear. Also returns the time dimensions the coordinates move along
 * (see selectCoordinateTimeStep).
 */
export async function getIrregularLatLonData(
  variable: string,
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  datasources: TSources | undefined
) {
  const [coordinates, dimensions] = await Promise.all([
    getLatLonOrReprojectedAxesData(variable, datavar, datasources),
    ZarrDataManager.getDimensionNames(datasources!, variable),
  ]);
  const timeDimensions = await findCoordinateTimeDimensions(
    datasources!,
    variable,
    dimensions,
    [
      ...(coordinates.latitudesAttrs.dimensionNames as string[]),
      ...(coordinates.longitudesAttrs!.dimensionNames as string[]),
    ]
  );
  return { ...coordinates, timeDimensions };
}

async function getGeographicLatLonData(
  variable: string,
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  datasources: TSources | undefined,
  isRotated: boolean
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
