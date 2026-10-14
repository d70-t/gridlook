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

## Shareable Camera Parameters

The URL represents a view with five projection-independent camera parameters:

- `lat` and `lon` are the projection center in degrees
- `alt` is the camera height above the spherical Earth surface at that center, in metres
- `px` and `py` are horizontal and vertical camera-plane offsets in projected metres

Positive `px` moves right in the projection plane and positive `py` moves up.
Gridlook models Earth as a sphere with the IUGG mean radius of
`6,371,008.8 m`. For the globe, `alt` is the camera's radial distance minus
that radius. For flat projections it is the conceptual camera's perpendicular
height above the projection plane. Consequently, the same `alt` remains the
same physical height when changing projections; local map distortion can still
make ground resolution differ between projection types.

The main view uses a fixed `7.5°` vertical field of view. For example, at an
`alt` of `6,000,000 m`, the corresponding tangent plane spans approximately
`787 km` vertically before accounting for globe curvature or the viewport's
aspect ratio.

## Touch Controls

Touch behavior also depends on the current projection.

### Nearside Perspective

- One-finger drag rotates the globe
- Pinch zooms

### Flat Projections

- One-finger drag changes the projection center

## Flow Streamlines

Gridlook detects matching `u`/`v`, `ua`/`va`, `uas`/`vas`, or `u10`/`v10`
variable pairs on regular, curvilinear, reduced Gaussian, HEALPix, triangular,
and irregular grids. Streamlines are disabled by default; use the visibility
button on the **Flow streamlines** layer to start them. Enabling the layer also
reveals its U and V menus, which can assign any compatible eastward/x and
northward/y component, including ocean-current variables. The animated
particles follow cached trajectories through the steady vector field at the
currently selected time and level. Adaptive RK4/3 integration runs when that
field changes, not on every animation frame. Dense, short traces fade in and
out. The layer panel can hide, reorder, or adjust their opacity. This state is
included in shared URLs: automatically detected components only add
`streamlines=true`, while manually selected components also add `streamlineu`
and `streamlinev`.

## Animation

On desktop, use **Animation** to prepare a time range for interactive playback
or video export. Enable the desired layers first, select the start and end
indices, then choose **Estimate preparation**. This loads one timestep to
estimate preparation time and memory. Choose **Prepare** to load the remaining
keyframes. Memory estimates are advisory; the editable reference is under
**Memory and estimate details**.

After preparation, colormap bounds switch to **Animation**, using the minimum
and maximum across the prepared range. You can choose Data or custom bounds
under Appearance → Colormap afterwards.

Once prepared, choose original timesteps, linear interpolation, or cubic
Smoothstep, then set intermediate frames and FPS. All animated layers and the
displayed timestamp use the same interpolation timing. Smoothstep slows at each
keyframe; unequal source-time gaps produce different simulated speeds because
each interval has the same number of frames. Only original scalar and volume
keyframes are retained. Interpolation and appearance changes do not require
preparing again. **Release animation** frees the prepared sequence and lets you
choose another range.

Enabled streamlines become particles following time-dependent horizontal flow
at the selected level. Particle count is set before preparation; worker count
and accuracy controls are under **Integration settings**. **Particle appearance**
controls size, opacity, fading and preview quality afterwards. Fast preview
approximates motion between keyframes; video export uses the full trajectories.

Volumes participate on their supported grids, including HEALPix, regular and
projected curvilinear grids. Their normalization stays fixed across the selected
range; preview uses fewer ray samples than export. Particles currently render on
the globe surface, while volumes use an exaggerated shell. Physical vertical
alignment and adjustable vertical scale are not yet supported.

Expand **Video export** to save H.264/MP4 or lossless FFV1/MKV, using the current
view and optional globe rotation. Labels and the colormap can be included on
the left. Dataset labels include the grid variable, enabled volume variables
and the particle velocity components. The encoded video stays in browser memory
until download; lossless files can be large. Layer order is not currently
preserved in shared URLs.

## Notes

- Presenter mode is only available on desktop
- Hover-based value inspection depends on the `Data Picker` action being enabled
