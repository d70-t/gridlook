import pytest
from obstore.store import LocalStore

pytest_plugins = ["pytest_jupyter.jupyter_server"]

ALLOWED_BUCKET = "test-bucket"


@pytest.fixture
def static_root(tmp_path):
    d = tmp_path / "static"
    d.mkdir()
    (d / "index.html").write_text("<!doctype html><title>gridlook test index</title>")
    return d


@pytest.fixture
def bucket_root(tmp_path):
    d = tmp_path / "buckets"
    (d / ALLOWED_BUCKET).mkdir(parents=True)
    return d


@pytest.fixture
def allowed_buckets():
    return [ALLOWED_BUCKET]


@pytest.fixture
def jp_server_config(static_root, allowed_buckets):
    return {
        "ServerApp": {"jpserver_extensions": {"gridlook_jupyter": True}},
        "GridlookProxy": {
            "allowed_buckets": allowed_buckets,
            "static_dir": str(static_root),
        },
    }


@pytest.fixture
def proxy(jp_serverapp, bucket_root):
    """The live GridlookProxy, with its store factory pointed at a LocalStore tree."""
    p = jp_serverapp.web_app.settings["gridlook_proxy"]

    def local_factory(bucket, region):
        return LocalStore(prefix=str(bucket_root / bucket))

    p.store_factory = local_factory
    p._stores.clear()
    return p


@pytest.fixture
def put_object(bucket_root):
    def _put(bucket: str, key: str, data: bytes):
        path = bucket_root / bucket / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    return _put
