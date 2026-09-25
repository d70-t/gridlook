"""Wires the gridlook routes into a running jupyter-server."""

import re
from pathlib import Path

from jupyter_server.base.handlers import AuthenticatedFileHandler, JupyterHandler
from jupyter_server.utils import url_path_join
from tornado import web

from .config import GridlookProxy
from .handlers import HealthHandler, S3ProxyHandler


class SpaFileHandler(AuthenticatedFileHandler):
    """Serve the built SPA WITHOUT jupyter's ``sandbox allow-scripts`` CSP.

    ``AuthenticatedFileHandler`` appends that directive for user-authored
    files; under it the document gets an opaque origin, so the app's own
    module scripts and same-origin fetches (the ``/files/`` store, the S3
    proxy) fail CORS with ``Origin: null`` and IndexedDB is denied. The app is
    the extension's code, not user content — it gets the ordinary jupyter
    policy. The JupyterLab extension embeds this route in its iframe.
    """

    @property
    def content_security_policy(self):
        return JupyterHandler.content_security_policy.fget(self)


def load_extension(serverapp):
    proxy = GridlookProxy(parent=serverapp)
    static_dir = proxy.static_dir
    if not (Path(static_dir) / "index.html").exists():
        serverapp.log.warning(
            "gridlook-jupyter: no built SPA at %s — /gridlook/ will 404. "
            "Install from a wheel, or set GridlookProxy.static_dir to a gridlook dist/.",
            static_dir,
        )

    base = url_path_join(serverapp.base_url, "gridlook")
    escaped = re.escape(base)
    handlers = [
        (escaped + r"/api/health", HealthHandler),
        (escaped + r"/s3/([^/]+)/(.+)", S3ProxyHandler),
        (escaped + r"$", web.RedirectHandler, {"url": base + "/"}),
        (
            escaped + r"/(.*)",
            SpaFileHandler,
            {"path": static_dir, "default_filename": "index.html"},
        ),
    ]
    serverapp.web_app.settings["gridlook_proxy"] = proxy
    serverapp.web_app.add_handlers(".*$", handlers)
    serverapp.log.info(
        "gridlook-jupyter loaded: app at %s/, proxy %s",
        base,
        f"enabled for buckets {proxy.allowed_buckets}" if proxy.enabled else "disabled",
    )
