import json

import pytest
from tornado.httpclient import HTTPClientError

from gridlook_jupyter import handlers


async def test_health(jp_fetch, proxy):
    resp = await jp_fetch("gridlook", "api", "health")
    assert resp.code == 200
    body = json.loads(resp.body)
    assert body["extension"] == "gridlook-jupyter"
    assert body["proxy_enabled"] is True


@pytest.mark.parametrize("installed", [True, False])
async def test_health_reports_labextension_only_when_installed(
    jp_fetch, proxy, tmp_path, monkeypatch, installed
):
    if installed:
        (tmp_path / "jupyterlab-gridlook").mkdir()
        (tmp_path / "jupyterlab-gridlook" / "package.json").write_text("{}")
    monkeypatch.setattr(handlers, "jupyter_path", lambda *_: [str(tmp_path)])
    body = json.loads((await jp_fetch("gridlook", "api", "health")).body)
    assert body["labextension"] == ("jupyterlab-gridlook" if installed else None)


async def test_static_index_served(jp_fetch, proxy):
    resp = await jp_fetch("gridlook/")
    assert resp.code == 200
    assert b"gridlook test index" in resp.body


async def test_spa_csp_has_no_sandbox(jp_fetch, proxy, static_root):
    # `sandbox allow-scripts` (jupyter's policy for user files) gives the document an
    # opaque origin (module scripts and same-origin fetches fail CORS); the SPA
    # is served under jupyter's ordinary policy instead.
    (static_root / "app.js").write_text("console.log('gridlook');")
    for path in (("gridlook/",), ("gridlook", "index.html"), ("gridlook", "app.js")):
        resp = await jp_fetch(*path)
        assert resp.code == 200
        csp = resp.headers.get("Content-Security-Policy", "")
        assert "sandbox" not in csp
        assert "frame-ancestors" in csp  # the ordinary jupyter policy still applies


@pytest.mark.parametrize(
    "configured, served",
    [
        # jupyterhub-singleuser's default would block the Lab tab's iframe
        ("frame-ancestors 'none'", "frame-ancestors 'self'"),
        # the same, from the legacy (non-extension) jupyterhub-singleuser
        (
            "frame-ancestors 'none';report-uri /hub/security/csp-report",
            "frame-ancestors 'self';report-uri /hub/security/csp-report",
        ),
        # a policy a hub admin wrote is left alone
        (
            "frame-ancestors 'self' https://hub.example.org",
            "frame-ancestors 'self' https://hub.example.org",
        ),
    ],
)
async def test_spa_csp_under_hub_headers(
    jp_fetch, jp_serverapp, proxy, monkeypatch, configured, served
):
    headers = jp_serverapp.web_app.settings.setdefault("headers", {})
    monkeypatch.setitem(headers, "Content-Security-Policy", configured)
    resp = await jp_fetch("gridlook/")
    assert resp.headers["Content-Security-Policy"] == served


async def test_static_asset_served(jp_fetch, proxy, static_root):
    (static_root / "app.js").write_text("console.log('gridlook');")
    resp = await jp_fetch("gridlook", "app.js")
    assert resp.code == 200
    assert b"console.log" in resp.body


async def test_spa_assets_need_no_login_but_document_and_data_routes_do(
    jp_fetch, proxy, static_root
):
    # Under JupyterHub the page's module scripts (CORS-mode, no XSRF token) are not
    # cookie-authenticated, so the bundle is served like Lab's own /static/. The
    # document, like any Lab page, sends an anonymous visitor to the login.
    # follow_redirects=False: following the login redirect would need DNS.
    (static_root / "app.js").write_text("console.log('gridlook');")
    anonymous = {"Authorization": ""}
    resp = await jp_fetch("gridlook", "app.js", headers=anonymous, follow_redirects=False)
    assert resp.code == 200
    for path in (("gridlook/",), ("gridlook", "index.html"), ("gridlook", "api", "health")):
        with pytest.raises(HTTPClientError) as e:
            await jp_fetch(*path, headers=anonymous, follow_redirects=False)
        assert e.value.code in (302, 403)


async def test_document_sets_xsrf_cookie_and_is_revalidated(jp_fetch, proxy):
    # A bookmarked /gridlook/ must set the _xsrf cookie the viewer adds to its data
    # fetches, and must not be cached past a wheel upgrade that renames the assets.
    resp = await jp_fetch("gridlook/", headers={"Sec-Fetch-Mode": "navigate"})
    assert "_xsrf=" in resp.headers.get("Set-Cookie", "")
    assert resp.headers["Cache-Control"] == "no-cache"


async def test_bare_route_redirects_to_slash(jp_fetch, jp_base_url, proxy):
    # follow_redirects=False: the follow would need DNS, which sandboxed
    # environments may block; the Location assertion is what matters.
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", follow_redirects=False)
    assert e.value.code == 301
    assert e.value.response.headers["Location"] == f"{jp_base_url}gridlook/"


class TestEnvFallback:
    def test_allowlist_from_env(self, monkeypatch):
        from gridlook_jupyter.config import GridlookProxy

        monkeypatch.setenv("GRIDLOOK_ALLOWED_BUCKETS", "bucket-a, bucket-b")
        proxy = GridlookProxy()
        assert proxy.allowed_buckets == ["bucket-a", "bucket-b"]
        assert proxy.enabled

    def test_region_from_env(self, monkeypatch):
        from gridlook_jupyter.config import GridlookProxy

        monkeypatch.setenv("GRIDLOOK_S3_REGION", "us-west-2")
        assert GridlookProxy().region == "us-west-2"

    def test_traitlet_wins_over_env(self, monkeypatch):
        from gridlook_jupyter.config import GridlookProxy

        monkeypatch.setenv("GRIDLOOK_ALLOWED_BUCKETS", "env-bucket")
        proxy = GridlookProxy(allowed_buckets=["cfg-bucket"])
        assert proxy.allowed_buckets == ["cfg-bucket"]

    def test_empty_by_default(self, monkeypatch):
        from gridlook_jupyter.config import GridlookProxy

        monkeypatch.delenv("GRIDLOOK_ALLOWED_BUCKETS", raising=False)
        proxy = GridlookProxy()
        assert proxy.allowed_buckets == []
        assert not proxy.enabled


@pytest.mark.parametrize(
    "header,expected",
    [
        ("bytes=10-19", (10, 20)),
        ("bytes=95-", {"offset": 95}),
        ("bytes=-5", {"suffix": 5}),
        ("bytes=0-0", (0, 1)),
        ("bytes=20-10", None),
        ("bytes=1-2,5-6", None),
        ("chars=1-2", None),
        ("bytes=", None),
    ],
)
def test_parse_range_header(header, expected):
    from gridlook_jupyter.handlers import parse_range_header

    assert parse_range_header(header) == expected
