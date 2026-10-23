# Multi-resolution datasets

Gridlook can open a dataset that ships the same variables at several
resolutions and pick the resolution to render from the camera. Internally a
dataset is a list of _levels_; single-resolution datasets have exactly one and
behave as before.

## How levels are discovered

- **`multiscales` attribute.** When the root group (or the group a URL points
  at) carries a `multiscales` attribute, each entry it declares becomes one
  level, read from the named child group. Without one there, the shallowest
  group below it that carries the attribute is used (the store's listing is
  in memory for consolidated metadata, Icechunk and reference files, so this
  costs no requests); when several do, the shallowest is read and the
  browser console lists them all. Paths in the attribute are relative to the
  group that carries it. Three layouts are understood:
  - OME-NGFF: `multiscales[0].datasets[].path` (0.4), or the same under
    `ome.multiscales` (0.5). A `scale` coordinate transformation together
    with `axes` that carry a length unit (`degree`, `metre`, `km`) gives the
    level's ground resolution. An ndpyramid dataset (`crs: "EPSG:3857"` and
    `pixels_per_tile` p) of zoom n (its `level`, a number or a string of
    digits, else its numeric `path`) has cells of 2πR / (p · 2ⁿ) at the
    equator.
  - [zarr-conventions `multiscales`](https://github.com/zarr-conventions/multiscales):
    `multiscales.layout[].asset`. The `transform.scale` of a layout entry is relative to
    another level, so the resolution comes from the level's grid (below). An
    asset that is an array and not a group is not a level.
  - GeoZarr: `multiscales[0].tile_matrix_limits` keyed by tile matrix (child
    group) id, or the `tileMatrices` of an inline `tile_matrix_set`. A tile
    matrix's `cellSize` is its resolution (degrees for a CRS84/EPSG:4326 set,
    the CRS unit, taken as metres, otherwise); with the `WebMercatorQuad` tile
    matrix set it follows from the zoom. Levels are sorted finest first.
- **Grid metadata.** A level whose attributes do not state a resolution gets
  one from its grid where possible: the HEALPix `nside` (from the CRS
  variable's `healpix_nside`, the level group's DGGS `refinement_level`, or a
  `cell` dimension of length `12 nside²`) or the spacing of a one-dimensional
  `lon` coordinate on a regular grid, else of a projected `x` coordinate in
  a length unit. Every level also records how many cells it holds: the length of its spatial
  dimensions (`cell` for HEALPix, sparse or not; `lat · lon` or `y · x` on a
  regular grid).
- **JSON index.** An index file may list several `levels`, each with its own
  `datasources`, and may state `resolution` (metres per cell) and `cellCount`
  per level.

Arrays outside the level groups (next to them, or in groups that are not
levels) stay listed as variables without levels. Such a variable is shown
like a single-level dataset: the level list is disabled, nothing is loaded
by view or drawn beneath it, and the camera picks no level for it. It is
loaded whole, however many cells it has. The levels of a second pyramid in
the same store are such variables too, so a fine level of it can be slow or
too large to render.

Once every level has a resolution, the levels are sorted finest first,
whatever order the attribute or the JSON index lists them in. Levels
without a resolution are still selectable by hand, but the camera
cannot choose between them. A group whose `multiscales` attribute yields fewer
than two usable levels is opened as a single-level dataset.

## How the level is picked

In every projection, also while the camera is moving, Gridlook measures the
ground distance one screen pixel covers at the point below the camera and
picks the level whose cells come nearest to **16 pixels** on screen (nearest
in log2 of the cell size). The active level is kept unless another level fits
better by more than **0.35 orders**, so panning along a boundary does not flip
back and forth. Where a projection stretches the map more one way than the
other, the coarser of the two directions counts, so cells are never smaller
than the target. A flat projection also stretches the map unevenly from place
to place, so away from the point below the camera the cells can be larger or
smaller on screen than the target.

A level switch keeps the view: the level on screen stays until the next one
has loaded and then replaces it in one frame. Triangular grids rebuild their
mesh first and are blank while the next level loads.

## Loading only what is in view

Regular lat/lon grids (one-dimensional `lat` and `lon` axes, not rotated or
projected) and nested HEALPix grids do not fetch a large level whole. A level
with more than **12 · 4^8 ≈ 786 000 cells** is loaded as the part the camera
sees plus a margin of half the view on every side:

- **Regular lat/lon:** an index window on both axes, requested as a slice.
  Zarr fetches only the chunks the slice touches. A window across the seam of
  a global longitude axis is fetched as two slices and stitched; around a
  pole the window takes every longitude and reads every n-th column.
