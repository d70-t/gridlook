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
  try {
    try {
      // CHECK IF TRIANGULAR
      const gridsource = datasources!.levels[0].grid;
      const gridRoot = zarr.root(new zarr.FetchStore(gridsource.store));
      const grid = await zarr.open(gridRoot.resolve(gridsource.dataset), {
        kind: "group",
      });
      await zarr.open(grid.resolve("vertex_of_cell"), {
        kind: "array",
      });
      return GRID_TYPES.TRIANGULAR;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      /* empty */
    }

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
      if (crs.attrs["grid_mapping_name"] === "healpix") {
        return GRID_TYPES.HEALPIX;
      }
      if (crs.attrs["grid_mapping_name"] === "rotated_latitude_longitude") {
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
        return GRID_TYPES.IRREGULAR;
      }
    } catch {
      /* fall through */
    }
    return GRID_TYPES.GAUSSIAN;
  } catch (error) {
    logError(error, "Could not determine grid type");
    return GRID_TYPES.ERROR;
  }
}
