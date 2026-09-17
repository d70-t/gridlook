import {
  isLatitudeName,
  isLongitudeName,
} from "@/lib/data/coordinateVariables.ts";
import type { TDataSource, TModelInfo } from "@/lib/types/GlobeTypes.ts";

function dimensionNames(source: TDataSource) {
  const names =
    source.attrs?.dimensionNames ?? source.attrs?._ARRAY_DIMENSIONS ?? [];
  return Array.isArray(names) ? names.map(String) : [];
}

export function isVerticalDimensionName(name: string) {
  return /(^|_)(z|lev|level|plev|depth|height|altitude|pressure|sigma|hybrid)(_|$)/.test(
    name.toLowerCase()
  );
}

export function isTemporalDimensionName(name: string) {
  return /(^|_)(time|date)(_|$)/.test(name.toLowerCase());
}

export function volumeSpatialDimensions(dimensions: string[]) {
  if (dimensions.at(-1) === "cell") {
    return dimensions.slice(-1);
  }
  if (
    dimensions.length >= 2 &&
    isLatitudeName(dimensions.at(-2)!) &&
    isLongitudeName(dimensions.at(-1)!)
  ) {
    return dimensions.slice(-2);
  }
  return [];
}

/** Supported volumes have one vertical axis and geographic horizontal axes. */
export function isVolumeVariable(source: TDataSource) {
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
    spatial.length === 0 ||
    shape.slice(-spatial.length).some((size) => size < 1)
  ) {
    return false;
  }
  const verticalDimensions = dimensions.filter((name, index) =>
    Boolean(
      !spatial.includes(name) &&
      shape[index] > 1 &&
      isVerticalDimensionName(name)
    )
  );
  if (verticalDimensions.length !== 1) {
    return false;
  }
  return shape[dimensions.indexOf(verticalDimensions[0])] > 1;
}

export function getVolumeVariables(modelInfo?: TModelInfo) {
  if (!modelInfo) {
    return [];
  }
  return Object.keys(modelInfo.vars)
    .filter((name) => isVolumeVariable(modelInfo.vars[name]))
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
      ) === spatial.join("\0")
  );
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
