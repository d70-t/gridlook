/* eslint-disable camelcase -- CF attribute and variable names are snake_case. */
/**
 * Scientific downloads of a computed plot result: one shared model of
 * dimensions, variables and attributes (CF conventions), written as Zarr v3
 * (one.zarr.zip) or NetCDF-4, plus the selection as GeoJSON. Writing needs no
 * source reads: everything comes from the result in memory.
 */
import { deflateSync, Zip, type ZipInputFile } from "fflate";
import * as zarr from "zarrita";

import { hasNoStoredCell, resultProvenance } from "./analysisExport.ts";
import { durationSeconds } from "./calendar.ts";
import {
  COUNTRY_ATLAS_VERSION,
  countriesName,
  getCountriesRings,
} from "./countryAtlas.ts";
import { idEncoding } from "./identifiers.ts";
import {
  DRAWING_SPHERE_RADIUS_METERS,
  interpolateArc,
  toLatLon,
  toVec,
  angleBetween,
  boxLonSpan,
  polygonContains,
  preparePolygon,
  type TLatLon,
} from "./sphere.ts";
import { rowsUntil } from "./timeRows.ts";
import {
  ANALYSIS_KINDS,
  GEOMETRY_KINDS,
  SAMPLE_STATUS,
  SECTION_MODES,
  type TAnalysisResult,
  type TGeometry,
  countryIds,
} from "./types.ts";
import { converter } from "./unitConvert.ts";

export type TExportAttr = string | number | number[];

type TExportArray = {
  name: string;
  dims: string[];
  /** `str`: text (a member's label), written as variable-length strings. */
  type: "f8" | "i4" | "i8" | "u8" | "str";
  data: Float64Array | Int32Array | BigInt64Array | BigUint64Array | string[];
  attrs: Record<string, TExportAttr>;
  /**
   * The native dimensions of a combined cell index, as names: its text
   * attribute is for readers.
   */
  indexDims?: string[];
};

export type TExportModel = {
  dims: [string, number][];
  arrays: TExportArray[];
  attrs: Record<string, TExportAttr>;
};

/** Status flags of every value: CF flag_values / flag_meanings. */
export const STATUS_FLAGS = {
  OK: 0,
  MISSING: 1,
  NOT_READ: 2,
  NO_STORED_CELL: 3,
} as const;

const STATUS_ATTRS = {
  long_name: "value status",
  flag_values: [0, 1, 2, 3],
  flag_meanings: "ok missing_value not_read no_stored_cell",
};

/** A file-safe name: letters, digits and underscores, not starting with a digit. */
function safeName(name: string) {
  const local = name.split("/").pop() || "value";
  const clean = local.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(clean) ? `v_${clean}` : clean;
}

/**
 * Dimensions every export may create itself. A source level dimension with
 * one of these names (`sample`, `time`, …) gets its own unique name first,
 * so two different axes never share a dimension.
 */
const OWN_DIMS = new Set([
  "sample",
  "time",
  "nv",
  "bin",
  "distance",
  "cell_rank",
  "lat",
  "lon",
]);

function levelDim(dimension: string) {
  const base = safeName(dimension);
  if (!OWN_DIMS.has(base)) {
    return base;
  }
  let name = `${base}_level`;
  for (let k = 2; OWN_DIMS.has(name); k++) {
    name = `${base}_level${k}`;
  }
  return name;
}

function f8(
  name: string,
  dims: string[],
  values: ArrayLike<number>,
  attrs: Record<string, TExportAttr> = {}
): TExportArray {
  return { name, dims, type: "f8", data: Float64Array.from(values), attrs };
}

function statusArray(
  name: string,
  dims: string[],
  codes: number[]
): TExportArray {
  return {
    name,
    dims,
    type: "i4",
    data: Int32Array.from(codes),
    attrs: { ...STATUS_ATTRS },
  };
}

function timeAttrs(result: TAnalysisResult) {
  const time = result.time!;
  return {
    standard_name: "time",
    ...(time.units ? { units: time.units } : {}),
    ...(time.calendar ? { calendar: time.calendar } : {}),
  };
}

/**
 * The source's cell methods, then the reduction applied here, in the order they
 * were applied (CF): a regional mean of daily maxima stays "time: maximum area:
 * mean", not "area: mean" alone.
 */
function composedMethods(result: TAnalysisResult, added?: TExportAttr) {
  const source = renamedMethods(
    result.cellMethods?.trim(),
    result.time?.dimension
  );
  const own = typeof added === "string" ? added.trim() : undefined;
  return source && own ? `${source} ${own}` : (own ?? source);
}

/**
 * The source's cell methods with its time axis under its exported name: `t:
 * maximum` describes `time` once `t` is written as `time`. Comments in
 * parentheses are left as they are.
 */
function renamedMethods(methods: string | undefined, dimension?: string) {
  if (!methods || !dimension || dimension === "time") {
    return methods;
  }
  return methods.replace(/\([^)]*\)|[^\s()]+/g, (token) =>
    token === `${dimension}:` ? "time:" : token
  );
}

function valueAttrs(
  result: TAnalysisResult,
  extra: Record<string, TExportAttr> = {}
) {
  const methods = composedMethods(result, extra.cell_methods);
  return {
    long_name: result.longName ?? result.query.variable,
    ...(result.units ? { units: result.units } : {}),
    // What the numbers are.
    ...(result.unitsMetadata ? { units_metadata: result.unitsMetadata } : {}),
    ...(result.standardName && result.kind !== ANALYSIS_KINDS.DISTRIBUTION
      ? { standard_name: result.standardName }
      : {}),
    gridlook_source_variable: result.query.variable,
    ...extra,
    ...(methods ? { cell_methods: methods } : {}),
  };
}

function verticalArray(result: TAnalysisResult, name: string): TExportArray {
  const v = result.vertical!;
  const n =
    result.kind === ANALYSIS_KINDS.TIME_DEPTH
      ? result.axis!.values.length
      : (result.shape[result.shape.length - 1] ?? 0);
  // The source's own model coordinate (a formula's sigma, never labelled
  // Pa or m) when the plot has no physical levels, and always for a formula
  // profile: its column's physical positions are an auxiliary coordinate.
  if (
    v.model?.values.length === n &&
    (!v.values.length || result.kind === ANALYSIS_KINDS.PROFILE)
  ) {
    return f8(name, [name], v.model.values, {
      long_name: v.model.label,
      axis: "Z",
      comment:
        "source model coordinate; the physical vertical position is in the auxiliary coordinate named in the field's coordinates attribute",
    });
  }
  const values = v.values.length
    ? v.values
    : Array.from({ length: n }, (_, k) => k);
  return f8(name, [name], values, {
    long_name: v.label,
    ...(v.physical && v.values.length && v.standardName
      ? { standard_name: v.standardName }
      : {}),
    ...(v.units && v.physical && v.values.length ? { units: v.units } : {}),
    ...(v.positive && v.values.length ? { positive: v.positive } : {}),
    ...(v.values.length ? {} : { comment: "model level index" }),
    axis: "Z",
  });
}

/** The physical vertical position of each value, from the formula. */
function physicalVertical(
  result: TAnalysisResult,
  name: string,
  dims: string[],
  positions = result.columnVertical!
): TExportArray {
  const v = result.vertical!;
  const pressure = /pa$/i.test(v.units ?? "");
  // The published computed_standard_name (or air_pressure for hybrid
  // pressure); a height's datum is never guessed, so none is written then.
  const standard = v.standardName ?? (pressure ? "air_pressure" : undefined);
  return f8(name, dims, positions, {
    ...(standard ? { standard_name: standard } : {}),
    long_name: `${pressure ? "pressure" : "vertical position"} of each value (from the vertical formula)`,
    ...(v.units ? { units: v.units } : {}),
    ...(v.positive ? { positive: v.positive } : {}),
  });
}

/** Status of each value: missing, not read (partial series) or ok. */
function rowStatus(result: TAnalysisResult, values: number[], rows: number) {
  const unreadFrom = result.partial
    ? rowsUntil(result.query.time, result.partial.readUntil)
    : Infinity;
  const per = rows ? values.length / rows : 1;
  // A point no stored cell holds (outside the grid, or absent from a
  // packed source): every read value is no_stored_cell.
  const noCell = !result.region && hasNoStoredCell(result);
  // A section stopped part way through its chunks: cell by cell.
  const chunks = result.partial?.chunks;
  return values.map((v, at) =>
    chunks
      ? !result.cellRead?.[at]
        ? STATUS_FLAGS.NOT_READ
        : Number.isNaN(v)
          ? STATUS_FLAGS.MISSING
          : STATUS_FLAGS.OK
      : Math.floor(at / per) >= unreadFrom
        ? STATUS_FLAGS.NOT_READ
        : noCell
          ? STATUS_FLAGS.NO_STORED_CELL
          : Number.isNaN(v)
            ? STATUS_FLAGS.MISSING
            : STATUS_FLAGS.OK
  );
}

/**
 * Each station's status: as its column says, but for a section stopped part
 * way, ok with any value arrived, not read while any cell is still to come.
 */
