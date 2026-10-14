"""Wires the gridlook routes into a running jupyter-server."""

import re
from pathlib import Path

from jupyter_server.auth.decorator import allow_unauthenticated
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.utils import url_path_join
from tornado import web

from .config import GridlookProxy
from .handlers import HealthHandler, S3ProxyHandler

# jupyterhub/singleuser/extension.py sets "frame-ancestors 'none'"; the legacy
# singleuser mixin (JUPYTERHUB_SINGLEUSER_EXTENSION=0) appends ";report-uri <hub>".
HUB_DEFAULT_CSP = re.compile(r"frame-ancestors 'none'(;report-uri \S+)?")


class SpaFileHandler(JupyterHandler, web.StaticFileHandler):
    """Serve the built SPA the way JupyterLab serves its own bundle.

    Like Lab's ``/static/`` and ``/lab/extensions/``, the assets need no login.
    That matters under JupyterHub: the page's ``<script type="module">`` and
    ``crossorigin`` stylesheets are CORS-mode requests, and the hub ignores the
    session cookie on those unless they carry an XSRF token, so behind an
    authenticated handler every asset is bounced into the OAuth flow. The
    bundle is the extension's public code; the data routes (``/files/``, the S3
    proxy) stay authenticated.

    The document itself does need login, like any Lab page: an anonymous
    visitor goes to the login, and serving it sets the ``_xsrf`` cookie the
    viewer adds to its data fetches. The hub sets that cookie only on a page
    navigation that reads ``xsrf_token``, and it lasts one browser session, so a
    bookmarked ``/gridlook/`` must set it rather than rely on Lab having run.

    It also avoids ``AuthenticatedFileHandler``'s ``sandbox allow-scripts``,
    meant for user-authored files: under it the document gets an opaque
    origin, so same-origin fetches fail CORS with ``Origin: null`` and
    IndexedDB is denied. The JupyterLab extension embeds this route in its
    iframe, so jupyterhub-singleuser's default ``frame-ancestors 'none'`` is
    relaxed to ``'self'``, plain jupyter-server's default. Any other policy —
    one a hub admin configured — is served unchanged.
    """

    @allow_unauthenticated
    def get(self, path, include_body=True):
        if path in ("", "index.html"):
            return self._get_document(path, include_body)
        return super().get(path, include_body)

    @web.authenticated
    def _get_document(self, path, include_body):
        self.xsrf_token  # noqa: B018 -- reading it sets the _xsrf cookie
        return super().get(path, include_body)

    def set_headers(self):
        super().set_headers()
        # Revalidate every file, as jupyter's own file handler does: a cached
        # index.html would point at hashed assets a wheel upgrade removed.
        self.set_header("Cache-Control", "no-cache")

    @allow_unauthenticated
    def head(self, path):
        return super().head(path)

    @property
    def content_security_policy(self):
        policy = super().content_security_policy
        # ponytail: exact match on the hub default, so an admin who sets this same string
        # on purpose is relaxed too; telling them apart would need the hub's config.
        match = HUB_DEFAULT_CSP.fullmatch(policy)
        if match:
            return "frame-ancestors 'self'" + (match[1] or "")
        return policy


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
