# Changelog

## 1.0.0 (2026-04-30)


### Features

* **config:** added changelog for previous PRs ([e2eb2e8](https://github.com/d70-t/gridlook/commit/e2eb2e862046901f1db78df78d09f98a844727a1))
* **lib:** added functionality to make min-bound values transparent ([230d01e](https://github.com/d70-t/gridlook/commit/230d01efa66ef9ffc22f63c26cdf50cff2291ae2))
* **lib:** URL-Camerastate is now compressed via fflate. Backwards-compatibility is ensured ([2ee270d](https://github.com/d70-t/gridlook/commit/2ee270d94fc95a04b3d51576bd17ead469c539c3))
* **ui:** Added Catalog-Feature ([48c304a](https://github.com/d70-t/gridlook/commit/48c304af5c261d1391e6af3ea1f3c743edf92068))
* **ui:** added distraction free-mode controllable via URL ([a376c61](https://github.com/d70-t/gridlook/commit/a376c617a7275a220bf8c658de33d7aed72f4945))
* **ui:** added information for coordinates and dimensions into Dataset Info ([b4899bf](https://github.com/d70-t/gridlook/commit/b4899bf7e74e3effe9957f9cdea85dc2b6716a34))
* **ui:** added possibility to change resolution for snapshots ([c40d835](https://github.com/d70-t/gridlook/commit/c40d835b49059b83bf038f66396b257bd67efb50))
* **ui:** added QR-Code to the share button ([15fed7e](https://github.com/d70-t/gridlook/commit/15fed7eb9b444d397b582699231edda8d2273f14))


### Bug Fixes

* **lib:** fixed broken cellCoords for Healpix ([7d4464f](https://github.com/d70-t/gridlook/commit/7d4464f2ec13f49d4196a1e146777d965b80015e))
* **lib:** fixed broken dimension value information, when the value is a string ([3ea3c64](https://github.com/d70-t/gridlook/commit/3ea3c64782b5ad24ebc8cc1a9fe028f0658fc505))
* **lib:** fixed broken time info when time dimension is not at first pos ([0115aaa](https://github.com/d70-t/gridlook/commit/0115aaa4739154e18dbc9e23c6cf3b4bbe853d16))
* **lib:** fixed noisy filled values under windows ([9c52b38](https://github.com/d70-t/gridlook/commit/9c52b38056801137706724c6b02e0f01cb4a12c1))
* **lib:** fixed occasionally disappearing coastlines when zooming ([c63a62a](https://github.com/d70-t/gridlook/commit/c63a62a2b5e228cd6be216c81055290a87e2d334))
* **lib:** projections no longer disappear on certain zoom-levels ([b18d5c7](https://github.com/d70-t/gridlook/commit/b18d5c7845f0cecf26fa43f67353db86b978139c))
* **lib:** sharper and faster land/sea-mask ([e484f1f](https://github.com/d70-t/gridlook/commit/e484f1f918866ef13ef4698d5adc9b0a2d3fe936))
* **ui:** fixed hidden bottom control elements on mobile devices ([cb495eb](https://github.com/d70-t/gridlook/commit/cb495eb7d90689c6cd169c28e907891b24e1e9f7))
* **ui:** fixed name truncation for colormap selector in Chrome ([86f0156](https://github.com/d70-t/gridlook/commit/86f0156f16e1a330e3d99af14f3b2603f4203dab))
* **ui:** fixed prematurely cancelled inertia animation ([5a1daa2](https://github.com/d70-t/gridlook/commit/5a1daa2bc383b26ab7bc58f36463096b424c1369))
* **ui:** graticules and coastlines are now visible even when mask is enabled ([5ea1526](https://github.com/d70-t/gridlook/commit/5ea15265bf863ebce10cdac0fe22ee2e60398b56))

## Pre-Versioning Changelog

For the period covered below, this changelog was organized in a conventional-commit-inspired format, inferred from merge request and pull request titles rather than commit messages.

Because the project did not use version tags yet, entries were grouped by month instead of release version. Category assignments were approximate when a PR title spanned more than one conventional-commit type.

## 2026-03

### Features

- [#111](https://github.com/d70-t/gridlook/pull/111) Presenter Mode
- [#105](https://github.com/d70-t/gridlook/pull/105) Hover Values
- [#103](https://github.com/d70-t/gridlook/pull/103) Hyperglobe-Support and License
- [#102](https://github.com/d70-t/gridlook/pull/102) Redesign
- [#101](https://github.com/d70-t/gridlook/pull/101) Info Panel improvement and more data compatibility
- [#100](https://github.com/d70-t/gridlook/pull/100) Distribution Plot and Ranged Sliders

### Fixes

- [#104](https://github.com/d70-t/gridlook/pull/104) Moved CoastLine/GeoJson-Calculation into WebGL

## 2026-02

### Features

- [#98](https://github.com/d70-t/gridlook/pull/98) Support for Zarr V3
- [#97](https://github.com/d70-t/gridlook/pull/97) Posterization and Histogram
- [#93](https://github.com/d70-t/gridlook/pull/93) Added way to switch between rendering methods, if grid type allows it

### Fixes

- [#99](https://github.com/d70-t/gridlook/pull/99) Better Grid-Compatibility
- [#96](https://github.com/d70-t/gridlook/pull/96) Fixed Projections

## 2026-01

### Features

- [#92](https://github.com/d70-t/gridlook/pull/92) Info panel
- [#91](https://github.com/d70-t/gridlook/pull/91) Share button
- [#89](https://github.com/d70-t/gridlook/pull/89) Datetime Picker
- [#86](https://github.com/d70-t/gridlook/pull/86) Time handling
- [#85](https://github.com/d70-t/gridlook/pull/85) Open new dataset -> Modal
- [#84](https://github.com/d70-t/gridlook/pull/84) Inertia
- [#80](https://github.com/d70-t/gridlook/pull/80) Added Data Input Form
- [#88](https://github.com/d70-t/gridlook/pull/88) Caching

### Fixes

- [#81](https://github.com/d70-t/gridlook/pull/81) Refactoring and smaller bug fixes

## 2025-12

### Features

- [#75](https://github.com/d70-t/gridlook/pull/75) Rotation on flat projections
- [#74](https://github.com/d70-t/gridlook/pull/74) Added Projections
- [#72](https://github.com/d70-t/gridlook/pull/72) Added Debug-Panel
- [#70](https://github.com/d70-t/gridlook/pull/70) Implemented varying Dimensions

### Fixes

- [#69](https://github.com/d70-t/gridlook/pull/69) Updated Controls

## 2025-11

### Features

- [#68](https://github.com/d70-t/gridlook/pull/68) Curvilinear grid
- [#67](https://github.com/d70-t/gridlook/pull/67) Optional time
- [#62](https://github.com/d70-t/gridlook/pull/62) Irregular Grid changes
- [#61](https://github.com/d70-t/gridlook/pull/61) Gaussian reduced
- [#59](https://github.com/d70-t/gridlook/pull/59) Shuffle Codec
- [#53](https://github.com/d70-t/gridlook/pull/53) Dimension sliders
- [#50](https://github.com/d70-t/gridlook/pull/50) Land sea mask

### Fixes

- [#66](https://github.com/d70-t/gridlook/pull/66) Missing values
- [#52](https://github.com/d70-t/gridlook/pull/52) Error logging: write errors to console, including traceback

## 2025-10

### Features

- [#48](https://github.com/d70-t/gridlook/pull/48) Added About Modal

## 2025-07

### Fixes

- [#39](https://github.com/d70-t/gridlook/pull/39) Regular Grid fixes

## 2025-06

### Features

- [#33](https://github.com/d70-t/gridlook/pull/33) Irregular grid

## 2025-05

### Features

- [#28](https://github.com/d70-t/gridlook/pull/28) Responsive design
- [#23](https://github.com/d70-t/gridlook/pull/23) Regular grid
- [#22](https://github.com/d70-t/gridlook/pull/22) Include standard name
- [#20](https://github.com/d70-t/gridlook/pull/20) Add very simple dark theme support
- [#17](https://github.com/d70-t/gridlook/pull/17) Include standard_name
- [#15](https://github.com/d70-t/gridlook/pull/15) On the fly index
- [#14](https://github.com/d70-t/gridlook/pull/14) Healpix par
- [#12](https://github.com/d70-t/gridlook/pull/12) Healpix
- [#10](https://github.com/d70-t/gridlook/pull/10) Zarrita

### Fixes

- [#30](https://github.com/d70-t/gridlook/pull/30) The responsive-PR introduced some annoying border-shadows
- [#26](https://github.com/d70-t/gridlook/pull/26) CRS detection: allow differently named crs variables
- [#16](https://github.com/d70-t/gridlook/pull/16) be more forgiving when detecting healpix crs

## 2024-08

### Features

- !4 Rotating Earth

## 2022-05

### Features

- !1 Visible defaults
