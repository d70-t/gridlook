import * as zarr from "zarrita";

export type TInfoDimension = {
  name: string;
  size: number;
};

/** The level of a multi-resolution dataset the chunk overview describes. */
export type TChunkLevel = {
  label: string;
  /** The coarsest level, when it is also loaded beneath for one colour range. */
  backdrop: string | null;
};

export type TCoordinateSlice = {
  first10: number[];
  last10: number[];
};

export type TTimeInfo = {
  units: string;
  calendar: string;
  firstTimestamp: string;
  lastTimestamp: string;
  timestep: string | null;
  numTimesteps: number;
};

export type TVariableMetadata = {
  attrs: zarr.Attributes | null;
  dimensions: string[];
  shape?: number[];
  dtype: string | null;
  error: string | null;
};

export type TVariableTableRow = {
  name: string;
  hidden: boolean;
  // why the variable cannot be visualised from the table (shown as the
  // tooltip of its greyed-out button): it is on a level other than the one
  // shown
  visualizeDisabled?: string;
} & TVariableMetadata;

/** What the table says about a group that is a level of the dataset. */
export type TVariableGroupInfo = {
  // resolution and cell count, when known
  detail?: string;
  // the level shown, whose variables can be visualised
  current: boolean;
};

export type TGroupInfo = {
  path: string;
  attrs: zarr.Attributes | null;
};

export const InfoPanelTab = {
  OVERVIEW: "overview",
  BROWSE: "browse",
} as const;

export type TInfoPanelTab = (typeof InfoPanelTab)[keyof typeof InfoPanelTab];

/** The first values of a variable, loaded on request from the Browse tab. */
export type TVariableSample = {
  // null while loading or after an error
  values: string[] | null;
  error: string | null;
};