function stationStatus(result: TAnalysisResult) {
  const s = result.samples!;
  if (!result.partial?.chunks) {
    return s.status.map(sampleStatus);
  }
  const nk = Math.max(1, result.shape[1] ?? 1);
  return s.status.map((status, at) => {
    let [any, unread] = [false, false];
    for (let k = 0; k < nk; k++) {
      any ||= Number.isFinite(result.values[at * nk + k]);
      unread ||= !result.cellRead?.[at * nk + k];
    }
    return status === SAMPLE_STATUS.OUTSIDE
      ? sampleStatus(status)
      : any
        ? STATUS_FLAGS.OK
        : unread
          ? STATUS_FLAGS.NOT_READ
          : STATUS_FLAGS.MISSING;
  });
}

function sampleStatus(status: string) {
  return status === SAMPLE_STATUS.OK
    ? STATUS_FLAGS.OK
    : status === SAMPLE_STATUS.OUTSIDE
      ? STATUS_FLAGS.NO_STORED_CELL
      : STATUS_FLAGS.MISSING;
}

/**
 * Structured positions from an id written by an older version: "123",
 * "4,5" or "dim=7, other=2" (names may hold digits, e.g. n2d=7).
 */
function parseCellId(id: string): { dims?: string[]; values: string[] } {
  const named = [...id.matchAll(/([A-Za-z_]\w*)=(-?\d+)/g)];
  if (named.length) {
    return { dims: named.map((m) => m[1]), values: named.map((m) => m[2]) };
  }
  return {
    values: /^\s*-?\d+(\s*,\s*-?\d+)*\s*$/.test(id)
      ? id.split(/\s*,\s*/).map((v) => v.trim())
      : [],
  };
}

/**
 * Exact cell positions as int64 columns, one per index dimension, from the
 * locator's structured index (HEALPix ids above 2^53 stay exact). −1 marks
 * a sample without a stored cell; no fill attribute is written, so default
 * readers keep the column as integers.
 */
function cellIndex(
  rows: string[][],
  dimNames: string[],
  dim: string
): TExportArray[] {
  const rank = dimNames.length || Math.max(0, ...rows.map((r) => r.length));
  if (!rank) {
    return [];
  }
  const data = new BigInt64Array(rows.length * rank).fill(-1n);
  rows.forEach((row, at) => {
    if (row.length === rank) {
      row.forEach((value, k) => (data[at * rank + k] = BigInt(value)));
    }
  });
  return [
    {
      name: "cell_index",
      dims: rank > 1 ? [dim, "cell_rank"] : [dim],
      type: "i8",
      data,
      ...(dimNames.length ? { indexDims: dimNames } : {}),
      attrs: {
        long_name: "native index of the sampled cell (-1: none)",
        ...(dimNames.length
          ? { gridlook_index_dimensions: dimNames.join(" ") }
          : {}),
      },
    },
  ];
}

/** Rows and dimension names of a result's sample or cell positions. */
function indexRows(
  index: { dims: string[]; values: string[][] } | undefined,
  ids: string[]
) {
  if (index) {
    return { rows: index.values, dims: index.dims };
  }
  const parsed = ids.map(parseCellId);
  return {
    rows: parsed.map((p) => p.values),
    dims: parsed.find((p) => p.dims)?.dims ?? [],
  };
}

function scalarTime(result: TAnalysisResult): TExportArray[] {
  return result.time && result.time.raw.length === 1
    ? [f8("time", [], result.time.raw, timeAttrs(result))]
    : [];
}

function pointArrays(result: TAnalysisResult): TExportArray[] {
  const cell = result.cell;
  if (!cell) {
    return [];
  }
  // Outside the grid: the requested position, so `coordinates="lat lon"`
  // never names variables the file lacks; its rows are no_stored_cell.
  if (!cell.id) {
    return [
      f8("lat", [], [cell.lat], {
        standard_name: "latitude",
        units: "degrees_north",
        comment: "requested position; no stored cell contains it",
      }),
      f8("lon", [], [cell.lon], {
        standard_name: "longitude",
        units: "degrees_east",
        comment: "requested position; no stored cell contains it",
      }),
    ];
  }
  return [
    f8("lat", [], [cell.lat], {
      standard_name: "latitude",
      units: "degrees_north",
      comment: cell.selection,
    }),
    f8("lon", [], [cell.lon], {
      standard_name: "longitude",
      units: "degrees_east",
    }),
    ...(() => {
      const { rows, dims } = indexRows(
        cell.index && { dims: cell.index.dims, values: [cell.index.values] },
        [cell.id]
      );
      return cellIndex(rows, dims, "cell").map((a) => ({
        ...a,
        dims: a.dims.slice(1),
      }));
    })(),
  ];
}

// eslint-disable-next-line max-lines-per-function
function shapeArrays(
  result: TAnalysisResult,
  name: string
): { dims: [string, number][]; arrays: TExportArray[] } {
  const values = result.values;
  if (result.histogram) {
    const h = result.histogram;
    const nb = values.length;
    return {
      dims: [
        ["bin", nb],
        ["nv", 2],
      ],
      arrays: [
        f8(
          "value_bin",
          ["bin"],
          h.edges.slice(0, -1).map((e, at) => midpoint(e, h.edges[at + 1])),
          {
            long_name: `${result.longName ?? name} bin centre`,
            ...(result.units ? { units: result.units } : {}),
            // A bin of temperature differences stays one.
            ...(result.unitsMetadata
              ? { units_metadata: result.unitsMetadata }
              : {}),
            bounds: "value_bin_bounds",
          }
        ),
        f8(
          "value_bin_bounds",
          ["bin", "nv"],
          h.edges.slice(0, -1).flatMap((e, at) => [e, h.edges[at + 1]])
        ),
        f8("area_fraction", ["bin"], values, {
          long_name: "fraction of the valid selected area in each value bin",
          units: "1",
          // Scalar time (and the fixed level, added later) attach here.
          coordinates: `value_bin${scalarTime(result).length ? " time" : ""}`,
          gridlook_source_variable: result.query.variable,
          gridlook_weighting: h.weighting,
          gridlook_valid_fraction: h.validFraction,
          gridlook_valid_cells: h.validCells,
          gridlook_selected_cells: h.selectedCells,
          gridlook_area_mean: h.mean,
          ...(h.summary
            ? {
                gridlook_area_std: h.summary.std,
                gridlook_area_skewness: h.summary.skewness,
                gridlook_area_percentiles: "0 to 100 in steps of 0.5",
                gridlook_area_percentile_values: h.summary.percentiles,
              }
            : {}),
        }),
        ...scalarTime(result),
      ],
    };
  }
  if (
    result.kind === ANALYSIS_KINDS.LAT_VERTICAL ||
    result.kind === ANALYSIS_KINDS.LON_VERTICAL
  ) {
    return latitudeVerticalArrays(result, name);
  }
  if (result.axis && result.time) {
    return gridArrays(result, name);
  }
  if (result.samples) {
    const s = result.samples;
    const ns = s.distances.length;
    const sample = [
      f8("distance", ["sample"], s.distances, {
        long_name: "distance along the path from A",
        units: "m",
      }),
      f8("lat", ["sample"], s.lats, {
        standard_name: "latitude",
        units: "degrees_north",
      }),
      f8("lon", ["sample"], s.lons, {
        standard_name: "longitude",
        units: "degrees_east",
      }),
      statusArray("sample_status", ["sample"], stationStatus(result)),
      ...(() => {
        const { rows, dims } = indexRows(s.index, s.cells);
        return cellIndex(rows, dims, "sample");
      })(),
    ];
    if (result.sectionMode === SECTION_MODES.PATH) {
      return {
        dims: [["sample", ns]],
        arrays: [
          ...sample,
          f8(
            name,
            ["sample"],
            values,
            valueAttrs(result, {
              coordinates: `lat lon distance${scalarTime(result).length ? " time" : ""}`,
            })
          ),
          // The same reason as `sample_status`: no stored cell is not a
          // missing value.
          statusArray(
            "status",
            ["sample"],
            values.map((value, at) =>
              Number.isNaN(value)
                ? sampleStatus(s.status[at]) || STATUS_FLAGS.MISSING
                : STATUS_FLAGS.OK
            )
          ),
          ...scalarTime(result),
        ],
      };
    }
    const v = result.vertical!;
    const nk = result.shape[1];
    const level = levelDim(v.dimension);
    return {
      dims: [
        ["sample", ns],
        [level, nk],
      ],
      arrays: [
        ...sample,
        verticalArray(result, level),
        ...(result.columnVertical
          ? [physicalVertical(result, `${level}_position`, ["sample", level])]
          : []),
        f8(
          name,
          ["sample", level],
          values,
          valueAttrs(result, {
            coordinates: `lat lon distance${result.columnVertical ? ` ${level}_position` : ""}${scalarTime(result).length ? " time" : ""}`,
          })
        ),
        statusArray(
          "status",
          ["sample", level],
          // A section stopped part way: cell by cell, unread as such, a column
          // read in part not missing as a whole. A station outside the grid
          // has no stored cell whatever was read: known before any read.
          values.map((value, at) =>
            s.status[Math.floor(at / nk)] === SAMPLE_STATUS.OUTSIDE
              ? STATUS_FLAGS.NO_STORED_CELL
              : result.partial?.chunks && !result.cellRead?.[at]
                ? STATUS_FLAGS.NOT_READ
                : Number.isNaN(value)
                  ? result.partial?.chunks
                    ? STATUS_FLAGS.MISSING
                    : sampleStatus(s.status[Math.floor(at / nk)]) ||
                      STATUS_FLAGS.MISSING
                  : STATUS_FLAGS.OK
          )
        ),
        ...scalarTime(result),
      ],
    };
  }
  if (result.kind === ANALYSIS_KINDS.PROFILE && result.vertical) {
    const level = levelDim(result.vertical.dimension);
    const v = result.vertical;
    // A formula profile: the column's physical positions are an auxiliary
    // coordinate beside the source model levels (never in their place).
    const positions =
      result.columnVertical ??
      (v.model &&
      v.physical &&
      v.model.values.length === values.length &&
      v.values.length === values.length
        ? v.values
        : undefined);
    const point = pointArrays(result);
    const time = scalarTime(result);
    const position = positions
      ? [physicalVertical(result, `${level}_position`, [level], positions)]
      : [];
    return {
      dims: [[level, values.length]],
      arrays: [
        verticalArray(result, level),
        ...position,
        f8(
          name,
          [level],
          values,
          valueAttrs(result, {
            coordinates: [...point, ...position, ...time]
              .map((a) => a.name)
              .join(" "),
          })
        ),
        statusArray("status", [level], rowStatus(result, values, 0)),
        ...point,
        ...time,
      ],
    };
  }
  // Time series: point or area mean.
  const nt = values.length;
  const region = result.region;
  return {
    dims: [["time", nt]],
    arrays: [
      f8("time", ["time"], result.time?.raw ?? [], timeAttrs(result)),
      f8(
        name,
        ["time"],
        values,
        valueAttrs(
          result,
          // A mean of sites is no area mean: no CF area method; the weighting
          // says what it is.
          region?.sites
            ? { gridlook_weighting: region.weighting }
            : region
              ? {
                  cell_methods: "area: mean (weighted)",
                  gridlook_weighting: region.weighting,
                }
              : {
                  coordinates: `lat lon${result.cell?.id ? " cell_index" : ""}`,
                }
        )
      ),
      statusArray("status", ["time"], rowStatus(result, values, nt)),
      ...(region
        ? [
            region.sites
              ? f8("valid_site_fraction", ["time"], region.coverage, {
                  long_name:
                    "fraction of the selected sites with a valid value",
                  units: "1",
                })
              : f8("valid_area_fraction", ["time"], region.coverage, {
                  long_name: "fraction of the selected area with a valid value",
                  units: "1",
                }),
            {
              name: "valid_cells",
              dims: ["time"],
              type: "i8" as const,
              // Times not read have no count: −1, flagged by `status`.
              data: BigInt64Array.from(region.validCells, (n) =>
                Number.isFinite(n) ? BigInt(n) : -1n
              ),
              attrs: {
                long_name: `${region.sites ? "sites" : "cells"} with a valid value (-1: not read)`,
              },
            },
            ...spreadArrays(result, name),
          ]
        : pointArrays(result)),
    ],
  };
}

