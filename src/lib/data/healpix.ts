import * as healpix from "@hscmap/healpix";

const DEGREES_TO_RADIANS = Math.PI / 180;

// @hscmap/healpix can select its clipped fallback face when phi lies exactly
// on a northern base-face boundary (0, 90, 180, or 270 degrees). The angular
// displacement is far below floating-point HEALPix resolution, but ensures
// that the boundary is consistently assigned to the adjacent valid pixel.
const FACE_BOUNDARY_NUDGE_RADIANS = 1e-12;

/** Return the NESTED pixel containing a geographic position. */
export function healpixNestedPixelIndex(
  nside: number,
  latitude: number,
  longitude: number
) {
  const theta = (90 - latitude) * DEGREES_TO_RADIANS;
  const normalizedLongitude = ((longitude % 360) + 360) % 360;
  const phi =
    normalizedLongitude * DEGREES_TO_RADIANS + FACE_BOUNDARY_NUDGE_RADIANS;
  return healpix.ang2pix_nest(nside, theta, phi);
}
