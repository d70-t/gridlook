import * as zarr from "zarrita";

export type TCloneSafeGridData = Exclude<
  zarr.TypedArray<zarr.DataType>,
  zarr.BoolArray | zarr.ByteStringArray | zarr.UnicodeStringArray
>;

type TGridDataChunk = {
  data: zarr.TypedArray<zarr.DataType>;
  shape: number[];
};

function isGridDataChunk(value: unknown): value is TGridDataChunk {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const chunk = value as Partial<TGridDataChunk>;
  return chunk.data !== undefined && Array.isArray(chunk.shape);
}

function makeCloneSafeGridData(
  data: zarr.TypedArray<zarr.DataType>
): TCloneSafeGridData {
  if (data instanceof zarr.BoolArray) {
    return Array.from(data) as TCloneSafeGridData;
  }
  if (ArrayBuffer.isView(data) || Array.isArray(data)) {
    return data as TCloneSafeGridData;
  }
  return Array.from(data) as TCloneSafeGridData;
}

export function serializeGridDataChunk(result: unknown): {
  data: TCloneSafeGridData;
  shape: number[];
} {
  if (!isGridDataChunk(result)) {
    throw new Error(
      "Grid data selection returned a scalar instead of an array."
    );
  }
  return {
    data: makeCloneSafeGridData(result.data),
    shape: [...result.shape],
  };
}
