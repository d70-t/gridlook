export type TInfoDimension = {
  name: string;
  size: number;
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
