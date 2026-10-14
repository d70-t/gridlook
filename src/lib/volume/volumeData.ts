import type * as zarr from "zarrita";

import { loadGridAxes } from "@/lib/data/coordinateVariables.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { getGridVariableData } from "@/lib/grids/gridDataWorkerClient.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import {
  VOLUME_GRID_TYPES,
  type TProjectedVolumeGrid,
} from "@/lib/volume/volumeGrid.ts";
import {
  projectedVolumeCRS,
  volumeSpatialDimensions,
  volumeVerticalDimension,
} from "@/lib/volume/volumeVariables.ts";

export async function loadProjectedVolumeGrid(
  datasources: TSources,
  variable: string,
  dimensions: string[]
): Promise<TProjectedVolumeGrid | undefined> {
  const crs = projectedVolumeCRS(variable, datasources.levels[0].datasources);
  if (!crs) {
    return undefined;
  }
  const { x, y } = await loadGridAxes(datasources, variable, dimensions);
  return { kind: VOLUME_GRID_TYPES.PROJECTED, x, y, crs };
}

export type TVolumeDataContext = {
  dimensionNames: string[];
  indices: (number | null | zarr.Slice)[];
};

export type TVolumeReadOptions = {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  chunkConcurrency?: number;
  coordinates?: TVolumeCoordinates;
};

export function assertVolumeCurrent(options: TVolumeReadOptions) {
  if (options.signal?.aborted || options.isCurrent?.() === false) {
    throw new DOMException("Volume preparation cancelled", "AbortError");
  }
}

export type TVolumeSource = {
  name: string;
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>;
  dimensionNames: string[];
  verticalDimension: string;
  selection: (number | null)[];
  sourceLevelCount: number;
  sourceCellCount: number;
  spatialShape: number[];
};

function selectedIndex(dimensionName: string, context: TVolumeDataContext) {
  const index = context.dimensionNames.indexOf(dimensionName);
  const value = context.indices[index];
  return typeof value === "number" ? value : 0;
}

function volumeSelection(
  dimensionNames: string[],
  verticalDimension: string,
  context: TVolumeDataContext
) {
  const spatial = volumeSpatialDimensions(dimensionNames);
  return dimensionNames.map((name) => {
    if (name === verticalDimension || spatial.includes(name)) {
      return null;
    }
    return selectedIndex(name, context);
  });
}

async function inspectSource(
  datasources: TSources,
  name: string,
  context: TVolumeDataContext
): Promise<TVolumeSource> {
  const [variable, dimensionNames] = await Promise.all([
    ZarrDataManager.getVariableInfoByDatasetSources(datasources, name),
    ZarrDataManager.getDimensionNames(datasources, name),
  ]);
  const verticalDimension = volumeVerticalDimension(
    dimensionNames,
    variable.shape,
    name,
    datasources.levels[0].datasources
  );
  const spatial = volumeSpatialDimensions(dimensionNames);
  if (
    !verticalDimension ||
    spatial.length === 0 ||
    spatial.join("\0") !==
      volumeSpatialDimensions(context.dimensionNames).join("\0")
  ) {
    throw new Error(`${name} is not a supported volume on this grid.`);
  }
  const selection = volumeSelection(dimensionNames, verticalDimension, context);
  for (let i = 0; i < selection.length; i++) {
    const index = selection[i];
    if (
      index !== null &&
      (!Number.isSafeInteger(index) || index < 0 || index >= variable.shape[i])
    ) {
      throw new Error(
        `Invalid volume index for ${dimensionNames[i]}: ${index}`
      );
    }
  }
  const spatialShape = variable.shape.slice(-spatial.length);
  const verticalIndex = dimensionNames.indexOf(verticalDimension);
  return {
    name,
    variable,
    dimensionNames,
    verticalDimension,
    selection,
    sourceLevelCount: variable.shape[verticalIndex],
    sourceCellCount: spatialShape.reduce((count, size) => count * size, 1),
    spatialShape,
  };
}

