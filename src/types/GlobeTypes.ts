import type { Dayjs } from "dayjs";
import type { availableColormaps } from "../components/utils/colormapShaders.ts";
import * as zarr from "zarrita";

export type EmptyObj = Record<PropertyKey, never>;

export type TColorMap = keyof typeof availableColormaps;

export type TBounds = EmptyObj | { low: number; high: number };

export type TSelection = {
  bounds: TBounds;
};

export type TVarInfo = {
  timeinfo: EmptyObj | { current: Dayjs; values: Int32Array };
  timeRange: { start: number; end: number };
  bounds: TBounds;
  dimRanges: ({ name: string; start: number; end: number } | null)[];
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
  timeRange: { start: number; end: number };
};

export type TSources = {
  name: string;
  default_var: string;
  levels: {
    name: string;
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
