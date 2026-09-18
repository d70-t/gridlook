import {
  getCRSFromAttrs,
  isLatitudeName,
  isLongitudeName,
  isProjectedXName,
  isProjectedYName,
} from "@/lib/data/coordinateVariables.ts";
import { verticalCoordinateScore } from "@/lib/data/dimensionData.ts";
import { GRID_TYPES, type T_GRID_TYPES } from "@/lib/data/gridTypeDetector.ts";
import { isTimeCoordinate } from "@/lib/data/timeHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import type { TDataSource, TModelInfo } from "@/lib/types/GlobeTypes.ts";
import { isSupportedVolumeCRS } from "@/lib/volume/projectedVolumeMapping.ts";

function dimensionNames(source: TDataSource) {
  const names =
    source.attrs?.dimensionNames ?? source.attrs?._ARRAY_DIMENSIONS ?? [];
  return Array.isArray(names) ? names.map(String) : [];
}

export function volumeSpatialDimensions(dimensions: string[]) {
  if (dimensions.at(-1) === "cell") {
    return dimensions.slice(-1);
  }
  if (
    dimensions.length >= 2 &&
    ((isLatitudeName(dimensions.at(-2)!) &&
      isLongitudeName(dimensions.at(-1)!)) ||
      (isProjectedYName(dimensions.at(-2)!) &&
        isProjectedXName(dimensions.at(-1)!)))
  ) {
    return dimensions.slice(-2);
  }
  return [];
}

export function projectedVolumeCRS(
  variable: string,
  sources: Record<string, TDataSource>
) {
  const source = sources[variable];
  if (!source) {
    return undefined;
  }
  const dimensions = dimensionNames(source);
  if (volumeSpatialDimensions(dimensions).length !== 2) {
    return undefined;
  }
  for (const name of dimensions.slice(-2)) {
    const axis = sources[ZarrDataManager.resolveVariablePath(variable, name)];
    if (axis?.shape?.length !== 1 || axis.shape[0] < 2) {
      return undefined;
    }
  }
  const mapping = ZarrDataManager.getCRSVariableName(
    source.attrs ?? {},
    source.groupAttrs
  );
  const attrs =
    sources[ZarrDataManager.resolveVariablePath(variable, mapping)]?.attrs ??
    {};
  const crs =
    getCRSFromAttrs(attrs) ?? getCRSFromAttrs(source.groupAttrs ?? {});
  return isSupportedVolumeCRS(crs) ? crs : undefined;
}

