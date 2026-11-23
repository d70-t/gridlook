/**
 * A canvas 2D context that records drawing as PDF page operators, so the
 * plot code (Chart.js, the heatmap and the section) draws a vector PDF the
 * same way it draws on screen. Paths and text stay vectors; rasters (cells,
 * images, the missing-data hatch) become PDF images. Text is Helvetica;
 * text with characters outside the PDF's standard encoding (Greek letters,
 * for instance) is drawn as a sharp image in its place.
 *
 * Canvas coordinates are CSS pixels; a page point is 0.75 px (96 px/inch).
 */
import {
  helveticaWidth,
  pdfFontName,
  pdfLiteral,
  toWinAnsi,
  type TPdfImage,
  type TPdfPage,
  type TPdfPattern,
} from "@/lib/analysis/pdfWriter.ts";

type TMatrix = [number, number, number, number, number, number];
type TPoint = [number, number];
type TColour = { r: number; g: number; b: number; a: number };
type TPatternStyle = { kind: "pattern"; image: TPdfImage };
type TGradientStyle = {
  kind: "gradient";
  stops: { offset: number; colour: TColour }[];
  addColorStop(offset: number, colour: string): void;
};
type TStyle = TColour | TPatternStyle | TGradientStyle;
type TSize = { width: number; height: number };

const PT_PER_PX = 0.75;
const IDENTITY: TMatrix = [1, 0, 0, 1, 0, 0];
// Helvetica's (Arial's) ascent and descent, for the canvas text baselines.
const ASCENT = 0.905;
const DESCENT = 0.212;
// Text drawn as an image is rendered at this many pixels per CSS pixel.
const TEXT_IMAGE_SCALE = 4;

