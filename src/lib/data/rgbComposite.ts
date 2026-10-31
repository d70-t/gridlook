import type { TDimInfo, TDimensionRange } from "@/lib/types/GlobeTypes.ts";

/* An RGB composite shows three slices of one dimension of the current
   variable (e.g. the bands B04/B03/B02 of a `band` dimension) as the red,
   green and blue channels of one image. */

export type TRgbChannels = [number, number, number];

export type TRgbSettings = {
  // the dimension whose slices become the channels
  dimension?: string;
  // indices along that dimension for red, green and blue
  channels: TRgbChannels;
  // shared display range; undefined means the range of the loaded slices
  low?: number;
  high?: number;
  gamma: number;
};

export type TRgbDimensionOption = {
  name: string;
  // position of the dimension in the variable's dimensions
  index: number;
  labels: string[];
};

export type TRgbBounds = { low: number; high: number };

export const RGB_GAMMA = {
  MIN: 0.2,
  MAX: 3,
  STEP: 0.05,
  DEFAULT: 1,
} as const;

export const DEFAULT_RGB_CHANNELS: TRgbChannels = [0, 1, 2];

export function createDefaultRgbSettings(): TRgbSettings {
  return { channels: [...DEFAULT_RGB_CHANNELS], gamma: RGB_GAMMA.DEFAULT };
}

// Dimensions that usually hold spectral bands, picked before any other.
const PREFERRED_RGB_DIMENSIONS = [
  "band",
  "bands",
  "channel",
  "channels",
  "wavelength",
  "spectral",
];

function preferenceRank(name: string) {
  const rank = PREFERRED_RGB_DIMENSIONS.indexOf(name.toLowerCase());
  return rank === -1 ? PREFERRED_RGB_DIMENSIONS.length : rank;
}

function dimensionLabels(info: TDimInfo | undefined, length: number) {
  const values = info && "values" in info ? info.values : undefined;
  return Array.from({ length }, (_, index) =>
    values && values.length === length ? String(values[index]) : String(index)
  );
}

/**
 * The non-spatial dimensions with at least three entries, preferred band-like
 * names first. Spatial dimensions have a null range and are never offered.
 */
export function getRgbDimensionOptions(
  dimRanges: TDimensionRange[] | undefined,
  dimInfo: TDimInfo[] | undefined
): TRgbDimensionOption[] {
  const options: TRgbDimensionOption[] = [];
  (dimRanges ?? []).forEach((range, index) => {
    if (!range?.name || range.maxBound < 2) {
      return;
    }
    options.push({
      name: range.name,
      index,
      labels: dimensionLabels(dimInfo?.[index], range.maxBound + 1),
    });
  });
  return options.sort(
    (a, b) => preferenceRank(a.name) - preferenceRank(b.name)
  );
}

export function chooseRgbDimension(
  options: TRgbDimensionOption[],
  requested?: string
) {
  return (
    options.find((option) => option.name === requested) ??
    (requested === undefined ? options[0] : undefined)
  );
}

export function clampRgbChannels(
  channels: TRgbChannels,
  length: number
): TRgbChannels {
  const last = Math.max(0, length - 1);
  return channels.map((channel) =>
    Number.isInteger(channel) ? Math.min(last, Math.max(0, channel)) : 0
  ) as TRgbChannels;
}

/** Packs three equally long channels into one RGBA texture buffer. */
export function interleaveRgba(
  red: ArrayLike<number>,
  green: ArrayLike<number>,
  blue: ArrayLike<number>
) {
  const length = red.length;
  if (green.length !== length || blue.length !== length) {
    throw new Error("RGB channels must have the same length");
  }
  const rgba = new Float32Array(length * 4);
  for (let index = 0; index < length; index++) {
    rgba[4 * index] = red[index];
    rgba[4 * index + 1] = green[index];
    rgba[4 * index + 2] = blue[index];
    rgba[4 * index + 3] = 1;
  }
  return rgba;
}

/** The range spanned by all channels, ignoring channels without data. */
export function mergeRgbBounds(bounds: { min: number; max: number }[]) {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const { min, max } of bounds) {
    if (Number.isFinite(min)) {
      low = Math.min(low, min);
    }
    if (Number.isFinite(max)) {
      high = Math.max(high, max);
    }
  }
  return low <= high ? { low, high } : undefined;
}

export function resolveRgbDisplayRange(
  settings: TRgbSettings,
  dataBounds?: TRgbBounds
): TRgbBounds {
  const low = settings.low ?? dataBounds?.low ?? 0;
  const high = settings.high ?? dataBounds?.high ?? 1;
  return { low, high };
}
