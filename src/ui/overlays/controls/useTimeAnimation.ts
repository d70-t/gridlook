import { storeToRefs } from "pinia";
import { computed, ref, watch, type ComputedRef } from "vue";

import { isTimeUnits } from "@/lib/data/timeHandling.ts";
import type { TDimensionRange, TVarInfo } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const PLAYBACK_SPEED = {
  SLOW: 0,
  NORMAL: 1,
  FAST: 2,
  MAX: 3,
} as const;

type TPlaybackSpeed = (typeof PLAYBACK_SPEED)[keyof typeof PLAYBACK_SPEED];

type TPlayableDimensionRange = Exclude<TDimensionRange, null>;

const PLAYBACK_SPEED_ORDER: readonly TPlaybackSpeed[] = [
  PLAYBACK_SPEED.SLOW,
  PLAYBACK_SPEED.NORMAL,
  PLAYBACK_SPEED.FAST,
  PLAYBACK_SPEED.MAX,
];

const SPEED_DELAYS: Record<TPlaybackSpeed, number> = {
  [PLAYBACK_SPEED.SLOW]: 1500,
  [PLAYBACK_SPEED.NORMAL]: 700,
  [PLAYBACK_SPEED.FAST]: 200,
  [PLAYBACK_SPEED.MAX]: 0,
};

const SPEED_LABELS: Record<TPlaybackSpeed, string> = {
  [PLAYBACK_SPEED.SLOW]: "0.5x",
  [PLAYBACK_SPEED.NORMAL]: "1x",
  [PLAYBACK_SPEED.FAST]: "2x",
  [PLAYBACK_SPEED.MAX]: "Max",
};

// Only one dimension can play back at a time: playback is driven by the
// shared `loading` state (advancing a slider triggers a fetch, and the next
// step is scheduled once that fetch completes), so two dimensions animating
// at once would race over the same loading pulse.
const playingIndex = ref(-1);
const speed = ref<TPlaybackSpeed>(PLAYBACK_SPEED.NORMAL);
let delayTimer: ReturnType<typeof setTimeout> | null = null;
let loadingWatcherStarted = false;

function getDimensionRange(
  varinfo: TVarInfo | undefined,
  index: number
): TPlayableDimensionRange | null {
  return varinfo?.dimRanges[index] ?? null;
}

function findTimeDimensionIndex(varinfo: TVarInfo | undefined): number {
  if (!varinfo) {
    return -1;
  }
  return varinfo.dimRanges.findIndex((range, index) => {
    if (range === null) {
      return false;
    }
    const dimInfo = varinfo.dimInfo[index];
    return (
      dimInfo !== undefined &&
      "attrs" in dimInfo &&
      isTimeUnits(dimInfo.attrs.units)
    );
  });
}

export function stopAnimation() {
  playingIndex.value = -1;
  if (delayTimer !== null) {
    clearTimeout(delayTimer);
    delayTimer = null;
  }
}

function advanceStep(store: ReturnType<typeof useGlobeControlStore>) {
  const index = playingIndex.value;
  const range = getDimensionRange(store.varinfo, index);
  if (index === -1 || range === null) {
    stopAnimation();
    return;
  }

  const current = store.dimSlidersValues[index] ?? range.minBound;
  const next = current + 1;
  store.dimSlidersValues[index] = next > range.maxBound ? range.minBound : next;
}

function scheduleNextStep(store: ReturnType<typeof useGlobeControlStore>) {
  if (playingIndex.value === -1) {
    return;
  }
  delayTimer = setTimeout(() => {
    delayTimer = null;
    advanceStep(store);
  }, SPEED_DELAYS[speed.value]);
}

function ensureLoadingWatcher(store: ReturnType<typeof useGlobeControlStore>) {
  if (loadingWatcherStarted) {
    return;
  }
  loadingWatcherStarted = true;
  const { loading } = storeToRefs(store);
  watch(loading, (isLoading, wasLoading) => {
    if (playingIndex.value !== -1 && wasLoading && !isLoading) {
      scheduleNextStep(store);
    }
  });
}

function toggleDimension(
  store: ReturnType<typeof useGlobeControlStore>,
  index: number,
  canAnimate: boolean
) {
  if (playingIndex.value === index) {
    stopAnimation();
    return;
  }
  if (!canAnimate) {
    return;
  }
  stopAnimation();
  playingIndex.value = index;
  if (!store.loading) {
    advanceStep(store);
  }
}

export function toggleTimeAnimation() {
  const store = useGlobeControlStore();
  const index = findTimeDimensionIndex(store.varinfo);
  if (index === -1) {
    return;
  }
  const range = getDimensionRange(store.varinfo, index);
  const canAnimate =
    !store.live && range !== null && range.maxBound > range.minBound;
  toggleDimension(store, index, canAnimate);
}

export function useDimensionAnimation(
  dimensionIndex: ComputedRef<number>,
  options: { excludeWhileLive?: boolean } = {}
) {
  const store = useGlobeControlStore();
  ensureLoadingWatcher(store);

  const range = computed<TPlayableDimensionRange | null>(() =>
    getDimensionRange(store.varinfo, dimensionIndex.value)
  );
  const canAnimate = computed(() => {
    if (options.excludeWhileLive && store.live) {
      return false;
    }
    const currentRange = range.value;
    return (
      dimensionIndex.value !== -1 &&
      currentRange !== null &&
      currentRange.maxBound > currentRange.minBound
    );
  });
  const isPlaying = computed(() => playingIndex.value === dimensionIndex.value);

  function toggle() {
    toggleDimension(store, dimensionIndex.value, canAnimate.value);
  }

  function cycleSpeed() {
    const currentIndex = PLAYBACK_SPEED_ORDER.indexOf(speed.value);
    speed.value =
      PLAYBACK_SPEED_ORDER[(currentIndex + 1) % PLAYBACK_SPEED_ORDER.length];
  }

  return {
    isPlaying,
    canAnimate,
    toggle,
    cycleSpeed,
    speedLabel: computed(() => SPEED_LABELS[speed.value]),
  };
}
