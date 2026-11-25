import * as zarr from "zarrita";

import { decodeTime, isTimeUnits } from "@/lib/data/timeHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import type { TDatasetSource, TZarrFormat } from "@/lib/types/GlobeTypes.ts";

const SAMPLE_SIZE = 10;

/** A stored value as text; time coordinates are shown as dates. */
export function formatSampleValue(
  value: unknown,
  attrs: zarr.Attributes,
  dtype: string
): string {
  if (typeof value === "number" || typeof value === "bigint") {
    if (isTimeUnits(attrs.units)) {
      try {
        return decodeTime(value, attrs).format("YYYY-MM-DD HH:mm:ss");
      } catch {
        return String(value);
      }
    }
    // a float32 read into a double shows digits it never stored
    if (typeof value === "number" && dtype === "float32") {
      return String(Number(value.toPrecision(7)));
    }
  }
  return String(value);
}

/**
 * The first values of a variable as stored (unscaled, fill values kept).
 * ponytail: reads along the last dimension at index 0 of the others, so it
 * gives fewer than 10 values when the last dimension is shorter; read a block
 * spanning several rows if the first values in storage order are needed.
 */
export async function loadVariableSample(
  source: TDatasetSource,
  name: string,
  format?: TZarrFormat
): Promise<string[]> {
  const array = await ZarrDataManager.getVariableInfo(source, name, format);
  if (array.shape.some((size) => size === 0)) {
    return [];
  }
  const last = array.shape.length - 1;
  const selection = array.shape.map((size, index) =>
    index === last ? zarr.slice(0, Math.min(SAMPLE_SIZE, size)) : 0
  );
  const result: unknown = await ZarrDataManager.getVariableDataFromArray(
    array,
    selection
  );
  // a 0-d array comes back as a single value
  const values =
    typeof result === "object" && result !== null && "data" in result
      ? Array.from(result.data as ArrayLike<unknown>)
      : [result];
  const dtype = String(array.dtype);
  return values.map((value) => formatSampleValue(value, array.attrs, dtype));
}
