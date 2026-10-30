# Data Sources

Gridlook opens remote datasets by their URL:

```text
https://gridlook.pages.dev/#<DATASET_URL>
```

Supported are Zarr v2 and v3 stores, Icechunk repositories, Kerchunk reference
files and NetCDF files. The server has to allow cross-origin browser requests,
see [CORS & Hosting Notes](../README.md#cors--hosting-notes).

## Forcing the data type

Gridlook detects the data type of a URL by probing it. To skip probing, or when
the detection guesses wrong, prefix the URL with the type:

| Prefix       | Data type                                                                        |
| ------------ | -------------------------------------------------------------------------------- |
| `zarr2+`     | Zarr v2                                                                          |
| `zarr3+`     | Zarr v3                                                                          |
| `icechunk+`  | Icechunk repository                                                              |
| `netcdf+`    | NetCDF file                                                                      |
| `reference+` | [Kerchunk](https://fsspec.github.io/kerchunk/spec.html) reference file (`.json`) |

For example:

```text
https://gridlook.pages.dev/#netcdf+https://example.org/data/file
```

The "Data type" field in the advanced settings of the "Open dataset" dialog
adds the prefix for you.

## Remote NetCDF files

URLs ending in `.nc`, `.nc4` or `.cdf` are recognized as NetCDF files
automatically; for other URLs, add the `netcdf+` prefix.

The file is read in the browser via WebAssembly with HTTP `Range` requests, so
only the parts that are needed are downloaded. For this, the server has to:

- allow cross-origin requests,
- support `Range` requests,
- report the file size, either as `Content-Length` on a `HEAD` request or as
  `Content-Range` on a ranged `GET`. Cross-origin, `Content-Range` is only
  readable if the server lists it in `Access-Control-Expose-Headers`.

If the server ignores `Range` requests, the whole file is downloaded once. This
is limited to files up to 4 GiB; larger files fail to open. Download them
instead and open them as a local NetCDF file.

## Authentication

The advanced settings of the "Open dataset" dialog can send a bearer token,
custom HTTP headers and cookies with the data requests, e.g. for datasets that
need authentication. They are kept in memory only and never added to the URL,
so they have to be entered again after a page reload.

Cookies are only sent to other origins if the server allows credentials via
CORS (`Access-Control-Allow-Credentials: true` and an
`Access-Control-Allow-Origin` that names the origin instead of `*`).