- **HEALPix:** blocks of 4^6 cells, six orders above the level, which are
  contiguous in nested order and a square on their face. A dense level reads
  them by index. A level with a `cell` coordinate must store it in ascending
  nested order; the coordinate is then searched chunk by chunk and never read
  whole. Every chunk is checked as it is read, and a coordinate found out of
  order makes the level load whole.

The window is reloaded in place once the view leaves it; moving inside it
fetches nothing. While the camera keeps moving, a window that is already
loading is shown before the next one is requested. With a level picked by
hand that is too fine for the view, the window is cut down to the budget
around the point below the camera.

The coarsest level is the exception: it is always loaded whole. It is drawn
under a finer level wherever that level has no cells on screen (outside its
window, or outside the region it covers): the level marks the stencil buffer
where it draws a cell and the coarsest level is drawn after it, only where
nothing is marked, so it never shows through a translucent grid. A cell
that is not drawn (no value, or hidden at or beyond a bound of the colour
range) marks nothing either, so the coarsest level shows through it: along
a coastline or at a threshold, coarse cells fill the gaps of the finer
level. By default the colour range and histogram are taken from the
coarsest level, so colours do not shift as the view moves or the level
changes (see the toggles below). A pyramid
whose levels do not state their resolution has no known coarsest level, and
loads every level whole.

A level that is loaded by view can be of any size, so automatic selection has
no cap for it. Streamlines and the volume layer read the whole level: while
either is on, the cap below applies and levels up to it are loaded whole.

HEALPix levels in ring order or with an unsorted `cell` coordinate, rotated
and projected regular grids, and the other grid types load every level whole.
Every timestep then fetches and decodes as many values as the level has
cells, so automatic selection never picks such a level with more than
**12 · 4^10 ≈ 12.6 million cells** (about 50 MB of Float32 per timestep); a
sparse regional level counts only the cells it stores. A level whose cell
count is unknown is counted as a square grid as wide and as tall as the
equator at its resolution, `(2πR / resolution)²`, which is never less than a
global grid of that resolution holds. Finer levels remain available through
the manual picker.

Choosing a level in the **Variable** card turns automatic selection off; the
"Pick the level from the zoom" checkbox turns it back on.

## Whole levels and the colour range

Two checkboxes under the level list, independent of each other:

- **Load whole level** (off by default) loads the selected level whole
  instead of the part in view, and reloads it in place when toggled.
  Automatic selection keeps the 12 · 4^10 cap above, so it picks a coarser
  level where the view would need a larger one; a level over the cap can
  still be picked by hand, marked as having too many cells.
- **Keep one colour range across levels** (on by default) takes the range
  and histogram of every level from the coarsest level. Off, each level
  takes its own: the whole level's when it is loaded whole, else the loaded
  window's, which changes when the window reloads (the same view always
  gives the same colours). The Custom bounds fix a range by hand.

The range checkbox defaults to off for a variable whose CF `cell_methods`
sum over its cells (`area: sum` or `cell: sum`, also among other entries,
as in `time: mean area: sum`): such a sum grows about 4× per HEALPix level,
so a range shared from the coarsest level squeezes every finer one. The
attribute is read from the level on screen. Once the checkbox is changed,
that choice holds for every variable of the dataset until another dataset
is opened; set back to the default of the variable shown, it follows each
variable's default again.

Below the colour bounds, a hint says where the range and histogram come
from: "coarsest level" when it was taken from the coarsest level, "loaded
area" for a level loaded by view with its own range. There is none when
the range is the whole level's own, on the coarsest level itself, or for a
dataset or variable without levels.

## Levels in the URL

Variables are named by their path from the opened group, level group
included (`0/tas`, `multiscales/zoom_0/pr`), as for a dataset without
levels, so the varname in the URL says which level is shown, and a level
switch rewrites it. A link opens on the level its varname names; with
automatic selection on, that level stays unless the screen calls for
another (outside the hysteresis above). Automatic selection that is off is
written as `levelauto=false`, and such a link stays on its level; it is
honoured only when the varname names a level. "Load whole level" is
written as `levelwhole=true` when on, and the range checkbox as
`levelshared=true` or `levelshared=false` when it differs from the default
of the variable shown; both are read back when a link opens. A bare name
from an older
link (`pr`) opens on the level it is found in first.

Automatic selection, and the level list, skip levels that lack the variable
shown. A presenter display that picks its own level keeps doing so and shows
the controller's variable on that level.

The **Dataset Info** panel lists the attributes of every group from the
opened one down to the level shown: the root, the group carrying
`multiscales` (with the attribute itself) and the level group.
