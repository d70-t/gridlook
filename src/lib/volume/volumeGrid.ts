import type { GridOptions } from "healpix-geo";

export const VOLUME_GRID_TYPES = {
  HEALPIX: "healpix",
  REGULAR: "regular",
} as const;

export type TVolumeGrid =
  | {
      kind: typeof VOLUME_GRID_TYPES.HEALPIX;
      options: GridOptions;
      nside: number;
      cellCoordinates?: Float64Array;
    }
  | {
      kind: typeof VOLUME_GRID_TYPES.REGULAR;
      latitudes: Float32Array;
      longitudes: Float32Array;
    };
