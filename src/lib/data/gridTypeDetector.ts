import * as zarr from "zarrita";

import { ZarrDataManager } from "./ZarrDataManager";
import { getLatLonData, isLatitude, isLongitude } from "./zarrUtils";

import type { TSources } from "@/lib/types/GlobeTypes";

export const GRID_TYPES = {
  REGULAR: "regular",
  HEALPIX: "healpix",
  REGULAR_ROTATED: "regular_rotated",
  TRIANGULAR: "triangular",
  GAUSSIAN_REDUCED: "gaussian_reduced",
  IRREGULAR: "irregular",
  CURVILINEAR: "curvilinear",
  ERROR: "error",
} as const;

export type T_GRID_TYPES = (typeof GRID_TYPES)[keyof typeof GRID_TYPES];

async function checkTriangularGrid(
  datasources: TSources | undefined
): Promise<boolean> {
  try {
    const gridsource = datasources!.levels[0].grid;
    await ZarrDataManager.getVariableInfo(gridsource, "vertex_of_cell");
    return true;
  } catch {
    return false;
  }
}

function checkHealpixGrid(crs: zarr.Array<zarr.DataType, zarr.FetchStore>) {
  return crs.attrs["grid_mapping_name"] === "healpix";
}

function checkRegularRotatedGrid(
  crs: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  return crs.attrs["grid_mapping_name"] === "rotated_latitude_longitude";
}

function checkCurvilinear(
  latitudesVar: zarr.Chunk<zarr.DataType>,
  longitudesVar: zarr.Chunk<zarr.DataType>
) {
  const latitudes = latitudesVar.data as Float64Array;
  const longitudes = longitudesVar.data as Float64Array;

  const uniqueLatsNum = new Set(latitudes).size;
  const uniqueLonsNum = new Set(longitudes).size;

  return (
    latitudesVar.shape.length === 2 &&
    longitudesVar.shape.length === 2 &&
    uniqueLatsNum !== latitudes.length &&
    uniqueLonsNum !== longitudes.length
  );
}

function checkGaussianGrid(latitudes: Float64Array, longitudes: Float64Array) {
  const uniqueLatsNum = new Set(latitudes).size;
  const uniqueLonsNum = new Set(longitudes).size;

  return (
    uniqueLatsNum * uniqueLonsNum !== latitudes.length * longitudes.length &&
    latitudes[0] === latitudes[1]
  );
}

function checkIrregularGrid(latitudes: Float64Array, longitudes: Float64Array) {
  if (latitudes.length === longitudes.length) {
    return true;
  }
}

// Check if grid is regular based on dimension names
function checkRegularGridFromDimensions(dimensions: string[]): boolean {
  return (
    dimensions.length >= 2 &&
    isLatitude(dimensions[dimensions.length - 2]) &&
    isLongitude(dimensions[dimensions.length - 1])
  );
}

// Attempt to determine grid type from CRS information
async function determineGridTypeFromCRS(
  datasources: TSources,
  varnameSelector: string
): Promise<string | null> {
  try {
    const crs = await ZarrDataManager.getCRSInfo(datasources, varnameSelector);

    if (checkHealpixGrid(crs)) {
      return GRID_TYPES.HEALPIX;
    }
    if (checkRegularRotatedGrid(crs)) {
      return GRID_TYPES.REGULAR_ROTATED;
    }
  } catch {
    // CRS check failed, return null to continue with other checks
  }

  return null;
}

// Determine grid type from lat/lon data analysis
async function determineGridTypeFromData(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>,
  datasources: TSources | undefined
): Promise<string | null> {
  const { latitudes, longitudes } = await getLatLonData(datavar, datasources);
  const latitudesData = latitudes.data as Float64Array;
  const longitudesData = longitudes.data as Float64Array;

  if (checkCurvilinear(latitudes, longitudes)) {
    return GRID_TYPES.CURVILINEAR;
  }
  if (checkGaussianGrid(latitudesData, longitudesData)) {
    return GRID_TYPES.GAUSSIAN_REDUCED;
  }
  if (checkIrregularGrid(latitudesData, longitudesData)) {
    return GRID_TYPES.IRREGULAR;
  }
  return null;
}

export async function getGridType(
  sourceValid: boolean,
  varnameSelector: string,
  datasources: TSources | undefined,
  logError: (maybeError: unknown, context?: string) => void
) {
  // FIXME: This is a clumsy hack to distinguish between different
  // grid types.
  if (!sourceValid) {
    return GRID_TYPES.ERROR;
  }

  if (await checkTriangularGrid(datasources)) {
    return GRID_TYPES.TRIANGULAR;
  }

  try {
    const datavar = await ZarrDataManager.getVariableInfo(
      ZarrDataManager.getDatasetSource(datasources!, varnameSelector),
      varnameSelector
    );

    // Check CRS-based grid types
    const crsGridType = await determineGridTypeFromCRS(
      datasources!,
      varnameSelector
    );
    if (crsGridType) {
      return crsGridType;
    }

    // Check if it's a regular grid based on dimensions
    const dimensions = datavar.attrs._ARRAY_DIMENSIONS as string[];
    if (checkRegularGridFromDimensions(dimensions)) {
      return GRID_TYPES.REGULAR;
    }

    const dataGridType = await determineGridTypeFromData(datavar, datasources);
    if (dataGridType) {
      return dataGridType;
    }
    logError("No matching grid type found", "Could not determine grid type");
    return GRID_TYPES.ERROR;
  } catch (error) {
    logError(error, "Could not determine grid type");
    return GRID_TYPES.ERROR;
  }
}
