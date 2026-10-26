"""jupyter-gridlook: serve the gridlook viewer and an object-store byte-range proxy from jupyter-server."""

from importlib.metadata import version

__version__ = version("jupyter-gridlook")


def _jupyter_server_extension_points():
    return [{"module": "jupyter_gridlook"}]


def _jupyter_labextension_paths():
    # The prebuilt Lab extension next to this package (hatch_build.py output);
    # `jupyter-builder develop` symlinks it for editable installs.
    return [{"src": "labextension", "dest": "jupyter-gridlook"}]


def _load_jupyter_server_extension(serverapp):
    from .extension import load_extension

    load_extension(serverapp)


# Alias kept for older jupyter-server enable paths.
load_jupyter_server_extension = _load_jupyter_server_extension
