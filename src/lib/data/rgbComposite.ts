import { isTimeCoordinate } from "@/lib/data/timeHandling.ts";
import { getVariableGroup } from "@/lib/data/vectorField.ts";
import type {
  TDataSource,
  TDimInfo,
  TDimensionRange,
} from "@/lib/types/GlobeTypes.ts";

/* An RGB composite shows three slices of one dimension of the current
   variable (e.g. the bands B04/B03/B02 of a `band` dimension), or three
   variables next to it (e.g. the arrays b04, b03 and b02), as the red, green
   and blue channels of one image. */

export type TRgbChannels = [number, number, number];
export type TRgbVariables = [string, string, string];

export const RGB_SOURCES = {
  DIMENSION: "dimension",
  VARIABLES: "variables",
} as const;

export type TRgbSource = (typeof RGB_SOURCES)[keyof typeof RGB_SOURCES];

export type TRgbSettings = {
  source: TRgbSource;
  // the dimension whose slices become the channels
  dimension?: string;
  // indices along that dimension for red, green and blue
  channels: TRgbChannels;
  // basenames of the variables for red, green and blue, taken from the
  // current variable's group; undefined means a guess from the names
  variables?: TRgbVariables;
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

// A band-like dimension has 3 to this many entries: more would be a time
// series or a long axis, and every entry becomes an option in three selects.
export const RGB_MAX_DIMENSION_LENGTH = 32;

export const DEFAULT_RGB_CHANNELS: TRgbChannels = [0, 1, 2];

export function createDefaultRgbSettings(): TRgbSettings {
  return {
    source: RGB_SOURCES.DIMENSION,
    channels: [...DEFAULT_RGB_CHANNELS],
    gamma: RGB_GAMMA.DEFAULT,
  };
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

function dimensionAttrs(info: TDimInfo | undefined) {
  return info && "attrs" in info ? info.attrs : {};
}

function dimensionLabels(info: TDimInfo | undefined, length: number) {
  const values = info && "values" in info ? info.values : undefined;
  return Array.from({ length }, (_, index) =>
    values && values.length === length ? String(values[index]) : String(index)
  );
}

/**
 * The band-like dimensions: not spatial (spatial dimensions have a null
 * range), not time, with 3 to RGB_MAX_DIMENSION_LENGTH entries. Preferred
 * band-like names come first.
 */
export function getRgbDimensionOptions(
  dimRanges: TDimensionRange[] | undefined,
  dimInfo: TDimInfo[] | undefined
): TRgbDimensionOption[] {
  const options: TRgbDimensionOption[] = [];
  (dimRanges ?? []).forEach((range, index) => {
    const length = (range?.maxBound ?? 0) + 1;
    if (
      !range?.name ||
      length < 3 ||
      length > RGB_MAX_DIMENSION_LENGTH ||
      isTimeCoordinate(range.name, dimensionAttrs(dimInfo?.[index]))
    ) {
      return;
    }
    options.push({
      name: range.name,
      index,
      labels: dimensionLabels(dimInfo?.[index], length),
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

function basename(name: string) {
  return name.slice(name.lastIndexOf("/") + 1);
}

function sameShape(a?: number[], b?: number[]) {
  return (
    a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((length, index) => length === b[index])
  );
}

/**
 * Basenames of the variables in the current variable's group that have its
 * shape (and so share its grid), the current one included. With a pyramid the
 * current variable is the one of the level shown, so are its siblings.
 */
export function getRgbVariableOptions(
  vars: Record<string, TDataSource> | undefined,
  current: string
) {
  const group = getVariableGroup(current);
  const shape = vars?.[current]?.shape;
  return Object.keys(vars ?? {})
    .filter(
      (name) =>
        !vars![name].hidden &&
        getVariableGroup(name) === group &&
        (shape === undefined || sameShape(vars![name].shape, shape))
    )
    .map(basename)
    .sort((a, b) => a.localeCompare(b));
}

/** The variable `name` (a basename) in the group of `current`. */
export function resolveSiblingVariable(current: string, name: string) {
  const group = getVariableGroup(current);
  return group === "" ? name : `${group}/${name}`;
}

const RGB_NAME_GUESSES: TRgbVariables[] = [
  ["b04", "b03", "b02"],
  ["b4", "b3", "b2"],
  ["red", "green", "blue"],
  ["r", "g", "b"],
];

/**
 * Red, green and blue among `options`: Sentinel-2-like band names first
 * (b04/b03/b02, any case), then colour names, else the first three.
 */
export function guessRgbVariables(options: string[]) {
  const byLowerName = new Map(
    options.map((option) => [option.toLowerCase(), option])
  );
  for (const guess of RGB_NAME_GUESSES) {
    const found = guess.map((name) => byLowerName.get(name));
    if (found.every((name) => name !== undefined)) {
      return found as TRgbVariables;
    }
  }
  return options.length >= 3
    ? (options.slice(0, 3) as TRgbVariables)
    : undefined;
}

/**
 * The variables shown, as basenames: the chosen ones while they are all
 * offered, else a guess.
 */
export function chooseRgbVariables(
  options: string[],
  requested?: TRgbVariables
) {
  if (requested?.every((name) => options.includes(name))) {
    return requested;
  }
  return requested === undefined ? guessRgbVariables(options) : undefined;
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
