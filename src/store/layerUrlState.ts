import {
  COASTLINE_RESOLUTIONS,
  GRATICULE_SPACINGS,
  LAYER_KINDS,
  LAYER_OPACITY,
  type TCoastlineResolution,
  type TGraticuleSpacing,
  type TVolumeSelection,
} from "./store.ts";

import {
  DEFAULT_RGB_CHANNELS,
  RGB_GAMMA,
  type TRgbSettings,
} from "@/lib/data/rgbComposite.ts";
import {
  DEFAULT_BASEMAP,
  DEFAULT_BASEMAP_OPTIONS,
  type TBasemapOptions,
} from "@/utils/basemap.ts";

/* The `layers` URL parameter: layers top to bottom, separated by ";". Each
   layer is "<kind>,<field>,<field>,..." with a fixed field order per kind.
   Empty or missing fields fall back to the default. Variable names and
   basemap ids must not contain "," or ";". */

const DEFAULT_LAYERS_PARAM = "coastlines;grid";
const MAX_VOLUME_SELECTIONS = 4;
const DEFAULT_STREAMLINE_OPACITY = 0.55;
// Replaces the textured land/sea mask of legacy URLs.
const SATELLITE_BASEMAP = "versatiles-satellite";
// Modes of the removed land/sea mask in legacy URLs.
const LEGACY_MASK_MODES = {
  LAND: "land",
  SEA: "sea",
  GLOBE: "globe",
} as const;

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
    }
  | {
      kind: typeof LAYER_KINDS.RGB;
      visible: boolean;
      opacity: number;
      settings: TRgbSettings;
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

function parseOptionalNumber(value: string | undefined) {
  const number = Number(value);
  return value && Number.isFinite(number) ? number : undefined;
}

function parseChannel(value: string | undefined, fallback: number) {
  const channel = Number(value);
  return value && Number.isInteger(channel) && channel >= 0
    ? channel
    : fallback;
}

// fields: dimension, red, green, blue, low, high, gamma
function parseRgbSettings(fields: string[]): TRgbSettings {
  const [dimension, red, green, blue, low, high, gamma] = fields;
  const parsedGamma = parseOptionalNumber(gamma);
  return {
    dimension: dimension || undefined,
    channels: [
      parseChannel(red, DEFAULT_RGB_CHANNELS[0]),
      parseChannel(green, DEFAULT_RGB_CHANNELS[1]),
      parseChannel(blue, DEFAULT_RGB_CHANNELS[2]),
    ],
    low: parseOptionalNumber(low),
    high: parseOptionalNumber(high),
    gamma:
      parsedGamma !== undefined &&
      parsedGamma >= RGB_GAMMA.MIN &&
      parsedGamma <= RGB_GAMMA.MAX
        ? parsedGamma
        : RGB_GAMMA.DEFAULT,
  };
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
    case LAYER_KINDS.RGB:
      return {
        kind,
        visible,
        opacity: parseOpacity(f[1], LAYER_OPACITY.MAX),
        settings: parseRgbSettings(f.slice(2)),
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

function formatOptionalNumber(value: number | undefined) {
  return value === undefined ? "" : String(value);
}

function formatFields(entry: TLayerUrlEntry): string[] {
  switch (entry.kind) {
    case LAYER_KINDS.COASTLINES:
      return [formatFlag(entry.visible), entry.resolution];
    case LAYER_KINDS.GRATICULES:
      return [formatFlag(entry.visible), String(entry.spacing)];
    case LAYER_KINDS.GRID:
      return [formatFlag(entry.visible), formatOpacity(entry.opacity)];
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
    case LAYER_KINDS.RGB:
      return [
        formatFlag(entry.visible),
        formatOpacity(entry.opacity),
        entry.settings.dimension ?? "",
        ...entry.settings.channels.map(String),
        formatOptionalNumber(entry.settings.low),
        formatOptionalNumber(entry.settings.high),
        String(entry.settings.gamma),
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

/**
 * Translates the pre-`layers` land/sea mask parameters into "Maps and
 * Masks", in the old layer order: simple masks become the vector map,
 * textured ones the satellite imagery, without labels.
 */
export function legacyMaskToLayersParam(
  maskMode: string | undefined,
  useTexture: string | undefined
): string | undefined {
  const provider = useTexture === "true" ? SATELLITE_BASEMAP : DEFAULT_BASEMAP;
  const water = formatFlag(maskMode !== LEGACY_MASK_MODES.LAND);
  const land = formatFlag(maskMode !== LEGACY_MASK_MODES.SEA);
  const mask = `${LAYER_KINDS.BASEMAP},1,1,${provider},${water},${land},0`;
  if (maskMode === LEGACY_MASK_MODES.GLOBE) {
    return `coastlines;grid;${mask}`;
  }
  if (
    maskMode === LEGACY_MASK_MODES.LAND ||
    maskMode === LEGACY_MASK_MODES.SEA
  ) {
    return `coastlines;${mask};grid`;
  }
  return undefined;
}
