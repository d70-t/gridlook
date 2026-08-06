import { around } from "geokdbush";
import KDBush from "kdbush";

import type { TSerializedGeoSampleIndexData } from "./gridWorkerTypes.ts";

import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

type TSerializedGeoSampleIndex = {
  findNearest(
    lat: number,
    lon: number
  ): { lat: number; lon: number; value: number } | null;
};

export function createSerializedGeoSampleIndex(
  data: TSerializedGeoSampleIndexData
): TSerializedGeoSampleIndex {
  const index = KDBush.from(data.indexData);
  return {
    findNearest(lat, lon) {
      const nearest = around(
        index,
        ProjectionHelper.normalizeLongitude(lon),
        Math.max(-90, Math.min(90, lat)),
        1
      )[0];
      if (nearest === undefined) {
        return null;
      }
      return {
        lat: data.latitudes[nearest],
        lon: data.longitudes[nearest],
        value: data.values[nearest],
      };
    },
  };
}
