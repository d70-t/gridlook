# URL Parameters

Gridlook stores the dataset and the view settings in the hash part of its URL:

```text
https://gridlook.pages.dev/#<DATASET_URL>::<name>=<value>::<name>=<value>...
```

Parameters are separated by `::`. Values should be URL-encoded. Gridlook keeps
the URL up to date while you change settings, so the easiest way to get a valid
set of parameters is to configure the view in Gridlook and copy them from the
address bar.

| Parameter                                  | Meaning                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `varname`                                  | Variable to show                                                             |
| `colormap`                                 | Colormap name                                                                |
| `invertcolormap`                           | `true` to invert the colormap                                                |
| `posterizelevels`                          | Number of discrete colormap levels                                           |
| `hidelowerbound`, `hideupperbound`         | `true` to hide values below/above the colormap range                         |
| `boundlow`, `boundhigh`                    | User-defined colormap range                                                  |
| `dimIndices_<dim>`                         | Index of dimension `<dim>`, e.g. `dimIndices_time=12`                        |
| `dimMinBounds_<dim>`, `dimMaxBounds_<dim>` | Range of the slider of dimension `<dim>`                                     |
| `projection`                               | Map projection, e.g. `mollweide` or `robinson`                               |
| `lat`, `lon`                               | Center of the projection                                                     |
| `px`, `py`, `alt`                          | Camera position                                                              |
| `layers`                                   | Layer stack, see [`layerUrlState.ts`](/src/store/layerUrlState.ts)           |
| `gridtype`                                 | Force a grid type instead of auto-detection, see [Grid types](grid-types.md) |
| `distractionFree`                          | `true` to hide the controls                                                  |
| `live`                                     | `true` to follow a live dataset, see [Live datasets](live-datasets.md)       |
| `catalog`                                  | URL of the [catalog](catalogs.md) shown in the "Open dataset" dialog         |
| `basemapcatalog`                           | URL of the basemap catalog                                                   |

Example that opens a dataset with a fixed variable, colormap and time step:

```text
https://gridlook.pages.dev/#https://example.org/icon/daily_mean.zarr::varname=tas::colormap=viridis::dimIndices_time=12
```

In a [catalog](catalogs.md), put these settings into the `params` property of
an entry instead of appending them to its `url`.
