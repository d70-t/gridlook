"""The proxy's store factory: S3 credentials through botocore, GCS/Azure through obstore."""

import pytest

from gridlook_jupyter import config as cfg


@pytest.fixture
def aws_env(monkeypatch, tmp_path):
    """A hermetic AWS environment: one profile in a shared credentials file, no
    ambient keys, no metadata endpoint."""
    for key in (
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_PROFILE",
        "AWS_DEFAULT_REGION",
        "AWS_REGION",
    ):
        monkeypatch.delenv(key, raising=False)
    creds = tmp_path / "credentials"
    creds.write_text(
        "[hub]\naws_access_key_id = AKIAHUBPROFILE\naws_secret_access_key = hubsecret\n"
    )
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(creds))
    monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "config"))
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    return creds


@pytest.fixture
def captured_store(monkeypatch):
    """Replace obstore's S3Store with a recorder so no client is built."""
    calls = []

    class FakeS3Store:
        def __init__(self, bucket, **kwargs):
            calls.append((bucket, kwargs))

    import obstore.store

    monkeypatch.setattr(obstore.store, "S3Store", FakeS3Store)
    return calls


def test_profile_credentials_reach_the_store(aws_env, captured_store, monkeypatch):
    monkeypatch.setenv("AWS_PROFILE", "hub")
    cfg.default_store_factory("s3://private-bucket/pub", "us-west-2")
    (bucket, kwargs) = captured_store[0]
    assert bucket == "private-bucket"
    assert kwargs["prefix"] == "pub"
    assert kwargs["region"] == "us-west-2"
    resolved = kwargs["credential_provider"]()
    assert resolved["access_key_id"] == "AKIAHUBPROFILE"
    assert resolved["secret_access_key"] == "hubsecret"


def test_region_is_omitted_when_unset(aws_env, captured_store, monkeypatch):
    monkeypatch.setenv("AWS_PROFILE", "hub")
    cfg.default_store_factory("s3://private-bucket", None)
    assert "region" not in captured_store[0][1]
    assert "prefix" not in captured_store[0][1]


def test_no_credentials_fails_loudly(aws_env, captured_store):
    with pytest.raises(
        RuntimeError, match="no AWS credentials resolved for bucket 's3://private-bucket'"
    ):
        cfg.default_store_factory("s3://private-bucket", None)
    assert captured_store == []


def test_bare_names_are_s3_buckets():
    assert cfg.store_url(" my-bucket/ ") == "s3://my-bucket"
    assert cfg.store_url("gs://b/prefix/") == "gs://b/prefix"


def test_gcs_store_from_url(captured_store):
    from obstore.store import GCSStore

    store = cfg.default_store_factory("gs://gcs-bucket/pre", None)
    assert isinstance(store, GCSStore)
    assert captured_store == []


def test_azure_needs_the_account_name(monkeypatch, captured_store):
    from obstore.store import AzureStore

    monkeypatch.delenv("AZURE_STORAGE_ACCOUNT_NAME", raising=False)
    with pytest.raises(RuntimeError, match="AZURE_STORAGE_ACCOUNT_NAME"):
        cfg.default_store_factory("az://container", None)
    monkeypatch.setenv("AZURE_STORAGE_ACCOUNT_NAME", "acct")
    assert isinstance(cfg.default_store_factory("az://container/pub", None), AzureStore)
