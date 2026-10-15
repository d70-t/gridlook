import {
  COASTLINE_RESOLUTIONS,
  GRATICULE_SPACINGS,
  LAYER_KINDS,
  LAYER_OPACITY,
  type TCoastlineResolution,
  type TGraticuleSpacing,
  type TVisibleLandSeaMaskMode,
  type TVolumeSelection,
} from "./store.ts";

import { LAND_SEA_MASK_MODES } from "@/lib/layers/landSeaMask.ts";
import {
  DEFAULT_BASEMAP_OPTIONS,
  type TBasemapOptions,
} from "@/utils/basemap.ts";

/* The `layers` URL parameter: layers top to bottom, separated by ";". Each
   layer is "<kind>,<field>,<field>,..." with a fixed field order per kind.
   Empty or missing fields fall back to the default. Variable names and
   basemap ids must not contain "," or ";". */

const MASK_STYLES = {
  SIMPLE: "simple",
  TEXTURED: "textured",
} as const;

const DEFAULT_LAYERS_PARAM = "coastlines;grid";
const MAX_VOLUME_SELECTIONS = 4;
const DEFAULT_STREAMLINE_OPACITY = 0.55;
const DEFAULT_BASEMAP = "osm";

export type TLayerUrlEntry =
  | {
      kind: typeof LAYER_KINDS.COASTLINES;
      visible: boolean;
      resolution: TCoastlineResolution;
    }
  | {
      kind: typeof LAYER_KINDS.GRATICULES;
      visible: boolean;
      spacing: TGraticuleSpacing;
    }
  | { kind: typeof LAYER_KINDS.GRID; visible: boolean; opacity: number }
  | {
      kind: typeof LAYER_KINDS.MASK;
      visible: boolean;
      opacity: number;
      mode: TVisibleLandSeaMaskMode;
      textured: boolean;
    }
  | {
      kind: typeof LAYER_KINDS.STREAMLINES;
      visible: boolean;
      opacity: number;
      // both undefined means the automatic pair
      u?: string;
      v?: string;
      magnitude: boolean;
    }
  | {
      kind: typeof LAYER_KINDS.VOLUME;
      visible: boolean;
      opacity: number;
      selections: TVolumeSelection[];
    }
  | {
      kind: typeof LAYER_KINDS.BASEMAP;
      visible: boolean;
      opacity: number;
      provider: string;
      options: TBasemapOptions;
    };

function parseFlag(value: string | undefined, fallback: boolean) {
  if (value === "1") {
    return true;
  }
  if (value === "0") {
    return false;
  }
  return fallback;
}

function parseOpacity(value: string | undefined, fallback: number) {
  const opacity = Number(value);
  if (
    !value ||
    !Number.isFinite(opacity) ||
    opacity < LAYER_OPACITY.MIN ||
    opacity > LAYER_OPACITY.MAX
  ) {
    return fallback;
  }
  return opacity;
}

function parseOneOf<T extends string | number>(
  value: T | undefined,
  allowed: Record<string, T>,
  fallback: T
): T {
  return Object.values(allowed).includes(value as T) ? (value as T) : fallback;
}

function parseVolumeSelections(fields: string[]): TVolumeSelection[] {
  const selections: TVolumeSelection[] = [];
  for (let i = 0; i + 1 < fields.length; i += 3) {
    const [variable, color, opacity] = fields.slice(i, i + 3);
    if (!variable || !/^[0-9a-f]{6}$/i.test(color)) {
      continue;
    }
    selections.push({
      variable,
      color: `#${color.toLowerCase()}`,
      opacity: parseOpacity(opacity, LAYER_OPACITY.MAX),
    });
  }
  return selections.slice(0, MAX_VOLUME_SELECTIONS);
}

// eslint-disable-next-line max-lines-per-function
function parseLayer(kind: string, f: string[]): TLayerUrlEntry | undefined {
  const visible = parseFlag(f[0], true);
  switch (kind) {
    case LAYER_KINDS.COASTLINES:
      return {
        kind,
        visible,
        resolution: parseOneOf(
          f[1] as TCoastlineResolution,
          COASTLINE_RESOLUTIONS,
          COASTLINE_RESOLUTIONS.FIFTY_M
        ),
      };
    case LAYER_KINDS.GRATICULES:
      return {
        kind,
        visible,
        spacing: parseOneOf(
          Number(f[1]) as TGraticuleSpacing,
          GRATICULE_SPACINGS,
          GRATICULE_SPACINGS.THIRTY_DEGREES
        ),
      };
    case LAYER_KINDS.GRID:
      return { kind, visible, opacity: parseOpacity(f[1], LAYER_OPACITY.MAX) };
    case LAYER_KINDS.MASK:
      return {
        kind,
        visible,
        opacity: parseOpacity(f[1], LAYER_OPACITY.MAX),
        mode: parseOneOf(
          f[2] as TVisibleLandSeaMaskMode,
          {
            LAND: LAND_SEA_MASK_MODES.LAND,
            SEA: LAND_SEA_MASK_MODES.SEA,
            GLOBE: LAND_SEA_MASK_MODES.GLOBE,
          },
          LAND_SEA_MASK_MODES.LAND
        ),
        textured: f[3] === MASK_STYLES.TEXTURED,
      };
    case LAYER_KINDS.STREAMLINES:
      return {
        kind,
        visible,
        opacity: parseOpacity(f[1], DEFAULT_STREAMLINE_OPACITY),
        u: f[2] || undefined,
        v: f[3] || undefined,
        magnitude: parseFlag(f[4], false),
      };
    case LAYER_KINDS.VOLUME:
      return {
        kind,
        visible,
        opacity: parseOpacity(f[1], LAYER_OPACITY.MAX),
        selections: parseVolumeSelections(f.slice(2)),
      };
    case LAYER_KINDS.BASEMAP:
      return {
        kind,
        visible,
        opacity: parseOpacity(f[1], LAYER_OPACITY.MAX),
        provider: f[2] || DEFAULT_BASEMAP,
        options: {
          water: parseFlag(f[3], DEFAULT_BASEMAP_OPTIONS.water),
          land: parseFlag(f[4], DEFAULT_BASEMAP_OPTIONS.land),
          labels: parseFlag(f[5], DEFAULT_BASEMAP_OPTIONS.labels),
        },
      };
    default:
      return undefined;
  }
}