/** The area's spread per time: weighted standard deviation, min and max. */
function spreadArrays(result: TAnalysisResult, name: string) {
  const spread = result.region?.spread;
  if (!spread) {
    return [];
  }
  const units: Record<string, TExportAttr> = result.units
    ? { units: result.units }
    : {};
  // The extrema are values of the quantity (its own units_metadata); a standard
  // deviation of a temperature is a temperature difference.
  const own: Record<string, TExportAttr> = result.unitsMetadata
    ? { units_metadata: result.unitsMetadata }
    : {};
  const spreadMeta: Record<string, TExportAttr> = converter(result.units, "K")
    ? { units_metadata: "temperature: difference" }
    : own;
  // Sites are counted once each: no CF area method, said in words.
  const sites = Boolean(result.region?.sites);
  const methods = (added: string): Record<string, TExportAttr> => {
    const composed = composedMethods(result, sites ? undefined : added);
    return composed ? { cell_methods: composed } : {};
  };
  const where = sites ? "among the selected sites" : "in the area";
  const of = result.longName ?? result.query.variable;
  return [
    f8(`${name}_std`, ["time"], spread.std, {
      long_name: sites
        ? `standard deviation of ${of} among the selected sites (equal weights)`
        : `area-weighted standard deviation of ${of}`,
      ...units,
      ...spreadMeta,
      ...methods("area: standard_deviation (weighted)"),
    }),
    f8(`${name}_min`, ["time"], spread.min, {
      long_name: `smallest valid value of ${of} ${where}`,
      ...units,
      ...own,
      ...methods("area: minimum"),
    }),
    f8(`${name}_max`, ["time"], spread.max, {
      long_name: `largest valid value of ${of} ${where}`,
      ...units,
      ...own,
      ...methods("area: maximum"),
    }),
  ];
}

/** CF cell bounds of bin centres (`[n, 2]`), when the result has edges. */
function binBounds(axisName: string, edges: number[] | undefined, n: number) {
  return edges?.length === n + 1
    ? [
        f8(
          `${axisName}_bnds`,
          [axisName, "nv"],
          Array.from({ length: n }, (_, b) => [edges[b], edges[b + 1]]).flat()
        ),
      ]
    : [];
}

/**
 * Latitude (or longitude) × vertical at one time: [lat, level] or
 * [lon, level], with bin bounds; the other horizontal axis averaged.
 */
function latitudeVerticalArrays(result: TAnalysisResult, name: string) {
  const axis = result.axis!;
  const [nb, nk] = result.shape;
  const level = levelDim(result.vertical?.dimension ?? "level");
  const lonAxis = axis.dimension === "longitude";
  const a = lonAxis ? "lon" : "lat";
  const bounds = binBounds(a, axis.bounds, nb);
  return {
    dims: [[a, nb], [level, nk], ...(bounds.length ? [["nv", 2]] : [])] as [
      string,
      number,
    ][],
    arrays: [
      f8(a, [a], axis.values, {
        standard_name: lonAxis ? "longitude" : "latitude",
        units: lonAxis ? "degrees_east" : "degrees_north",
        comment: "bin centres",
        ...(bounds.length ? { bounds: `${a}_bnds` } : {}),
      }),
      ...bounds,
      verticalArray(result, level),
      ...scalarTime(result),
      f8(
        name,
        [a, level],
        result.values,
        valueAttrs(result, {
          cell_methods: `${lonAxis ? "latitude" : "longitude"}: mean (area-weighted)`,
          gridlook_reduction: axis.reduction,
          ...(scalarTime(result).length ? { coordinates: "time" } : {}),
        })
      ),
      statusArray(
        "status",
        [a, level],
        result.values.map((v) =>
          Number.isNaN(v) ? STATUS_FLAGS.MISSING : STATUS_FLAGS.OK
        )
      ),
      ...(result.cellCoverage
        ? [
            f8("valid_area_fraction", [a, level], result.cellCoverage, {
              long_name: "fraction of each bin's area with a valid value",
              units: "1",
            }),
          ]
        : []),
    ],
  };
}

/** Time × axis results: time–depth and the Hovmöller family. */
// eslint-disable-next-line max-lines-per-function
function gridArrays(result: TAnalysisResult, name: string) {
  const axis = result.axis!;
  const nt = result.time!.raw.length;
  const n = axis.values.length;
  const axisName =
    result.kind === ANALYSIS_KINDS.TIME_DEPTH
      ? levelDim(result.vertical?.dimension ?? "level")
      : result.kind === ANALYSIS_KINDS.HOVMOLLER_LON
        ? "lon"
        : result.kind === ANALYSIS_KINDS.HOVMOLLER_LAT
          ? "lat"
          : "distance";
  const axisArray =
    result.kind === ANALYSIS_KINDS.TIME_DEPTH && result.vertical
      ? verticalArray(result, axisName)
      : f8(axisName, [axisName], axis.values, {
          ...((axisName === "lat" || axisName === "lon") &&
          axis.bounds?.length === n + 1
            ? { bounds: `${axisName}_bnds` }
            : {}),
          ...(axisName === "lon"
            ? {
                standard_name: "longitude",
                units: "degrees_east",
                comment:
                  "bin centres, continuous eastwards from the band's west edge",
              }
            : {}),
          ...(axisName === "lat"
            ? {
                standard_name: "latitude",
                units: "degrees_north",
                comment: "bin centres",
              }
            : {}),
          ...(axisName === "distance"
            ? { long_name: "distance along the path from A", units: "m" }
            : {}),
        });
  const s = result.samples;
  const path =
    axisName === "distance" && s
      ? [
          f8("lat", ["distance"], s.lats, {
            standard_name: "latitude",
            units: "degrees_north",
          }),
          f8("lon", ["distance"], s.lons, {
            standard_name: "longitude",
            units: "degrees_east",
          }),
          statusArray(
            "sample_status",
            ["distance"],
            s.status.map(sampleStatus)
          ),
          // The source cell of each sample, as on a cross-section.
          ...(() => {
            const { rows, dims } = indexRows(s.index, s.cells);
            return cellIndex(rows, dims, "distance");
          })(),
        ]
      : [];
  // A time–depth column's place and native cell, attached to the field.
  const point =
    result.kind === ANALYSIS_KINDS.TIME_DEPTH ? pointArrays(result) : [];
  const bounds =
    axisName === "lat" || axisName === "lon"
      ? binBounds(axisName, axis.bounds, n)
      : [];
  return {
    dims: [
      ["time", nt],
      [axisName, n],
      ...(bounds.length ? [["nv", 2]] : []),
    ] as [string, number][],
    arrays: [
      f8("time", ["time"], result.time!.raw, timeAttrs(result)),
      axisArray,
      ...bounds,
      ...path,
      ...point,
      f8(
        name,
        ["time", axisName],
        result.values,
        valueAttrs(result, {
          // The band mean, after the source's own methods.
          ...(axisName === "lon" || axisName === "lat"
            ? {
                cell_methods: `${axisName === "lon" ? "latitude" : "longitude"}: mean (area-weighted)`,
              }
            : {}),
          gridlook_reduction: axis.reduction,
          ...(path.length || point.length
            ? {
                coordinates: [...path, ...point]
                  .map((a) => a.name)
                  .filter((a) => /^(lat|lon|cell_index)$/.test(a))
                  .join(" "),
              }
            : {}),
        })
      ),
      statusArray(
        "status",
        ["time", axisName],
        // A sample outside the grid is "no stored cell" at every time, read
        // yet or not; a missing value elsewhere has its sample's reason.
        rowStatus(result, result.values, nt).map((code, at) =>
          s && axisName === "distance"
            ? s.status[at % n] === SAMPLE_STATUS.OUTSIDE
              ? STATUS_FLAGS.NO_STORED_CELL
              : code === STATUS_FLAGS.MISSING
                ? sampleStatus(s.status[at % n]) || STATUS_FLAGS.MISSING
                : code
            : code
        )
      ),
      ...(result.cellCoverage
        ? [
            f8("valid_area_fraction", ["time", axisName], result.cellCoverage, {
              long_name: "fraction of each bin's area with a valid value",
              units: "1",
            }),
          ]
        : []),
    ],
  };
}

