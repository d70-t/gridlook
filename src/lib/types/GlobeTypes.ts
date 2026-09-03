import type { Dayjs } from "dayjs";
import * as zarr from "zarrita";

import type { TColorMap } from "@/lib/shaders/colormapShaders.ts";

export const ZARR_FORMAT = {
  V2: 2,
  V3: 3,
  ICECHUNK: -1, // Not a standard Zarr format, but used internally to indicate icechunk stores
  NETCDF: -2, // Not a Zarr format; keeps the existing datasource interface small
} as const;

export type TZarrFormat = (typeof ZARR_FORMAT)[keyof typeof ZARR_FORMAT];

type EmptyObj = Record<PropertyKey, never>;

export type TBounds = EmptyObj | { low: number; high: number };

export type TDimensionRange = {
  name: string;
  startPos: number;
  minBound: number;
  maxBound: number;
} | null;

export type TDimInfo =
  | EmptyObj
  | {
      current: Dayjs | number | bigint | string;
      values: ArrayLike<number | bigint | string>;
      units?: string;
      attrs: zarr.Attributes;
      longName?: string;
    };

export type TVarInfo = {
  dimInfo: TDimInfo[];
  bounds: TBounds;
  dimRanges: TDimensionRange[];
  attrs: zarr.Attributes;
};

export type TZarrDggsMetadata = {
  name: string;
  refinement_level: number;
  coordinate: string | null;
};

export type TDatasetSource = {
  store: string;
  dataset: string;
  file?: File;
};

export type TDataSource = TDatasetSource & {
  default_colormap?: {
    name: TColorMap;
    inverted: boolean;
  };
  dtype?: string;
  shape?: number[];
  hidden?: boolean;
  default_range?: TBounds;
  attrs?: zarr.Attributes;
};

export type TModelInfo = {
  vars: Record<string, TDataSource>;
  defaultVar: string;
  title: string;
  colormaps: TColorMap[];
};

export type TSources = {
  name?: string;
  zarr_format: TZarrFormat;
  default_var?: string;
  levels: {
    name?: string;
    grid: TDatasetSource;
    time: TDatasetSource;
    datasources: Record<string, TDataSource>;
  }[];
};

export const SnapshotBackgrounds = {
  BLACK: "black",
  WHITE: "white",
  TRANSPARENT: "transparent",
} as const;
export type TSnapshotBackground =
  (typeof SnapshotBackgrounds)[keyof typeof SnapshotBackgrounds];
export type TSnapshotResolutionScale = 1 | 2 | 4;

export type TSnapshotOptions = {
  background: TSnapshotBackground;
  resolutionScale: TSnapshotResolutionScale;
  showDatasetInfo: boolean;
  showColormap: boolean;
};

export const DEFAULT_SNAPSHOT_OPTIONS: TSnapshotOptions = {
  background: SnapshotBackgrounds.BLACK,
  resolutionScale: 1,
  showDatasetInfo: true,
  showColormap: true,
};
