import type { Dayjs } from "dayjs";
import * as zarr from "zarrita";

import type { TColorMap } from "@/lib/shaders/colormapShaders";

export const ZARR_FORMAT = {
  V2: 2,
  V3: 3,
} as const;

export type TZarrFormat = (typeof ZARR_FORMAT)[keyof typeof ZARR_FORMAT];

export type EmptyObj = Record<PropertyKey, never>;

export type TBounds = EmptyObj | { low: number; high: number };

export type TSelection = {
  bounds: TBounds;
};

export type TDimensionRange = {
  name: string;
  startPos: number;
  minBound: number;
  maxBound: number;
} | null;

export type TDimInfo =
  | EmptyObj
  | {
      current: Dayjs | number;
      values: Int32Array;
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

export type TDataSource = {
  store: string;
  dataset: string;
  default_colormap?: {
    name: TColorMap;
    inverted: boolean;
  };
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
    grid: {
      store: string;
      dataset: string;
    };
    time: {
      store: string;
      dataset: string;
    };
    datasources: Record<string, TDataSource>;
  }[];
};

export type TZarrV3RootMetadata = {
  zarr_format: 3;
  node_type: "group";
  attributes?: Record<string, unknown>;
  consolidated_metadata: {
    metadata: Record<string, zarr.ArrayMetadata | zarr.GroupMetadata>;
  };
};