/**
 * Refuse a model whose arrays do not fit their dimensions, before any file
 * is written: each array holds exactly the product of its dimension sizes,
 * no dimension is repeated within an array, and a dimension has one size.
 */
function checkShapes(dims: [string, number][], arrays: TExportArray[]) {
  const sizes = new Map<string, number>();
  for (const [name, size] of dims) {
    if (sizes.has(name) && sizes.get(name) !== size) {
      throw new Error(`Export dimension ${name} has two sizes.`);
    }
    sizes.set(name, size);
  }
  for (const array of arrays) {
    if (new Set(array.dims).size !== array.dims.length) {
      throw new Error(
        `Export array ${array.name} repeats a dimension (${array.dims.join(", ")}).`
      );
    }
    const expected = array.dims.reduce(
      (product, dim) => product * (sizes.get(dim) ?? Number.NaN),
      1
    );
    if (expected !== array.data.length) {
      throw new Error(
        `Export array ${array.name} (${array.dims.join(", ")}) holds ${array.data.length} values, not ${expected}.`
      );
    }
  }
}

/** Sizes of dimensions only arrays name (such as `cell_rank`). */
function completeDims(dims: [string, number][], arrays: TExportArray[]) {
  const sizes = new Map(dims);
  for (const array of arrays) {
    const unknown = array.dims.filter((dim) => !sizes.has(dim));
    if (unknown.length === 1) {
      const known = array.dims.reduce((p, dim) => p * (sizes.get(dim) ?? 1), 1);
      sizes.set(unknown[0], array.data.length / known);
      dims.push([unknown[0], array.data.length / known]);
    }
  }
  return dims;
}

/**
 * Arrays under unique names: a source variable called `status`, `time`,
 * `lat` or `z` must not share a name with an auxiliary array or a
 * dimension, so the value array takes a suffix until it is unique.
 */
function withoutCollisions(result: TAnalysisResult, base: string) {
  for (let k = 0; ; k++) {
    const name = k === 0 ? base : `${base}_value${k > 1 ? k : ""}`;
    const shaped = shapeArrays(result, name);
    const names = shaped.arrays.map((array) => array.name);
    const dims = new Set(shaped.arrays.flatMap((array) => array.dims));
    // The value array's name is free (other clashes, such as a source
    // dimension named `status`, are renamed by uniqueNames).
    if (names.filter((n) => n === name).length <= 1 && !dims.has(name)) {
      return shaped;
    }
    if (k > 8) {
      throw new Error(
        `No unique export name for ${base}: ${names.join(" ")} / ${[...dims].join(" ")}.`
      );
    }
  }
}

/** The array holding the plotted values. */
function valueArray(arrays: TExportArray[]) {
  return arrays.find((a) => a.attrs.gridlook_source_variable !== undefined);
}

