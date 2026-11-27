# Plots: time series, profiles, sections and space–time diagrams

Gridlook plots a variable at a location, over an area, along the vertical,
along a drawn path, or as a space–time (Hovmöller) diagram, in floating
windows over the map. Plots read the same store as the map, in a worker,
and never block the globe.

## Creating a plot

Plots are grouped by where they sample: **Point**, **Path**, **Box**,
**Polygon** and **Country**. Two entry points offer the same groups:

- **Plotting tools** (bottom left, chart icon) opens the plot chooser. With
  plots open it lists them first (**Open plots**), with **Compare** and
  **New plot**. Its badge counts every retained plot.
- **Right-click** on the globe (without dragging) opens a menu at the
  pointer for the clicked place. A point plot opens there at once; a path or
  polygon starts from it; a box is dragged; a country plot opens the country
  picker with the clicked country chosen. The context-menu key or
  <kbd>Shift</kbd>+<kbd>F10</kbd> on the focused map uses the map centre.

Every row also accepts typed coordinates, and Polygon rows can import a
shape from a file.

### Select a country

The country picker searches countries by name and can add several; the
selection is their union. Boundaries come from the bundled
Natural Earth atlas (licences in `public/static/country-boundary-licenses.txt`).
Large atlas levels are parsed only after the plot's cost is confirmed.

### Import a shape

GeoJSON, KML/KMZ or a Shapefile (`.zip`, or `.shp` with `.dbf` and
`.prj`), in longitude/latitude, become a Polygon plot. The file stays on
the computer.

## Plot kinds

| Plot              | Definition                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Time series       | The cell containing the point, over the chosen time range, at a fixed level.                |
| Area time series  | Area-weighted mean of the cells whose centres lie in the box, polygon or country, per date. |
| Vertical profile  | One column at one date, on the physical vertical coordinate when available.                 |
| Cross-section     | Cells along the great-circle path at one date: sample × level (curtain), or one level.      |
| Time–depth        | Every level of the point's cell at every date of the range.                                 |
| Longitude × time  | Per longitude bin, the area-weighted mean over the box at each date.                        |
| Latitude × time   | The same per latitude bin.                                                                  |
| Distance × time   | The path's samples at one level, at every date of the range.                                |
| Distribution      | At one date and level, the area-weighted share of the selection per value bin.              |
| Latitude–pressure | At one date, the area-weighted mean over the box's longitudes per latitude bin and level.   |

- Coverage is the valid selected area divided by the selected area. Cells
  absent from a packed source count in the denominator. No valid cell
  gives a missing mean.
- Values are decoded in Float64 as the map decodes them: missing markers
  and valid ranges first, then scale and offset. Chunks never written are
  missing.
- A vector (wind, current) pairs its two components by their physical
  valid times, levels and cells; components that do not match are refused
  with the reason.

## Windows

A window shows the chart, its place, level and time, and its state.
While it reads, partial results are drawn and **Stop** keeps what has
arrived; **Continue** reads the rest. **Extend** adds dates before or after
a series and quotes their cost first. **Follow** keeps a plot on the map's
current date or level.

Reads that are large (many chunks, much decoded data, or a cold grid
geometry) ask before they start and show what they will read. Hard limits
(512 MiB of working memory, the shard-index budget) are refused before any
read.

**Compare** pairs two or more time series by their times and shows bias,
scatter, Q–Q and parallel coordinates. Series with different supports (a
6-hour and a 24-hour total) or unknown supports are not paired.

Time series offer views of the same values: anomaly, annual and diurnal
cycles, running mean, cumulative total, count above a value per year,
boxes by month, spectrum and return levels. Each view uses only records of the
series' own support and says what it left out.

## Sharing

The page URL holds the open plots (`plots`, see
[URL parameters](url-parameters.md)) and Compare. A shared link reopens and
recomputes them; its parameters are checked before any read.

## The map's time in plots

A plot reads the dates its query names, not the map's. A series marks the
map's date; Follow moves a one-date plot with the map. Forecast sources are
plotted on their valid times: published valid times, the reference time plus
a lead, or a valid-time axis. Clocks that disagree, or valid times in
another calendar or without date units, are not used.

## Display settings

Colour limits follow the plot's own data unless the map's **Custom** range
is chosen; then plots use it too. Colormaps, inversion and posterization
follow the map.

## Figures

Each window exports its figure as PNG, SVG or PDF (vectors), its data as
CSV, and a Python script that redraws the figure from embedded data. The
script can optionally reopen the remote source; it then checks every range
it reads and stops if the object changes while it reads.

## Vertical statistics

Profiles and time–depth plots offer level diagnostics where the quantity
allows them: maximum and minimum level, mixed-layer depth, thermocline and
the 20 °C isotherm for ocean temperature, the tropopause for air
temperature, and column amounts for mass fractions. A column amount of a
mean mixing ratio is the burden of the mean state and says so.

## Supported grids

- **Nested HEALPix**: dense and packed levels (`cell`/`cell_ids`,
  `compacted`, `ranges`), at the source order.
- **Latitude/longitude grids** with monotonic 1-D axes. Area means weight
  cells by the declared cell measure (also from a CMIP6 `fx` store beside
  the field), else by their spherical areas.
- **Rotated-pole grids** and **projected grids** (x/y with a CRS, any linear
  unit): points are located against the cells' published sides; large
  projected cells' areas follow their straight sides.
- **Curvilinear grids** with 2-D latitude/longitude, including halos and
  tripolar folds (duplicated cells are counted once).
- **Unstructured meshes** (UGRID faces or nodes) and site lists.
- **Zarr v2 and v3**, sharded arrays, Kerchunk references and Icechunk
  repositories. Requests share one gate of 24 at a time with the map.

## Downloads

Downloads are written from the computed result, with no new reads:

- **NetCDF-4** (`.nc`) and **Zarr v3** (`.zarr.zip`) with CF metadata, the
  source time units and calendar, vertical coordinates, bounds, and a
  `status` variable (`ok`, `missing_value`, `not_read`, `no_stored_cell`).
  A stopped plot is marked `partial`, and cells it never read are
  `not_read`. Member identifiers keep their stored type.
- **GeoJSON** of the selection (RFC 7946), split at 180°.
- **CSV** of the chart's data.

The source address in a download keeps its protocol, host and path only.

## Deployment switch

`VITE_GRIDLOOK_PLOTS=false` builds Gridlook without plot windows, charts or
the analysis worker. In a normal build these load when the first plot
opens.
