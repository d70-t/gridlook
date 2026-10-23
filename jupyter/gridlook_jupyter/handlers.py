"""Tornado handlers: health endpoint and the streaming object-store byte-range proxy."""

import json
import mimetypes
import re
from pathlib import Path

import obstore
from jupyter_core.paths import jupyter_path
from jupyter_server.base.handlers import JupyterHandler
from obstore.exceptions import BaseError, NotFoundError
from tornado import web

from . import __version__
from .config import GridlookProxy

#: Single-range "bytes=" header; multi-range is not supported (RFC 9110 permits
#: ignoring the Range header, in which case the full object is served with 200).
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

_STREAM_CHUNK = 256 * 1024

#: The Lab half shipped in the same wheel (its directory under share/jupyter/labextensions/).
LABEXTENSION = "jupyterlab-gridlook"


def labextension_installed() -> bool:
    """Whether the Lab half is on a Jupyter data path (wheel shared-data or `develop` link)."""
    return any(
        Path(d, LABEXTENSION, "package.json").exists() for d in jupyter_path("labextensions")
    )


class _RangeNotSatisfiableError(Exception):
    """Raised by range parsing for a well-formed but unsatisfiable range (e.g. ``bytes=-0``)."""


def parse_range_header(header: str):
    """Map a single-range ``Range`` header to obstore get options, or None to ignore it.

    Raises :class:`_RangeNotSatisfiableError` for a syntactically valid range that can never
    be satisfied (a zero-length suffix, ``bytes=-0``).
    """
    m = _RANGE_RE.match(header.strip())
    if m is None:
        return None
    start, end = m.groups()
    if start and end:
        if int(end) < int(start):
            return None
        return (int(start), int(end) + 1)  # inclusive -> exclusive
    if start:
        return {"offset": int(start)}
    if end:
        suffix = int(end)
        if suffix == 0:  # bytes=-0 selects the last zero bytes: unsatisfiable
            raise _RangeNotSatisfiableError
        return {"suffix": suffix}
    return None


def _content_type(key: str, attributes=None) -> str:
    """Pass through the object's content-type when the store reports one, else guess."""
    try:
        for k, v in dict(attributes or {}).items():
            if str(k).lower().replace("_", "-") == "content-type":
                return str(v)
    except (TypeError, ValueError):
        pass
    guess, _ = mimetypes.guess_type(key)
    return guess or "application/octet-stream"


class HealthHandler(JupyterHandler):
    """Tiny probe endpoint; the SPA uses it to detect extension-served context."""

    @web.authenticated
    async def get(self):
        proxy: GridlookProxy = self.settings["gridlook_proxy"]
        self.set_header("Content-Type", "application/json")
        self.finish(
            json.dumps(
                {
                    "extension": "jupyter-gridlook",
                    "version": __version__,
                    "proxy_enabled": proxy.enabled,
                    # A probe for hub operators: null when the Lab half is not installed.
                    "labextension": LABEXTENSION if labextension_installed() else None,
                }
            )
        )


class PlainTextErrorMixin:
    """Surface HTTPError log messages as plain-text bodies (pointed, curl-readable)."""

    def write_error(self, status_code, **kwargs):
        exc = kwargs.get("exc_info", (None, None, None))[1]
        message = ""
        if isinstance(exc, web.HTTPError) and exc.log_message:
            message = exc.log_message
        self.set_header("Content-Type", "text/plain; charset=utf-8")
        self.finish(message or f"error {status_code}")


