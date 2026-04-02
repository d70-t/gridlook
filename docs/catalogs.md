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
- `tag`: optional short label shown in the catalog list
- `description`: optional longer text used in the catalog list and search

Example:

```json
{
  "type": "gridlook_catalog",
  "title": "My Gridlook Catalog",
  "datasets": [
    {
      "title": "ICON Daily Mean",
      "url": "https://example.org/icon/daily_mean.zarr",
      "tag": "healpix",
      "description": "Daily mean atmosphere output on the native grid."
    },
    {
      "title": "AWI Ocean",
      "url": "https://example.org/awi/ocean.zarr",
      "tag": "irregular"
    }
  ]
}
```

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

## Sharing Links with a Catalog

When a dataset is opened from a catalog, Gridlook keeps the catalog URL in the hash using the `catalog` parameter. This allows shared links to reopen the same dataset while preserving the catalog context.

Example:

```text
#https://example.org/icon/daily_mean.zarr::catalog=https%3A%2F%2Fexample.org%2Fgridlook%2Fcatalog.json
```

## Notes

- `tag` is only used for display and sorting in the catalog panel.
- `description` is shown in the catalog panel and is also included in search.
- Use dataset URLs that Gridlook can already open directly.
- Absolute HTTPS URLs are the safest choice for catalog entries.
