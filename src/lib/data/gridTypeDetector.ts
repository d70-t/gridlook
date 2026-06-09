import * as zarr from "zarrita";

import {
  getCRSWkt,
  getLatLonData,
  isLatitudeName,
  isLongitudeName,
  isProjectedXName,
  isProjectedYName,
  isWebMercatorCRS,
} from "./coordinateVariables.ts";
import { ZarrDataManager } from "./ZarrDataManager.ts";

import type { TSources, TZarrDggsMetadata } from "@/lib/types/GlobeTypes.ts";

export const GRID_TYPES = {
  REGULAR: "regular",
  HEALPIX: "healpix",
  REGULAR_ROTATED: "regular_rotated",
  TRIANGULAR: "triangular",
  GAUSSIAN_REDUCED: "gaussian_reduced",
  IRREGULAR: "irregular",
  IRREGULAR_DELAUNAY: "irregular_delaunay",
  CURVILINEAR: "curvilinear",
  ERROR: "error",
} as const;

export type T_GRID_TYPES = (typeof GRID_TYPES)[keyof typeof GRID_TYPES];

/* Some grid types can be displayed as others. Maps to array of alternatives. */
export const GRID_TYPE_DISPLAY_OVERRIDES: Partial<
  Record<T_GRID_TYPES, T_GRID_TYPES[]>
> = {
  [GRID_TYPES.REGULAR]: [GRID_TYPES.IRREGULAR, GRID_TYPES.IRREGULAR_DELAUNAY],
  [GRID_TYPES.REGULAR_ROTATED]: [
    GRID_TYPES.IRREGULAR,
    GRID_TYPES.IRREGULAR_DELAUNAY,
  ],
  [GRID_TYPES.CURVILINEAR]: [
    GRID_TYPES.IRREGULAR,
    GRID_TYPES.IRREGULAR_DELAUNAY,
  ],
  [GRID_TYPES.GAUSSIAN_REDUCED]: [
    GRID_TYPES.IRREGULAR,
    GRID_TYPES.IRREGULAR_DELAUNAY,
  ],
  [GRID_TYPES.IRREGULAR]: [GRID_TYPES.IRREGULAR_DELAUNAY],
};

async function checkTriangularGrid(
  datasources: TSources | undefined,
  variable: string
): Promise<T_GRID_TYPES | null> {
  try {
    const gridsource = datasources!.levels[0].grid;
    const resolvedPath = ZarrDataManager.resolveVariablePath(
      variable,
      "vertex_of_cell"
    );
    await ZarrDataManager.getVariableInfo(
      gridsource,
      resolvedPath,
      datasources?.zarr_format
    );
    return GRID_TYPES.TRIANGULAR;
  } catch {
    return null;
  }
}

function checkHealpixGrid(crs: zarr.Array<zarr.DataType, zarr.AsyncReadable>) {
  return crs.attrs["grid_mapping_name"] === "healpix";
}

function checkRegularRotatedGrid(
  crs: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  return crs.attrs["grid_mapping_name"] === "rotated_latitude_longitude";
}

function checkCurvilinear(
  latitudesVar: zarr.Chunk<zarr.DataType>,
  longitudesVar: zarr.Chunk<zarr.DataType>
) {
  // const latitudes = latitudesVar.data as Float64Array;
  // const longitudes = longitudesVar.data as Float64Array;

  // const uniqueLatsNum = new Set(latitudes).size;
  // const uniqueLonsNum = new Set(longitudes).size;

  return latitudesVar.shape.length === 2 && longitudesVar.shape.length === 2;
}

function checkGaussianGrid(latitudes: Float64Array, longitudes: Float64Array) {
  // Quick O(1) check: a Gaussian-reduced grid stores all cells for a given
  // latitude row consecutively, so the first two entries share the same lat.
  // If they differ, this is definitely not a Gaussian-reduced grid.
  if (latitudes.length < 2 || latitudes[0] !== latitudes[1]) {
    return false;
  }
  const uniqueLatsNum = new Set(latitudes).size;
  const uniqueLonsNum = new Set(longitudes).size;

  return (
    uniqueLatsNum * uniqueLonsNum !== latitudes.length * longitudes.length &&
    latitudes[0] === latitudes[1]
  );
}

// Check if grid is regular based on dimension names
// Also accepts lat-only grids (e.g., zonally averaged data)
async function checkRegularGridFromDimensions(
  datasources: TSources,
  varnameSelector: string
): Promise<T_GRID_TYPES | null> {
  const dimensions = await ZarrDataManager.getDimensionNames(
    datasources!,
    varnameSelector
  );

  const latitudeIndex = dimensions.findIndex((dim) => isLatitudeName(dim));
  const longitudeIndex = dimensions.findIndex((dim) => isLongitudeName(dim));
  const hasLatLon = latitudeIndex !== -1 && longitudeIndex !== -1;
  const hasLatOnly = latitudeIndex !== -1 && longitudeIndex === -1;

  if (hasLatLon || hasLatOnly) {
    return GRID_TYPES.REGULAR;
  }

  return null;
}