function assertCompatibleSources(sources: TVolumeSource[]) {
  const first = sources[0];
  for (const source of sources.slice(1)) {
    if (
      source.dimensionNames.length !== first.dimensionNames.length ||
      !source.dimensionNames.every(
        (name, index) => name === first.dimensionNames[index]
      ) ||
      source.sourceLevelCount !== first.sourceLevelCount ||
      source.spatialShape.some(
        (size, index) => size !== first.spatialShape[index]
      )
    ) {
      throw new Error("Selected volume variables use incompatible grids.");
    }
  }
}

export async function inspectVolumeSources(
  datasources: TSources,
  names: string[],
  context: TVolumeDataContext
) {
  if (
    !names.length ||
    names.length > 4 ||
    new Set(names).size !== names.length
  ) {
    throw new Error("Select between one and four distinct volume variables.");
  }
  const sources = await Promise.all(
    names.map((name) => inspectSource(datasources, name, context))
  );
  assertCompatibleSources(sources);
  return sources;
}

async function loadSourceValues(
  datasources: TSources,
  source: TVolumeSource,
  onProgress: ((completed: number, total: number) => void) | undefined,
  options: TVolumeReadOptions
) {
  assertVolumeCurrent(options);
  const raw = await getGridVariableData({
    source: ZarrDataManager.getDatasetSource(datasources, source.name),
    variable: source.name,
    format: datasources.zarr_format,
    selection: source.selection,
    onProgress,
    chunkConcurrency: options.chunkConcurrency,
  });
  assertVolumeCurrent(options);
  const values = castDataVarToFloat32(raw);
  decodeVariableDataAndGetBounds(source.variable, values);
  const expectedLength = source.sourceLevelCount * source.sourceCellCount;
  if (values.length !== expectedLength) {
    throw new Error(
      `${source.name} returned ${values.length} values; expected ${expectedLength}.`
    );
  }
  return values;
}

function coordinateCandidates(
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const coordinates = String(variable.attrs.coordinates ?? "")
    .split(/\s+/)
    .filter(Boolean);
  return [...coordinates, "zg", "zghalf"].filter(
    (name, index, names) => names.indexOf(name) === index
  );
}

export type TVolumeCoordinates = {
  heights: TVolumeSource[];
  levels?: {
    name: string;
    variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>;
    negative: boolean;
  };
};

export async function inspectVolumeCoordinates(
  datasources: TSources,
  source: TVolumeSource,
  context: TVolumeDataContext,
  options: TVolumeReadOptions = {}
): Promise<TVolumeCoordinates> {
  const heights: TVolumeSource[] = [];
  for (const coordinate of coordinateCandidates(source.variable)) {
    assertVolumeCurrent(options);
    const name = ZarrDataManager.resolveVariablePath(source.name, coordinate);
    if (!datasources.levels[0].datasources[name]) {
      continue;
    }
    try {
      const candidate = await inspectSource(datasources, name, context);
      assertVolumeCurrent(options);
      if (
        String(candidate.variable.attrs.standard_name ?? "").toLowerCase() ===
          "height" &&
        candidate.verticalDimension === source.verticalDimension &&
        candidate.sourceLevelCount === source.sourceLevelCount &&
        candidate.spatialShape.every(
          (size, i) => size === source.spatialShape[i]
        )
      ) {
        heights.push(candidate);
      }
    } catch {
      assertVolumeCurrent(options);
      // Try the next declared or conventional height coordinate.
    }
  }
  const levels = await inspectVerticalCoordinate(datasources, source, options);
  assertVolumeCurrent(options);
  return { heights, levels };
}

async function loadHeightValues(
  datasources: TSources,
  sources: TVolumeSource[],
  onProgress: (completed: number, total: number) => void,
  options: TVolumeReadOptions
) {
  for (const source of sources) {
    assertVolumeCurrent(options);
    try {
      return await loadSourceValues(datasources, source, onProgress, options);
    } catch {
      assertVolumeCurrent(options);
      // Keep the existing fallback to the next coordinate or model-level order.
    }
  }
}

