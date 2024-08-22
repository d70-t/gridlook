import type { Dayjs } from "dayjs";
import type { available_colormaps } from "../components/js/colormap_shaders";

export type TColorMap = keyof typeof available_colormaps;
export type TSelection = {
  colormap: TColorMap;
  invertColormap: boolean;
  varname: string;
  bounds: TBounds;
};

export type TVarInfo = {
  timeinfo: { current: Dayjs; values: Int32Array };
  time_range: { start: number; end: number };
  bounds: TBounds;
  attrs: { long_name: string; units: string };
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

export type TBounds = { low?: number; high?: number };

export type TSources = {
  name: string;
  default_var: string;
  levels: {
    name: string;
    datasources: object;
  }[];
};