// Check if grid uses projected x/y coordinates (e.g. EPSG:3857 with spatial_ref)
function checkProjectedXYDimensions(dimensions: string[]): boolean {
  return dimensions.some(isProjectedXName) && dimensions.some(isProjectedYName);
}

async function determineProjectedXYGridType(
  datasources: TSources | undefined,
  variable: string,
  dimensions: string[]
): Promise<T_GRID_TYPES | null> {
  if (!checkProjectedXYDimensions(dimensions)) {
    return null;
  }
  if (!datasources) {
    return GRID_TYPES.REGULAR;
  }

  const crsWkt = await getCRSWkt(datasources, variable);
  if (crsWkt && !isWebMercatorCRS(crsWkt)) {
    return GRID_TYPES.CURVILINEAR;
  }
  return GRID_TYPES.REGULAR;
}

// Attempt to determine grid type from CRS information
async function determineGridTypeFromCRS(
  datasources: TSources,
  varnameSelector: string
): Promise<T_GRID_TYPES | null> {
  try {
    const crs = await ZarrDataManager.getCRSInfo(datasources, varnameSelector);

    if (checkHealpixGrid(crs)) {
      return GRID_TYPES.HEALPIX;
    }
    if (checkRegularRotatedGrid(crs)) {
      return GRID_TYPES.REGULAR_ROTATED;
    }
    // Polar stereographic datasets are routed to CURVILINEAR so that
    // computePolarStereoLatLon2D can produce proper 2-D lat/lon arrays.
    if (crs.attrs?.grid_mapping_name === "polar_stereographic") {
      return GRID_TYPES.CURVILINEAR;
    }
  } catch {
    // CRS check failed, return null to continue with other checks
  }

  return null;
}

function determineGridTypeFromDGGSZarrConvention(
  metadata: TZarrDggsMetadata
): T_GRID_TYPES | null {
  if (metadata["name"] !== "healpix") {
    // unsupported DGGS, for now
    return GRID_TYPES.ERROR;
  }

  return GRID_TYPES.HEALPIX;
}

async function determineGridTypeFromZarrConvention(
  datasources: TSources,
  varnameSelector: string
): Promise<T_GRID_TYPES | null> {
  const group = await ZarrDataManager.getParentGroup(
    datasources,
    varnameSelector,
    datasources?.zarr_format
  );
  const metadata = group.attrs;

  if (!("zarr_conventions" in metadata)) {
    return null;
  }

  const dggsMetadata: TZarrDggsMetadata | unknown = metadata["dggs"];
  if (dggsMetadata) {
    return determineGridTypeFromDGGSZarrConvention(
      dggsMetadata as TZarrDggsMetadata
    );
  }

  return null;
}

// Determine grid type from lat/lon data analysis
async function determineGridTypeFromData(
  datasources: TSources,
  varnameSelector: string
): Promise<T_GRID_TYPES | null> {
  const dimensions = await ZarrDataManager.getDimensionNames(
    datasources!,
    varnameSelector
  );

  try {
    const datavar = await ZarrDataManager.getVariableInfo(
      ZarrDataManager.getDatasetSource(datasources!, varnameSelector),
      varnameSelector,
      datasources?.zarr_format
    );

    const { latitudes, longitudes } = await getLatLonData(
      varnameSelector,
      datavar,
      datasources
    );
    if (latitudes === null || longitudes === null) {
      return null; // Cannot determine grid type without lat/lon data
    }
    const latitudesData = latitudes.data as Float64Array;
    const longitudesData = longitudes.data as Float64Array;

    if (checkCurvilinear(latitudes, longitudes)) {
      return GRID_TYPES.CURVILINEAR;
    }
    if (checkGaussianGrid(latitudesData, longitudesData)) {
      return GRID_TYPES.GAUSSIAN_REDUCED;
    }
    // as long as we have lat/lon pairs, we can very likely display something as
    // an irregular grid
    return GRID_TYPES.IRREGULAR;
  } catch {
    return await determineProjectedXYGridType(
      datasources,
      variable,
      dimensions
    );
  }
}

export async function getGridType(
  sourceValid: boolean,
  varnameSelector: string,
  datasources: TSources | undefined,
  logError: (maybeError: unknown, context?: string) => void
): Promise<T_GRID_TYPES> {
  // FIXME: This is a clumsy hack to distinguish between different
  // grid types.
  if (!sourceValid) {
    return GRID_TYPES.ERROR;
  }

  const gridDetectionFunctions: ((
    datasources: TSources,
    varnameSelector: string
  ) => Promise<T_GRID_TYPES | null>)[] = [
    // Check triangular grids
    checkTriangularGrid,
    // Check CRS-based grid types
    determineGridTypeFromCRS,
    // zarr convention metadata
    determineGridTypeFromZarrConvention,
    checkRegularGridFromDimensions,
    determineGridTypeFromData,
  ];

  try {
    for (const gridDetectionFunction of gridDetectionFunctions) {
      const gridType = await gridDetectionFunction(
        datasources!,
        varnameSelector
      );
      if (gridType) {
        return gridType;
      }
    }

    logError("No matching grid type found", "Could not determine grid type");
    return GRID_TYPES.ERROR;
  } catch (error) {
    logError(error, "Could not determine grid type");
    return GRID_TYPES.ERROR;
  }
}
