/**
 * The Dates part of Settings: a few affordable ranges with their price, and the
 * price of the range being typed, from what the plot already knows (bytes per
 * stored time chunk). Nothing is read to price a range; editing a date
 * dispatches no field read.
 */
import { bytesText } from "./readStatus.ts";

import {
  decodeTimeValue,
  encodeTimeValue,
  parseTimeAxis,
} from "@/lib/analysis/calendar.ts";
import {
  previewRange,
  timeGroups,
  type TRange,
} from "@/lib/analysis/preview.ts";
import { rowCount, type TTimeSelection } from "@/lib/analysis/timeRows.ts";

export type TDatePreset = {
  id: "map" | "year" | "all";
  label: string;
  /** Its stored rows: slices when the file keeps the dates apart. */
  range: TTimeSelection;
  /** "≈ 16 MiB" when the plot knows its price per chunk, else empty. */
  cost: string;
};

/** The price of a range: its stored time chunks at `perGroup` bytes each. */
export function rangeCost(range: TRange, chunk: number, perGroup?: number) {
  return perGroup && perGroup > 0
    ? `≈ ${bytesText(timeGroups(range, chunk) * perGroup)}`
    : "";
}

/**
 * Bytes one stored time chunk decodes, from the plot's first-dates preview,
 * its estimate for the range it asked for, or what its last read decoded.
 */
export function bytesPerGroup(options: {
  chunk?: number;
  previewPerGroup?: number;
  committed?: TRange;
  estimateBytes?: number;
  decodedBytes?: number;
}) {
  if (options.previewPerGroup) {
    return options.previewPerGroup;
  }
  const { chunk, committed } = options;
  const bytes = options.estimateBytes || options.decodedBytes;
  return chunk && committed && bytes
    ? bytes / Math.max(1, timeGroups(committed, chunk))
    : undefined;
}

/**
 * Up to three ranges worth offering: around the map's date (whole chunks,
 * within the first-dates budget), the last year of the axis (when its
 * units say how long a year is), and every date.
 */
export function datePresets(options: {
  raw: number[];
  units?: string;
  calendar?: string;
  chunk: number;
  perGroup?: number;
  anchor?: number;
}): TDatePreset[] {
  const { raw, chunk, perGroup } = options;
  const all = { start: 0, stop: raw.length };
  const presets: TDatePreset[] = [];
  const around =
    options.anchor !== undefined
      ? previewRange({ span: all, anchor: options.anchor, chunk, perGroup })
      : undefined;
  if (around) {
    presets.push({
      id: "map",
      label: "Around the map date",
      range: around,
      cost: rangeCost(around, chunk, perGroup),
    });
  }
  const year = lastYear(raw, options.units, options.calendar);
  if (year && rowCount(year) < raw.length) {
    presets.push({
      id: "year",
      label: "Last year",
      range: year,
      cost: rangeCost(year, chunk, perGroup),
    });
  }
  presets.push({
    id: "all",
    label: `All ${raw.length.toLocaleString("en-US")} dates`,
    range: all,
    cost: rangeCost(all, chunk, perGroup),
  });
  return presets;
}

/**
 * The dates within a calendar year of the latest one, wherever they are stored:
 * the year before it in that calendar (any spelling of it), so `noleap` and
 * `365_day` agree and a descending file offers it too and [364, 730); none for
 * a reversed file).
 */
function lastYear(
  raw: number[],
  units?: string,
  calendar?: string
): TTimeSelection | undefined {
  const axis = parseTimeAxis(units, calendar);
  let last = -Infinity;
  for (const value of raw) {
    last = value > last ? value : last;
  }
  if ("unsupported" in axis || !Number.isFinite(last)) {
    return undefined;
  }
  const date = decodeTimeValue(axis, last);
  let from = Number.NaN;
  // 29 February a year back is the 28th.
  for (let day = date.day; day >= date.day - 3 && Number.isNaN(from); day--) {
    try {
      from = encodeTimeValue(axis, { ...date, year: date.year - 1, day });
    } catch {
      // Not a day of that month in that year: one earlier.
    }
  }
  const runs: [number, number][] = [];
  raw.forEach((value, at) => {
    if (value > from && value <= last) {
      const run = runs.at(-1);
      if (run && run[1] === at) {
        run[1] = at + 1;
      } else {
        runs.push([at, at + 1]);
      }
    }
  });
  if (!runs.length) {
    return undefined;
  }
  const [start, stop] = [runs[0][0], runs.at(-1)![1]];
  return runs.length > 1 ? { start, stop, runs } : { start, stop };
}
