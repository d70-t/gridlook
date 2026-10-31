import {
  isLatitudeName,
  isLongitudeName,
  isProjectedXName,
} from "./coordinateVariables.ts";

import { EARTH_RADIUS_METERS } from "@/lib/camera/cameraSettings.ts";
import type { TDataSource } from "@/lib/types/GlobeTypes.ts";

/**
 * One level of a `multiscales` pyramid: the child group holding it and, when
 * the attributes say so, the ground size of one of its cells in metres.
 */
export type TMultiscaleEntry = {
  path: string;
  resolution?: number;
};

export type TLevelGeometry = {
  resolution?: number;
  cellCount?: number;
};

const WEB_MERCATOR_QUAD = "WebMercatorQuad";
// Ground size of one 256 px WebMercatorQuad tile pixel at zoom 0 (equator).
const WEB_MERCATOR_ZOOM0_METERS_PER_PIXEL = 156543.03392804097;
const METERS_PER_DEGREE = (Math.PI / 180) * EARTH_RADIUS_METERS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metersPerUnit(unit: unknown): number | undefined {
  switch (String(unit ?? "").toLowerCase()) {
    case "degree":
    case "degrees":
    case "degrees_east":
    case "degrees_north":
      return METERS_PER_DEGREE;
    case "m":
    case "meter":
    case "meters":
    case "metre":
    case "metres":
      return 1;
    case "km":
    case "kilometer":
    case "kilometers":
    case "kilometre":
    case "kilometres":
      return 1000;
    default:
      return undefined;
  }
}

/**
 * OME-NGFF: the mean ground size of a cell over the spatial axes of the
 * dataset's `scale` transformation, when every spatial axis has a length unit.
 */
function omeResolution(
  dataset: Record<string, unknown>,
  axes: unknown
): number | undefined {
  const transformations = dataset.coordinateTransformations;
  if (!Array.isArray(transformations) || !Array.isArray(axes)) {
    return undefined;
  }
  const scale = transformations.find(
    (transformation) =>
      isRecord(transformation) &&
      transformation.type === "scale" &&
      Array.isArray(transformation.scale)
  )?.scale as unknown[] | undefined;
  if (!scale) {
    return undefined;
  }
  let sum = 0;
  let count = 0;
  for (let index = 0; index < axes.length; index++) {
    const axis = axes[index];
    if (!isRecord(axis) || axis.type !== "space") {
      continue;
    }
    const factor = metersPerUnit(axis.unit);
    const step = Number(scale[index]);
    if (factor === undefined || !(step > 0)) {
      return undefined;
    }
    sum += step * factor;
    count++;
  }
  return count > 0 ? sum / count : undefined;
}

/** A zoom written as a number or a string of digits. */
function zoomOf(value: unknown) {
  return /^\d+$/.test(String(value)) ? Number(value) : undefined;
}

/**
 * ndpyramid: a web-mercator dataset of zoom `n` (its `level`, else its
 * numeric path) with `pixels_per_tile` p has cells of 2πR / (p · 2ⁿ) at the
 * equator.
 */
function ndpyramidResolution(
  dataset: Record<string, unknown>
): number | undefined {
  const pixels = Number(dataset.pixels_per_tile);
  const zoom = zoomOf(dataset.level) ?? zoomOf(dataset.path);
  if (
    String(dataset.crs).toUpperCase() !== "EPSG:3857" ||
    !(pixels > 0) ||
    zoom === undefined
  ) {
    return undefined;
  }
  return (WEB_MERCATOR_ZOOM0_METERS_PER_PIXEL * 256) / (pixels * 2 ** zoom);
}

function omeEntries(multiscale: Record<string, unknown>): TMultiscaleEntry[] {
  const datasets = multiscale.datasets;
  if (!Array.isArray(datasets)) {
    return [];
  }
  return datasets
    .filter(
      (dataset): dataset is Record<string, unknown> =>
        isRecord(dataset) && typeof dataset.path === "string"
    )
    .map((dataset) => ({
      path: dataset.path as string,
      resolution:
        omeResolution(dataset, multiscale.axes) ?? ndpyramidResolution(dataset),
    }));
}

/**
 * The zarr-conventions `multiscales` layout: one entry per `layout[].asset`,
 * kept as declared. Its `transform.scale` is relative to another level, not a
 * ground size, so the resolution is left to the level's grid. An asset may
 * name a level group or one array of a level (the parent group then is the
 * level); `groupArrayAssets` folds the latter into levels once the store
 * tells which assets are arrays.
 */
function layoutEntries(
  multiscale: Record<string, unknown>
): TMultiscaleEntry[] {
  const layout = multiscale.layout;
  if (!Array.isArray(layout)) {
    return [];
  }
  return layout
    .filter(
      (level): level is Record<string, unknown> =>
        isRecord(level) && typeof level.asset === "string"
    )
    .map((level) => ({ path: level.asset as string }));
}

/**
 * Fold entries whose path names an array (`isArray`) into the level that
 * holds it: its parent group, listed once, at the position of its first
 * array. Entries naming groups are
 * kept as they are; a layout mixing both is folded the same way.
 */
