/**
 * The Export menu, grouped by what the file is: the figure, the values, or
 * what reproduces the selection. Each group is one row of formats; one menu
 * serves Chart and Data alike.
 */

export type TExportFormat =
  | "png"
  | "pdf"
  | "svg"
  | "chart-csv"
  | "csv"
  | "nc"
  | "zarr"
  | "geojson"
  | "json"
  | "py";

type TExportItem = {
  format: TExportFormat;
  /** The format's chip in the row. */
  chip: string;
  /** Its full name (read out, and the start of its tooltip). */
  label: string;
  /** What the file holds. */
  hint: string;
};

export type TExportGroup = {
  name: string;
  /** The row's short heading. */
  short: string;
  items: TExportItem[];
};

const FIGURE: TExportGroup = {
  name: "Figure",
  short: "Figure",
  items: [
    {
      format: "png",
      chip: "PNG",
      label: "Figure (PNG)",
      hint: "with title, selection and legend, at the size chosen beside it",
    },
    {
      format: "pdf",
      chip: "PDF",
      label: "Figure (PDF, vector)",
      hint: "vector, with the query and provenance attached",
    },
    {
      format: "svg",
      chip: "SVG",
      label: "Figure (SVG, vector)",
      hint: "vector",
    },
  ],
};

const CHART_VALUES: TExportItem = {
  format: "chart-csv",
  chip: "As shown",
  label: "Chart values as shown (CSV)",
  hint: "what the chart draws now (its view), as CSV",
};

const COMPUTED: TExportItem[] = [
  {
    format: "csv",
    chip: "CSV",
    label: "Computed values (CSV)",
    hint: "every requested row, with status and coverage",
  },
  {
    format: "nc",
    chip: "NetCDF",
    label: "Computed values (NetCDF-4)",
    hint: "CF metadata; units and calendar kept",
  },
  {
    format: "zarr",
    chip: "Zarr",
    label: "Computed values (Zarr v3, ZIP)",
    hint: "Zarr v3 in a ZIP",
  },
];

const REPRODUCE: TExportGroup = {
  name: "Selection and reproducibility",
  short: "Reproduce",
  items: [
    {
      format: "geojson",
      chip: "GeoJSON",
      label: "Selection on the map (GeoJSON)",
      hint: "the point, path or area plotted",
    },
    {
      format: "json",
      chip: "Query",
      label: "Query and provenance (JSON)",
      hint: "the request, source and method, without values",
    },
    {
      format: "py",
      chip: "Python",
      label: "Python script (pandas, matplotlib)",
      hint: "redraws this plot from its values",
    },
  ],
};

/**
 * The groups and their entries. `chartValues`: the chart (or a figure in
 * its place) can say what it draws, so "as shown" is offered.
 */
export function exportGroups(options: {
  chartValues: boolean;
}): TExportGroup[] {
  return [
    FIGURE,
    {
      name: "Values",
      short: "Values",
      items: [...(options.chartValues ? [CHART_VALUES] : []), ...COMPUTED],
    },
    REPRODUCE,
  ];
}