function addCoordinate(array: TExportArray | undefined, name: string) {
  if (!array) {
    return;
  }
  const listed = String(array.attrs.coordinates ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (!listed.includes(name)) {
    array.attrs = {
      ...array.attrs,
      coordinates: [...listed, name].join(" "),
    };
  }
}

/** Halfway between two finite numbers without overflow (1e308 and 1.7e308). */
function midpoint(a: number, b: number) {
  return Math.sign(a) === Math.sign(b) ? a + (b - a) / 2 : (a + b) / 2;
}

/** `base`, or `base_1`, `base_2`, …: a name no array has yet. */
function freeName(arrays: TExportArray[], base: string) {
  let name = base;
  for (let k = 1; arrays.some((a) => a.name === name); k++) {
    name = `${base}_${k}`;
  }
  return name;
}

/** CF time bounds, from the source's own, on the time coordinate. */
/** Seconds in one unit of a time span ("seconds", "h", "days since …"). */

/**
 * A time axis of forecast reference times is no valid time. With one forecast
 * period fixed, `time` becomes the valid time, reference time plus period,
 * beside an auxiliary `forecast_reference_time` and the scalar
 * `forecast_period` (CF); without it, the axis keeps the reference times under
 * their own standard name.
 */
// eslint-disable-next-line max-lines-per-function
function withForecastTimes(result: TAnalysisResult, arrays: TExportArray[]) {
  if (result.time?.standardName !== "forecast_reference_time") {
    return arrays;
  }
  const time = arrays.find(
    (a) => a.name === "time" && a.attrs.standard_name === "time"
  );
  if (!time) {
    return arrays;
  }
  const period = result.selections?.find(
    (s) => s.standardName === "forecast_period" && s.value !== undefined
  );
  // Every fixed-length CF unit, as the calendar reads them.
  const perUnit = durationSeconds(result.time.units);
  const lead = period?.seconds ?? durationSeconds(period?.units);
  const reference: TExportArray = {
    ...time,
    name: freeName(arrays, "forecast_reference_time"),
    data: Float64Array.from(time.data as Float64Array),
    attrs: {
      ...time.attrs,
      standard_name: "forecast_reference_time",
      long_name: "forecast reference time (initialization)",
    },
  };
  delete reference.attrs.bounds;
  // Valid times the source publishes beside its reference times: `time` is
  // those, the reference times beside it.
  const published = result.time.valid;
  if (!period && published?.length === time.data.length) {
    const cells = time.attrs.bounds;
    time.data = Float64Array.from(published);
    time.attrs = {
      ...time.attrs,
      long_name: "valid time (as published by the source)",
    };
    delete time.attrs.bounds;
    const value = valueArray(arrays);
    if (value) {
      addCoordinate(value, reference.name);
    }
    // Reference-time cells are no valid-time cells; the valid times' own
    // published cells are.
    const kept = arrays.filter((a) => a.name !== cells);
    const own = result.time.validBounds;
    if (own?.length === 2 * time.data.length) {
      const name = freeName(kept, "time_bnds");
      time.attrs = { ...time.attrs, bounds: name };
      kept.push(f8(name, [...time.dims, "nv"], own));
    }
    return [...kept, reference];
  }
  if (!period || !perUnit || !lead) {
    time.attrs = {
      ...time.attrs,
      standard_name: "forecast_reference_time",
      long_name:
        "forecast reference time; the valid time is not known (no single forecast period, or its units are not a duration)",
    };
    return arrays;
  }
  const shift = (period.value! * lead) / perUnit;
  const valid = Float64Array.from(time.data as Float64Array, (v) => v + shift);
  time.data = valid;
  time.attrs = {
    ...time.attrs,
    long_name: "valid time (forecast reference time + forecast period)",
  };
  // An accumulation over its lead interval keeps that interval: the 24–48 h
  // total of a run is from reference + 24 h to reference + 48 h, not an instant
  // at 48 h.
  const interval = period.valueBounds;
  const bounds = arrays.find((a) => a.name === time.attrs.bounds);
  const source = time.data as Float64Array;
  const shifted = interval
    ? Float64Array.from({ length: 2 * source.length }, (_, k) => {
        const reference = source[k >> 1] - shift;
        return reference + (interval[k & 1] * lead) / perUnit;
      })
    : undefined;
  if (bounds) {
    bounds.data =
      shifted ??
      Float64Array.from(bounds.data as Float64Array, (v) => v + shift);
  } else if (shifted) {
    const name = freeName(arrays, "time_bnds");
    time.attrs = { ...time.attrs, bounds: name };
    arrays = [...arrays, f8(name, [...time.dims, "nv"], shifted)];
  }
  const value = valueArray(arrays);
  if (value) {
    addCoordinate(value, reference.name);
  }
  return [...arrays, reference];
}

/**
 * A valid-time axis initialized at one reference time: that time as a scalar
 * `forecast_reference_time`.
 */
function withReferenceTime(result: TAnalysisResult, arrays: TExportArray[]) {
  const reference = result.referenceTime;
  const rows = result.time?.references;
  const time = arrays.find(
    (a) => a.name === "time" && a.attrs.standard_name === "time"
  );
  // One per valid time, along it.
  if (!reference && rows && time && rows.length === time.data.length) {
    const name = freeName(arrays, "forecast_reference_time");
    const value = valueArray(arrays);
    if (value) {
      addCoordinate(value, name);
    }
    return [
      ...arrays,
      f8(name, [...time.dims], rows, {
        standard_name: "forecast_reference_time",
        long_name:
          "forecast reference time (initialization) of each valid time",
        units: result.time!.units ?? "",
        ...(result.time!.calendar ? { calendar: result.time!.calendar } : {}),
      }),
    ];
  }
  if (!reference) {
    return arrays;
  }
  const name = freeName(arrays, "forecast_reference_time");
  const value = valueArray(arrays);
  if (value) {
    addCoordinate(value, name);
  }
  return [
    ...arrays,
    f8(name, [], [reference.value], {
      standard_name: "forecast_reference_time",
      long_name: "forecast reference time (initialization)",
      units: reference.units,
      ...(reference.calendar ? { calendar: reference.calendar } : {}),
    }),
  ];
}

function withTimeBounds(result: TAnalysisResult, arrays: TExportArray[]) {
  const bounds = result.time?.bounds;
  const time = arrays.find(
    (a) => a.name === "time" && a.attrs.standard_name === "time"
  );
  if (!time || !bounds || bounds.length !== 2 * time.data.length) {
    return arrays;
  }
  const name = freeName(arrays, "time_bnds");
  time.attrs = { ...time.attrs, bounds: name };
  return [...arrays, f8(name, [...time.dims, "nv"], bounds)];
}

/**
 * The fixed level of a horizontal result as a scalar coordinate: a series
 * taken at 50 m says so in the file, not only in a note.
 */
function withFixedLevel(result: TAnalysisResult, arrays: TExportArray[]) {
  const level = result.fixedLevel;
  if (!level) {
    return arrays;
  }
  // A name no other array or dimension holds, chosen before the field refers to
  // it.
  const base = safeName(level.dimension);
  let name = base;
  for (
    let k = 1;
    arrays.some((a) => a.name === name || a.dims.includes(name));
    k++
  ) {
    name = `${base}_${k}`;
  }
  const physical = level.value !== undefined;
  const scalar = f8(name, [], [physical ? level.value! : level.index], {
    long_name: physical
      ? `${level.dimension} of the selected level`
      : `model level index of ${level.dimension}`,
    axis: "Z",
    gridlook_level_index: level.index,
    ...(physical && level.units ? { units: level.units } : {}),
    ...(physical && level.positive ? { positive: level.positive } : {}),
    ...(physical && level.standardName
      ? { standard_name: level.standardName }
      : {}),
  });
  addCoordinate(valueArray(arrays), name);
  if (!physical || !level.bounds) {
    return [...arrays, scalar];
  }
  const boundsName = freeName([...arrays, scalar], `${name}_bnds`);
  scalar.attrs = { ...scalar.attrs, bounds: boundsName };
  return [...arrays, scalar, f8(boundsName, ["nv"], level.bounds)];
}

/**
 * Times stored out of order cannot be a CF coordinate variable (which is
 * monotonic): the values are then along an observation dimension `obs`, time an
 * auxiliary coordinate of it. Renames in place; returns the dimensions.
 */
function observedTime(dims: [string, number][], arrays: TExportArray[]) {
  const time = arrays.find(
    (a) => a.name === "time" && a.dims.length === 1 && a.dims[0] === "time"
  );
  return observedAxis(dims, arrays, time, "obs");
}

/**
 * The same for the vertical axis: depths [0, 20, 10, 30] or [0, missing, 10,
 * 30] are no coordinate variable either, so its values are an auxiliary
 * coordinate on an observation dimension, under their own name.
 */
function observedLevels(dims: [string, number][], arrays: TExportArray[]) {
  const levels = arrays.find(
    (a) =>
      a.attrs.axis === "Z" &&
      a.dims.length === 1 &&
      a.dims[0] === a.name &&
      a.type === "f8"
  );
  return observedAxis(dims, arrays, levels, `${levels?.name ?? "z"}_obs`);
}

function observedAxis(
  dims: [string, number][],
  arrays: TExportArray[],
  axis: TExportArray | undefined,
  base: string
) {
  const raw = axis ? Array.from(axis.data as ArrayLike<number>) : [];
  // Every value known and strictly ordered: a coordinate variable. A missing
  // value is no coordinate value.
  const known = raw.every(Number.isFinite);
  const rising = known && raw.every((v, at) => at === 0 || v > raw[at - 1]);
  const falling = known && raw.every((v, at) => at === 0 || v < raw[at - 1]);
  if (!axis || rising || falling) {
    return dims;
  }
  const dimension = axis.name;
  let obs = base;
  for (
    let k = 1;
    arrays.some((a) => a.name === obs || a.dims.includes(obs));
    k++
  ) {
    obs = `${base}_${k}`;
  }
  for (const a of arrays) {
    a.dims = a.dims.map((d) => (d === dimension ? obs : d));
  }
  // An auxiliary coordinate now: `axis` is a coordinate variable's only.
  axis.attrs = Object.fromEntries(
    Object.entries(axis.attrs).filter(([key]) => key !== "axis")
  );
  addCoordinate(valueArray(arrays), dimension);
  return dims.map(
    ([d, n]) => [d === dimension ? obs : d, n] as [string, number]
  );
}

/**
 * The chosen index of each other dimension as a scalar coordinate of the
 * field: an ensemble member by its identifier, as CF's `realization`.
 */

function withSelections(result: TAnalysisResult, arrays: TExportArray[]) {
  let out = arrays;
  for (const chosen of result.selections ?? []) {
    const base = safeName(chosen.dimension);
    let name = base;
    for (
      let k = 1;
      out.some((a) => a.name === name || a.dims.includes(name));
      k++
    ) {
      name = `${base}_${k}`;
    }
    if (
      chosen.standardName === "forecast_period" &&
      chosen.value !== undefined
    ) {
      // The lead time itself, with its units: index 16 of GEFS is 172,800 s.
      addCoordinate(valueArray(out), name);
      const boundsName = freeName(out, `${name}_bnds`);
      out = [
        ...out,
        f8(name, [], [chosen.value], {
          standard_name: "forecast_period",
          long_name: "forecast period (lead time)",
          ...(chosen.units ? { units: chosen.units } : {}),
          ...(chosen.valueBounds ? { bounds: boundsName } : {}),
          gridlook_index: chosen.index,
        }),
        ...(chosen.valueBounds
          ? [f8(boundsName, ["nv"], chosen.valueBounds)]
          : []),
      ];
      continue;
    }
    const scalar = memberScalar(chosen, name);
    addCoordinate(valueArray(out), name);
    out = [...out, scalar];
  }
  return out;
}

/**
 * A chosen member or index as a scalar coordinate, in its dimension's one
 * encoding (identifiers.ts): exact 64-bit integers, float64 numbers, or the
 * identifier as text; the position where it has none.
 */
/** netCDF's default fills of the 64-bit integer types. */
const NC_FILL_I8 = -9223372036854775806n;
const NC_FILL_U8 = 18446744073709551614n;

// eslint-disable-next-line max-lines-per-function
function memberScalar(
  chosen: NonNullable<TAnalysisResult["selections"]>[number],
  name: string
): TExportArray {
  const text = chosen.id;
  // Its identifier the source's missing value: written missing, never as a
  // known member. In the dimension's own encoding, as every other selection of
  // it is written, so files of one family concatenate without promotion: the
  // type's netCDF default fill, or empty text.
  if (chosen.idMissing) {
    const attrs = {
      long_name: `${chosen.dimension} of the selected ${chosen.ensemble ? "member" : "index"}: missing in the source`,
      comment: "The source holds its declared missing value here.",
      ...(chosen.ensemble ? { standard_name: "realization" } : {}),
      gridlook_index: chosen.index,
    };
    const encoding = chosen.idEncoding;
    return encoding === "i8"
      ? {
          name,
          dims: [],
          type: "i8",
          data: BigInt64Array.of(NC_FILL_I8),
          attrs,
        }
      : encoding === "u8"
        ? {
            name,
            dims: [],
            type: "u8",
            data: BigUint64Array.of(NC_FILL_U8),
            attrs,
          }
        : encoding === "text"
          ? { name, dims: [], type: "str", data: [""], attrs }
          : f8(name, [], [Number.NaN], attrs);
  }
  // A result without the dimension's encoding: its own identifier's.
  const encoding =
    text === undefined
      ? undefined
      : (chosen.idEncoding ?? idEncoding([text], chosen.idType));
  const known = encoding !== undefined;
  const attrs = {
    long_name: known
      ? `${chosen.dimension} of the selected ${chosen.ensemble ? "member" : "index"}`
      : `index along ${chosen.dimension}`,
    ...(chosen.ensemble && known ? { standard_name: "realization" } : {}),
    gridlook_index: chosen.index,
  };
  if (encoding === "text") {
    return { name, dims: [], type: "str", data: [text!], attrs };
  }
  if (encoding === "i8") {
    return {
      name,
      dims: [],
      type: "i8",
      data: BigInt64Array.of(BigInt(text!)),
      attrs,
    };
  }
  if (encoding === "u8") {
    return {
      name,
      dims: [],
      type: "u8",
      data: BigUint64Array.of(BigInt(text!)),
      attrs,
    };
  }
  return f8(name, [], [encoding === "f8" ? Number(text) : chosen.index], attrs);
}

/**
 * One integer coordinate per native index component (`j_index`, `i_index`)
 * beside the combined `cell_index`: a [sample, cell_rank] array cannot be
 * attached as a coordinate by xarray, a per-component one can.
 */
function withIndexComponents(arrays: TExportArray[]) {
  const combined = arrays.find(
    (a) => a.name === "cell_index" && a.dims[a.dims.length - 1] === "cell_rank"
  );
  const names = combined?.indexDims ?? [];
  if (!combined || names.length < 2) {
    return arrays;
  }
  const rank = names.length;
  const outer = combined.dims.slice(0, -1);
  const data = combined.data as BigInt64Array;
  // Names no other array or dimension has, before any reference is made to
  // them.
  const taken = new Set(arrays.flatMap((a) => [a.name, ...a.dims]));
  const free = (base: string) => {
    let name = base;
    for (let k = 1; taken.has(name); k++) {
      name = `${base}_${k}`;
    }
    taken.add(name);
    return name;
  };
  const parts = names.map((dim, k) => ({
    name: free(`${safeName(dim)}_index`),
    dims: outer,
    type: "i8" as const,
    data: BigInt64Array.from(
      { length: data.length / rank },
      (_, at) => data[at * rank + k]
    ),
    attrs: {
      long_name: `native ${dim} index of the sampled cell (-1: none)`,
    },
  }));
  const value = valueArray(arrays);
  for (const part of parts) {
    addCoordinate(value, part.name);
  }
  if (value) {
    // The combined array stays, but is no longer listed as a coordinate.
    value.attrs = {
      ...value.attrs,
      coordinates: String(value.attrs.coordinates)
        .split(/\s+/)
        .filter((n) => n !== "cell_index")
        .join(" "),
    };
  }
  return [...arrays, ...parts];
}

const REFERENCE_ATTRS = ["coordinates", "bounds", "ancillary_variables"];

/**
 * Every name allocated once: coordinate variables keep their dimension's
 * name; any other array whose name is taken, or equals a dimension name
 * (a source level dimension called `status`, say), gets a suffix, and
 * references in coordinates/bounds attributes follow the rename.
 */
function uniqueNames(arrays: TExportArray[]) {
  const dims = new Set(arrays.flatMap((a) => a.dims));
  const taken = new Set<string>();
  const isCoordinate = (a: TExportArray) =>
    a.dims.length === 1 && a.dims[0] === a.name;
  for (const a of arrays) {
    if (isCoordinate(a)) {
      taken.add(a.name);
    }
  }
  const renamed = new Map<string, string>();
  for (const a of arrays) {
    if (isCoordinate(a) && !renamed.has(a.name)) {
      renamed.set(a.name, a.name);
      continue;
    }
    let name = a.name;
    for (let k = 1; taken.has(name) || dims.has(name); k++) {
      name = `${a.name}_${k === 1 ? "var" : `var${k}`}`;
    }
    // References follow a rename only when no other array keeps the name:
    // a second array of the same name never takes the first's references.
    const kept = taken.has(a.name);
    taken.add(name);
    if (name !== a.name) {
      if (!kept) {
        renamed.set(a.name, name);
      }
      a.name = name;
    }
  }
  for (const a of arrays) {
    for (const key of REFERENCE_ATTRS) {
      const value = a.attrs[key];
      if (typeof value === "string") {
        a.attrs[key] = value
          .split(/\s+/)
          .map((n) => renamed.get(n) ?? n)
          .join(" ");
      }
    }
  }
  return arrays;
}

/**
 * Positions from an auxiliary coordinate, kept as the source has them: the
 * dimension with its own coordinate (observation IDs, else indices), the
 * positions under their own name with their bounds, an auxiliary coordinate of
 * the field, no `axis` (CF 1.12: a coordinate variable's only).
 */
// eslint-disable-next-line max-lines-per-function
function withAuxiliaryVertical(
  result: TAnalysisResult,
  arrays: TExportArray[]
) {
  const v = result.vertical;
  const axis = arrays.find(
    (a) =>
      a.attrs.axis === "Z" &&
      a.dims.length === 1 &&
      a.dims[0] === a.name &&
      a.type === "f8"
  );
  if (!v?.auxiliary || !v.physical || !axis) {
    return arrays;
  }
  const n = axis.data.length;
  const positions = Float64Array.from(axis.data as ArrayLike<number>);
  const native =
    v.auxiliary.native?.length === n ? v.auxiliary.native : undefined;
  // The dimension's own coordinate in place of the positions; 64-bit
  // integer IDs in their own type, exactly.
  const ids =
    v.auxiliary.nativeIds?.length === n ? v.auxiliary.nativeIds : undefined;
  if (native && ids && v.auxiliary.nativeType === "uint64") {
    axis.type = "u8";
    axis.data = BigUint64Array.from(ids, (id) => BigInt(id));
  } else if (native && ids) {
    axis.type = "i8";
    axis.data = BigInt64Array.from(ids, (id) => BigInt(id));
  } else {
    axis.data = Float64Array.from(
      native ?? Array.from({ length: n }, (_, k) => k)
    );
  }
  axis.attrs = native
    ? { long_name: `${axis.name} (source coordinate)` }
    : { long_name: `index along ${axis.name}` };
  const name = freeName(arrays, safeName(v.auxiliary.name));
  const out = [...arrays];
  const attrs: Record<string, TExportAttr> = {
    long_name: v.label,
    ...(v.standardName ? { standard_name: v.standardName } : {}),
    ...(v.units ? { units: v.units } : {}),
    ...(v.positive ? { positive: v.positive } : {}),
  };
  if (v.bounds?.length === 2 * n) {
    const bounds = freeName([...out, f8(name, [], [])], `${name}_bnds`);
    attrs.bounds = bounds;
    out.push(f8(bounds, [axis.name, "nv"], v.bounds));
  }
  out.push(f8(name, [axis.name], positions, attrs));
  const value = valueArray(out);
  if (value) {
    addCoordinate(value, name);
  }
  return out;
}

/** Published layer bounds of the vertical coordinate, as CF bounds. */
function withVerticalBounds(result: TAnalysisResult, arrays: TExportArray[]) {
  const v = result.vertical;
  const axis = arrays.find(
    (a) => a.attrs.axis === "Z" && a.dims.length === 1 && a.type === "f8"
  );
  if (
    !v?.physical ||
    !v.bounds ||
    !axis ||
    v.bounds.length !== 2 * axis.data.length
  ) {
    return arrays;
  }
  // A field may already be called depth_bnds: the bounds take a free name.
  const name = freeName(arrays, `${axis.name}_bnds`);
  axis.attrs = { ...axis.attrs, bounds: name };
  return [...arrays, f8(name, [axis.name, "nv"], v.bounds)];
}

/** The shared model of a result, for every scientific format. */
export function exportModel(result: TAnalysisResult): TExportModel {
  const shaped = withoutCollisions(result, safeName(result.query.variable));
  // Every array exists before bounds take a name (a fixed level called
  // `time_bnds` is there first, so the bounds take `time_bnds_1`).
  const arrays = uniqueNames(
    withIndexComponents(
      withReferenceTime(
        result,
        withForecastTimes(
          result,
          withTimeBounds(
            result,
            withVerticalBounds(
              result,
              withAuxiliaryVertical(
                result,
                withSelections(result, withFixedLevel(result, shaped.arrays))
              )
            )
          )
        )
      )
    )
  );
  const dims = completeDims(
    observedLevels(observedTime(shaped.dims, arrays), arrays),
    arrays
  );
  checkShapes(dims, arrays);
  const provenance = resultProvenance(result);
  return {
    dims,
    arrays,
    attrs: {
      Conventions: "CF-1.12",
      title: `Gridlook ${result.kind} of ${result.longName ?? result.query.variable}`,
      source: provenance.source.ref,
      history: `${new Date().toISOString()} exported by Gridlook from a computed plot (no source reads)`,
      gridlook_completeness: result.partial ? "partial" : "complete",
      gridlook_query: JSON.stringify(provenance.query),
      gridlook_provenance: JSON.stringify(provenance),
      geospatial_sphere_radius_m: DRAWING_SPHERE_RADIUS_METERS,
    },
  };
}

// ---------------------------------------------------------------------------
// Zarr v3, zipped.

const ZARR_TYPES = {
  f8: "float64",
  i4: "int32",
  i8: "int64",
  u8: "uint64",
  str: "string",
} as const;

/** Chunks of at most about 1 MiB (8-byte values), split along leading dims. */
const ZARR_CHUNK_VALUES = 1 << 17;

export function chunkShapeOf(shape: number[]) {
  const chunk = shape.map((n) => Math.max(1, n));
  let d = 0;
  while (
    chunk.reduce((p, n) => p * n, 1) > ZARR_CHUNK_VALUES &&
    d < chunk.length
  ) {
    const rest = chunk.slice(d + 1).reduce((p, n) => p * n, 1);
    chunk[d] = Math.max(1, Math.floor(ZARR_CHUNK_VALUES / rest));
    if (chunk[d] > 1 || rest <= ZARR_CHUNK_VALUES) {
      break;
    }
    d++;
  }
  return chunk;
}

/** Let input and drawing run between arrays of a large export. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One.zarr.zip: `zarr.json` at the archive root, arrays beside it. */
// eslint-disable-next-line max-lines-per-function
export async function toZarrZip(model: TExportModel): Promise<Uint8Array> {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: model.attrs });
  const sizes = new Map(model.dims);
  for (const array of model.arrays) {
    const shape = array.dims.map((dim) => sizes.get(dim)!);
    const target = await zarr.create(zarr.root(store).resolve(array.name), {
      shape,
      chunkShape: chunkShapeOf(shape),
      dtype: ZARR_TYPES[array.type],
      // An explicit bytes codec: some readers require one in the metadata.
      // Text: variable-length UTF-8, as zarr-python writes it.
      codecs: [
        array.type === "str"
          ? { name: "vlen-utf8", configuration: {} }
          : { name: "bytes", configuration: { endian: "little" } },
      ],
      dimensionNames: array.dims,
      attributes: array.attrs,
      // JSON metadata holds −1 as a number for every integer type.
      // (Unsigned: 0, which only a scalar past the signed range uses.)
      fillValue: (array.type === "f8"
        ? Number.NaN
        : array.type === "str"
          ? ""
          : array.type === "u8"
            ? 0
            : -1) as never,
    });
    if (array.type === "str") {
      // zarrita writes no text: the one chunk, in vlen-utf8's layout.
      const key = shape.length ? `${shape.map(() => 0).join("/")}` : "";
      store.set(
        `${target.path.replace(/\/$/, "")}/c${key ? `/${key}` : ""}`,
        vlenUtf8(array.data as string[])
      );
      continue;
    }
    if (!shape.length) {
      await zarr.set(target as never, null, array.data[0] as never);
      continue;
    }
    const stride = shape.map((_, d) =>
      shape.slice(d + 1).reduce((p, n) => p * n, 1)
    );
    await zarr.set(target as never, null, {
      data: array.data,
      shape,
      stride,
    } as never);
    await breathe();
  }
  const files: Record<string, Uint8Array> = {};
  for (const [key, bytes] of store) {
    files[key.replace(/^\/+/, "")] = bytes;
  }
  // Deflated entries; zarr-python, xarray and zarrita open the ZIP as a
  // store directly, or it can be extracted to a directory store.
  return zipEntries(files);
}