class StoreProxyHandler(PlainTextErrorMixin, JupyterHandler):
    """Streaming byte-range proxy: GET/HEAD only, no LIST, hub-side credentials only."""

    SUPPORTED_METHODS = ("GET", "HEAD")

    def _resolve(self, scheme: str, path: str):
        """``(store, key, url)`` for an allowlisted ``scheme://bucket/key``, else 400/403/502."""
        proxy: GridlookProxy = self.settings["gridlook_proxy"]
        url = f"{scheme}://{path}"
        if not proxy.enabled:
            raise web.HTTPError(
                403,
                "gridlook proxy is disabled: no allowed buckets are configured. "
                "Set GridlookProxy.allowed_buckets (or GRIDLOOK_ALLOWED_BUCKETS).",
            )
        found = proxy.match(url)
        if found is None:
            raise web.HTTPError(
                403,
                f"{url} is not under a store in the gridlook proxy allowlist "
                f"(GridlookProxy.allowed_buckets)",
            )
        entry, key = found
        if not key:
            raise web.HTTPError(400, f"invalid key: {url}")
        try:
            return proxy.get_store(entry), key, url
        except RuntimeError as e:
            # The store factory could not sign for an allowlisted store (no credentials):
            # an upstream-auth fault like the other store errors, so 502 with the message.
            raise web.HTTPError(502, str(e)) from e

    async def _send_range_not_satisfiable(self, store, key):
        """Emit a 416 with ``Content-Range: bytes */<size>``; head the object for the size.

        RFC 9110 §14.4 requires a numeric complete-length in the unsatisfied-range form
        (``*/*`` is not valid there), so we head the object — a single request on this cold
        error path — and only fall back to ``*/*`` if that head itself fails.
        """
        size = None
        try:
            meta = await obstore.head_async(store, key)
            size = meta["size"]
        except (BaseError, OSError, ValueError):
            pass
        self.set_status(416)
        self.set_header("Content-Type", "text/plain; charset=utf-8")
        self.set_header("Content-Range", f"bytes */{size}" if size is not None else "bytes */*")
        self.finish("range not satisfiable")

    @web.authenticated
    async def get(self, scheme, path):
        store, key, url = self._resolve(scheme, path)
        range_header = self.request.headers.get("Range")
        try:
            rng = parse_range_header(range_header) if range_header else None
        except _RangeNotSatisfiableError:
            await self._send_range_not_satisfiable(store, key)
            return
        options = {"range": rng} if rng is not None else {}
        try:
            result = await obstore.get_async(store, key, options=options)
        except (NotFoundError, FileNotFoundError) as e:
            raise web.HTTPError(404, f"no such object: {url}") from e
        except ValueError as e:
            # obstore's path parser rejects malformed keys (``..``, empty segments)
            # before any I/O; that is a bad client request, not a server fault.
            raise web.HTTPError(400, f"invalid key: {key}") from e
        except (BaseError, OSError) as e:
            # A range that runs past EOF surfaces as a generic "range invalid" error;
            # that is a client range fault (416), not an upstream/gateway fault (502).
            if rng is not None and "range" in str(e).lower():
                await self._send_range_not_satisfiable(store, key)
                return
            raise web.HTTPError(502, f"store error for {url}: {e}") from e

        size = result.meta["size"]
        start, end = result.range
        self.set_header("Accept-Ranges", "bytes")
        self.set_header("Content-Type", _content_type(key, result.attributes))
        self.set_header("Content-Length", str(end - start))
        etag = result.meta.get("e_tag")
        if etag:
            self.set_header("Etag", etag)
        if rng is not None:
            self.set_status(206)
            self.set_header("Content-Range", f"bytes {start}-{end - 1}/{size}")
        # Stream chunk-by-chunk; never buffer whole objects.
        async for chunk in result.stream(min_chunk_size=_STREAM_CHUNK):
            self.write(bytes(chunk))
            await self.flush()

    @web.authenticated
    async def head(self, scheme, path):
        store, key, url = self._resolve(scheme, path)
        try:
            meta = await obstore.head_async(store, key)
        except (NotFoundError, FileNotFoundError) as e:
            raise web.HTTPError(404, f"no such object: {url}") from e
        except ValueError as e:
            raise web.HTTPError(400, f"invalid key: {key}") from e
        except (BaseError, OSError) as e:
            raise web.HTTPError(502, f"store error for {url}: {e}") from e
        self.set_header("Accept-Ranges", "bytes")
        self.set_header("Content-Type", _content_type(key))
        self.set_header("Content-Length", str(meta["size"]))
        etag = meta.get("e_tag")
        if etag:
            self.set_header("Etag", etag)
