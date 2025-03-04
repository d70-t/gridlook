import type { Dayjs } from "dayjs";
import type { availableColormaps } from "../components/utils/colormapShaders.ts";
import type { UserAttributes } from "zarr/types/types.js";

export type EmptyObj = Record<PropertyKey, never>;

export type TColorMap = keyof typeof availableColormaps;

export type TBounds = EmptyObj | { low: number; high: number };

export type TSelection = {
  colormap: TColorMap;
  invertColormap: boolean;
  bounds: TBounds;
};

export type TVarInfo = {
  timeinfo: EmptyObj | { current: Dayjs; values: Int32Array };
  timeRange: { start: number; end: number };
  bounds: TBounds;
  attrs: UserAttributes; //{ long_name: string; units: string };
};

export type TModelInfo = {
  vars: Record<
    string,
    {
      dataset: string;
      default_colormap: {
        // external resource, we keep the kebab-case here...
        name: TColorMap;
        inverted: boolean;
      };
      default_range: TBounds;
      store: string;
    }
  >;
  defaultVar: string;
  title: string;
  colormaps: TColorMap[];
  timeRange: { start: number; end: number };
};

export type TDataSource = {
  dataset: string;
  default_colormap: {
    name: TColorMap;
    inverted: boolean;
  };
  default_range: TBounds;
  store: string;
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
