import type { TPreparedVolumeFrame, TVolumeFramePlan } from "./volumeFrame.ts";

/** Metadata-only check: callers can reject changing grids/units before fetching. */
export function assertCompatibleVolumePlans(
  plans: readonly TVolumeFramePlan[]
) {
  const first = plans[0];
  if (
    !first ||
    plans.some(
      (plan) =>
        !plan.interpolatable ||
        plan.datasources !== first.datasources ||
        plan.mappingKey !== first.mappingKey
    )
  ) {
    throw new Error(
      "Volume interpolation requires matching grids, channels and vertical coordinates."
    );
  }
}

/** One normalization and vertical shell for the entire prepared time range. */
export function createVolumeInterpolation(
  frames: readonly TPreparedVolumeFrame[]
) {
  assertCompatibleVolumePlans(frames.map((frame) => frame.plan));
  const first = frames[0];
  const valueScales = [...first.valueScales];
  let min = Infinity,
    max = -Infinity;
  for (const frame of frames) {
    const physical = frame.physical;
    if (
      !physical ||
      !(frame.data instanceof Uint16Array) ||
      physical.vertical !== first.physical?.vertical ||
      JSON.stringify(frame.bounds) !== JSON.stringify(first.bounds) ||
      frame.channelCount !== first.channelCount ||
      frame.storageChannelCount !== first.storageChannelCount ||
      !Number.isFinite(physical.range.min) ||
      !Number.isFinite(physical.range.max) ||
      physical.range.max < physical.range.min
    ) {
      throw new Error("Volume keyframes have incompatible physical mappings.");
    }
    min = Math.min(min, physical.range.min);
    max = Math.max(max, physical.range.max);
    for (let channel = 0; channel < valueScales.length; channel++) {
      valueScales[channel] = Math.max(
        valueScales[channel],
        frame.valueScales[channel]
      );
    }
  }
  return { frames: [...frames], valueScales, range: { min, max } };
}

export type TVolumeInterpolation = ReturnType<typeof createVolumeInterpolation>;

export type TVolumePresentation = {
  sequence: TVolumeInterpolation;
  first: number;
  next: number;
  alpha: number;
  forExport?: boolean;
};