/** A missing or empty parameter yields the default stack. */
export function parseLayersParam(value: string | undefined): TLayerUrlEntry[] {
  const entries: TLayerUrlEntry[] = [];
  for (const layer of (value || DEFAULT_LAYERS_PARAM).split(";")) {
    const [kind, ...fields] = layer.split(",");
    const entry = parseLayer(kind, fields);
    if (entry && !entries.some((existing) => existing.kind === entry.kind)) {
      entries.push(entry);
    }
  }
  // the data grid cannot be removed
  if (!entries.some((entry) => entry.kind === LAYER_KINDS.GRID)) {
    entries.push(parseLayer(LAYER_KINDS.GRID, [])!);
  }
  return entries;
}

function formatFlag(value: boolean) {
  return value ? "1" : "0";
}

function formatOpacity(value: number) {
  return String(Number(value.toFixed(2)));
}

function formatFields(entry: TLayerUrlEntry): string[] {
  switch (entry.kind) {
    case LAYER_KINDS.COASTLINES:
      return [formatFlag(entry.visible), entry.resolution];
    case LAYER_KINDS.GRATICULES:
      return [formatFlag(entry.visible), String(entry.spacing)];
    case LAYER_KINDS.GRID:
      return [formatFlag(entry.visible), formatOpacity(entry.opacity)];
    case LAYER_KINDS.MASK:
      return [
        formatFlag(entry.visible),
        formatOpacity(entry.opacity),
        entry.mode,
        entry.textured ? MASK_STYLES.TEXTURED : MASK_STYLES.SIMPLE,
      ];
    case LAYER_KINDS.STREAMLINES:
      return [
        formatFlag(entry.visible),
        formatOpacity(entry.opacity),
        entry.u ?? "",
        entry.v ?? "",
        formatFlag(entry.magnitude),
      ];
    case LAYER_KINDS.VOLUME:
      return [
        formatFlag(entry.visible),
        formatOpacity(entry.opacity),
        ...entry.selections.flatMap((selection) => [
          selection.variable,
          selection.color.replace(/^#/, "").toLowerCase(),
          formatOpacity(selection.opacity),
        ]),
      ];
    case LAYER_KINDS.BASEMAP:
      return [
        formatFlag(entry.visible),
        formatOpacity(entry.opacity),
        entry.provider,
        formatFlag(entry.options.water),
        formatFlag(entry.options.land),
        formatFlag(entry.options.labels),
      ];
  }
}

function formatLayer(entry: TLayerUrlEntry) {
  const fields = formatFields(entry);
  const defaults = formatFields(parseLayer(entry.kind, [])!);
  while (
    fields.length > 0 &&
    fields[fields.length - 1] === defaults[fields.length - 1]
  ) {
    fields.pop();
  }
  return [entry.kind, ...fields].join(",");
}

/** Returns "" for the default stack, so the parameter can be left out. */
export function formatLayersParam(entries: TLayerUrlEntry[]): string {
  const value = entries.map(formatLayer).join(";");
  return value === DEFAULT_LAYERS_PARAM ? "" : value;
}

/** Translates the pre-`layers` mask parameters, using the old layer order. */
export function legacyMaskToLayersParam(
  maskMode: string | undefined,
  useTexture: string | undefined
): string | undefined {
  const style =
    useTexture === "true" ? MASK_STYLES.TEXTURED : MASK_STYLES.SIMPLE;
  if (maskMode === LAND_SEA_MASK_MODES.GLOBE) {
    return `coastlines;grid;mask,1,1,${maskMode},${style}`;
  }
  if (
    maskMode === LAND_SEA_MASK_MODES.LAND ||
    maskMode === LAND_SEA_MASK_MODES.SEA
  ) {
    return `coastlines;mask,1,1,${maskMode},${style};grid`;
  }
  return undefined;
}
