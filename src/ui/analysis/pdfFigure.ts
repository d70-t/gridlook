/**
 * Export a figure as a vector PDF or SVG laid out like the PNG: title,
 * selection and status above the figure, the legend under it, on the
 * window's background. The PDF carries the query and provenance JSON as an
 * attachment. Both come from one recorded page.
 */
import { plotColor, wrap, type TFigureText } from "./figure.ts";
import { PdfPageRecorder, withRecordedPaths } from "./pdfCanvas.ts";

import {
  writePdf,
  type TPdfAttachment,
  type TPdfPage,
} from "@/lib/analysis/pdfWriter.ts";
import { pdfPageToSvg } from "@/lib/analysis/svgWriter.ts";

/** A figure drawn by plot code onto the canvas it is given. */
export type TPdfPart = {
  width: number;
  height: number;
  draw: (canvas: HTMLCanvasElement) => Promise<unknown>;
};

const PAD = 16;
const LINE = 18;

/**
 * A turn for the page between the long steps of an export (drawing each
 * figure, writing the file), so a very large figure does not hold it for
 * seconds in one piece.
 */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function composeFigurePdf(
  parts: TPdfPart[],
  text: TFigureText,
  theme: Element | undefined,
  attachments: TPdfAttachment[]
): Promise<Uint8Array> {
  const page = await recordFigurePage(parts, text, theme);
  await turn();
  return writePdf(page, {
    title: text.title,
    subject: text.subtitle,
    date: new Date(),
    attachments,
  });
}

/** The same figure as SVG: paths and text, images as embedded PNG. */
export async function composeFigureSvg(
  parts: TPdfPart[],
  text: TFigureText,
  theme: Element | undefined
): Promise<string> {
  const page = await recordFigurePage(parts, text, theme);
  await turn();
  return pdfPageToSvg(page, imageDataUrl, text.title);
}

/** An image's pixels as a PNG data URL (through a canvas). */
function imageDataUrl(image: TPdfPage["images"][number]) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return "";
  }
  const data = context.createImageData(image.width, image.height);
  for (let at = 0; at < image.width * image.height; at++) {
    data.data[at * 4] = image.rgb[at * 3];
    data.data[at * 4 + 1] = image.rgb[at * 3 + 1];
    data.data[at * 4 + 2] = image.rgb[at * 3 + 2];
    data.data[at * 4 + 3] = image.alpha ? image.alpha[at] : 255;
  }
  context.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}

/** The figure drawn onto a recorded page (PDF operators). */
// eslint-disable-next-line max-lines-per-function
async function recordFigurePage(
  parts: TPdfPart[],
  text: TFigureText,
  theme: Element | undefined
): Promise<TPdfPage> {
  const figureWidth = Math.max(...parts.map((part) => part.width));
  const width = figureWidth + 2 * PAD;
  // Measured in the PDF's own font (Helvetica), so lines fit on the page.
  const measure = new PdfPageRecorder(width, 1).attach(
    document.createElement("canvas"),
    0,
    0,
    width
  );
  const blocks: { lines: string[]; font: string; color: string }[] = [];
  const add = (
    value: string | undefined,
    font: string,
    color: string,
    into = blocks
  ) => {
    if (value) {
      measure.font = font;
      into.push({ lines: wrap(measure, value, width - 2 * PAD), font, color });
    }
  };
  const fg = plotColor(theme, "--plot-fg", "#1f2937");
  const muted = plotColor(theme, "--plot-muted", "#4b5563");
  add(text.title, "600 14px sans-serif", fg);
  add(text.subtitle, "12px sans-serif", muted);
  add(
    text.status,
    "12px sans-serif",
    plotColor(theme, "--plot-warn", "#b45309")
  );
  const legend: typeof blocks = [];
  add(text.legend, "11px sans-serif", muted, legend);
  const header =
    PAD + blocks.reduce((sum, b) => sum + b.lines.length * LINE, 0) + PAD / 2;
  const figures = parts.reduce((sum, part) => sum + part.height, 0);
  const footer = legend.length ? legend[0].lines.length * LINE + PAD : PAD;
  const recorder = new PdfPageRecorder(width, header + figures + footer);

  const page = recorder.attach(document.createElement("canvas"), 0, 0, width);
  page.canvas.width = width;
  page.fillStyle = plotColor(theme, "--plot-bg", "#ffffff");
  page.fillRect(0, 0, width, recorder.height);
  const lines = (list: typeof blocks, top: number) => {
    let y = top;
    page.textBaseline = "top";
    for (const block of list) {
      page.font = block.font;
      page.fillStyle = block.color;
      for (const line of block.lines) {
        page.fillText(line, PAD, y);
        y += LINE;
      }
    }
  };
  lines(blocks, PAD);

  let top = header;
  for (const part of parts) {
    await turn();
    const canvas = document.createElement("canvas");
    // Each figure draws in its own saved state, clipped to its box.
    page.save();
    page.beginPath();
    page.rect(PAD, top, part.width, part.height);
    page.clip();
    const context = recorder.attach(canvas, PAD, top, part.width);
    // Chart.js strokes lines from cached Path2D objects: record those too.
    await withRecordedPaths(() => part.draw(canvas));
    context.settle();
    page.restore();
    top += part.height;
  }
  lines(legend, top + PAD / 2);
  return recorder.page();
}
