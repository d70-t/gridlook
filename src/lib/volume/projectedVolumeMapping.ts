import { geoBounds } from "d3-geo";
import proj4, { type Converter as TProjectionConverter } from "proj4";

import {
  getRegularVolumeMapping,
  nearestIndex,
  orderedAxis,
} from "./regularVolumeMapping.ts";
import type { TProjectedVolumeGrid } from "./volumeGrid.ts";

import { transformProjectedAxesToLonLat } from "@/lib/data/coordinateVariables.ts";

const VOLUME_PROJECTIONS = {
  MERCATOR: "merc",
  LAMBERT: "lcc",
  ROTATED: "ob_tran",
} as const;

export function isSupportedVolumeCRS(crs: string | null | undefined) {
  if (!crs) {
    return false;
  }
  try {
    const projection = new proj4.Proj(crs);
    return (
      projection.names.includes(VOLUME_PROJECTIONS.MERCATOR) ||
      projection.names.includes(VOLUME_PROJECTIONS.LAMBERT) ||
      (projection.names.includes(VOLUME_PROJECTIONS.ROTATED) &&
        "o_proj" in projection &&
        projection.o_proj === "longlat")
    );
  } catch {
    return false;
  }
}

function axisBounds(axis: ReturnType<typeof orderedAxis>) {
  const values = axis.coordinates;
  if (values.length < 2) {
    throw new Error(
      "Projected volumes need at least two coordinates per axis."
    );
  }
  return {
    min: values[0] - (values[1] - values[0]) / 2,
    max: values.at(-1)! + (values.at(-1)! - values.at(-2)!) / 2,
  };
}

function wrapToAxis(
  value: number,
  axis: ReturnType<typeof axisBounds>,
  wrap: boolean
) {
  return wrap
    ? value + 360 * Math.round(((axis.min + axis.max) / 2 - value) / 360)
    : value;
}

function projectedBounds(
  x: ReturnType<typeof axisBounds>,
  y: ReturnType<typeof axisBounds>,
  transform: TProjectionConverter,
  steps: number,
  wrapLongitude: boolean
) {
  const boundary: number[][] = [];
  // ponytail: Sample the curved boundary at source resolution. Adaptive edge
  // subdivision could tighten bounds for very coarse or distorted grids.
  for (let i = 0; i <= steps; i++) {
    boundary.push(
      transform.forward([x.min + (i / steps) * (x.max - x.min), y.min])
    );
  }
  for (let i = 0; i <= steps; i++) {
    boundary.push(
      transform.forward([x.max, y.min + (i / steps) * (y.max - y.min)])
    );
  }
  for (let i = 0; i <= steps; i++) {
    boundary.push(
      transform.forward([x.max - (i / steps) * (x.max - x.min), y.max])
    );
  }
  for (let i = 0; i <= steps; i++) {
    boundary.push(
      transform.forward([x.min, y.max - (i / steps) * (y.max - y.min)])
    );
  }
  if (boundary.some((point) => !point.every(Number.isFinite))) {
    throw new Error("Could not determine projected volume bounds.");
  }
  const [[west, south], [east, north]] = geoBounds({
    type: "LineString",
    coordinates: boundary,
  });
  const bounds = { west, east: east < west ? east + 360 : east, south, north };
  for (const pole of [-90, 90]) {
    const [nativeX, py] = transform.inverse([0, pole]);
    const px = wrapToAxis(nativeX, x, wrapLongitude);
    if (px >= x.min && px <= x.max && py >= y.min && py <= y.max) {
      bounds.west = -180;
      bounds.east = 180;
      bounds[pole > 0 ? "north" : "south"] = pole;
    }
  }
  return bounds;
}

function getNativeVolumeMapping(
  grid: TProjectedVolumeGrid,
  width: number,
  height: number,
  wrapLongitude: boolean,
  onProgress?: (completed: number, total: number) => void
) {
  const x = orderedAxis(grid.x, wrapLongitude);
  const y = orderedAxis(grid.y);
  const xBounds = axisBounds(x);
  const yBounds = axisBounds(y);
  if (wrapLongitude) {
    if (y.coordinates.some((latitude) => Math.abs(latitude) > 90)) {
      throw new Error("Rotated volume latitudes must be in degrees.");
    }
    xBounds.max = Math.min(xBounds.max, xBounds.min + 360);
    yBounds.min = Math.max(yBounds.min, -90);
    yBounds.max = Math.min(yBounds.max, 90);
  }
  const transform = proj4(grid.crs, "EPSG:4326");
  const bounds = projectedBounds(
    xBounds,
    yBounds,
    transform,
    Math.max(64, grid.x.length, grid.y.length),
    wrapLongitude
  );
  const sourceCells = new Int32Array(width * height).fill(-1);
  for (let row = 0; row < height; row++) {
    const lat =
      bounds.south + ((row + 0.5) / height) * (bounds.north - bounds.south);
    for (let column = 0; column < width; column++) {
      const lon =
        bounds.west + ((column + 0.5) / width) * (bounds.east - bounds.west);
      const [nativeX, py] = transform.inverse([lon, lat]);
      const px = wrapToAxis(nativeX, xBounds, wrapLongitude);
      if (
        px >= xBounds.min &&
        px <= xBounds.max &&
        py >= yBounds.min &&
        py <= yBounds.max
      ) {
        sourceCells[row * width + column] =
          nearestIndex(y, py) * grid.x.length + nearestIndex(x, px);
      }
    }
    onProgress?.(row + 1, height);
  }
  return { sourceCells, bounds };
}

export function getProjectedVolumeMapping(
  grid: TProjectedVolumeGrid,
  width: number,
  height: number,
  onProgress?: (completed: number, total: number) => void
) {
  if (!isSupportedVolumeCRS(grid.crs)) {
    throw new Error(
      "Volume rendering supports Lambert, Mercator and rotated-pole grids."
    );
  }
  const projection = new proj4.Proj(grid.crs);
  if (projection.names.includes(VOLUME_PROJECTIONS.MERCATOR)) {
    const { latitudes, longitudes } = transformProjectedAxesToLonLat(
      grid.x,
      grid.y,
      grid.crs
    );
    return getRegularVolumeMapping(
      latitudes,
      longitudes,
      width,
      height,
      onProgress
    );
  }
  return getNativeVolumeMapping(
    grid,
    width,
    height,
    projection.names.includes(VOLUME_PROJECTIONS.ROTATED),
    onProgress
  );
}
