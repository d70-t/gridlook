/**
 * The colour bar beside a heatmap or section, drawn from the map's scale:
 * the limits at its ends, steps where the map posterizes, a triangle at an
 * end the data reach past (those values take the end colour, as on the
 * map), and a small note naming whose scale it is.
 */
import {
  extendsPast,
  legendShades,
  valueRange,
  type TColourScale,
} from "./colourScale.ts";

import { formatValue } from "@/utils/formatValue.ts";

export type TBarPlace = {
  x: number;
  top: number;
  height: number;
  /** Room for the labels to the right of the bar. */
  room: number;
};

type TBarInk = {
  fg: string;
  muted: string;
  /** The palette colour at a position 0–1. */
  colour: (t: number) => string;
  fit: (context: CanvasRenderingContext2D, text: string, max: number) => string;
};

/**
 * A key or note beside a narrow bar, in up to two lines of `room` pixels
 * (split at a space) rather than cut with an ellipsis (24 Nov: "map s…").
 */
export function keyLines(
  context: Pick<CanvasRenderingContext2D, "measureText">,
  text: string,
  room: number
) {
  if (context.measureText(text).width <= room) {
    return [text];
  }
  const words = text.split(" ");
  for (let k = words.length - 1; k > 0; k--) {
    const first = words.slice(0, k).join(" ");
    if (context.measureText(first).width <= room) {
      return [first, words.slice(k).join(" ")];
    }
  }
  return [text];
}

/** The bar; returns where its own labels end (keys go below that). */
// eslint-disable-next-line max-lines-per-function
export function drawScaleBar(
  context: CanvasRenderingContext2D,
  place: TBarPlace,
  scale: TColourScale,
  values: ArrayLike<number>,
  ink: TBarInk
) {
  const { x, top, room } = place;
  const range = valueRange(values);
  context.font = "11px sans-serif";
  context.textAlign = "left";
  if (range.empty) {
    context.fillStyle = ink.muted;
    context.fillText("no data", x, top + 10);
    return;
  }
  if (scale.high === scale.low) {
    context.fillStyle = ink.colour(0.5);
    context.fillRect(x, top, 12, 12);
    context.fillStyle = ink.fg;
    context.fillText(
      ink.fit(context, formatValue(scale.low), room),
      x + 15,
      top + 10
    );
    return;
  }
  const past = extendsPast(scale, values);
  // Triangles take 7 px at an end the data reach past.
  const barTop = top + (past.above ? 7 : 0);
  const barH = Math.max(
    12,
    place.height - (past.above ? 7 : 0) - (past.below ? 7 : 0)
  );
  const shades = legendShades(scale, Math.round(barH));
  shades.forEach((t, row) => {
    context.fillStyle = ink.colour(t);
    context.fillRect(x, barTop + row, 12, 1);
  });
  const triangle = (tip: number, base: number, t: number) => {
    context.fillStyle = ink.colour(t);
    context.beginPath();
    context.moveTo(x + 6, tip);
    context.lineTo(x + 12, base);
    context.lineTo(x, base);
    context.closePath();
    context.fill();
  };
  if (past.above) {
    triangle(top, barTop, shades[0]);
  }
  if (past.below) {
    triangle(barTop + barH + 7, barTop + barH, shades[shades.length - 1]);
  }
  context.fillStyle = ink.fg;
  context.fillText(
    ink.fit(context, formatValue(scale.high), room),
    x + 15,
    barTop + 8
  );
  context.fillText(
    ink.fit(context, formatValue(scale.low), room),
    x + 15,
    barTop + barH
  );
  // Whose scale: the map's (the default), or this plot's own range.
  context.font = "10px sans-serif";
  context.fillStyle = ink.muted;
  keyLines(
    context,
    scale.from === "map" ? "map scale" : "own range",
    room
  ).forEach((line, k) => context.fillText(line, x + 15, barTop + 22 + 11 * k));
}
