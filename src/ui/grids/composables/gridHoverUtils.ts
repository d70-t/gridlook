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

function longitudeDistance(a: number, b: number) {
  const delta = Math.abs(
    ProjectionHelper.normalizeLongitude(a) -
      ProjectionHelper.normalizeLongitude(b)
  );
  return Math.min(delta, 360 - delta);
}

function getBucketKey(latBucket: number, lonBucket: number) {
  return `${latBucket}:${lonBucket}`;
}

function getDistanceScore(
  targetLat: number,
  targetLon: number,
  sample: TGeoSample
) {
  const latDelta = targetLat - sample.lat;
  const meanLatRadians = ((targetLat + sample.lat) / 2 / 180) * Math.PI;
  const lonDelta =
    longitudeDistance(targetLon, sample.lon) * Math.cos(meanLatRadians);
  return latDelta * latDelta + lonDelta * lonDelta;
}

export function createGeoSampleIndex(
  samples: TGeoSample[],
  bucketSizeDegrees = 5
): TGeoSampleIndex {
  const safeBucketSize = Math.max(bucketSizeDegrees, 1);
  const buckets = new Map<string, number[]>();
  const latBucketCount = Math.max(1, Math.ceil(180 / safeBucketSize));
  const lonBucketCount = Math.max(1, Math.ceil(360 / safeBucketSize));

  const getLatBucket = (lat: number) =>
    Math.max(
      0,
      Math.min(
        latBucketCount - 1,
        Math.floor((Math.max(-90, Math.min(90, lat)) + 90) / safeBucketSize)
      )
    );
  const getLonBucket = (lon: number) =>
    ((Math.floor(
      (ProjectionHelper.normalizeLongitude(lon) + 180) / safeBucketSize
    ) %
      lonBucketCount) +
      lonBucketCount) %
    lonBucketCount;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const key = getBucketKey(
      getLatBucket(sample.lat),
      getLonBucket(sample.lon)
    );
    const entries = buckets.get(key);
    if (entries) {
      entries.push(i);
    } else {
      buckets.set(key, [i]);
    }
  }

  return {
    findNearest: (lat, lon) =>
      findNearestInBuckets({
        lat,
        lon,
        samples,
        buckets,
        latBucketCount,
        lonBucketCount,
        getLatBucket,
        getLonBucket,
      }),
  };
}

type BucketSearchContext = {
  lat: number;
  lon: number;
  samples: TGeoSample[];
  buckets: Map<string, number[]>;
  latBucketCount: number;
  lonBucketCount: number;
  getLatBucket: (lat: number) => number;
  getLonBucket: (lon: number) => number;
};

function findNearestInBuckets(ctx: BucketSearchContext): TGeoSample | null {
  const latBucket = ctx.getLatBucket(ctx.lat);
  const lonBucket = ctx.getLonBucket(ctx.lon);
  const visited = new Set<string>();
  const maxRing = Math.max(ctx.latBucketCount, ctx.lonBucketCount);

  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  let firstMatchRing = -1;

  for (let ring = 0; ring <= maxRing; ring++) {
    if (firstMatchRing >= 0 && ring > firstMatchRing + 1) {
      break;
    }

    ({ bestIndex, bestScore } = scanRing(
      ctx,
      ring,
      latBucket,
      lonBucket,
      visited,
      bestIndex,
      bestScore
    ));

    if (bestIndex !== -1 && firstMatchRing < 0) {
      firstMatchRing = ring;
    }
  }

  return bestIndex !== -1 ? ctx.samples[bestIndex] : null;
}

function scanRing(
  ctx: BucketSearchContext,
  ring: number,
  latBucket: number,
  lonBucket: number,
  visited: Set<string>,
  bestIndex: number,
  bestScore: number
) {
  for (let latOffset = -ring; latOffset <= ring; latOffset++) {
    for (let lonOffset = -ring; lonOffset <= ring; lonOffset++) {
      if (
        ring > 0 &&
        Math.abs(latOffset) !== ring &&
        Math.abs(lonOffset) !== ring
      ) {
        continue;
      }

      const candidateLatBucket = latBucket + latOffset;
      if (candidateLatBucket < 0 || candidateLatBucket >= ctx.latBucketCount) {
        continue;
      }

      const candidateLonBucket =
        (((lonBucket + lonOffset) % ctx.lonBucketCount) + ctx.lonBucketCount) %
        ctx.lonBucketCount;
      const key = getBucketKey(candidateLatBucket, candidateLonBucket);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      const entries = ctx.buckets.get(key);
      if (!entries) {
        continue;
      }

      for (const sampleIndex of entries) {
        const score = getDistanceScore(
          ctx.lat,
          ctx.lon,
          ctx.samples[sampleIndex]
        );
        if (score < bestScore) {
          bestScore = score;
          bestIndex = sampleIndex;
        }
      }
    }
  }

  return { bestIndex, bestScore };
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
