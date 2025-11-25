import * as zarr from "zarrita";
import {
  findCRSVar,
  getDataSourceStore,
  getLatLonData,
  isLatitude,
  isLongitude,
} from "./zarrUtils";
import type { TSources } from "@/types/GlobeTypes";

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
    const gridRoot = zarr.root(new zarr.FetchStore(gridsource.store));
    const grid = await zarr.open(gridRoot.resolve(gridsource.dataset), {
      kind: "group",
    });
    await zarr.open(grid.resolve("vertex_of_cell"), {
      kind: "array",
    });
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
  console.log(latitudes, longitudes);

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
    const root = getDataSourceStore(datasources!, varnameSelector);

    const datavar = await zarr.open(root.resolve(varnameSelector), {
      kind: "array",
    });

    try {
      const crs = await zarr.open(
        root.resolve(await findCRSVar(root, varnameSelector)),
        {
          kind: "array",
        }
      );
      if (checkHealpixGrid(crs)) {
        return GRID_TYPES.HEALPIX;
      }
      if (checkRegularRotatedGrid(crs)) {
        return GRID_TYPES.REGULAR_ROTATED;
      }
    } catch {
      /* fall through to other cases */
    }
    const dimensions = datavar.attrs._ARRAY_DIMENSIONS as string[];
    if (
      dimensions.length >= 2 &&
      isLatitude(dimensions[dimensions.length - 2]) &&
      isLongitude(dimensions[dimensions.length - 1])
    ) {
      return GRID_TYPES.REGULAR;
    }

    const [latitudesVar, longitudesVar] = await getLatLonData(
      datavar,
      datasources
    );
    const latitudes = latitudesVar.data as Float64Array;
    const longitudes = longitudesVar.data as Float64Array;
    if (checkCurvilinear(latitudesVar, longitudesVar)) {
      return GRID_TYPES.CURVILINEAR;
    }

    if (checkGaussianGrid(latitudes, longitudes)) {
      return GRID_TYPES.GAUSSIAN_REDUCED;
    }

    if (checkIrregularGrid(latitudes, longitudes)) {
      return GRID_TYPES.IRREGULAR;
    }
    return GRID_TYPES.ERROR;
  } catch (error) {
    logError(error, "Could not determine grid type");
    return GRID_TYPES.ERROR;
  }
}
