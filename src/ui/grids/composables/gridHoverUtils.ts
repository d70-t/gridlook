import { around } from "geokdbush";
import KDBush from "kdbush";
import { onBeforeUnmount, shallowRef, watch, type ShallowRef } from "vue";

import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  HOVERED_GRID_POINT_STATUS,
  useGlobeControlStore,
  type THoveredGridPointStatus,
} from "@/store/store.ts";

export type THoverGeoPoint = {
  lat: number;
  lon: number;
  screenX: number;
  screenY: number;
};

export type TGridHoverLookupResult = {
  lat: number;
  lon: number;
  value: number | null;
  status: THoveredGridPointStatus;
};

export type TGeoSample = {
  lat: number;
  lon: number;
  value: number;
};

export type TGeoSampleIndex = {
  findNearest(lat: number, lon: number): TGeoSample | null;
};

function clampLatitude(lat: number) {
  return Math.max(-90, Math.min(90, lat));
}

export function createGeoSampleIndex(
  samples: TGeoSample[],
  bucketSizeDegrees = 5
): TGeoSampleIndex {
  void bucketSizeDegrees;

  const normalizedSamples = samples.map((sample) => {
    return {
      ...sample,
      lat: clampLatitude(sample.lat),
      lon: ProjectionHelper.normalizeLongitude(sample.lon),
    };
  });

  const index = new KDBush(normalizedSamples.length);
  for (const sample of normalizedSamples) {
    index.add(sample.lon, sample.lat);
  }
  index.finish();

  return {
    findNearest(lat, lon) {
      const nearest = around(
        index,
        ProjectionHelper.normalizeLongitude(lon),
        clampLatitude(lat),
        1
      );
      const nearestIndex = nearest[0];
      if (nearestIndex === undefined) {
        return null;
      }
      return normalizedSamples[nearestIndex] ?? null;
    },
  };
}

function isMissingGridValue(
  value: number,
  fillValue: number,
  missingValue: number
) {
  return (
    !Number.isFinite(value) || value === fillValue || value === missingValue
  );
}

export function useGridHoverLookup(
  hoveredGeoPoint: Readonly<ShallowRef<THoverGeoPoint | null>>
) {
  const store = useGlobeControlStore();
  type HoverLookupFn = (
    lat: number,
    lon: number
  ) => TGridHoverLookupResult | null;
  const lookupRef = shallowRef<HoverLookupFn | null>(null);

  const stopWatch = watch(
    [hoveredGeoPoint, lookupRef] as const,
    ([point, currentLookup]) => {
      if (!point || !currentLookup) {
        store.clearHoveredGridPoint();
        return;
      }

      const result = currentLookup(point.lat, point.lon);
      if (!result) {
        store.clearHoveredGridPoint();
        return;
      }

      store.setHoveredGridPoint({
        ...result,
        screenX: point.screenX,
        screenY: point.screenY,
      });
    }
  );

  onBeforeUnmount(() => {
    stopWatch();
    store.clearHoveredGridPoint();
  });

  return {
    clearHoverLookup() {
      lookupRef.value = null;
    },
    setHoverLookup(nextLookup: HoverLookupFn) {
      lookupRef.value = nextLookup;
    },
    setHoverLookupFromIndex(
      index: TGeoSampleIndex,
      fillValue: number,
      missingValue: number
    ) {
      lookupRef.value = createSampleIndexLookup(index, fillValue, missingValue);
    },
  };
}

function createSampleIndexLookup(
  index: TGeoSampleIndex,
  fillValue: number,
  missingValue: number
): (lat: number, lon: number) => TGridHoverLookupResult | null {
  return (lat, lon) => {
    const sample = index.findNearest(lat, lon);
    if (!sample) {
      return null;
    }
    const missing = isMissingGridValue(sample.value, fillValue, missingValue);
    return {
      lat: sample.lat,
      lon: sample.lon,
      value: missing ? null : sample.value,
      status: missing
        ? HOVERED_GRID_POINT_STATUS.MISSING
        : HOVERED_GRID_POINT_STATUS.VALUE,
    };
  };
}
