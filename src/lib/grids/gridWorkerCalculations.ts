import KDBush from "kdbush";

import type { TSerializedGeoSampleIndexData } from "./gridWorkerTypes.ts";

export function buildSerializedGeoSampleIndexData(
  latitudes: Float64Array,
  longitudes: Float64Array,
  values: Float32Array
): TSerializedGeoSampleIndexData {
  const index = new KDBush(latitudes.length);
  for (let sampleIndex = 0; sampleIndex < latitudes.length; sampleIndex++) {
    latitudes[sampleIndex] = Math.max(
      -90,
      Math.min(90, latitudes[sampleIndex])
    );
    longitudes[sampleIndex] =
      (((longitudes[sampleIndex] % 360) + 540) % 360) - 180;
    index.add(longitudes[sampleIndex], latitudes[sampleIndex]);
  }
  index.finish();
  return {
    indexData: index.data as ArrayBuffer,
    latitudes,
    longitudes,
    values,
  };
}
