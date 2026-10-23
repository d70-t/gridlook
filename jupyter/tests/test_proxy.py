import pytest
from tornado.httpclient import HTTPClientError

ALLOWED_BUCKET = "test-bucket"  # matches conftest.ALLOWED_BUCKET

PAYLOAD = bytes(range(256)) * 4  # 1024 bytes, position-identifiable


@pytest.fixture
def seeded(proxy, put_object):
    put_object(ALLOWED_BUCKET, "data/chunk.bin", PAYLOAD)
    return proxy


async def test_full_get(jp_fetch, seeded):
    resp = await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, "data/chunk.bin")
    assert resp.code == 200
    assert resp.body == PAYLOAD
    assert resp.headers["Accept-Ranges"] == "bytes"
    assert resp.headers["Content-Type"] == "application/octet-stream"


async def test_range_get_exact_slice(jp_fetch, seeded):
    resp = await jp_fetch(
        "gridlook", "s3", ALLOWED_BUCKET, "data/chunk.bin", headers={"Range": "bytes=10-19"}
    )
    assert resp.code == 206
    assert resp.body == PAYLOAD[10:20]
    assert resp.headers["Content-Range"] == f"bytes 10-19/{len(PAYLOAD)}"
    assert resp.headers["Content-Length"] == "10"


async def test_open_ended_range(jp_fetch, seeded):
    resp = await jp_fetch(
        "gridlook", "s3", ALLOWED_BUCKET, "data/chunk.bin", headers={"Range": "bytes=1000-"}
    )
    assert resp.code == 206
    assert resp.body == PAYLOAD[1000:]
    assert resp.headers["Content-Range"] == f"bytes 1000-1023/{len(PAYLOAD)}"


async def test_suffix_range(jp_fetch, seeded):
    resp = await jp_fetch(
        "gridlook", "s3", ALLOWED_BUCKET, "data/chunk.bin", headers={"Range": "bytes=-16"}
    )
    assert resp.code == 206
    assert resp.body == PAYLOAD[-16:]


async def test_out_of_range_416(jp_fetch, seeded):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch(
            "gridlook",
            "s3",
            ALLOWED_BUCKET,
            "data/chunk.bin",
            headers={"Range": "bytes=999999-1000000"},
        )
    assert e.value.code == 416
    assert e.value.response.headers["Content-Range"] == f"bytes */{len(PAYLOAD)}"


async def test_zero_suffix_range_416(jp_fetch, seeded):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch(
            "gridlook", "s3", ALLOWED_BUCKET, "data/chunk.bin", headers={"Range": "bytes=-0"}
        )
    assert e.value.code == 416
    assert e.value.response.headers["Content-Range"] == f"bytes */{len(PAYLOAD)}"


async def test_head(jp_fetch, seeded):
    resp = await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, "data/chunk.bin", method="HEAD")
    assert resp.code == 200
    assert resp.headers["Content-Length"] == str(len(PAYLOAD))
    assert resp.headers["Accept-Ranges"] == "bytes"
    assert resp.body == b""


async def test_content_type_guess(jp_fetch, seeded, put_object):
    put_object(ALLOWED_BUCKET, "meta/zarr.json", b'{"zarr_format": 3}')
    resp = await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, "meta/zarr.json")
    assert resp.headers["Content-Type"] == "application/json"


async def test_missing_key_404(jp_fetch, seeded):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, "nope/missing.bin")
    assert e.value.code == 404
    assert b"no such object" in e.value.response.body


@pytest.mark.parametrize("key", ["../secret/x", "a/../b", "....//x"])
async def test_malformed_key_400_get(jp_fetch, seeded, key):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, key)
    assert e.value.code == 400
    assert b"invalid key" in e.value.response.body


@pytest.mark.parametrize("key", ["../secret/x", "a/../b", "....//x"])
async def test_malformed_key_400_head(jp_fetch, seeded, key):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, key, method="HEAD")
    assert e.value.code == 400