export function groupArrayAssets(
  entries: readonly TMultiscaleEntry[],
  isArray: (path: string) => boolean
): TMultiscaleEntry[] {
  const levels = new Map<string, TMultiscaleEntry>();
  for (const entry of entries) {
    const path = entry.path.replace(/\/+$/, "");
    if (!isArray(path)) {
      levels.set(path, levels.get(path) ?? { ...entry, path });
      continue;
    }
    const separator = path.lastIndexOf("/");
    const level = separator < 0 ? "" : path.slice(0, separator);
    const existing = levels.get(level);
    if (existing) {
      existing.resolution ??= entry.resolution;
    } else {
      levels.set(level, { ...entry, path: level });
    }
  }
  return [...levels.values()];
}

// Geographic CRSs whose tile matrix `cellSize` is in degrees.
const GEOGRAPHIC_CRS = /(CRS84|EPSG\W*(0\W*)?4326)$/i;

/**
 * The ground size of each tile matrix an inline GeoZarr tile matrix set
 * states as `tileMatrices[].cellSize`: in degrees for a CRS84/EPSG:4326 set,
 * in metres (the projected CRS's unit) otherwise.
 */
function tileMatrixCellSizes(tileMatrixSet: unknown): Map<string, number> {
  const sizes = new Map<string, number>();
  if (!isRecord(tileMatrixSet) || !Array.isArray(tileMatrixSet.tileMatrices)) {
    return sizes;
  }
  const factor = GEOGRAPHIC_CRS.test(String(tileMatrixSet.crs ?? ""))
    ? METERS_PER_DEGREE
    : 1;
  for (const matrix of tileMatrixSet.tileMatrices) {
    const cellSize = isRecord(matrix) ? Number(matrix.cellSize) : NaN;
    if (isRecord(matrix) && typeof matrix.id === "string" && cellSize > 0) {
      sizes.set(matrix.id, cellSize * factor);
    }
  }
  return sizes;
}

/**
 * GeoZarr: one child group per tile matrix listed in `tile_matrix_limits` (or,
 * without limits, per matrix of an inline tile matrix set). Each resolution is
 * the matrix's `cellSize`, or follows from the zoom for WebMercatorQuad.
 * Finest first: by resolution when every matrix has one, else by zoom when
 * the matrices are numbered.
 */
function geoZarrEntries(
  multiscale: Record<string, unknown>
): TMultiscaleEntry[] {
  const limits = multiscale.tile_matrix_limits;
  const tileMatrixSet = multiscale.tile_matrix_set;
  const cellSizes = tileMatrixCellSizes(tileMatrixSet);
  const ids = isRecord(limits) ? Object.keys(limits) : [...cellSizes.keys()];
  const isWebMercator =
    tileMatrixSet === WEB_MERCATOR_QUAD ||
    (isRecord(tileMatrixSet) && tileMatrixSet.id === WEB_MERCATOR_QUAD);
  const entries = ids.map((id) => ({
    path: id,
    resolution:
      cellSizes.get(id) ??
      (isWebMercator && /^\d+$/.test(id)
        ? WEB_MERCATOR_ZOOM0_METERS_PER_PIXEL / 2 ** Number(id)
        : undefined),
  }));
  if (entries.every(({ resolution }) => resolution !== undefined)) {
    entries.sort((a, b) => a.resolution! - b.resolution!);
  } else if (ids.every((id) => /^\d+$/.test(id))) {
    entries.sort((a, b) => Number(b.path) - Number(a.path));
  }
  return entries;
}

/**
 * The levels a group's `multiscales` attribute declares, finest first (OME-NGFF
 * orders its datasets that way, a zarr-conventions layout is taken as
 * declared; GeoZarr tile matrices are sorted by size).
 * OME-NGFF 0.5 nests the attribute under `ome`. Groups without the attribute
 * have no levels to declare.
 */
export function parseMultiscales(
  attrs: Record<string, unknown>
): TMultiscaleEntry[] {
  const multiscales =
    attrs.multiscales ?? (isRecord(attrs.ome) ? attrs.ome.multiscales : null);
  const multiscale = Array.isArray(multiscales) ? multiscales[0] : multiscales;
  if (!isRecord(multiscale)) {
    return [];
  }
  for (const entries of [omeEntries(multiscale), layoutEntries(multiscale)]) {
    if (entries.length > 0) {
      return entries;
    }
  }
  return geoZarrEntries(multiscale);
}

