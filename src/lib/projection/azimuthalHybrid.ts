/**
 * Azimuthal Hybrid projection — the mathematical core of the "Hyperglobe" mode.
 *
 * The projection smoothly interpolates between Lambert Azimuthal Equal-Area
 * (blend = 0) and Azimuthal Equidistant (blend = 1) based on angular distance
 * from the projection center. Near the center the map looks equal-area; near
 * the edge it transitions toward equidistant to reduce extreme compression.
 *
 * The tuned constants below were chosen to give the hyperglobe view its
 * characteristic look. Changing them will visibly alter the projection shape.
 */

import { clamp } from "./projectionUtils.ts";

// Base interpolation weight (0 = equal-area, 1 = equidistant).
const BLEND = 0.43;

// Additional blend applied near the rim of the visible disk (smoothstep window).
const RIM_BLEND = -0.08;
const RIM_BLEND_START = 0.42; // fraction of PI
const RIM_BLEND_END = 0.98;

// Additional blend applied near the far edge / antipodal region.
const FAR_BLEND = -0.14;
const FAR_BLEND_START = 0.68; // fraction of PI
const FAR_BLEND_END = 0.98;

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function effectiveBlend(c: number): number {
  const rimWeight = smoothstep(RIM_BLEND_START, RIM_BLEND_END, c / Math.PI);
  const farWeight = smoothstep(FAR_BLEND_START, FAR_BLEND_END, c / Math.PI);
  return clamp(BLEND + RIM_BLEND * rimWeight + FAR_BLEND * farWeight, 0, 1);
}

/**
 * Returns a raw d3-geo projection function for the azimuthal hybrid projection.
 * Pass the result to `d3.geoProjection()`.
 */
export function createAzimuthalHybridRaw(): (
  lambda: number,
  phi: number
) => [number, number] {
  return (lambda: number, phi: number): [number, number] => {
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const cosLambda = Math.cos(lambda);
    const sinLambda = Math.sin(lambda);
    const cosC = clamp(cosPhi * cosLambda, -1, 1);
    const c = Math.acos(cosC);

    if (c < 1e-6) {
      return [0, 0];
    }

    const sinC = Math.sin(c);
    const safeSinC = Math.abs(sinC) < 1e-6 ? 1e-6 : sinC;
    const rhoEqualArea = Math.sqrt(Math.max(0, 2 - 2 * cosC));
    const rhoEquidistant = c;
    const rho =
      rhoEqualArea + (rhoEquidistant - rhoEqualArea) * effectiveBlend(c);
    const scale = rho / safeSinC;

    return [scale * cosPhi * sinLambda, scale * sinPhi];
  };
}
