import type { GridOptions } from "healpix-geo";

export const VOLUME_GRID_TYPES = {
  HEALPIX: "healpix",
  REGULAR: "regular",
  PROJECTED: "projected",
} as const;

export type TProjectedVolumeGrid = {
  kind: typeof VOLUME_GRID_TYPES.PROJECTED;
  x: Float32Array;
  y: Float32Array;
  crs: string;
};

export type TVolumeGrid =
  | TProjectedVolumeGrid
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
