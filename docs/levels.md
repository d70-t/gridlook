# Multi-resolution datasets

Gridlook can open a dataset that ships the same variables at several
resolutions and pick the resolution to render from the camera. Internally a
dataset is a list of _levels_; single-resolution datasets have exactly one and
behave as before.

## How levels are discovered

- **`multiscales` attribute.** When the root group (or the group a URL points
  at) carries a `multiscales` attribute, each entry it declares becomes one
  level, read from the named child group. Three layouts are understood:
  - OME-NGFF: `multiscales[0].datasets[].path` (0.4), or the same under
    `ome.multiscales` (0.5), listed finest first. A `scale` coordinate
    transformation together with `axes` that carry a length unit (`degree`,
    `metre`, `km`) gives the level's ground resolution.
  - [zarr-conventions `multiscales`](https://github.com/zarr-conventions/multiscales):
    `multiscales.layout[].asset`, taken in the order declared, which has to be
    finest first. The `transform.scale` of a layout entry is relative to
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
  `lon` coordinate on a regular grid. Every level also records how many cells it holds: the length of its spatial
  dimensions (`cell` for HEALPix, sparse or not; `lat · lon` or `y · x` on a
  regular grid).
- **JSON index.** An index file may list several `levels`, each with its own
  `datasources`, and may state `resolution` (metres per cell) and `cellCount`
  per level.

Levels without a resolution are still selectable by hand, but the camera
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
window, or outside the region it covers), and the colour range and histogram
are taken from it, so colours do not shift as the view moves or the level
changes. A pyramid whose levels do not state their resolution has no known
coarsest level, and loads every level whole.

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
"Pick the level from the zoom" checkbox turns it back on. The selected level
is not part of the shareable URL.
