# Providing Catalogs to Gridlook

Gridlook can load either a dataset URL directly or a catalog JSON document that lists multiple datasets.

When a user enters a catalog URL in the "Open dataset" dialog, Gridlook fetches the JSON, shows the catalog entries, and lets the user open one of the listed datasets.

## Catalog Format

A Gridlook catalog is a JSON document with:

- `type`: must be `"gridlook_catalog"`
- `title`: optional catalog title shown in the UI
- `datasets`: array of dataset entries

Each dataset entry currently supports:

- `url`: required dataset URL
- `title`: optional display name
- `tags`: optional object of arbitrary `"key": "value"` string pairs
- `description`: optional longer text used in the catalog list and search
- `params`: optional Gridlook settings applied when the dataset is opened, as
  an object or as a string copied from the address bar, see
  [Params](#params) and [URL parameters](url-parameters.md).

Example:

```json
{
  "type": "gridlook_catalog",
  "title": "My Gridlook Catalog",
  "datasets": [
    {
      "title": "ICON Daily Mean",
      "url": "https://example.org/icon/daily_mean.zarr",
      "tags": { "grid": "healpix", "realm": "atmosphere" },
      "description": "Daily mean atmosphere output on the native grid.",
      "params": { "varname": "tas", "colormap": "viridis" }
    },
    {
      "title": "AWI Ocean",
      "url": "https://example.org/awi/ocean.zarr",
      "tags": { "grid": "irregular", "realm": "ocean" },
      "params": "varname=tos::dimIndices_time=12"
    }
  ]
}
```

### Tags

Every tag key gets its own filter dropdown in the catalog panel, labelled with
the key with its first letter capitalized (`grid` becomes "Grid"). Each value in
a dropdown shows how many datasets remain when picking it. Clicking a tag in the
list toggles that filter, and the catalog can also be sorted by any tag key.

Every tag key gets its own color, assigned in the order the keys first appear in
the catalog, so the same catalog always shows the same colors.

The older single `"tag": "healpix"` property is still accepted and treated as
`"tags": { "tag": "healpix" }`.

### Params

Gridlook settings like the variable, colormap or time step can be stored in the
URL hash (see [URL parameters](url-parameters.md)). Put them into `params`
instead of appending them to `url`: Gridlook adds them to the hash when the
dataset is opened, while `url` stays a plain dataset URL that the copy button
in the catalog panel can copy for use in other tools.

`params` can also be a string copied from the address bar, i.e. everything
after the dataset URL without the leading `::`, for example
`"varname=tas::colormap=viridis"`.

If "Keep view settings" is checked in the dialog, the kept settings take
precedence over `params`.

## Hosting Requirements

Gridlook fetches the catalog from the browser, so the catalog URL must be:

- publicly reachable from the client
- served as valid JSON
- CORS-enabled when hosted on another origin

The same browser-side access rules also apply to the dataset URLs listed inside the catalog.

## Ways to Provide a Catalog

### 1. Ship a Catalog with the App

Files in [`public/`](public) are served as static assets by Vite.

For example, if you add:

`public/static/my-catalog.json`

it will be available at:

`/static/my-catalog.json`

The current default catalog in this repository is [`public/static/catalog.json`](/public/static/catalog.json).

If you want your deployment to open a different default catalog on first load, update `DEFAULT_CATALOG` in [`src/views/HashGlobeView.vue`](/src/views/HashGlobeView.vue).

### 2. Host a Catalog Externally

You can also host the catalog anywhere else and paste its URL into the "Open dataset" dialog, for example:

`https://example.org/gridlook/catalog.json`

Gridlook will detect that the URL is a catalog, load it, and show its dataset entries in the dialog.

### 3. Open a Local Catalog

Use **Local Catalog** in the "Open" tab of the "Open dataset" dialog to
open a catalog JSON file from your computer. A local catalog is not part of
shared links, so they fall back to the default catalog.

## Sharing Links with a Catalog

When a dataset is opened from a catalog, Gridlook keeps the catalog URL in the hash using the `catalog` parameter. This allows shared links to reopen the same dataset while preserving the catalog context.

Example:

```text
#https://example.org/icon/daily_mean.zarr::catalog=https%3A%2F%2Fexample.org%2Fgridlook%2Fcatalog.json
```

## Notes

- `tags` are only used for display, filtering and sorting in the catalog panel.
- The dataset that is currently open is marked in the catalog list.
- The "Recently opened" list in the "Open" tab lists the last 20 datasets opened
  from the dialog. It is stored per browser in `localStorage`. Local NetCDF and
  Zarr datasets are not listed, because they cannot be reopened from a URL.
- `description` is shown in the catalog panel and is also included in search.
- Use dataset URLs that Gridlook can already open directly.
- Absolute HTTPS URLs are the safest choice for catalog entries.