function multiply(m: TMatrix, n: TMatrix): TMatrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: TMatrix, x: number, y: number): TPoint {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** A number for the content stream: three decimals, no "-0". */
function n(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const rounded = Math.round(value * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

const point = ([x, y]: TPoint) => `${n(x)} ${n(y)}`;
const matrix = (m: TMatrix) => m.map(n).join(" ");

/** A CSS colour as RGBA; named and other forms through the browser. */
export function parseColour(value: string): TColour {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const byte = (at: number) => parseInt(full.slice(at, at + 2), 16);
    return {
      r: byte(0),
      g: byte(2),
      b: byte(4),
      a: full.length === 8 ? byte(6) / 255 : 1,
    };
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(text)?.[1];
  if (rgb) {
    const parts = rgb.split(/[\s,/]+/).filter(Boolean);
    const channel = (part: string) =>
      part.endsWith("%") ? (parseFloat(part) * 255) / 100 : parseFloat(part);
    const alpha = parts[3];
    return {
      r: channel(parts[0]),
      g: channel(parts[1]),
      b: channel(parts[2]),
      a:
        alpha === undefined
          ? 1
          : alpha.endsWith("%")
            ? parseFloat(alpha) / 100
            : parseFloat(alpha),
    };
  }
  if (text === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const scratch = scratchContext();
  if (scratch) {
    scratch.fillStyle = "#000000";
    scratch.fillStyle = value;
    const resolved = String(scratch.fillStyle);
    if (resolved !== value) {
      return parseColour(resolved);
    }
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

let scratch: CanvasRenderingContext2D | null | undefined;
function scratchContext() {
  if (scratch === undefined) {
    scratch =
      typeof document === "undefined"
        ? null
        : document.createElement("canvas").getContext("2d");
  }
  return scratch;
}

type TFont = { size: number; bold: boolean; italic: boolean };

function parseFont(font: string): TFont {
  const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? "10");
  return {
    size,
    bold: /\b(bold|bolder|[6-9]00)\b/.test(font),
    italic: /\b(italic|oblique)\b/.test(font),
  };
}

const fallbackWidths = new Map<string, number>();

/** Text width in CSS px: Helvetica's widths, the browser's where unknown. */
function textWidth(text: string, font: TFont) {
  let units = 0;
  for (const char of text) {
    const known = helveticaWidth(char, font.bold);
    if (known !== undefined) {
      units += known;
      continue;
    }
    const key = `${font.bold ? "b" : ""}${char}`;
    let measured = fallbackWidths.get(key);
    if (measured === undefined) {
      const context = scratchContext();
      if (context) {
        context.font = `${font.bold ? "bold " : ""}100px Helvetica, Arial, sans-serif`;
        measured = context.measureText(char).width * 10;
      } else {
        measured = 556;
      }
      fallbackWidths.set(key, measured);
    }
    units += measured;
  }
  return (units * font.size) / 1000;
}

/** Pixels of an image source, cropped, as RGB and alpha planes. */
function pixelsOf(
  source: CanvasImageSource | ImageData,
  crop?: [number, number, number, number]
): TPdfImage | undefined {
  let data: ImageData;
  if (typeof ImageData !== "undefined" && source instanceof ImageData) {
    data = source;
  } else {
    const size = source as unknown as TSize;
    const [sx, sy, sw, sh] = crop ?? [0, 0, size.width, size.height];
    const w = Math.max(1, Math.round(sw));
    const h = Math.max(1, Math.round(sh));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }
    context.drawImage(source as CanvasImageSource, sx, sy, sw, sh, 0, 0, w, h);
    data = context.getImageData(0, 0, w, h);
  }
  const count = data.width * data.height;
  const rgb = new Uint8Array(count * 3);
  const alpha = new Uint8Array(count);
  let opaque = true;
  for (let at = 0; at < count; at++) {
    rgb[at * 3] = data.data[at * 4];
    rgb[at * 3 + 1] = data.data[at * 4 + 1];
    rgb[at * 3 + 2] = data.data[at * 4 + 2];
    alpha[at] = data.data[at * 4 + 3];
    opaque &&= alpha[at] === 255;
  }
  return {
    width: data.width,
    height: data.height,
    rgb,
    alpha: opaque ? undefined : alpha,
  };
}

type TPathCommand = [string, unknown[]];
type TRecordedPath = Path2D & { commands: TPathCommand[] };

const PATH_METHODS = [
  "moveTo",
  "lineTo",
  "bezierCurveTo",
  "quadraticCurveTo",
  "arc",
  "ellipse",
  "rect",
  "roundRect",
  "closePath",
] as const;

/**
 * A Path2D that also keeps its commands, so a recorded page can replay a
 * path Chart.js built and cached (its lines are stroked from one). It is a
 * real Path2D: a screen canvas drawing meanwhile still accepts it.
 */
function recordingPath2D(): typeof Path2D | undefined {
  if (typeof Path2D !== "function") {
    return undefined;
  }
  class RecordedPath extends Path2D {
    commands: TPathCommand[] = [];
  }
  for (const method of PATH_METHODS) {
    const native = Path2D.prototype[method] as (...args: unknown[]) => void;
    Object.defineProperty(RecordedPath.prototype, method, {
      value(this: TRecordedPath, ...args: unknown[]) {
        this.commands.push([method, args]);
        native.apply(this, args);
      },
    });
  }
  return RecordedPath;
}

/** Recordings under way, and the page's own Path2D while any runs. */
const recording = { depth: 0, native: undefined as typeof Path2D | undefined };

/**
 * Run `draw` with paths that record, so they can be replayed in a PDF.
 * Overlapping recordings share one recording class, and the page's own
 * Path2D comes back when the last one ends, in any order, even on error.
 */
export async function withRecordedPaths<T>(draw: () => Promise<T>) {
  if (recording.depth === 0) {
    recording.native = globalThis.Path2D;
    const recorded = recordingPath2D();
    if (recorded) {
      globalThis.Path2D = recorded;
    }
  }
  recording.depth++;
  try {
    return await draw();
  } finally {
    recording.depth--;
    if (recording.depth === 0 && recording.native) {
      globalThis.Path2D = recording.native;
    }
  }
}

const isRecordedPath = (value: unknown): value is TRecordedPath =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as TRecordedPath).commands);

/** One page being recorded; several contexts can draw into it. */
export class PdfPageRecorder {
  readonly ops: string[] = [];
  readonly images: TPdfImage[] = [];
  readonly patterns: TPdfPattern[] = [];
  readonly alphas: number[] = [];

  /** A page of `width` × `height` CSS pixels. */
  constructor(
    readonly width: number,
    readonly height: number
  ) {}

  /** CSS pixels (y down) to page points (y up). */
  get base(): TMatrix {
    return [PT_PER_PX, 0, 0, -PT_PER_PX, 0, this.height * PT_PER_PX];
  }

  /** The graphics state name for an opacity, reusing equal ones. */
  alpha(value: number) {
    const a = Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
    let at = this.alphas.indexOf(a);
    if (at < 0) {
      at = this.alphas.push(a) - 1;
    }
    return `/G${at} gs`;
  }

  image(image: TPdfImage) {
    return this.images.push(image) - 1;
  }

  pattern(image: TPdfImage, m: TMatrix) {
    const index = this.image(image);
    return (
      this.patterns.push({
        image: index,
        width: image.width,
        height: image.height,
        matrix: m.map((v) => Number(n(v))),
      }) - 1
    );
  }

  /**
   * Make `canvas` draw into this page with its top-left corner at (x, y)
   * and `width` CSS pixels wide (its pixel width may be larger: drawing at
   * a device pixel ratio keeps the same size on the page).
   */
  attach(canvas: HTMLCanvasElement, x: number, y: number, width: number) {
    const context = new PdfContext(this, canvas, x, y, width);
    (canvas as { getContext: unknown }).getContext = (type: string) =>
      type === "2d" ? context : null;
    return context;
  }

  page(): TPdfPage {
    return {
      width: Number(n(this.width * PT_PER_PX)),
      height: Number(n(this.height * PT_PER_PX)),
      content: this.ops.join("\n"),
      images: this.images,
      patterns: this.patterns,
      alphas: this.alphas,
    };
  }
}

type TState = {
  transform: TMatrix;
  fillStyle: TStyle;
  strokeStyle: TStyle;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  miterLimit: number;
  lineDash: number[];
  lineDashOffset: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
};

const BLACK: TColour = { r: 0, g: 0, b: 0, a: 1 };

/** The recording context (the subset of the 2D API the plots use). */
class PdfContext {
  private state: TState = {
    transform: IDENTITY,
    fillStyle: BLACK,
    strokeStyle: BLACK,
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    lineDash: [],
    lineDashOffset: 0,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    globalAlpha: 1,
  };
  private stack: TState[] = [];
  private path: string[] = [];
  private current?: TPoint;
  private start?: TPoint;
  // Accepted and ignored: no PDF equivalent the plots need.
  shadowBlur = 0;
  shadowColor = "rgba(0, 0, 0, 0)";
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  globalCompositeOperation: GlobalCompositeOperation = "source-over";
  imageSmoothingEnabled = true;
  imageSmoothingQuality: ImageSmoothingQuality = "low";
  filter = "none";
  direction: CanvasDirection = "ltr";

  /** Where this canvas's own drawing starts in the page's operations. */
  private readonly mark: number;
  /** Each clear of the whole canvas: where, and how many states were open. */
  private readonly clears: { at: number; depth: number }[] = [];

  constructor(
    private readonly recorder: PdfPageRecorder,
    readonly canvas: HTMLCanvasElement,
    private readonly x: number,
    private readonly y: number,
    private readonly cssWidth: number
  ) {
    this.mark = recorder.ops.length;
  }

  // ----- state

  get fillStyle(): string | TPatternStyle | TGradientStyle {
    return styleValue(this.state.fillStyle);
  }
  set fillStyle(value: string | TPatternStyle | TGradientStyle) {
    this.state.fillStyle = styleOf(value);
  }
  get strokeStyle(): string | TPatternStyle | TGradientStyle {
    return styleValue(this.state.strokeStyle);
  }
  set strokeStyle(value: string | TPatternStyle | TGradientStyle) {
    this.state.strokeStyle = styleOf(value);
  }
  get lineWidth() {
    return this.state.lineWidth;
  }
  set lineWidth(value: number) {
    if (Number.isFinite(value) && value > 0) {
      this.state.lineWidth = value;
    }
  }
  get lineCap() {
    return this.state.lineCap;
  }
  set lineCap(value: CanvasLineCap) {
    this.state.lineCap = value;
  }
  get lineJoin() {
    return this.state.lineJoin;
  }
  set lineJoin(value: CanvasLineJoin) {
    this.state.lineJoin = value;
  }
  get miterLimit() {
    return this.state.miterLimit;
  }
  set miterLimit(value: number) {
    if (Number.isFinite(value) && value > 0) {
      this.state.miterLimit = value;
    }
  }
  get lineDashOffset() {
    return this.state.lineDashOffset;
  }
  // As on a canvas, values that are not finite are ignored (Chart.js
  // assigns undefined when no offset is configured).
  set lineDashOffset(value: number) {
    if (Number.isFinite(value)) {
      this.state.lineDashOffset = value;
    }
  }
  get font() {
    return this.state.font;
  }
  set font(value: string) {
    this.state.font = value;
  }
  get textAlign() {
    return this.state.textAlign;
  }
  set textAlign(value: CanvasTextAlign) {
    this.state.textAlign = value;
  }
  get textBaseline() {
    return this.state.textBaseline;
  }
  set textBaseline(value: CanvasTextBaseline) {
    this.state.textBaseline = value;
  }
  get globalAlpha() {
    return this.state.globalAlpha;
  }
  set globalAlpha(value: number) {
    if (Number.isFinite(value) && value >= 0 && value <= 1) {
      this.state.globalAlpha = value;
    }
  }

  save() {
    this.stack.push({ ...this.state, lineDash: [...this.state.lineDash] });
    this.recorder.ops.push("q");
  }

  restore() {
    const previous = this.stack.pop();
    if (previous) {
      this.state = previous;
      this.recorder.ops.push("Q");
    }
  }

  /**
   * Keep only the last frame (since the last clear of the whole canvas
   * after which something was drawn), then close any state the drawing
   * code left saved.
   */
  settle() {
    const ops = this.recorder.ops;
    // The last drawing op, then the last clear before it: no copies, no
    // spread (200,000 ops overflow one call's arguments).
    let last = ops.length - 1;
    while (last >= this.mark && (ops[last] === "q" || ops[last] === "Q")) {
      last--;
    }
    const frame = [...this.clears].reverse().find((c) => c.at <= last);
    if (frame) {
      const kept = ops.slice(frame.at);
      ops.length = this.mark;
      for (let k = 0; k < frame.depth; k++) {
        ops.push("q");
      }
      for (const op of kept) {
        ops.push(op);
      }
    }
    this.clears.length = 0;
    while (this.stack.length) {
      this.restore();
    }
  }

  setLineDash(segments: number[]) {
    if (segments.some((s) => !Number.isFinite(s) || s < 0)) {
      return;
    }
    this.state.lineDash =
      segments.length % 2 ? [...segments, ...segments] : [...segments];
  }

  getLineDash() {
    return [...this.state.lineDash];
  }

  // ----- transforms

  translate(x: number, y: number) {
    this.transform(1, 0, 0, 1, x, y);
  }

  scale(x: number, y: number) {
    this.transform(x, 0, 0, y, 0, 0);
  }

  rotate(angle: number) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.transform(c, s, -s, c, 0, 0);
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.state.transform = multiply(this.state.transform, [a, b, c, d, e, f]);
  }

  setTransform(
    a?: number | DOMMatrix2DInit,
    b = 0,
    c = 0,
    d = 1,
    e = 0,
    f = 0
  ) {
    if (typeof a === "object" || a === undefined) {
      const m = a ?? {};
      this.state.transform = [
        m.a ?? 1,
        m.b ?? 0,
        m.c ?? 0,
        m.d ?? 1,
        m.e ?? 0,
        m.f ?? 0,
      ];
    } else {
      this.state.transform = [a, b, c, d, e, f];
    }
  }

  resetTransform() {
    this.state.transform = IDENTITY;
  }

  getTransform() {
    const [a, b, c, d, e, f] = this.state.transform;
    return typeof DOMMatrix === "undefined"
      ? { a, b, c, d, e, f }
      : new DOMMatrix([a, b, c, d, e, f]);
  }

  /** Canvas device pixels to page points. */
  private get device(): TMatrix {
    const k = this.cssWidth / (this.canvas.width || this.cssWidth);
    return multiply(this.recorder.base, [k, 0, 0, k, this.x, this.y]);
  }

  /**
   * User space to page points, kept until the transform or the canvas
   * size changes (transforms are replaced, never edited): a path of 40,000
   * points no longer multiplies two matrices per point.
   */
  private totalFor?: { transform: TMatrix; width: number; value: TMatrix };
  private get total(): TMatrix {
    const { transform } = this.state;
    const width = this.canvas.width;
    const cached = this.totalFor;
    if (cached?.transform === transform && cached.width === width) {
      return cached.value;
    }
    const value = multiply(this.device, transform);
    this.totalFor = { transform, width, value };
    return value;
  }

  private page(x: number, y: number) {
    return apply(this.total, x, y);
  }

  // ----- paths

  beginPath() {
    this.path = [];
    this.current = undefined;
    this.start = undefined;
  }

  moveTo(x: number, y: number) {
    const p = this.page(x, y);
    this.path.push(`${point(p)} m`);
    this.current = this.start = p;
  }

  lineTo(x: number, y: number) {
    if (!this.current) {
      this.moveTo(x, y);
      return;
    }
    const p = this.page(x, y);
    this.path.push(`${point(p)} l`);
    this.current = p;
  }

  bezierCurveTo(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x: number,
    y: number
  ) {
    if (!this.current) {
      this.moveTo(x1, y1);
    }
    const p = this.page(x, y);
    this.path.push(
      `${point(this.page(x1, y1))} ${point(this.page(x2, y2))} ${point(p)} c`
    );
    this.current = p;
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    if (!this.current) {
      this.moveTo(cx, cy);
    }
    const [x0, y0] = this.current!;
    const [qx, qy] = this.page(cx, cy);
    const p = this.page(x, y);
    const c1: TPoint = [x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0)];
    const c2: TPoint = [
      p[0] + (2 / 3) * (qx - p[0]),
      p[1] + (2 / 3) * (qy - p[1]),
    ];
    this.path.push(`${point(c1)} ${point(c2)} ${point(p)} c`);
    this.current = p;
  }

  arc(
    x: number,
    y: number,
    radius: number,
    start: number,
    end: number,
    counterclockwise = false
  ) {
    this.ellipse(x, y, radius, radius, 0, start, end, counterclockwise);
  }

  // eslint-disable-next-line max-lines-per-function
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    counterclockwise = false
  ) {
    const turn = 2 * Math.PI;
    let sweep: number;
    if (!counterclockwise && end - start >= turn) {
      sweep = turn;
    } else if (counterclockwise && start - end >= turn) {
      sweep = -turn;
    } else {
      const span = (((end - start) % turn) + turn) % turn;
      sweep = counterclockwise ? (span ? span - turn : 0) : span;
    }
    const cr = Math.cos(rotation);
    const sr = Math.sin(rotation);
    const at = (t: number): TPoint => [
      x + rx * Math.cos(t) * cr - ry * Math.sin(t) * sr,
      y + rx * Math.cos(t) * sr + ry * Math.sin(t) * cr,
    ];
    const slope = (t: number): TPoint => [
      -rx * Math.sin(t) * cr - ry * Math.cos(t) * sr,
      -rx * Math.sin(t) * sr + ry * Math.cos(t) * cr,
    ];
    const [sx, sy] = at(start);
    if (this.current) {
      this.lineTo(sx, sy);
    } else {
      this.moveTo(sx, sy);
    }
    const parts = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    const step = sweep / parts;
    const k = (4 / 3) * Math.tan(step / 4);
    for (let part = 0; part < parts; part++) {
      const t0 = start + part * step;
      const t1 = t0 + step;
      const [p0x, p0y] = at(t0);
      const [p1x, p1y] = at(t1);
      const [d0x, d0y] = slope(t0);
      const [d1x, d1y] = slope(t1);
      this.bezierCurveTo(
        p0x + k * d0x,
        p0y + k * d0y,
        p1x - k * d1x,
        p1y - k * d1y,
        p1x,
        p1y
      );
    }
  }

  rect(x: number, y: number, w: number, h: number) {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii: number | number[] = 0
  ) {
    const r = Math.min(
      Math.abs(Array.isArray(radii) ? (radii[0] ?? 0) : radii),
      Math.abs(w) / 2,
      Math.abs(h) / 2
    );
    if (!r) {
      this.rect(x, y, w, h);
      return;
    }
    this.moveTo(x + r, y);
    this.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    this.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    this.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    this.arc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2);
    this.closePath();
  }

  closePath() {
    if (this.current) {
      this.path.push("h");
      this.current = this.start;
    }
  }

  // ----- painting

  private paint(style: TStyle, stroke: boolean) {
    const ops = this.recorder.ops;
    const alpha = this.state.globalAlpha;
    if ("kind" in style && style.kind === "pattern") {
      const index = this.recorder.pattern(style.image, this.total);
      ops.push(this.recorder.alpha(alpha));
      ops.push(
        stroke ? `/Pattern CS /P${index} SCN` : `/Pattern cs /P${index} scn`
      );
      return;
    }
    const colour =
      "kind" in style
        ? (style.stops[Math.floor(style.stops.length / 2)]?.colour ?? BLACK)
        : style;
    ops.push(this.recorder.alpha(colour.a * alpha));
    const rgb = [colour.r, colour.g, colour.b].map((c) => n(c / 255)).join(" ");
    ops.push(`${rgb} ${stroke ? "RG" : "rg"}`);
  }

  private lineScale() {
    const [a, b, c, d] = this.total;
    return Math.sqrt(Math.abs(a * d - b * c));
  }

  private strokeSetup() {
    const s = this.lineScale();
    const caps = { butt: 0, round: 1, square: 2 };
    const joins = { miter: 0, round: 1, bevel: 2 };
    this.recorder.ops.push(
      `${n(this.state.lineWidth * s)} w ${caps[this.state.lineCap]} J ${joins[this.state.lineJoin]} j ${n(this.state.miterLimit)} M`,
      `[${this.state.lineDash.map((v) => n(v * s)).join(" ")}] ${n(this.state.lineDashOffset * s)} d`
    );
    this.paint(this.state.strokeStyle, true);
  }

  /**
   * Paint either the current path or a given Path2D (replayed from its
   * recorded commands under the current transform; the current path is
   * left as it was).
   */
  private withPath(
    first: CanvasFillRule | Path2D | undefined,
    second: CanvasFillRule | undefined,
    paint: (rule: CanvasFillRule | undefined) => void
  ) {
    if (typeof first !== "object") {
      if (this.path.length) {
        paint(first);
      }
      return;
    }
    if (!isRecordedPath(first)) {
      return;
    }
    const saved = [this.path, this.current, this.start] as const;
    this.beginPath();
    for (const [method, args] of first.commands) {
      (
        this[method as (typeof PATH_METHODS)[number]] as (
          ...a: unknown[]
        ) => void
      )(...args);
    }
    if (this.path.length) {
      paint(second);
    }
    [this.path, this.current, this.start] = saved;
  }

  fill(first?: CanvasFillRule | Path2D, second?: CanvasFillRule) {
    this.withPath(first, second, (rule) => {
      this.paint(this.state.fillStyle, false);
      this.recorder.ops.push(
        this.path.join(" "),
        rule === "evenodd" ? "f*" : "f"
      );
    });
  }

  stroke(path?: Path2D) {
    this.withPath(path, undefined, () => {
      this.strokeSetup();
      this.recorder.ops.push(this.path.join(" "), "S");
    });
  }

  clip(first?: CanvasFillRule | Path2D, second?: CanvasFillRule) {
    this.withPath(first, second, (rule) => {
      this.recorder.ops.push(
        this.path.join(" "),
        rule === "evenodd" ? "W* n" : "W n"
      );
    });
  }

  /** A shape painted without touching the current path. */
  private withRect(
    x: number,
    y: number,
    w: number,
    h: number,
    paint: () => void
  ) {
    const saved = [this.path, this.current, this.start] as const;
    this.beginPath();
    this.rect(x, y, w, h);
    paint();
    [this.path, this.current, this.start] = saved;
  }

  fillRect(x: number, y: number, w: number, h: number) {
    this.withRect(x, y, w, h, () => this.fill());
  }

  strokeRect(x: number, y: number, w: number, h: number) {
    this.withRect(x, y, w, h, () => this.stroke());
  }

  /**
   * The page has its own background, so a partial clear erases nothing.
   * Clearing the whole canvas starts its drawing over: what this canvas
   * recorded so far is dropped when the canvas settles (Chart.js paints
   * once when built and again after a resize; both kept would paint every
   * label twice and darken translucent lines). The last frame that drew
   * anything is kept: the clear of a chart being destroyed is not one.
   */
  clearRect(x: number, y: number, w: number, h: number) {
    const [a, b] = [
      apply(this.state.transform, x, y),
      apply(this.state.transform, x + w, y + h),
    ];
    const whole =
      Math.min(a[0], b[0]) <= 0 &&
      Math.min(a[1], b[1]) <= 0 &&
      Math.max(a[0], b[0]) >= this.canvas.width &&
      Math.max(a[1], b[1]) >= this.canvas.height;
    if (whole) {
      this.clears.push({
        at: this.recorder.ops.length,
        depth: this.stack.length,
      });
    }
  }

  isPointInPath() {
    return false;
  }

  isPointInStroke() {
    return false;
  }

  // ----- text

  measureText(text: string) {
    const font = parseFont(this.state.font);
    const width = textWidth(String(text), font);
    return {
      width,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      actualBoundingBoxAscent: 0.718 * font.size,
      actualBoundingBoxDescent: 0.207 * font.size,
      fontBoundingBoxAscent: ASCENT * font.size,
      fontBoundingBoxDescent: DESCENT * font.size,
    } as TextMetrics;
  }

  fillText(text: string, x: number, y: number, maxWidth?: number) {
    this.text(String(text), x, y, maxWidth, false);
  }

  strokeText(text: string, x: number, y: number, maxWidth?: number) {
    this.text(String(text), x, y, maxWidth, true);
  }

  // eslint-disable-next-line max-lines-per-function
  private text(
    text: string,
    x: number,
    y: number,
    maxWidth: number | undefined,
    stroke: boolean
  ) {
    if (!text) {
      return;
    }
    const font = parseFont(this.state.font);
    const width = textWidth(text, font);
    const squeeze =
      maxWidth !== undefined && maxWidth > 0 && width > maxWidth
        ? maxWidth / width
        : 1;
    const shown = width * squeeze;
    const align = this.state.textAlign;
    const ltr = this.direction !== "rtl";
    const left =
      align === "center"
        ? x - shown / 2
        : align === "right" ||
            (align === "end" && ltr) ||
            (align === "start" && !ltr)
          ? x - shown
          : x;
    const s = font.size;
    const baseline =
      {
        top: y + ASCENT * s,
        hanging: y + ASCENT * s,
        middle: y + ((ASCENT - DESCENT) / 2) * s,
        alphabetic: y,
        ideographic: y - DESCENT * s,
        bottom: y - DESCENT * s,
      }[this.state.textBaseline] ?? y;
    const bytes = toWinAnsi(text);
    if (bytes === undefined) {
      this.textImage(text, font, left, baseline, shown, stroke);
      return;
    }
    // Glyphs are drawn upright: user space has y down, text space y up.
    const at = multiply(this.total, [squeeze, 0, 0, -1, left, baseline]);
    if (stroke) {
      this.strokeSetup();
    } else {
      this.paint(this.state.fillStyle, false);
    }
    this.recorder.ops.push(
      `BT ${pdfFontName(font.bold, font.italic)} ${n(s)} Tf ${stroke ? 1 : 0} Tr ${matrix(at)} Tm ${pdfLiteral(bytes)} Tj ET`
    );
  }

  /** Text the standard encoding cannot hold, drawn as an image in place. */
  private textImage(
    text: string,
    font: TFont,
    left: number,
    baseline: number,
    width: number,
    stroke: boolean
  ) {
    if (typeof document === "undefined") {
      return;
    }
    const s = font.size;
    const box = {
      x: left - 1,
      y: baseline - 1.1 * s,
      w: width + 2,
      h: 1.45 * s,
    };
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(box.w * TEXT_IMAGE_SCALE);
    canvas.height = Math.ceil(box.h * TEXT_IMAGE_SCALE);
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const style = stroke ? this.state.strokeStyle : this.state.fillStyle;
    const colour = "kind" in style ? BLACK : style;
    context.scale(TEXT_IMAGE_SCALE, TEXT_IMAGE_SCALE);
    context.font = `${font.italic ? "italic " : ""}${font.bold ? "bold " : ""}${s}px Helvetica, Arial, sans-serif`;
    context.fillStyle = `rgb(${colour.r}, ${colour.g}, ${colour.b})`;
    context.textBaseline = "alphabetic";
    context.fillText(text, 1, 1.1 * s, width);
    const image = pixelsOf(canvas);
    if (image) {
      this.placeImage(image, box.x, box.y, box.w, box.h, colour.a);
    }
  }

  // ----- images

  drawImage(source: CanvasImageSource, ...args: number[]) {
    const size = source as unknown as TSize & {
      naturalWidth?: number;
      naturalHeight?: number;
    };
    const w = size.naturalWidth || size.width;
    const h = size.naturalHeight || size.height;
    let crop: [number, number, number, number] = [0, 0, w, h];
    let place: number[];
    if (args.length >= 8) {
      crop = [args[0], args[1], args[2], args[3]];
      place = args.slice(4, 8);
    } else if (args.length >= 4) {
      place = args.slice(0, 4);
    } else {
      place = [args[0], args[1], w, h];
    }
    const image = pixelsOf(source, crop);
    if (image) {
      this.placeImage(
        this.imageSmoothingEnabled ? image : { ...image, pixelated: true },
        place[0],
        place[1],
        place[2],
        place[3]
      );
    }
  }

  /** An image filling a user-space rectangle. */
  private placeImage(
    image: TPdfImage,
    x: number,
    y: number,
    w: number,
    h: number,
    opacity = 1
  ) {
    const index = this.recorder.image(image);
    const at = multiply(this.total, [w, 0, 0, -h, x, y + h]);
    this.recorder.ops.push(
      `q ${this.recorder.alpha(opacity * this.state.globalAlpha)} ${matrix(at)} cm /Im${index} Do Q`
    );
  }

  /** Pixels placed in device pixels, ignoring the transform (as canvas). */
  putImageData(data: ImageData, dx: number, dy: number) {
    const image = pixelsOf(data);
    if (!image) {
      return;
    }
    const index = this.recorder.image(image);
    const at = multiply(this.device, [
      data.width,
      0,
      0,
      -data.height,
      dx,
      dy + data.height,
    ]);
    this.recorder.ops.push(`q ${matrix(at)} cm /Im${index} Do Q`);
  }

  createImageData(width: number | ImageData, height?: number) {
    return typeof width === "number"
      ? new ImageData(Math.max(1, width), Math.max(1, height ?? 1))
      : new ImageData(width.width, width.height);
  }

  getImageData(_x: number, _y: number, width: number, height: number) {
    return new ImageData(Math.max(1, width), Math.max(1, height));
  }

  createPattern(source: CanvasImageSource): TPatternStyle | null {
    const image = pixelsOf(source);
    return image ? { kind: "pattern", image } : null;
  }

  createLinearGradient(): TGradientStyle {
    return gradient();
  }

  createRadialGradient(): TGradientStyle {
    return gradient();
  }

  createConicGradient(): TGradientStyle {
    return gradient();
  }
}

/** Gradients are drawn in their middle colour (the plots use none). */
function gradient(): TGradientStyle {
  const stops: TGradientStyle["stops"] = [];
  return {
    kind: "gradient",
    stops,
    addColorStop(offset, colour) {
      stops.push({ offset, colour: parseColour(colour) });
      stops.sort((a, b) => a.offset - b.offset);
    },
  };
}

function styleOf(value: string | TPatternStyle | TGradientStyle): TStyle {
  return typeof value === "string" ? parseColour(value) : value;
}

function styleValue(style: TStyle) {
  if ("kind" in style) {
    return style;
  }
  const { r, g, b, a } = style;
  return a === 1
    ? `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`
    : `rgba(${r}, ${g}, ${b}, ${a})`;
}
