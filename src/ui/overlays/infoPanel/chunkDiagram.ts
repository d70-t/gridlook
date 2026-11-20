import type { TChunkDimension } from "@/lib/data/chunkLayout.ts";

const MAX_SIDE = 150;
const STRIP_HEIGHT = 20;
const DEPTH_SCALE = 0.7;
const PADDING = 18;
// Distance of the y label from the right face in 3D blocks (px).
const RIGHT_LABEL_GAP = 12;
// ponytail: when chunk lines would be closer than this (px) they blur into a
// solid face, so none are drawn and the face is shaded instead. A sampled line
// grid would keep some structure visible.
const MIN_LINE_GAP = 3;
// Keeps the slab of a single chunk on a long axis visible (px).
const MIN_SLAB = 2;

type TAxis = {
  name: string;
  length: number;
  size: number;
  chunkSize: number;
  chunkCount: number;
  /** Index ranges `[lo, hi)` read for one step, drawn as highlighted slabs. */
  spans: [number, number][];
};

type TPoint = [number, number, number];

export type TDiagramBlock = {
  width: number;
  height: number;
  faces: string[];
  slab: string[];
  lines: string;
  dense: boolean;
  labels: { x: number; y: number; angle: number; text: string }[];
};

/**
 * Compresses large size ratios like dask's array preview does: ratios up to
 * e stay linear, larger ones grow logarithmically and stop at 100.
 */
function ratioResponse(ratio: number) {
  if (ratio < Math.E) {
    return ratio;
  }
  return Math.log(Math.min(ratio, 100) + 12.4);
}

function toAxes(
  dims: TChunkDimension[],
  indices: readonly (number | null)[],
  offset: number
): TAxis[] {
  let maxSize = 1;
  for (const dim of dims) {
    if (dim.size > maxSize) {
      maxSize = dim.size;
    }
  }
  return dims.map((dim, i) => {
    const chunk = Math.floor((indices[offset + i] ?? 0) / dim.chunkSize);
    const chunks = dim.isSpatial
      ? dim.readChunks
      : [{ start: chunk, end: chunk + 1 }];
    return {
      ...dim,
      length: MAX_SIDE / ratioResponse(maxSize / Math.max(dim.size, 1)),
      spans: chunks.map((c): [number, number] => [
        c.start * dim.chunkSize,
        Math.min(c.end * dim.chunkSize, dim.size),
      ]),
    };
  });
}

function scale(axis: TAxis | undefined, index: number) {
  return axis ? (index / axis.size) * axis.length : 0;
}

function isDense(axis: TAxis) {
  return axis.length / axis.chunkCount < MIN_LINE_GAP;
}

/** Pixel extents of the slabs along an axis, each at least MIN_SLAB wide. */
function slabSpans(axis: TAxis | undefined, fallback: number) {
  if (!axis) {
    return [[0, fallback]];
  }
  return axis.spans.map(([from, to]) => {
    const lo = scale(axis, from);
    const hi = scale(axis, to);
    if (hi - lo >= MIN_SLAB) {
      return [lo, hi];
    }
    const start = lo < axis.length - MIN_SLAB ? lo : axis.length - MIN_SLAB;
    return [start, start + MIN_SLAB];
  });
}

function boundaries(axis: TAxis | undefined) {
  const result: number[] = [];
  if (!axis || isDense(axis)) {
    return result;
  }
  for (let k = 1; k < axis.chunkCount; k++) {
    result.push(scale(axis, k * axis.chunkSize));
  }
  return result;
}

/** Draws the visible faces (front, top, right) of a box from `a` to `b`. */
function boxFaces(project: (p: TPoint) => string, a: TPoint, b: TPoint) {
  const [x0, y0, z0] = a;
  const [x1, y1, z1] = b;
  const quad = (...points: TPoint[]) => points.map(project).join(" ");
  const faces = [quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0])];
  if (z1 > z0) {
    faces.push(
      quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]),
      quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1])
    );
  }
  return faces;
}

/**
 * Lays out up to three dimensions as an oblique box: the last dimension runs
 * along x, the one before along y and the one before that into the depth.
 */
// eslint-disable-next-line max-lines-per-function
function buildBlock(axes: TAxis[]): TDiagramBlock {
  const [z, y, x] = [
    axes.length === 3 ? axes[0] : undefined,
    axes.length >= 2 ? axes[axes.length - 2] : undefined,
    axes[axes.length - 1],
  ];
  const W = x.length;
  const H = y ? y.length : STRIP_HEIGHT;
  const D = z ? z.length * DEPTH_SCALE : 0;
  const zScale = z ? DEPTH_SCALE : 0;
  const pt = ([px, py, pz]: TPoint): [number, number] => [
    PADDING + px + pz * zScale,
    py + D - pz * zScale,
  ];
  const project = (p: TPoint) => pt(p).join(",");
  const zLength = z ? z.length : 0;

  const slab: string[] = [];
  for (const [x0, x1] of slabSpans(x, W)) {
    for (const [y0, y1] of slabSpans(y, H)) {
      for (const [z0, z1] of slabSpans(z, 0)) {
        slab.push(...boxFaces(project, [x0, y0, z0], [x1, y1, z1]));
      }
    }
  }

  const segments: [TPoint, TPoint][] = [];
  for (const b of boundaries(x)) {
    segments.push([
      [b, 0, 0],
      [b, H, 0],
    ]);
    segments.push([
      [b, 0, 0],
      [b, 0, zLength],
    ]);
  }
  for (const b of boundaries(y)) {
    segments.push([
      [0, b, 0],
      [W, b, 0],
    ]);
    segments.push([
      [W, b, 0],
      [W, b, zLength],
    ]);
  }
  for (const b of boundaries(z)) {
    segments.push([
      [0, 0, b],
      [W, 0, b],
    ]);
    segments.push([
      [W, 0, b],
      [W, H, b],
    ]);
  }

  const label = (axis: TAxis) => `${axis.name}: ${axis.size.toLocaleString()}`;
  const labels = [
    { x: PADDING + W / 2, y: D + H + 12, angle: 0, text: label(x) },
  ];
  if (y) {
    // In 3D the left side holds the depth label, so y moves to the right face.
    const [lx, ly] = z ? pt([W, H / 2, zLength]) : pt([0, H / 2, 0]);
    const dx = z ? RIGHT_LABEL_GAP : -6;
    labels.push({ x: lx + dx, y: ly, angle: -90, text: label(y) });
  }
  if (z) {
    const [lx, ly] = pt([0, 0, zLength / 2]);
    labels.push({ x: lx - 6, y: ly, angle: -45, text: label(z) });
  }

  return {
    width: PADDING + W + D + (z ? RIGHT_LABEL_GAP + 4 : 4),
    height: D + H + PADDING,
    faces: boxFaces(project, [0, 0, 0], [W, H, zLength]),
    slab,
    lines: segments.map(([a, b]) => `M${project(a)}L${project(b)}`).join(""),
    dense: axes.some(isDense),
    labels,
  };
}

/**
 * Splits the dimensions into groups of up to three, taken from the end, and
 * draws each group as its own block (like dask's HTML preview for >3D arrays).
 */
export function buildChunkDiagram(
  dims: TChunkDimension[],
  indices: readonly (number | null)[]
): TDiagramBlock[] {
  const blocks: TDiagramBlock[] = [];
  for (let end = dims.length; end > 0; end -= 3) {
    const start = end - 3 > 0 ? end - 3 : 0;
    blocks.unshift(buildBlock(toAxes(dims.slice(start, end), indices, start)));
  }
  return blocks;
}
