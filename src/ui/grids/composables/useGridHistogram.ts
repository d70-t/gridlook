import { storeToRefs } from "pinia";
import { ref, watch } from "vue";

import { useGlobeControlStore } from "@/store/store.ts";
import {
  HISTOGRAM_SUMMARY_BINS,
  buildHistogramSummary,
  isHistogramSummary,
  mergeHistogramSummaries,
  rebinHistogramSummary,
  type THistogramSummary,
} from "@/utils/histogram.ts";

const DISPLAY_BIN_COUNT = 50;

export function createGridHistogramSummary(
  data: ArrayLike<number> | THistogramSummary[] | undefined,
  min: number,
  max: number,
  missingValue?: number,
  fillValue?: number
) {
  if (!data || data.length === 0 || !isFinite(min) || !isFinite(max)) {
    return undefined;
  }
  return isHistogramSummary(data[0])
    ? mergeHistogramSummaries(
        data as THistogramSummary[],
        min,
        max,
        HISTOGRAM_SUMMARY_BINS
      )
    : buildHistogramSummary(
        data as ArrayLike<number>,
        min,
        max,
        HISTOGRAM_SUMMARY_BINS,
        fillValue,
        missingValue
      );
}

/* eslint-disable-next-line max-lines-per-function */
export function useGridHistogram() {
  const store = useGlobeControlStore();

  const { selection, posterizeLevels } = storeToRefs(store);
  const lastHistogramSummary = ref<THistogramSummary | null>(null);

  function getSelectionBinCount() {
    return posterizeLevels.value > 1
      ? posterizeLevels.value
      : DISPLAY_BIN_COUNT;
  }

  function recomputeHistogramFromSummary(
    summary: THistogramSummary,
    low: number,
    high: number
  ) {
    if (
      low !== undefined &&
      high !== undefined &&
      isFinite(low) &&
      isFinite(high)
    ) {
      const histogram = rebinHistogramSummary(
        summary,
        getSelectionBinCount(),
        low,
        high
      );
      store.updateHistogram(histogram);
    } else {
      store.updateHistogram(undefined);
    }
  }

  watch(
    [() => posterizeLevels.value, () => selection.value],
    () => {
      if (
        lastHistogramSummary.value &&
        selection.value?.low !== undefined &&
        selection.value?.high !== undefined
      ) {
        const low = selection.value.low as number;
        const high = selection.value.high as number;
        recomputeHistogramFromSummary(lastHistogramSummary.value, low, high);
      } else {
        store.updateHistogram(undefined);
      }
    },
    { deep: true }
  );

  function updateHistogram(
    data: ArrayLike<number> | THistogramSummary[] | undefined,
    min: number,
    max: number,
    missingValue?: number,
    fillValue?: number
  ) {
    const summary = createGridHistogramSummary(
      data,
      min,
      max,
      missingValue,
      fillValue
    );
    if (!summary) {
      store.updateHistogram(undefined);
      store.updateFullHistogram(undefined);
      store.updateHistogramSummary(undefined);
      lastHistogramSummary.value = null;
      return;
    }

    const fullHist = rebinHistogramSummary(
      summary,
      DISPLAY_BIN_COUNT,
      min,
      max
    );
    store.updateFullHistogram(fullHist);
    store.updateHistogramSummary(summary);

    recomputeHistogramFromSummary(
      summary,
      selection.value.low as number,
      selection.value.high as number
    );
    lastHistogramSummary.value = summary;
  }

  return { updateHistogram };
}
