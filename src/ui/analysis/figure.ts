/** A theme colour from the plot CSS variables, resolved for canvas drawing. */
export function plotColor(
  element: Element | undefined,
  name: string,
  fallback: string
) {
  const value = element
    ? getComputedStyle(element).getPropertyValue(name).trim()
    : "";
  return value || fallback;
}

export type TFigureText = {
  title: string;
  subtitle: string;
  /** Partial or snapshot status; drawn in the warning colour. */
  status?: string;
  /** A legend line under the figure. */
  legend?: string;
};

function canvasToBlob(canvas: HTMLCanvasElement) {
  // toBlob reports through its callback, never through a return value.
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob((blob) => resolve(blob), "image/png")
  );
}

/** Split text into lines that fit `width` at the context's font. */
export function wrap(
  context: Pick<CanvasRenderingContext2D, "measureText" | "font">,
  text: string,
  width: number
) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && context.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

/**
 * Export a figure as PNG: the figure (rendered at its own export size)
 * under its title and selection, with partial status and legend wrapped to
 * the figure's width, on the window's own background, so the image can be
 * read on its own.
 */

/** The PNG's side margin in layout pixels (each side). */
export const FIGURE_PAD = 16;

/**
 * The title, subtitle and status above a figure and its legend below, laid
 * out for an image `sourceWidth` pixels wide at `ratio` image pixels per
 * layout pixel: wrapped lines and the room they take.
 */
// eslint-disable-next-line max-lines-per-function
function captionLayout(
  sourceWidth: number,
  text: TFigureText,
  theme: Element | undefined,
  ratio: number
) {
  const pad = FIGURE_PAD * ratio;
  const line = 18 * ratio;
  const width = sourceWidth + 2 * pad;
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) {
    return undefined;
  }
  const blocks: { lines: string[]; font: string; color: string }[] = [];
  const add = (value: string | undefined, font: string, color: string) => {
    if (value) {
      measure.font = font;
      blocks.push({
        lines: wrap(measure, value, width - 2 * pad),
        font,
        color,
      });
    }
  };
  add(
    text.title,
    `600 ${14 * ratio}px sans-serif`,
    plotColor(theme, "--plot-fg", "#1f2937")
  );
  add(
    text.subtitle,
    `${12 * ratio}px sans-serif`,
    plotColor(theme, "--plot-muted", "#4b5563")
  );
  add(
    text.status,
    `${12 * ratio}px sans-serif`,
    plotColor(theme, "--plot-warn", "#b45309")
  );
  const header =
    pad + blocks.reduce((sum, b) => sum + b.lines.length * line, 0) + pad / 2;
  const legend: typeof blocks = [];
  if (text.legend) {
    measure.font = `${11 * ratio}px sans-serif`;
    legend.push({
      lines: wrap(measure, text.legend, width - 2 * pad),
      font: measure.font,
      color: plotColor(theme, "--plot-muted", "#4b5563"),
    });
  }
  const footer = legend.length ? legend[0].lines.length * line + pad : pad;
  return { pad, line, width, blocks, legend, header, footer };
}

/**
 * The image height the caption and margins take around a chart
 * `chartWidth` layout pixels wide, in layout pixels; with the chart's
 * height it gives the whole image's.
 */
export function captionHeight(
  text: TFigureText,
  chartWidth: number,
  theme: Element | undefined
) {
  const layout = captionLayout(chartWidth, text, theme, 1);
  return layout ? layout.header + layout.footer : 0;
}

// eslint-disable-next-line max-lines-per-function
export async function composeFigure(
  source: HTMLCanvasElement | undefined,
  text: TFigureText,
  theme: Element | undefined,
  /** Image pixels per layout pixel (2 for the standard PNG). */
  ratio = 2,
  /** A size the image must have exactly (a custom PNG): fitted to it. */
  exact?: { width: number; height: number }
): Promise<Blob | null> {
  if (!source || source.width === 0 || source.height === 0) {
    return null;
  }
  const layout = captionLayout(source.width, text, theme, ratio);
  if (!layout) {
    return null;
  }
  const { pad, line, width, blocks, legend, header, footer } = layout;
  const out = document.createElement("canvas");
  out.width = width;
  out.height = source.height + header + footer;
  const context = out.getContext("2d");
  if (!context) {
    return null;
  }
  context.fillStyle = plotColor(theme, "--plot-bg", "#ffffff");
  context.fillRect(0, 0, out.width, out.height);
  context.textBaseline = "top";
  let y = pad;
  for (const block of blocks) {
    context.font = block.font;
    context.fillStyle = block.color;
    for (const textLine of block.lines) {
      context.fillText(textLine, pad, y);
      y += line;
    }
  }
  context.drawImage(source, pad, header);
  y = header + source.height + pad / 2;
  for (const block of legend) {
    context.font = block.font;
    context.fillStyle = block.color;
    for (const textLine of block.lines) {
      context.fillText(textLine, pad, y);
      y += line;
    }
  }
  if (exact && (exact.width !== out.width || exact.height !== out.height)) {
    // Rounding leaves a pixel or two: fitted to the exact size asked for.
    const fitted = document.createElement("canvas");
    fitted.width = exact.width;
    fitted.height = exact.height;
    fitted.getContext("2d")?.drawImage(out, 0, 0, exact.width, exact.height);
    return canvasToBlob(fitted);
  }
  return canvasToBlob(out);
}
