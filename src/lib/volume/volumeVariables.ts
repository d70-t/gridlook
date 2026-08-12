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

/** A supported volume has one vertical axis followed by a HEALPix cell axis. */
export function isHealpixVolumeVariable(source: TDataSource) {
  if (source.hidden || !source.shape) {
    return false;
  }
  const shape = source.shape;
  const dimensions = dimensionNames(source);
  if (dimensions.length !== shape.length) {
    return false;
  }
  const cellIndex = dimensions.indexOf("cell");
  if (cellIndex !== dimensions.length - 1 || shape[cellIndex] <= 1) {
    return false;
  }
  const verticalDimensions = dimensions.filter((name, index) =>
    Boolean(shape[index] > 1 && isVerticalDimensionName(name))
  );
  if (verticalDimensions.length !== 1) {
    return false;
  }
  return shape[dimensions.indexOf(verticalDimensions[0])] > 1;
}

export function getHealpixVolumeVariables(modelInfo?: TModelInfo) {
  if (!modelInfo) {
    return [];
  }
  return Object.keys(modelInfo.vars)
    .filter((name) => isHealpixVolumeVariable(modelInfo.vars[name]))
    .sort((a, b) => a.localeCompare(b));
}

function variableGroup(name: string) {
  const slashIndex = name.lastIndexOf("/");
  return slashIndex < 0 ? "" : name.slice(0, slashIndex);
}

export function getHealpixVolumeVariablesForGroup(
  modelInfo: TModelInfo | undefined,
  selectedVariable: string
) {
  const selectedGroup = variableGroup(selectedVariable);
  return getHealpixVolumeVariables(modelInfo).filter(
    (name) => variableGroup(name) === selectedGroup
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

export function volumeVariableColor(variableName: string, index = 0) {
  const basename = variableName.slice(variableName.lastIndexOf("/") + 1);
  if (basename === "clw") {
    return "#ffffff";
  }
  if (basename === "cli") {
    return "#72b7ff";
  }
  const palette = ["#ffcc80", "#c4a7ff", "#8de5a1", "#ff8fab"];
  return palette[index % palette.length];
}

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