async def test_non_allowlisted_bucket_403(jp_fetch, seeded):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "s3", "sneaky-bucket", "any/key")
    assert e.value.code == 403
    assert b"sneaky-bucket" in e.value.response.body
    assert b"allowlist" in e.value.response.body


async def test_head_non_allowlisted_403(jp_fetch, seeded):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "s3", "sneaky-bucket", "any/key", method="HEAD")
    assert e.value.code == 403


@pytest.fixture
def failing_factory(proxy):
    """A store factory that cannot resolve credentials, as default_store_factory raises."""
    calls = []

    def factory(url, region):
        calls.append(url)
        raise RuntimeError(f"no AWS credentials resolved for bucket {url!r}")

    proxy.store_factory = factory
    return calls


async def test_store_factory_failure_502_get(jp_fetch, failing_factory):
    for _ in range(2):
        with pytest.raises(HTTPClientError) as e:
            await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, "any/key")
        assert e.value.code == 502
        assert b"no AWS credentials resolved for bucket 's3://test-bucket'" in e.value.response.body
    assert failing_factory == [f"s3://{ALLOWED_BUCKET}"] * 2  # the failure is not cached


async def test_store_factory_failure_502_head(jp_fetch, failing_factory):
    with pytest.raises(HTTPClientError) as e:
        await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, "any/key", method="HEAD")
    assert e.value.code == 502
    assert failing_factory == [f"s3://{ALLOWED_BUCKET}"]


class TestStoreUrls:
    """Allowlist entries are `scheme://bucket[/prefix]` URLs; a bare name is an S3 bucket."""

    @pytest.fixture
    def allowed_buckets(self):
        return [ALLOWED_BUCKET, "gs://gcs-bucket", "az://container/pub", "s3://other/data/"]

    @pytest.mark.parametrize(
        "route, bucket, key",
        [
            (("s3", ALLOWED_BUCKET), ALLOWED_BUCKET, "data/chunk.bin"),
            (("gs", "gcs-bucket"), "gcs-bucket", "data/chunk.bin"),
            (("az", "container", "pub"), "container/pub", "chunk.bin"),
            (("s3", "other", "data"), "other/data", "chunk.bin"),
        ],
    )
    async def test_each_scheme_and_prefix_is_served(
        self, jp_fetch, proxy, put_object, route, bucket, key
    ):
        put_object(bucket, key, PAYLOAD)
        resp = await jp_fetch("gridlook", *route, key, headers={"Range": "bytes=0-3"})
        assert resp.code == 206
        assert resp.body == PAYLOAD[:4]

    @pytest.mark.parametrize(
        "route",
        [
            ("gs", ALLOWED_BUCKET, "data/chunk.bin"),  # allowlisted on s3 only
            ("az", "container", "private", "chunk.bin"),  # outside the allowed prefix
            ("az", "container", "pub-lic", "chunk.bin"),  # prefix must end at a `/`
            ("s3", "other", "chunk.bin"),
        ],
    )
    async def test_outside_the_allowlist_403(self, jp_fetch, proxy, route):
        with pytest.raises(HTTPClientError) as e:
            await jp_fetch("gridlook", *route)
        assert e.value.code == 403
        assert b"allowlist" in e.value.response.body

    async def test_bare_store_url_400(self, jp_fetch, proxy):
        with pytest.raises(HTTPClientError) as e:
            await jp_fetch("gridlook", "gs", "gcs-bucket/")
        assert e.value.code == 400


class TestDisabledProxy:
    @pytest.fixture
    def allowed_buckets(self):
        return []

    async def test_empty_allowlist_disables_proxy(self, jp_fetch, proxy):
        with pytest.raises(HTTPClientError) as e:
            await jp_fetch("gridlook", "s3", ALLOWED_BUCKET, "any/key")
        assert e.value.code == 403
        assert b"disabled" in e.value.response.body
        assert b"GRIDLOOK_ALLOWED_BUCKETS" in e.value.response.body

    async def test_health_reports_disabled(self, jp_fetch, proxy):
        import json

        resp = await jp_fetch("gridlook", "api", "health")
        assert json.loads(resp.body)["proxy_enabled"] is False
