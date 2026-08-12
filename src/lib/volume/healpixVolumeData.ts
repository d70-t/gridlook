import type * as zarr from "zarrita";

import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { getGridVariableData } from "@/lib/grids/gridDataWorkerClient.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import {
  isTemporalDimensionName,
  isVerticalDimensionName,
} from "@/lib/volume/volumeVariables.ts";

export type THealpixVolumeDataContext = {
  dimensionNames: string[];
  indices: (number | null | zarr.Slice)[];
};

export type THealpixVolumeSource = {
  name: string;
  variable: zarr.Array<zarr.DataType, zarr.AsyncReadable>;
  dimensionNames: string[];
  verticalDimension: string;
  selection: (number | null)[];
  sourceLevelCount: number;
  sourceCellCount: number;
};

function selectedIndex(
  dimensionName: string,
  context: THealpixVolumeDataContext
) {
  const index = context.dimensionNames.indexOf(dimensionName);
  const value = context.indices[index];
  return typeof value === "number" ? value : 0;
}

function volumeSelection(
  dimensionNames: string[],
  verticalDimension: string,
  context: THealpixVolumeDataContext
) {
  return dimensionNames.map((name) => {
    if (name === verticalDimension || name === "cell") {
      return null;
    }
    return selectedIndex(name, context);
  });
}

function findVerticalDimension(
  dimensionNames: string[],
  shape: readonly number[]
) {
  const candidates = dimensionNames.filter(
    (name, index) =>
      !isTemporalDimensionName(name) && name !== "cell" && shape[index] > 1
  );
  const recognized = candidates.filter(isVerticalDimensionName);
  return recognized.length === 1
    ? recognized[0]
    : candidates.length === 1
      ? candidates[0]
      : undefined;
}

async function inspectSource(
  datasources: TSources,
  name: string,
  context: THealpixVolumeDataContext
): Promise<THealpixVolumeSource> {
  const [variable, dimensionNames] = await Promise.all([
    ZarrDataManager.getVariableInfoByDatasetSources(datasources, name),
    ZarrDataManager.getDimensionNames(datasources, name),
  ]);
  const verticalDimension = findVerticalDimension(
    dimensionNames,
    variable.shape
  );
  const cellIndex = dimensionNames.indexOf("cell");
  if (!verticalDimension || cellIndex !== dimensionNames.length - 1) {
    throw new Error(`${name} is not a supported HEALPix volume.`);
  }
  const verticalIndex = dimensionNames.indexOf(verticalDimension);
  return {
    name,
    variable,
    dimensionNames,
    verticalDimension,
    selection: volumeSelection(dimensionNames, verticalDimension, context),
    sourceLevelCount: variable.shape[verticalIndex],
    sourceCellCount: variable.shape[cellIndex],
  };
}

function assertCompatibleSources(sources: THealpixVolumeSource[]) {
  const first = sources[0];
  for (const source of sources.slice(1)) {
    if (
      source.dimensionNames.length !== first.dimensionNames.length ||
      !source.dimensionNames.every(
        (name, index) => name === first.dimensionNames[index]
      ) ||
      source.sourceLevelCount !== first.sourceLevelCount ||
      source.sourceCellCount !== first.sourceCellCount
    ) {
      throw new Error("Selected volume variables use incompatible grids.");
    }
  }
}

export async function inspectHealpixVolumeSources(
  datasources: TSources,
  names: string[],
  context: THealpixVolumeDataContext
) {
  const sources = await Promise.all(
    names.map((name) => inspectSource(datasources, name, context))
  );
  assertCompatibleSources(sources);
  return sources;
}

async function loadSourceValues(
  datasources: TSources,
  source: THealpixVolumeSource,
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
  source: THealpixVolumeSource,
  context: THealpixVolumeDataContext,
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
        !dimensionNames.includes("cell")
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

export async function loadHealpixVolumeData(
  datasources: TSources,
  sources: THealpixVolumeSource[],
  context: THealpixVolumeDataContext,
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
  const [loadedValues, loadedHeights] = await Promise.all([
    Promise.all(values),
    heights,
  ]);
  return { values: loadedValues, heights: loadedHeights };
}