export function volumeVerticalDimension(
  dimensions: string[],
  shape: readonly number[],
  variable: string,
  sources: Record<string, TDataSource>
) {
  const spatial = volumeSpatialDimensions(dimensions);
  const candidates = dimensions.filter((name, index) => {
    const path = ZarrDataManager.resolveVariablePath(variable, name);
    const attrs = sources[path]?.attrs ?? {};
    return (
      shape[index] > 1 &&
      !spatial.includes(name) &&
      !isTimeCoordinate(name, attrs) &&
      verticalCoordinateScore(name, attrs) > 0
    );
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Supported volumes have one vertical axis and supported horizontal axes. */
export function isVolumeVariable(
  source: TDataSource,
  variable = "",
  sources: Record<string, TDataSource> = {}
) {
  if (source.hidden || !source.shape) {
    return false;
  }
  const shape = source.shape;
  const dimensions = dimensionNames(source);
  if (dimensions.length !== shape.length) {
    return false;
  }
  const spatial = volumeSpatialDimensions(dimensions);
  if (
    isProjectedXName(spatial.at(-1) ?? "") &&
    !projectedVolumeCRS(variable, sources)
  ) {
    return false;
  }
  if (
    spatial.length === 0 ||
    shape.slice(-spatial.length).some((size) => size < 1)
  ) {
    return false;
  }
  return (
    volumeVerticalDimension(dimensions, shape, variable, sources) !== undefined
  );
}

export function getVolumeVariables(modelInfo?: TModelInfo) {
  if (!modelInfo) {
    return [];
  }
  return Object.keys(modelInfo.vars)
    .filter((name) =>
      isVolumeVariable(modelInfo.vars[name], name, modelInfo.vars)
    )
    .sort((a, b) => a.localeCompare(b));
}

function variableGroup(name: string) {
  const slashIndex = name.lastIndexOf("/");
  return slashIndex < 0 ? "" : name.slice(0, slashIndex);
}

export function getVolumeVariablesForGroup(
  modelInfo: TModelInfo | undefined,
  selectedVariable: string
) {
  const selectedGroup = variableGroup(selectedVariable);
  const selected = modelInfo?.vars[selectedVariable];
  const spatial = selected
    ? volumeSpatialDimensions(dimensionNames(selected))
    : [];
  return getVolumeVariables(modelInfo).filter(
    (name) =>
      variableGroup(name) === selectedGroup &&
      volumeSpatialDimensions(dimensionNames(modelInfo!.vars[name])).join(
        "\0"
      ) === spatial.join("\0") &&
      projectedVolumeCRS(name, modelInfo!.vars) ===
        projectedVolumeCRS(selectedVariable, modelInfo!.vars)
  );
}

export function getVolumeUnavailableReason(
  modelInfo: TModelInfo | undefined,
  selectedVariable: string,
  gridType: T_GRID_TYPES | undefined,
  rendererAvailable: boolean
): string | undefined {
  if (!modelInfo) {
    return "Load a dataset to add a volume layer.";
  }
  if (!gridType) {
    return "Waiting for grid information.";
  }
  if (gridType === GRID_TYPES.ERROR) {
    return "The dataset's grid type could not be determined.";
  }
  const selected = modelInfo.vars[selectedVariable];
  const dimensions = selected ? dimensionNames(selected) : [];
  const projected =
    isProjectedYName(dimensions.at(-2) ?? "") &&
    isProjectedXName(dimensions.at(-1) ?? "");
  const rotated = gridType === GRID_TYPES.REGULAR_ROTATED;
  if (
    gridType !== GRID_TYPES.REGULAR &&
    gridType !== GRID_TYPES.HEALPIX &&
    !rotated &&
    !(gridType === GRID_TYPES.CURVILINEAR && projected)
  ) {
    return `Volume rendering is not supported for ${gridType.replaceAll("_", " ")} grids.`;
  }
  if (
    (projected || rotated) &&
    !projectedVolumeCRS(selectedVariable, modelInfo.vars)
  ) {
    return rotated
      ? "Volume rendering needs one-dimensional rotated axes and valid pole coordinates."
      : "Volume rendering needs one-dimensional x/y axes with Lambert or Mercator projection metadata.";
  }
  if (gridType === GRID_TYPES.REGULAR && dimensions.length > 0) {
    if (volumeSpatialDimensions(dimensions).length !== 2) {
      return "Volume rendering requires latitude and longitude axes.";
    }
  }
  if (getVolumeVariablesForGroup(modelInfo, selectedVariable).length === 0) {
    return "No compatible variable with a recognized vertical axis and at least two levels.";
  }
  if (!rendererAvailable) {
    return "Volume rendering is not ready for this grid yet.";
  }
  return undefined;
}

export function preferredVolumeVariable(variableNames: string[]) {
  for (const preferredName of ["clw", "cli"]) {
    const match = variableNames.find(
      (name) => name.slice(name.lastIndexOf("/") + 1) === preferredName
    );
    if (match) {
      return match;
    }
  }
  return variableNames[0];
}

export const DEFAULT_VOLUME_COLOR = "#ffffff";

export function volumeVariableOpacity() {
  return 0.75;
}

export function volumeVariablesAreCompatible(
  first: TDataSource,
  second: TDataSource
) {
  const firstDimensions = dimensionNames(first);
  const secondDimensions = dimensionNames(second);
  return (
    firstDimensions.length === secondDimensions.length &&
    firstDimensions.every(
      (dimension, index) => dimension === secondDimensions[index]
    ) &&
    first.shape?.length === second.shape?.length &&
    first.shape?.every((size, index) => size === second.shape?.[index]) === true
  );
}
