export type TGridGeometryBatch = {
  batchIndex: number;
  positionValues: Float32Array;
  dataValues: Float32Array;
  latLonValues: Float32Array;
  indices: Uint32Array;
};

export type TGridPointBatch = Omit<TGridGeometryBatch, "indices">;

export type TGridDataValueBatch = {
  batchIndex: number;
  dataValues: Float32Array;
};

export type TGridWorkerBatch =
  | TGridGeometryBatch
  | TGridPointBatch
  | TGridDataValueBatch;

export type TSerializedGeoSampleIndexData = {
  indexData: ArrayBuffer;
  latitudes: Float64Array;
  longitudes: Float64Array;
  values: Float32Array;
};