/** Strings as Zarr's vlen-utf8 codec stores them: a count, then each length and bytes. */
function vlenUtf8(values: string[]) {
  const parts = values.map((value) => new TextEncoder().encode(value));
  const out = new Uint8Array(4 + parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, values.length, true);
  let at = 4;
  for (const part of parts) {
    view.setUint32(at, part.length, true);
    out.set(part, at + 4);
    at += 4 + part.length;
  }
  return out;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (let at = 0; at < bytes.length; at++) {
    c = CRC_TABLE[(c ^ bytes[at]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Deflate entries one at a time (one-shot deflate per entry; fflate's
 * streaming deflater mis-encodes some short inputs) into a streaming
 * archive, yielding to the page between entries: no burst of compression
 * workers, and one entry compressed at a time.
 */
async function zipEntries(files: Record<string, Uint8Array>) {
  const parts: Uint8Array[] = [];
  let failure: Error | null = null;
  const archive = new Zip((error, data) => {
    if (error) {
      failure = error;
    } else {
      parts.push(data);
    }
  });
  for (const [name, bytes] of Object.entries(files)) {
    const entry: ZipInputFile = {
      filename: name,
      size: bytes.length,
      crc: crc32(bytes),
      compression: 8,
      terminate: () => undefined,
    };
    archive.add(entry);
    entry.ondata!(null, deflateSync(bytes, { level: 6 }), true);
    delete files[name]; // release the uncompressed copy
    if (failure) {
      throw failure;
    }
    await breathe();
  }
  archive.end();
  if (failure) {
    throw failure;
  }
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// GeoJSON of the selection (RFC 7946: longitude, latitude; split at 180°).

type TPosition = [number, number];

function wrap(lon: number) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Points along great circles between vertices, about one per degree. */
function densify(vertices: TLatLon[], closed: boolean) {
  const out: TLatLon[] = [];
  const n = vertices.length;
  for (let at = 0; at < (closed ? n : n - 1); at++) {
    const a = toVec(vertices[at].lat, vertices[at].lon);
    const b = toVec(vertices[(at + 1) % n].lat, vertices[(at + 1) % n].lon);
    const steps = Math.max(1, Math.ceil(angleBetween(a, b) / (Math.PI / 180)));
    for (let k = 0; k < steps; k++) {
      out.push(toLatLon(interpolateArc(a, b, k / steps)));
    }
  }
  if (!closed) {
    out.push(vertices[n - 1]);
  }
  return out;
}

/** Continuous longitudes (no jumps above 180°) along a line. */
function unwrap(points: TLatLon[]): TPosition[] {
  const out: TPosition[] = [];
  let previous = wrap(points[0].lon);
  for (const p of points) {
    let lon = wrap(p.lon);
    while (lon - previous > 180) {
      lon -= 360;
    }
    while (lon - previous < -180) {
      lon += 360;
    }
    out.push([lon, p.lat]);
    previous = lon;
  }
  return out;
}

/** A line cut where it crosses ±180°, each piece in [-180, 180]. */
function splitLine(points: TLatLon[]): TPosition[][] {
  const line = unwrap(points);
  const pieces: TPosition[][] = [[]];
  for (let at = 0; at < line.length; at++) {
    const p = line[at];
    if (at > 0) {
      const q = line[at - 1];
      const band = Math.floor((q[0] + 180) / 360);
      const next = Math.floor((p[0] + 180) / 360);
      if (band !== next) {
        const edge = Math.max(band, next) * 360 - 180;
        const f = (edge - q[0]) / (p[0] - q[0]);
        const lat = q[1] + f * (p[1] - q[1]);
        const shift = band * 360;
        pieces[pieces.length - 1].push([edge - shift, lat]);
        pieces.push([[edge - next * 360, lat]]);
      }
    }
    pieces[pieces.length - 1].push([
      p[0] - Math.floor((p[0] + 180) / 360) * 360,
      p[1],
    ]);
  }
  // A piece made only of a seam point (a route ending exactly on 180°)
  // is no line: repeated positions collapse and such pieces are dropped.
  return pieces
    .map((piece) =>
      piece.filter(
        (p, at) =>
          at === 0 || p[0] !== piece[at - 1][0] || p[1] !== piece[at - 1][1]
      )
    )
    .filter((piece) => piece.length > 1);
}

function closeRing(ring: TPosition[]) {
  return ring.length ? [...ring, ring[0]] : ring;
}

/** Twice the signed area in the lon/lat plane: positive when CCW. */
function signedArea(ring: TPosition[]) {
  let sum = 0;
  for (let at = 0; at < ring.length; at++) {
    const [x0, y0] = ring[at];
    const [x1, y1] = ring[(at + 1) % ring.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum;
}

/** RFC 7946: exterior rings counterclockwise. */
function counterClockwise(ring: TPosition[]) {
  return signedArea(ring) < 0 ? [...ring].reverse() : ring;
}

type TChain = { points: TPosition[]; start: number; end: number };

/**
 * Split a simple CCW ring by the meridian `x` into the rings west and east
 * of it. Each side's chains are joined along the meridian in the direction
 * that keeps the interior on the left (north on the west side, south on
 * the east), so a concave ring yields separate simple pieces rather than
 * one self-touching ring.
 */
function splitAt(ring: TPosition[], x: number) {
  // A vertex on the meridian is nudged west, so crossings are proper.
  const pts = ring.map(
    ([lon, lat]) => [lon === x ? x - 1e-9 : lon, lat] as TPosition
  );
  const side = (p: TPosition) => (p[0] < x ? 0 : 1);
  const first = pts.findIndex(
    (p, at) => side(p) !== side(pts[(at + pts.length - 1) % pts.length])
  );
  if (first < 0) {
    return side(pts[0]) === 0
      ? { west: [ring], east: [] }
      : { west: [], east: [ring] };
  }
  const chains: [TChain[], TChain[]] = [[], []];
  let current: TChain | undefined;
  for (let k = 0; k < pts.length; k++) {
    const at = (first + k) % pts.length;
    const a = pts[(at + pts.length - 1) % pts.length];
    const b = pts[at];
    if (side(a) !== side(b)) {
      const lat = a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
      if (current) {
        current.points.push([x, lat]);
        current.end = lat;
        chains[side(a)].push(current);
      }
      current = { points: [[x, lat]], start: lat, end: lat };
    }
    current!.points.push(b);
  }
  // The walk began just after a crossing: close the last chain there.
  const a = pts[(first + pts.length - 1) % pts.length];
  const b = pts[first];
  const lat = a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
  current!.points.push([x, lat]);
  current!.end = lat;
  chains[side(a)].push(current!);
  return {
    west: joinChains(chains[0], true),
    east: joinChains(chains[1], false),
  };
}

function joinChains(chains: TChain[], north: boolean) {
  const rings: TPosition[][] = [];
  const left = new Set(chains);
  while (left.size) {
    const head = left.values().next().value!;
    left.delete(head);
    const ring = [...head.points];
    let tail = head;
    for (;;) {
      // The nearest chain start along the meridian in the interior's sense.
      let next: TChain | undefined;
      for (const chain of [head, ...left]) {
        const ahead = north ? chain.start >= tail.end : chain.start <= tail.end;
        if (
          ahead &&
          (!next ||
            (north ? chain.start < next.start : chain.start > next.start))
        ) {
          next = chain;
        }
      }
      if (!next || next === head) {
        break;
      }
      left.delete(next);
      ring.push(...next.points);
      tail = next;
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * A ring that winds once round a pole, as one polygon spanning −180° to
 * 180°: the ring is opened where it crosses the antimeridian and closed
 * along the pole's latitude, so no piece shares an edge with another.
 */
function poleCap(ring: TPosition[], pole: 90 | -90): TPosition[] {
  const span = ring[ring.length - 1][0] - ring[0][0];
  const loop = span < 0 ? [...ring].reverse() : [...ring];
  loop.push([loop[0][0] + 360, loop[0][1]]);
  // Two turns, so the seam crossing and the one a turn later both occur.
  const twice = [
    ...loop,
    ...loop.slice(1).map(([lon, lat]) => [lon + 360, lat] as TPosition),
  ];
  const edge = 360 * Math.floor((loop[0][0] - 180) / 360) + 540;
  const out: TPosition[] = [];
  for (let at = 1; at < twice.length; at++) {
    const [x0, y0] = twice[at - 1];
    const [x1, y1] = twice[at];
    for (const cut of [edge, edge + 360]) {
      if (x0 < cut && x1 >= cut) {
        const lat = y0 + ((cut - x0) / (x1 - x0)) * (y1 - y0);
        out.push([cut, lat]);
        if (cut === edge + 360) {
          const shift = edge + 180;
          return [...out, [edge + 360, pole], [edge, pole]].map(
            ([lon, lat]) => [lon - shift, lat] as TPosition
          );
        }
      }
    }
    if (out.length && x1 > edge && x1 < edge + 360) {
      out.push(twice[at]);
    }
  }
  return ring;
}

/**
 * A polygon (or box) as GeoJSON polygons: rings in continuous longitudes
 * are cut at every ±180° + k|360° they cross, each piece is shifted into
 * [−180°, 180°] and wound counterclockwise.
 */
/** Minimum and maximum in one pass (no argument spread). */
function rangeOf(values: number[]): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (const v of values) {
    low = Math.min(low, v);
    high = Math.max(high, v);
  }
  return [low, high];
}

function polygonParts(ring: TPosition[], pole?: 90 | -90): TPosition[][][] {
  const span = ring[ring.length - 1][0] - ring[0][0];
  if (pole !== undefined && Math.abs(span) > 180) {
    return [[closeRing(counterClockwise(poleCap(ring, pole)))]];
  }
  let pieces = [counterClockwise(ring)];
  const [low, high] = rangeOf(ring.map((p) => p[0]));
  for (let k = Math.ceil((low - 180) / 360); 360 * k + 180 < high; k++) {
    const edge = 360 * k + 180;
    if (edge <= low) {
      continue;
    }
    pieces = pieces.flatMap((piece) => {
      const { west, east } = splitAt(piece, edge);
      return [...west, ...east];
    });
  }
  return pieces
    .filter((piece) => piece.length >= 3)
    .map((piece) => {
      const [a, b] = rangeOf(piece.map((p) => p[0]));
      const shift = 360 * Math.round((a + b) / 720);
      return [
        closeRing(
          counterClockwise(
            piece.map(([lon, lat]) => [lon - shift, lat] as TPosition)
          )
        ),
      ];
    });
}

/** The pole a polygon winds round and contains, if any. */
function enclosedPole(vertices: TLatLon[]): 90 | -90 | undefined {
  const polygon = preparePolygon(vertices);
  return polygonContains(polygon, 90, 0)
    ? 90
    : polygonContains(polygon, -90, 0)
      ? -90
      : undefined;
}

/** A band all the way round, as one polygon from −180° to 180°. */
function fullBand(south: number, north: number) {
  return {
    type: "Polygon",
    coordinates: [
      [
        [-180, south],
        [180, south],
        [180, north],
        [-180, north],
        [-180, south],
      ],
    ],
  };
}

/**
 * A shape as GeoJSON. A box drawn on the globe or a curved map keeps its
 * outline whole (continuous across the date line, closed along a pole it
 * goes round): cut here as a drawn polygon is.
 */
function shapeOf(geometry: TGeometry & { kind: typeof GEOMETRY_KINDS.SHAPE }) {
  const [only] = geometry.polygons;
  if (geometry.drawn && geometry.polygons.length === 1 && only.length === 1) {
    const ring = only[0].slice(0, -1).map(([lon, lat]) => ({ lat, lon }));
    const parts = polygonParts(unwrap(ring));
    return parts.length === 1
      ? { type: "Polygon", coordinates: parts[0] }
      : { type: "MultiPolygon", coordinates: parts };
  }
  // The imported shape as prepared (clipped at the antimeridian).
  return { type: "MultiPolygon", coordinates: geometry.polygons };
}

function geometryOf(geometry: TGeometry, countryRings?: number[][][][]) {
  switch (geometry.kind) {
    case GEOMETRY_KINDS.POINT:
      return { type: "Point", coordinates: [wrap(geometry.lon), geometry.lat] };
    case GEOMETRY_KINDS.BOX: {
      // The same span the calculation uses: a full turn (0..360,
      // 180..−180) is one band; 10..370.5 is half a degree, not a band.
      const span = boxLonSpan(geometry);
      if (span >= 360) {
        return fullBand(geometry.south, geometry.north);
      }
      const west = wrap(geometry.west);
      const east = west + span;
      const ring: TPosition[] = [
        [west, geometry.south],
        [east, geometry.south],
        [east, geometry.north],
        [west, geometry.north],
      ];
      const parts = polygonParts(ring);
      return parts.length === 1
        ? { type: "Polygon", coordinates: parts[0] }
        : { type: "MultiPolygon", coordinates: parts };
    }
    case GEOMETRY_KINDS.COUNTRY:
      if (!countryRings) {
        throw new Error("Country boundary must be loaded for GeoJSON export.");
      }
      return { type: "MultiPolygon", coordinates: countryRings };
    case GEOMETRY_KINDS.SHAPE:
      return shapeOf(geometry);
    case GEOMETRY_KINDS.POLYGON: {
      const parts = polygonParts(
        unwrap(densify(geometry.vertices, true)),
        enclosedPole(geometry.vertices)
      );
      return parts.length === 1
        ? { type: "Polygon", coordinates: parts[0] }
        : { type: "MultiPolygon", coordinates: parts };
    }
    default: {
      const pieces = splitLine(densify(geometry.vertices, false));
      return pieces.length === 1
        ? { type: "LineString", coordinates: pieces[0] }
        : { type: "MultiLineString", coordinates: pieces };
    }
  }
}

const SAMPLE_FEATURE_LIMIT = 20_000;

/** The selection, its waypoints and resolved samples or cell, as GeoJSON. */
// eslint-disable-next-line max-lines-per-function
export function toGeoJSON(
  result: TAnalysisResult,
  label: string,
  countryRings?: number[][][][]
) {
  const geometry = result.query.geometry;
  const common = {
    plot: label,
    kind: result.kind,
    variable: result.query.variable,
  };
  const features: object[] = [
    {
      type: "Feature",
      geometry: geometryOf(geometry, countryRings),
      properties: {
        ...common,
        role: "selection",
        geometry_kind: geometry.kind,
        ...(geometry.kind === GEOMETRY_KINDS.COUNTRY
          ? {
              country_id: countryIds(geometry).join("+"),
              country_name: countriesName(
                countryIds(geometry),
                geometry.resolution
              ),
              boundary_resolution: geometry.resolution,
              boundary_atlas: COUNTRY_ATLAS_VERSION,
            }
          : geometry.kind === GEOMETRY_KINDS.SHAPE
            ? { shape_name: geometry.name, shape_digest: geometry.digest }
            : {}),
      },
    },
  ];
  if (geometry.kind === GEOMETRY_KINDS.POLYLINE) {
    features.push({
      type: "Feature",
      geometry: {
        type: "MultiPoint",
        coordinates: geometry.vertices.map((v) => [wrap(v.lon), v.lat]),
      },
      properties: {
        ...common,
        role: "waypoints",
        // Numbered as on the map's badges and the chart's axis (1, 2, …).
        labels: geometry.vertices.map((_, at) => String(at + 1)),
      },
    });
  }
  const s = result.samples;
  if (s && s.distances.length <= SAMPLE_FEATURE_LIMIT) {
    const path = result.sectionMode === SECTION_MODES.PATH;
    s.distances.forEach((distance, at) =>
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [wrap(s.lons[at]), s.lats[at]],
        },
        properties: {
          ...common,
          role: "sample",
          sample: at,
          distance_m: distance,
          status: s.status[at],
          cell: s.cells[at] || null,
          ...(path
            ? {
                value: Number.isNaN(result.values[at])
                  ? null
                  : result.values[at],
                units: result.units ?? null,
              }
            : {}),
        },
      })
    );
  }
  if (result.cell?.id) {
    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [wrap(result.cell.lon), result.cell.lat],
      },
      properties: {
        ...common,
        role: "cell",
        cell: result.cell.id,
        selection: result.cell.selection,
        ...(result.cell.stored !== undefined
          ? { stored: result.cell.stored }
          : {}),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** The selection as GeoJSON, a country from the same versioned boundary. */
export async function selectionGeoJSON(result: TAnalysisResult, label: string) {
  const g = result.query.geometry;
  const rings =
    g.kind === GEOMETRY_KINDS.COUNTRY
      ? await getCountriesRings(countryIds(g), g.resolution)
      : undefined;
  return toGeoJSON(result, label, rings);
}
