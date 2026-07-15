import KDBush from "kdbush";

import type { TSerializedGeoSampleIndexData } from "./gridWorkerTypes.ts";

export function shouldFlipCartesianTriangle(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number
) {
  const edgeAx = x1 - x0;
  const edgeAy = y1 - y0;
  const edgeAz = z1 - z0;
  const edgeBx = x2 - x0;
  const edgeBy = y2 - y0;
  const edgeBz = z2 - z0;
  const normalX = edgeAy * edgeBz - edgeAz * edgeBy;
  const normalY = edgeAz * edgeBx - edgeAx * edgeBz;
  const normalZ = edgeAx * edgeBy - edgeAy * edgeBx;
  const centerX = x0 + x1 + x2;
  const centerY = y0 + y1 + y2;
  const centerZ = z0 + z1 + z2;
  return normalX * centerX + normalY * centerY + normalZ * centerZ < 0;
}

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
