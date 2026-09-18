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
  const spatialShape = variable.shape.slice(-spatial.length);
  const verticalIndex = dimensionNames.indexOf(verticalDimension);
  return {
    name,
    variable,
    dimensionNames,
    verticalDimension,
    selection: volumeSelection(dimensionNames, verticalDimension, context),
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
  const sources = await Promise.all(
    names.map((name) => inspectSource(datasources, name, context))
  );
  assertCompatibleSources(sources);
  return sources;
}

async function loadSourceValues(
  datasources: TSources,
  source: TVolumeSource,
  onProgress?: (completed: number, total: number) => void
) {
  const values = castDataVarToFloat32(
    await getGridVariableData({
      source: ZarrDataManager.getDatasetSource(datasources, source.name),
      variable: source.name,
      format: datasources.zarr_format,
      selection: source.selection,
      onProgress,
    })
  );
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

// eslint-disable-next-line max-lines-per-function
async function loadHeightValues(
  datasources: TSources,
  source: TVolumeSource,
  context: TVolumeDataContext,
  onProgress?: (completed: number, total: number) => void
) {
  for (const coordinate of coordinateCandidates(source.variable)) {
    const coordinateName = ZarrDataManager.resolveVariablePath(
      source.name,
      coordinate
    );
    if (!datasources.levels[0].datasources[coordinateName]) {
      continue;
    }
    try {
      const [coordinateVariable, dimensionNames] = await Promise.all([
        ZarrDataManager.getVariableInfoByDatasetSources(
          datasources,
          coordinateName
        ),
        ZarrDataManager.getDimensionNames(datasources, coordinateName),
      ]);
      if (
        String(coordinateVariable.attrs.standard_name ?? "").toLowerCase() !==
          "height" ||
        !dimensionNames.includes(source.verticalDimension) ||
        volumeSpatialDimensions(dimensionNames).join("\0") !==
          volumeSpatialDimensions(source.dimensionNames).join("\0")
      ) {
        continue;
      }
      const values = castDataVarToFloat32(
        await getGridVariableData({
          source: ZarrDataManager.getDatasetSource(datasources, coordinateName),
          variable: coordinateName,
          format: datasources.zarr_format,
          selection: volumeSelection(
            dimensionNames,
            source.verticalDimension,
            context
          ),
          onProgress,
        })
      );
      decodeVariableDataAndGetBounds(coordinateVariable, values);
      if (values.length === source.sourceLevelCount * source.sourceCellCount) {
        return values;
      }
    } catch {
      // Try the next declared or conventional height coordinate.
    }
  }
  return undefined;
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

async function loadVerticalCoordinates(
  datasources: TSources,
  source: TVolumeSource
) {
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
  const levels = castDataVarToFloat32(
    await getGridVariableData({
      source: datasources.levels[0].grid,
      variable: name,
      format: datasources.zarr_format,
      selection: [null],
    })
  );
  decodeVariableDataAndGetBounds(coordinate, levels);
  // Place increasing height (or decreasing pressure/depth) outward in the shell.
  if (pressure || positive === "down") {
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
  onProgress: (fraction: number) => void
) {
  const progress = createDownloadProgress(sources.length + 1, onProgress);
  const values = sources.map((source, index) =>
    loadSourceValues(datasources, source, (completed, total) =>
      progress.update(index, completed, total)
    ).finally(() => progress.complete(index))
  );
  const heightIndex = sources.length;
  const heights = loadHeightValues(
    datasources,
    sources[0],
    context,
    (completed, total) => progress.update(heightIndex, completed, total)
  ).finally(() => progress.complete(heightIndex));
  const [loadedValues, loadedHeights, levels] = await Promise.all([
    Promise.all(values),
    heights,
    loadVerticalCoordinates(datasources, sources[0]),
  ]);
  return { values: loadedValues, heights: loadedHeights, levels };
}