function createDownloadProgress(
  jobCount: number,
  report: (fraction: number) => void
) {
  const fractions = Array.from({ length: jobCount }, () => 0);
  const emit = () =>
    report(fractions.reduce((sum, fraction) => sum + fraction, 0) / jobCount);
  return {
    update(index: number, completed: number, total: number) {
      fractions[index] = total > 0 ? completed / total : 0;
      emit();
    },
    complete(index: number) {
      fractions[index] = 1;
      emit();
    },
  };
}

async function inspectVerticalCoordinate(
  datasources: TSources,
  source: TVolumeSource,
  options: TVolumeReadOptions
) {
  assertVolumeCurrent(options);
  const name = ZarrDataManager.resolveVariablePath(
    source.name,
    source.verticalDimension
  );
  let coordinate;
  try {
    coordinate = await ZarrDataManager.getVariableInfo(
      datasources.levels[0].grid,
      name
    );
  } catch {
    // ponytail: Without a coordinate, retain top-to-bottom model-level order.
    // CF vertical formula evaluation can replace this fallback later.
    return undefined;
  }
  assertVolumeCurrent(options);
  const { units } = coordinate.attrs;
  // NEMO's deptht axis may omit CF metadata; its depths increase downward.
  const positive =
    coordinate.attrs.positive ??
    (source.verticalDimension.toLowerCase() === "deptht" ? "down" : undefined);
  const pressure =
    /pressure/.test(String(coordinate.attrs.standard_name ?? "")) ||
    /^(pa|hpa|mbar|millibar|bar)$/i.test(String(units));
  if (
    coordinate.shape.length !== 1 ||
    coordinate.shape[0] !== source.sourceLevelCount ||
    (!pressure &&
      positive !== "up" &&
      positive !== "down" &&
      !/^(m|km|metres?|meters?)$/i.test(String(units)))
  ) {
    return undefined;
  }
  return {
    name,
    variable: coordinate,
    negative: pressure || positive === "down",
  };
}

async function loadVerticalCoordinates(
  datasources: TSources,
  coordinate: NonNullable<TVolumeCoordinates["levels"]>,
  options: TVolumeReadOptions
) {
  assertVolumeCurrent(options);
  const raw = await getGridVariableData({
    source: datasources.levels[0].grid,
    variable: coordinate.name,
    format: datasources.zarr_format,
    selection: [null],
    chunkConcurrency: options.chunkConcurrency,
  });
  assertVolumeCurrent(options);
  const levels = castDataVarToFloat32(raw);
  decodeVariableDataAndGetBounds(coordinate.variable, levels);
  // Place increasing height (or decreasing pressure/depth) outward in the shell.
  if (coordinate.negative) {
    for (let index = 0; index < levels.length; index++) {
      levels[index] = -levels[index];
    }
  }
  return levels;
}

export async function loadVolumeData(
  datasources: TSources,
  sources: TVolumeSource[],
  context: TVolumeDataContext,
  onProgress: (fraction: number) => void,
  options: TVolumeReadOptions = {}
) {
  assertVolumeCurrent(options);
  const progress = createDownloadProgress(sources.length + 1, onProgress);
  const values: Float32Array[] = [];
  // Read one variable at a time so the chunk limit also bounds the whole job.
  // In-flight shared-worker reads finish on cancellation; no further read starts.
  for (const [index, source] of sources.entries()) {
    values.push(
      await loadSourceValues(
        datasources,
        source,
        (completed, total) => progress.update(index, completed, total),
        options
      )
    );
    progress.complete(index);
  }
  const coordinates =
    options.coordinates ??
    (await inspectVolumeCoordinates(datasources, sources[0], context, options));
  const heightIndex = sources.length;
  const heights = await loadHeightValues(
    datasources,
    coordinates.heights,
    (completed, total) => progress.update(heightIndex, completed, total),
    options
  );
  assertVolumeCurrent(options);
  const levels = coordinates.levels
    ? await loadVerticalCoordinates(datasources, coordinates.levels, options)
    : undefined;
  assertVolumeCurrent(options);
  progress.complete(heightIndex);
  return { values, heights, levels };
}
