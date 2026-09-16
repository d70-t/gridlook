import { nextTick, onScopeDispose } from "vue";

import {
  createGridHistogramSummary,
  type useGridHistogram,
} from "./useGridHistogram.ts";
import { createVectorMagnitudeVarInfo } from "./vectorMagnitudeScalar.ts";

import type { TVectorMagnitudeData } from "@/lib/data/vectorMagnitude.ts";
import type { TVarInfo } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import type { THistogramSummary } from "@/utils/histogram.ts";

type TRender = () => void;
type TOptions = {
  updateHistogram: ReturnType<typeof useGridHistogram>["updateHistogram"];
  updateColormap: () => void;
  redraw: () => void;
};

type TScalarFrame = {
  render: TRender;
  info: TVarInfo;
  indices: number[];
  data: ArrayLike<number> | THistogramSummary[];
  missingValue?: number;
  fillValue?: number;
  isCurrent?: () => boolean;
};

/** Stage the current scalar slice without changing the frame on screen. */
// eslint-disable-next-line max-lines-per-function
export function useScalarFieldCache(options: TOptions) {
  const store = useGlobeControlStore();
  let generation = 0;
  let displayRevision = 0;
  let scalar: ReturnType<typeof snapshot> | undefined;
  let visibleFrame: ReturnType<typeof snapshot> | undefined;
  let needsScalarRender = false;
  let magnitude:
    | {
        data: TVectorMagnitudeData;
        prepared: Promise<TRender>;
        display?: ReturnType<typeof snapshot>;
      }
    | undefined;

  function snapshot(frame: TScalarFrame, name: string) {
    return {
      render: frame.render,
      info: frame.info,
      indices: frame.indices,
      name,
      histogram: createGridHistogramSummary(
        frame.data,
        frame.info.bounds.low ?? NaN,
        frame.info.bounds.high ?? NaN,
        frame.missingValue,
        frame.fillValue
      ),
      isCurrent: frame.isCurrent ?? (() => true),
    };
  }

  async function display(state: ReturnType<typeof snapshot>, revision: number) {
    if (!state.isCurrent() || visibleFrame === state) {
      return;
    }
    store.varnameDisplay = state.name;
    store.updateVarInfo(state.info, state.indices);
    options.updateHistogram(
      state.histogram ? [state.histogram] : undefined,
      state.info.bounds.low ?? NaN,
      state.info.bounds.high ?? NaN
    );
    // Bounds controls must restore their range before the next frame is drawn.
    await nextTick();
    if (revision !== displayRevision || !state.isCurrent()) {
      return;
    }
    // Some grids create their geometry with the scalar slice. Install it in
    // the same frame as the magnitude, without an intervening asynchronous step.
    if (needsScalarRender && state !== scalar) {
      scalar?.render();
    }
    needsScalarRender = false;
    state.render();
    visibleFrame = state;
    store.dimSlidersDisplay = state.indices.slice();
    options.updateColormap();
    options.redraw();
  }

  function clear() {
    generation++;
    displayRevision++;
    scalar = undefined;
    visibleFrame = undefined;
    magnitude = undefined;
    needsScalarRender = false;
  }

  function captureScalar(frame: TScalarFrame) {
    clear();
    scalar = snapshot(frame, store.varnameSelector);
    needsScalarRender = true;
  }

  async function restoreScalar() {
    const revision = ++displayRevision;
    if (!scalar || !scalar.isCurrent()) {
      return false;
    }
    await display(scalar, revision);
    return true;
  }

  async function showMagnitude(
    data: TVectorMagnitudeData,
    prepare: () => TRender | Promise<TRender>
  ) {
    const revision = ++displayRevision;
    const currentGeneration = generation;
    const selectionRevision = store.streamlineSelectionRevision;
    if (magnitude?.data !== data) {
      magnitude = { data, prepared: Promise.resolve().then(prepare) };
    }
    const cached = magnitude;
    let render: TRender;
    try {
      render = await cached.prepared;
    } catch (error) {
      if (magnitude === cached) {
        magnitude = undefined;
      }
      throw error;
    }
    if (
      currentGeneration !== generation ||
      revision !== displayRevision ||
      selectionRevision !== store.streamlineSelectionRevision ||
      !store.streamlineMagnitudeDisplayed ||
      !scalar ||
      !scalar.isCurrent()
    ) {
      return;
    }
    cached.display ??= snapshot(
      {
        render,
        info: createVectorMagnitudeVarInfo(scalar.info, data)!,
        indices: scalar.indices,
        data: data.data,
        isCurrent: scalar.isCurrent,
      },
      data.standardName ?? "vector_magnitude"
    );
    await display(cached.display, revision);
  }

  onScopeDispose(clear);
  return { captureScalar, restoreScalar, showMagnitude, clear };
}