function healpixResolution(nside: number) {
  // Every HEALPix cell has the same area, 4π / (12 nside²) steradians.
  return (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / nside;
}

/** The HEALPix `dggs` attribute of a level group, if it has one. */
function healpixDggs(levelAttrs: Record<string, unknown>) {
  const dggs = levelAttrs.dggs;
  return isRecord(dggs) &&
    String(dggs.name ?? "healpix").toLowerCase() === "healpix"
    ? dggs
    : undefined;
}

function healpixNside(
  datasources: Record<string, TDataSource>,
  levelAttrs: Record<string, unknown>
): number | undefined {
  for (const source of Object.values(datasources)) {
    const nside = Number(source.attrs?.healpix_nside);
    if (Number.isInteger(nside) && nside > 0) {
      return nside;
    }
  }
  const refinementLevel = Number(healpixDggs(levelAttrs)?.refinement_level);
  if (Number.isInteger(refinementLevel) && refinementLevel >= 0) {
    return 2 ** refinementLevel;
  }
  for (const source of Object.values(datasources)) {
    const dimensions = source.attrs?.dimensionNames;
    const shape = source.shape;
    if (source.hidden || !Array.isArray(dimensions) || !shape?.length) {
      continue;
    }
    if (!/^cells?$/.test(String(dimensions[dimensions.length - 1]))) {
      continue;
    }
    const nside = Math.sqrt(shape[shape.length - 1] / 12);
    if (Number.isInteger(nside) && nside > 0) {
      return nside;
    }
  }
  return undefined;
}

// Dimensions that span a level horizontally.
const SPATIAL_DIMENSION = /^(cells?|x|y|lat|lon|latitude|longitude|rlat|rlon)$/;

/**
 * The cells one horizontal slice of a level holds, i.e. the values one
 * timestep of a variable fetches: the product of the spatial dimension
 * lengths of the first visible variable — the `cell` dimension of a HEALPix
 * level, however sparse, or `lat · lon` / `y · x` on a regular grid.
 */
function spatialCellCount(
  datasources: Record<string, TDataSource>,
  levelAttrs: Record<string, unknown>
): number | undefined {
  // The DGGS convention names the cell coordinate, and so its dimension.
  const coordinate = healpixDggs(levelAttrs)?.coordinate;
  const cellDimension =
    typeof coordinate === "string"
      ? datasources[coordinate]?.attrs?.dimensionNames
      : undefined;
  const isSpatial = (name: unknown) =>
    SPATIAL_DIMENSION.test(String(name)) ||
    (Array.isArray(cellDimension) && name === cellDimension[0]);
  for (const source of Object.values(datasources)) {
    const dimensions = source.attrs?.dimensionNames;
    const shape = source.shape;
    if (
      source.hidden ||
      !Array.isArray(dimensions) ||
      shape?.length !== dimensions.length
    ) {
      continue;
    }
    let count = 1;
    let spatial = false;
    dimensions.forEach((name, index) => {
      if (isSpatial(name)) {
        count *= shape[index];
        spatial = true;
      }
    });
    if (spatial) {
      return count;
    }
  }
  return undefined;
}

function findAxis(
  datasources: Record<string, TDataSource>,
  matches: (name: string) => boolean
) {
  return Object.keys(datasources).find(
    (name) => matches(name) && datasources[name].shape?.length === 1
  );
}

/**
 * The cell size and cell count of a level whose attributes do not state them,
 * read off its grid. The count is the length of the level's spatial
 * dimensions (see `spatialCellCount`). The size comes from the HEALPix nside
 * (the CRS variable, the level group's DGGS `refinement_level`, or a
 * `12 nside²` cell dimension) or the spacing of a
 * one-dimensional longitude coordinate on a regular grid, else of a
 * projected `x` coordinate in a length unit; `readAxis` fetches
 * the first values of a coordinate variable of the level, and without it only
 * the count is read.
 */
export async function levelGeometryFromGrid(
  datasources: Record<string, TDataSource>,
  readAxis?: (name: string) => Promise<ArrayLike<number>>,
  levelAttrs: Record<string, unknown> = {}
): Promise<TLevelGeometry> {
  const cellCount = spatialCellCount(datasources, levelAttrs);
  const nside = healpixNside(datasources, levelAttrs);
  if (nside !== undefined) {
    return {
      resolution: healpixResolution(nside),
      // A dense level whose variables state no dimension names.
      cellCount: cellCount ?? 12 * nside * nside,
    };
  }
  const longitudeName = findAxis(datasources, isLongitudeName);
  const latitudeName = findAxis(datasources, isLatitudeName);
  // Without longitudes, a projected `x` axis in a length unit.
  const xName = longitudeName
    ? undefined
    : findAxis(datasources, isProjectedXName);
  const xFactor = xName
    ? metersPerUnit(datasources[xName].attrs?.units)
    : undefined;
  const axisName = longitudeName ?? (xFactor === undefined ? undefined : xName);
  const longitudeCount = longitudeName
    ? datasources[longitudeName].shape?.[0]
    : undefined;
  const latitudeCount = latitudeName
    ? datasources[latitudeName].shape?.[0]
    : undefined;
  const count =
    cellCount ??
    (latitudeCount && longitudeCount
      ? latitudeCount * longitudeCount
      : undefined);
  const counted = count === undefined ? {} : { cellCount: count };
  if (!axisName || !readAxis) {
    return counted;
  }
  const values = await readAxis(axisName);
  const step = Math.abs(Number(values[1]) - Number(values[0]));
  if (values.length < 2 || !(step > 0)) {
    return counted;
  }
  return {
    resolution: step * (longitudeName ? METERS_PER_DEGREE : xFactor!),
    ...counted,
  };
}
