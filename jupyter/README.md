# gridlook-jupyter

A jupyter-server extension that serves the built [gridlook](../README.md) viewer inside a
JupyterHub/Jupyter environment, plus a **streaming S3 byte-range proxy** so the browser can read
private buckets through the hub's credentials — credentials never reach the browser, and the
buckets never need to be public.

The same wheel carries a **JupyterLab extension** (`jupyterlab-gridlook`, under
[`labextension/`](labextension/)): a launcher card and an **Open with Gridlook** entry in the
file browser's context menu, both opening the viewer in a Lab tab
([d70-t/gridlook#214](https://github.com/d70-t/gridlook/issues/214)).

## Install

```bash
pip install ./jupyter        # from a gridlook checkout — needs node >= 24 on PATH
# or
pip install gridlook_jupyter-<version>-py3-none-any.whl
```

The wheel embeds the built Vite app as package data and the prebuilt Lab extension as
shared data (`share/jupyter/labextensions/jupyterlab-gridlook/`). **Building the wheel requires
node/npm** — the build hook ([`hatch_build.py`](hatch_build.py)) runs `npm ci && npm run build`
at the repo root and copies `dist/` into the wheel, then `jlpm install && jlpm build:prod` in
`labextension/` (jlpm comes from `jupyterlab`, a build-time-only requirement in
`build-system.requires`; an isolated build fetches it). Installing a pre-built wheel needs
neither. Both halves auto-enable on install — the server extension via
`jupyter_server_config.d`, the Lab extension as a prebuilt labextension with its
`install.json` — so there is no `jupyter labextension develop` step for users. Runtime
dependencies are `jupyter-server`, `obstore` and `boto3`.

The sdist is **source-only**: the hook needs the frontend sources one directory up, which the
sdist does not carry, so a wheel cannot be built from it. Build the wheel from a repository
checkout (`uv build --wheel jupyter`, or `pip install ./jupyter`); `uv build jupyter` without
`--wheel` builds the wheel from the sdist and fails for this reason.

Editable installs (`pip install -e ./jupyter`) skip both frontend builds — point
`GridlookProxy.static_dir` at a locally built `dist/` and `jupyter labextension develop` the
built extension instead (see [Development](#development)).

## Launch

In JupyterLab, either:

- the **Gridlook** launcher card (under _Other_; also in the command palette) — opens the
  viewer in a Lab tab on its start page, where any dataset URL can be pasted (including
  `s3://…` through the proxy, see below);
- **right-click a directory or a `.zarr` entry in the file browser → Open with Gridlook** —
  opens the viewer in a Lab tab on that store. The tab holds an iframe on

  ```
  <base>/gridlook/#<base>/files/<path>
  ```

  i.e. the extension-served viewer with the store handed over in the hash as a URL under
  jupyter's own `/files/` handler, so it is read with the user's session — anything the user
  can see in the file browser (home directory, mounted shares) opens this way.

The URL form still works without Lab (Jupyter Server alone, notebook 7, a bookmark):

```
<your-server-base>/gridlook/
```

e.g. on a hub: `https://hub.example.org/user/<you>/gridlook/`, optionally with a
`#<dataset-url>` hash.

### Stores opened through `/files/` need consolidated metadata

`/files/` serves single files and **cannot list a directory**, so the viewer can only
discover a store's arrays from consolidated metadata: a zarr **v3** root `zarr.json` carrying a
`consolidated_metadata` block, or a **v2** `.zmetadata`. Write stores with
`zarr.consolidate_metadata(path)` (zarr-python) or `ds.to_zarr(path, consolidated=True)`
(xarray); an unconsolidated store opens to "Failed to fetch index". This is a property of the
handler, not something the extension works around.

The viewer also has to detect a grid from that metadata (see
[Supported grid types](../docs/grid-types.md)). For a regular grid, the data array's
`dimension_names` must name `lat`/`lon` coordinate arrays, which carry CF `units`
(`degrees_north`/`degrees_east`); a HEALPix store carries a `dggs` block instead. A bare array
with neither opens the viewer but fails with "Could not determine grid type". A minimal store
that opens, with zarr-python 3:

```python
import numpy as np
import zarr

root = zarr.create_group("example.zarr", zarr_format=3)
root.create_array(
    "lat",
    data=np.linspace(-89, 89, 90),
    dimension_names=("lat",),
    attributes={"units": "degrees_north"},
)
root.create_array(
    "lon",
    data=np.linspace(-179, 179, 180),
    dimension_names=("lon",),
    attributes={"units": "degrees_east"},
)
root.create_array("t", data=np.zeros((90, 180), "f4"), dimension_names=("lat", "lon"))
zarr.consolidate_metadata("example.zarr")
```

### The viewer stays served by the server extension

The Lab tab embeds the SPA at `<base>/gridlook/`, **not** a copy under the labextension's
static directory or a page under `/files/`, for three reasons:

- **one build** — the wheel carries the viewer once, as the server extension's package data;
  the same `/gridlook/` also serves the S3 proxy the app fetches from.
- **the server extension's own policy** — `extension.py` serves the SPA through
  `SpaFileHandler` under jupyter's ordinary content-security policy
  (`frame-ancestors 'self'`). A copy under `/files/` would not work: jupyter serves user files
  with `sandbox allow-scripts`, which gives the document an opaque origin, so the app's own
  module scripts and every same-origin fetch (the `/files/` store, the S3 proxy) fail CORS
  with `Origin: null`, and IndexedDB is denied.
- **one URL everywhere** — `<base>/gridlook/#<dataset-url>` works the same outside Lab
  (Jupyter Server alone, notebook 7, a bookmark).

Keep it that way when changing how the app is served.

### Reserved: iframe `postMessage` seam

The iframe is the natural seam for parent → viewer control — camera and parameters
([d70-t/gridlook#133](https://github.com/d70-t/gridlook/issues/133)) and bearer tokens
handed over by `postMessage` instead of the URL
([d70-t/gridlook#56](https://github.com/d70-t/gridlook/issues/56)). Neither is implemented;
the extension only creates the `<iframe>` (`labextension/src/index.ts`).

## Routes

| Route                         | What                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/gridlook/`                  | the static gridlook SPA                                                                                                                                        |
| `/gridlook/api/health`        | tiny JSON probe (`{"extension": "gridlook-jupyter", "labextension": "jupyterlab-gridlook", ...}`; `labextension` is `null` when the Lab half is not installed) |
| `/gridlook/s3/<bucket>/<key>` | streaming S3 proxy — GET/HEAD only, `Range` pass-through (206), no LIST                                                                                        |

## Configuration

Allowlist-only auth: **the proxy is disabled until you configure buckets.** Requests for
non-allowlisted buckets get a 403 naming the bucket; with an empty allowlist every proxy request
gets a 403 saying the proxy is disabled.

Via traitlets (`jupyter_server_config.py`, or `--GridlookProxy.…` on the command line):

```python
c.GridlookProxy.allowed_buckets = ["my-bucket"]
c.GridlookProxy.region = "us-west-2"  # optional; ambient AWS config otherwise
c.GridlookProxy.static_dir = "/path/to/dist"  # optional; dev override for the SPA files
```

Or environment variables (used only when the trait is not configured):

```bash
export GRIDLOOK_ALLOWED_BUCKETS="my-bucket,another-bucket"
export GRIDLOOK_S3_REGION="us-west-2"
```

S3 credentials are resolved through botocore (the same chain as the AWS CLI: `AWS_PROFILE`
and the shared config, SSO, instance/pod roles, web identity, plain `AWS_*` env), with
expiring tokens refreshed. A bucket the chain cannot sign for fails the request loudly
rather than falling back to an unsigned read: the proxy answers 502 with the reason. The
proxy streams responses chunk-by-chunk and never buffers whole objects; there are no presigned
URLs, so nothing credential-shaped is ever exposed to the browser.

## `s3://` inputs in the app

Point the app at the proxy path as the dataset URL — `<base>/gridlook/s3/<bucket>/<prefix>` —
for an allowlisted bucket; it is a plain HTTP zarr source to the viewer.

## Development

Create the venv **outside the checkout**: the repo root `package.json` declares
`"type": "module"`, and node then loads jlpm's bundled `yarn.js` as an ES module (and fails)
from any venv nested under it.

```bash
uv venv ~/.venvs/gridlook && source ~/.venvs/gridlook/bin/activate
uv pip install -e "./jupyter[test]" "jupyterlab>=4" ruff
pytest jupyter/tests -v
ruff check jupyter/gridlook_jupyter jupyter/tests jupyter/hatch_build.py
# run against a dev-built frontend:
npm run build   # at the repo root
jupyter server --GridlookProxy.static_dir="$(pwd)/dist" --GridlookProxy.allowed_buckets='["my-bucket"]'
```

Tests exercise the proxy against an obstore `LocalStore` via the `GridlookProxy.store_factory`
seam — no real S3 needed.

The Lab extension (editable install; the wheel build does all of this itself):

```bash
cd jupyter/labextension
jlpm install
jlpm test                # jest: URL construction (src/urls.ts), tab reuse (src/tabs.ts)
jlpm build               # tsc + `jupyter labextension build` -> ../gridlook_jupyter/labextension/
jupyter labextension develop --overwrite ../     # symlink it into share/jupyter/labextensions/
jupyter lab              # launcher card + "Open with Gridlook" in the file browser
```

`jlpm watch` rebuilds `lib/` on change; rerun `jlpm build:labextension:dev` (or `jlpm build`)
to refresh the prebuilt bundle, then reload Lab.
