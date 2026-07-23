# Gridlook Controls

This page documents Gridlook keyboard, mouse, and touch controls.

## Keyboard Shortcuts

These shortcuts are active in the main viewer.

- <kbd>r</kbd>: start or stop auto-rotation
- <kbd>d</kbd>: toggle distraction-free mode
- <kbd>g</kbd>: switch to the Hyperglobe preset
- <kbd>h</kbd>: open the Hyperglobe presenter view in a second window on desktop

Notes:

- These shortcuts are disabled on the second screen of the presenter mode
- They are ignored while typing in an input, textarea, or select field

## Keyboard Navigation

The arrow keys (<kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd>), <kbd>+</kbd> and <kbd>-</kbd> are handled by the focused canvas area.

If the canvas does not react to keyboard navigation, click the viewer once to focus it.

### Nearside Perspective

In the default 3D globe view:

- Arrow keys rotate the globe
- <kbd>+</kbd> zooms in
- <kbd>-</kbd> zooms out

### Flat Projections

In flat projections such as Equirectangular, Mercator, Robinson, or Mollweide:

- Arrow keys pan the map
- <kbd>+</kbd> zooms in
- <kbd>-</kbd> zooms out

## Mouse Controls

Mouse behavior depends on the current projection.

### Nearside Perspective

- Left drag rotates the globe
- Mouse wheel zooms
- Right drag pans the camera target

If `Data Picker` is enabled, moving the pointer over the canvas also shows the value under the cursor.

### Flat Projections

- Left drag pans the map
- Mouse wheel zooms
- Right drag changes the projection center

For flat projections, the projection center can also be adjusted numerically in the side panel.

## Touch Controls

Touch behavior also depends on the current projection.

### Nearside Perspective

- One-finger drag rotates the globe
- Pinch zooms

### Flat Projections

- One-finger drag changes the projection center

## Flow Streamlines

Gridlook detects matching `u`/`v`, `ua`/`va`, or `uas`/`vas` variable pairs on
regular, curvilinear, reduced Gaussian, HEALPix, triangular, and irregular
grids. Streamlines are disabled by default; use **Enable streamlines** in the
**Flow** menu or the visibility button on the **Flow streamlines** layer to
start them. The **Flow** menu can instead assign any compatible eastward/x and
northward/y component, including ocean-current variables. The animated
particles follow cached trajectories through the steady vector field at the
currently selected time and level. Adaptive RK4/3 integration runs when that
field changes, not on every animation frame. Dense, short traces fade in and
out. The layer panel can hide, reorder, or adjust their opacity.

## Notes

- Presenter mode is only available on desktop
- Hover-based value inspection depends on the `Data Picker` action being enabled
