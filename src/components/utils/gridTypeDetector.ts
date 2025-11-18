import * as zarr from "zarrita";
import { findCRSVar, getDataSourceStore } from "./zarrUtils";
import type { TSources } from "@/types/GlobeTypes";

export const GRID_TYPES = {
  REGULAR: "regular",
  HEALPIX: "healpix",
  REGULAR_ROTATED: "regular_rotated",
  TRIANGULAR: "triangular",
  GAUSSIAN: "gaussian",
  IRREGULAR: "irregular",
  ERROR: "error",
} as const;

export type T_GRID_TYPES = (typeof GRID_TYPES)[keyof typeof GRID_TYPES];

function isLongitude(name: string) {
  // FIXME: Need to check for unit later
  return name === "lon" || name === "longitude";
}

function isLatitude(name: string) {
  // FIXME: Need to check for unit later
  return name === "lat" || name === "latitude";
}

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

async function checkIrregularGrid(datasources: TSources | undefined) {
  try {
    const gridsource = datasources!.levels[0].grid;
    const gridRoot = zarr.root(new zarr.FetchStore(gridsource.store));
    const grid = await zarr.open(gridRoot.resolve(gridsource.dataset), {
      kind: "group",
    });
    const latitudes = (
      await zarr.open(grid.resolve("lat"), { kind: "array" }).then(zarr.get)
    ).data as Float64Array;

    const longitudes = (
      await zarr.open(grid.resolve("lon"), { kind: "array" }).then(zarr.get)
    ).data as Float64Array;

    if (latitudes.length === longitudes.length) {
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
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
      dimensions.length >= 3 &&
      isLatitude(dimensions[dimensions.length - 2]) &&
      isLongitude(dimensions[dimensions.length - 1])
    ) {
      return GRID_TYPES.REGULAR;
    }
    if (await checkIrregularGrid(datasources)) {
      return GRID_TYPES.IRREGULAR;
    }
    return GRID_TYPES.GAUSSIAN;
  } catch (error) {
    logError(error, "Could not determine grid type");
    return GRID_TYPES.ERROR;
  }
}
