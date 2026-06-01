import { storeToRefs } from "pinia";
import {
  computed,
  onUnmounted,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";

import { isTimeUnits } from "@/lib/data/timeHandling.ts";
import type { TDimensionRange, TVarInfo } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

export const PLAYBACK_SPEED = {
  SLOW: 0,
  NORMAL: 1,
  FAST: 2,
  MAX: 3,
} as const;

export type TPlaybackSpeed =
  (typeof PLAYBACK_SPEED)[keyof typeof PLAYBACK_SPEED];

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

const isPlaying = ref(false);
const speed = ref<TPlaybackSpeed>(PLAYBACK_SPEED.NORMAL);
let activeToggle: (() => void) | null = null;

export function toggleTimeAnimation() {
  activeToggle?.();
}

type TAnimationContext = {
  timeRangeIndex: ComputedRef<number>;
  timeRange: ComputedRef<TPlayableDimensionRange | null>;
  dimSlidersValues: Ref<(number | null)[]>;
  loading: Ref<boolean>;
  canAnimate: ComputedRef<boolean>;
};

type TAnimationStoreRefs = {
  varinfo: Ref<TVarInfo | undefined>;
  dimSlidersValues: Ref<(number | null)[]>;
  loading: Ref<boolean>;
};

function createTimeRangeIndex(varinfo: Ref<TVarInfo | undefined>) {
  return computed(() => {
    const info = varinfo.value;
    if (!info) {
      return -1;
    }
    return info.dimRanges.findIndex((range, index) => {
      if (range === null) {
        return false;
      }
      const dimInfo = info.dimInfo[index];
      return (
        dimInfo !== undefined &&
        "attrs" in dimInfo &&
        isTimeUnits(dimInfo.attrs.units)
      );
    });
  });
}

function createTimeAnimationContext(
  refs: TAnimationStoreRefs
): TAnimationContext {
  const timeRangeIndex = createTimeRangeIndex(refs.varinfo);
  const timeRange = computed<TPlayableDimensionRange | null>(() => {
    const index = timeRangeIndex.value;
    return index === -1 ? null : (refs.varinfo.value?.dimRanges[index] ?? null);
  });
  const canAnimate = computed(() => {
    const range = timeRange.value;
    return range !== null && range.maxBound > range.minBound;
  });

  return {
    timeRangeIndex,
    timeRange,
    dimSlidersValues: refs.dimSlidersValues,
    loading: refs.loading,
    canAnimate,
  };
}

function createAdvanceStep(ctx: TAnimationContext, stop: () => void) {
  return function advanceStep() {
    const index = ctx.timeRangeIndex.value;
    const range = ctx.timeRange.value;
    if (index === -1 || range === null) {
      stop();
      return;
    }

    const current = ctx.dimSlidersValues.value[index] ?? range.minBound;
    const next = current + 1;
    ctx.dimSlidersValues.value[index] =
      next > range.maxBound ? range.minBound : next;
  };
}

function createPlaybackControls(ctx: TAnimationContext) {
  let delayTimer: ReturnType<typeof setTimeout> | null = null;

  function stop() {
    isPlaying.value = false;
    if (delayTimer !== null) {
      clearTimeout(delayTimer);
      delayTimer = null;
    }
  }

  const advanceStep = createAdvanceStep(ctx, stop);

  function scheduleNextStep() {
    if (!isPlaying.value) {
      return;
    }
    delayTimer = setTimeout(() => {
      delayTimer = null;
      advanceStep();
    }, SPEED_DELAYS[speed.value]);
  }

  function play() {
    if (!ctx.canAnimate.value) {
      return;
    }
    isPlaying.value = true;
    if (!ctx.loading.value) {
      advanceStep();
    }
  }

  function toggle() {
    if (isPlaying.value) {
      stop();
    } else {
      play();
    }
  }

  function cycleSpeed() {
    const currentIndex = PLAYBACK_SPEED_ORDER.indexOf(speed.value);
    speed.value =
      PLAYBACK_SPEED_ORDER[(currentIndex + 1) % PLAYBACK_SPEED_ORDER.length];
  }

  return { stop, toggle, cycleSpeed, scheduleNextStep };
}

export function useTimeAnimation() {
  const store = useGlobeControlStore();
  const { varinfo, dimSlidersValues, loading } = storeToRefs(store);
  const animationContext = createTimeAnimationContext({
    varinfo,
    dimSlidersValues,
    loading,
  });

  const { stop, toggle, cycleSpeed, scheduleNextStep } =
    createPlaybackControls(animationContext);

  activeToggle = toggle;

  watch(loading, (isLoading, wasLoading) => {
    if (isPlaying.value && wasLoading && !isLoading) {
      scheduleNextStep();
    }
  });

  onUnmounted(() => {
    stop();
    if (activeToggle === toggle) {
      activeToggle = null;
    }
  });

  return {
    isPlaying,
    speed,
    canAnimate: animationContext.canAnimate,
    toggle,
    cycleSpeed,
    speedLabel: computed(() => SPEED_LABELS[speed.value]),
  };
}
