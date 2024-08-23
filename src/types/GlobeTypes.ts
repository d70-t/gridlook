import type { Dayjs } from "dayjs";
import type { availableColormaps } from "../components/utils/colormap_shaders.ts";
import type { UserAttributes } from "zarr/types/types.js";

export type EmptyObj = Record<PropertyKey, never>;

export type TColorMap = keyof typeof availableColormaps;
export type TSelection = {
  colormap: TColorMap;
  invertColormap: boolean;
  bounds: TBounds;
};

export type TVarInfo = {
  timeinfo: EmptyObj | { current: Dayjs; values: Int32Array };
  time_range: { start: number; end: number };
  bounds: TBounds;
  attrs: UserAttributes; //{ long_name: string; units: string };
};

export type TModelInfo = {
  vars: Record<
    string,
    {
      dataset: string;
      default_colormap: {
        name: TColorMap;
        inverted: boolean;
      };
      default_range: TBounds;
      store: string;
    }
  >;
  default_var: string;
  title: string;
  colormaps: TColorMap[];
  time_range: { start: number; end: number };
};

export type TBounds = EmptyObj | { low: number; high: number };

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

export type TDataSource = {
  dataset: string;
  default_colormap: {
    name: TColorMap;
    inverted: boolean;
  };
  default_range: TBounds;
  store: string;
};
