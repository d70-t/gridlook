/**
 * Motion that connects a plot window to where it came from: it grows out of
 * its selection when created, folds into the Plotting tools button when
 * minimized and grows back out of it when restored (the folder-minimize
 * cue). Reduced motion gets a short stationary fade.
 */
import { geometryVertices } from "./plotLayout.ts";

import { GEOMETRY_KINDS, type TGeometry } from "@/lib/analysis/types.ts";
import { getMapScene } from "@/ui/grids/composables/useMapInteraction.ts";

export type TScreenBox = { x: number; y: number; w: number; h: number };

const OPEN_MS = 240;
const CLOSE_MS = 170;
const FADE_MS = 120;

function reducedMotion() {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * A selection's bounds on screen, relative to the map area (a point is a
 * small box around its marker); undefined when no vertex is visible.
 */
export function selectionBox(
  geometry: TGeometry,
  area: { left: number; top: number; width: number; height: number }
): TScreenBox | undefined {
  const scene = getMapScene();
  if (!scene) {
    return undefined;
  }
  const vertices =
    geometry.kind === GEOMETRY_KINDS.BOX
      ? [
          { lat: geometry.south, lon: geometry.west },
          { lat: geometry.north, lon: geometry.west },
          { lat: geometry.south, lon: geometry.east },
          { lat: geometry.north, lon: geometry.east },
          {
            lat: (geometry.south + geometry.north) / 2,
            lon: geometry.west + boxMid(geometry.west, geometry.east),
          },
        ]
      : geometryVertices(geometry);
  const points = vertices
    .flatMap((v) => {
      const p = scene.project(v.lat, v.lon);
      return p ? [{ x: p.x - area.left, y: p.y - area.top }] : [];
    })
    .filter(
      (p) => p.x >= 0 && p.y >= 0 && p.x <= area.width && p.y <= area.height
    );
  if (!points.length) {
    return undefined;
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, x1, y0, y1] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  return { x: x0 - 6, y: y0 - 6, w: x1 - x0 + 12, h: y1 - y0 + 12 };
}

function boxMid(west: number, east: number) {
  const span = (((east - west) % 360) + 360) % 360 || 360;
  return span / 2;
}

/** The Plotting tools button on screen (where minimized plots go). */
export function launcherBox(): TScreenBox | undefined {
  const button = document.querySelector<HTMLElement>(
    ".analysis-plots-button .analysis-plots-icon, .analysis-plots-button"
  );
  const r = button?.getBoundingClientRect();
  return r && r.width
    ? { x: r.left, y: r.top, w: r.width, h: r.height }
    : undefined;
}

function transformFrom(element: HTMLElement, from: TScreenBox) {
  const to = element.getBoundingClientRect();
  const sx = Math.max(0.02, from.w / Math.max(1, to.width));
  const sy = Math.max(0.02, from.h / Math.max(1, to.height));
  return `translate(${from.x - to.left}px, ${from.y - to.top}px) scale(${sx}, ${sy})`;
}

/** Grow a window out of `from` (screen pixels) into its own bounds. */
export function growFrom(element: HTMLElement, from: TScreenBox | undefined) {
  if (!from || typeof element.animate !== "function") {
    return;
  }
  if (reducedMotion()) {
    element.animate([{ opacity: 0 }, { opacity: 1 }], FADE_MS);
    return;
  }
  element.animate(
    [
      {
        transformOrigin: "0 0",
        transform: transformFrom(element, from),
        opacity: 0.2,
      },
      { transformOrigin: "0 0", transform: "none", opacity: 1 },
    ],
    { duration: OPEN_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
  );
}

/** Fold a window into `to` (screen pixels); resolves when it is there. */
export async function foldInto(
  element: HTMLElement,
  to: TScreenBox | undefined
) {
  if (!to || typeof element.animate !== "function") {
    return;
  }
  const animation = reducedMotion()
    ? element.animate([{ opacity: 1 }, { opacity: 0 }], FADE_MS)
    : element.animate(
        [
          { transformOrigin: "0 0", transform: "none", opacity: 1 },
          {
            transformOrigin: "0 0",
            transform: transformFrom(element, to),
            opacity: 0.2,
          },
        ],
        {
          duration: CLOSE_MS,
          easing: "cubic-bezier(0.4, 0, 1, 1)",
          fill: "forwards",
        }
      );
  try {
    await animation.finished;
  } catch {
    // cancelled: the window is going away regardless
  }
}
