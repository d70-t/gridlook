"""gridlook-jupyter: serve the gridlook viewer and an S3 byte-range proxy from jupyter-server."""

__version__ = "0.1.0"


def _jupyter_server_extension_points():
    return [{"module": "gridlook_jupyter"}]


def _jupyter_labextension_paths():
    # The prebuilt Lab extension next to this package (hatch_build.py output);
    # `jupyter labextension develop` symlinks it for editable installs.
    return [{"src": "labextension", "dest": "jupyterlab-gridlook"}]


def _load_jupyter_server_extension(serverapp):
    from .extension import load_extension

    load_extension(serverapp)


# Alias kept for older jupyter-server enable paths.
load_jupyter_server_extension = _load_jupyter_server_extension
