/**
 * A PNG at any size: the figure keeps its standard layout (960 layout
 * pixels wide, so text keeps its proportions) and is drawn at as many
 * image pixels per layout pixel as the chosen width needs; the chart's
 * height takes what the chosen height leaves after the caption.
 */
import { FIGURE_PAD } from "./figure.ts";

export const PNG_PRESETS = [
  {
    name: "Screen (1920 × 1080)",
    short: "Screen 1920 × 1080",
    width: 1920,
    height: 1080,
  },
  {
    name: "4K (3840 × 2160)",
    short: "4K 3840 × 2160",
    width: 3840,
    height: 2160,
  },
  {
    name: "Journal, one column: 85 mm at 600 dpi",
    short: "Journal, 1 column",
    width: 2008,
    height: 1339,
  },
  {
    name: "Journal, two columns: 180 mm at 600 dpi",
    short: "Journal, 2 columns",
    width: 4252,
    height: 2835,
  },
  {
    name: "A4 landscape at 300 dpi",
    short: "A4, 300 dpi",
    width: 3508,
    height: 2480,
  },
  {
    name: "A3 landscape at 300 dpi",
    short: "A3, 300 dpi",
    width: 4961,
    height: 3508,
  },
] as const;

/**
 * Browsers refuse larger canvases; past this a PNG is not drawn. The total
 * is kept to 50 million pixels: each canvas of the export (the chart, its
 * copy, the figure with its caption) holds 4 bytes a pixel, so about
 * 200 MB each (8K, 33 Mpx, and A3 at 300 dpi, 17 Mpx, fit).
 */
export const MAX_SIDE = 16_000;
const MAX_PIXELS = 50_000_000;

/** Millimetres a number of pixels prints at, at a resolution (dpi). */
export function printedMillimetres(pixels: number, dpi: number) {
  return Math.round((pixels / dpi) * 25.4);
}

/**
 * The drawing scale and chart height for a final image of `width` ×
 * `height` pixels, or why it cannot be drawn. `caption` and `trace` are
 * the room (layout pixels) the caption and a trace under the chart take.
 */
export function customLayout(
  size: { width: number; height: number },
  layoutWidth: number,
  caption: number,
  trace = 0
): { ratio: number; chartHeight: number } | { error: string } {
  const { width, height } = size;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 200 ||
    height < 200
  ) {
    return { error: "Width and height need at least 200 pixels." };
  }
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    return {
      error: `At most ${MAX_SIDE.toLocaleString("en-US")} pixels a side and ${MAX_PIXELS / 1e6} million in all: each copy of a larger figure needs over ${Math.round((MAX_PIXELS * 4) / 1e6)} MB of memory. For print quality beyond that, export the PDF or SVG.`,
    };
  }
  const ratio = width / (layoutWidth + 2 * FIGURE_PAD);
  const chartHeight = Math.floor(height / ratio - caption - trace);
  if (chartHeight < 120) {
    return {
      error:
        "Too short for this width: the chart would be under 120 layout pixels. Make it taller or narrower.",
    };
  }
  return { ratio, chartHeight };
}
