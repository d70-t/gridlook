"""Traitlets config surface for the gridlook extension."""

import os
from pathlib import Path

from traitlets import List, Unicode, default
from traitlets.config import Configurable

#: Bounded per-process cache of store URL -> store (entries come from the allowlist,
#: so this stays tiny; the bound is belt-and-braces).
_MAX_CACHED_STORES = 64

#: URL schemes the proxy routes, spelled as obstore's ``from_url`` takes them.
SCHEMES = ("s3", "gs", "az")


def store_url(entry: str) -> str:
    """An allowlist entry as a ``scheme://bucket[/prefix]`` URL; a bare name is an S3 bucket."""
    entry = entry.strip().rstrip("/")
    return entry if "://" in entry else f"s3://{entry}"


def default_store_factory(url: str, region: str | None):
    """Build an obstore store for the ``scheme://bucket[/prefix]`` URL *url*.

    S3 resolves credentials through botocore: its chain covers every setup a hub
    or a laptop uses -- ``AWS_PROFILE`` and the shared config, SSO caches,
    pod/instance roles, web identity, plain ``AWS_*`` env -- and refreshes
    expiring tokens. obstore's own Rust chain reads only env keys, web identity,
    container and instance-metadata credentials, so a hub run with a profile fell
    through to the metadata endpoint and hung. A bucket the chain cannot sign for
    fails here, loudly, rather than as an unsigned request: public buckets do not
    need the proxy at all.

    GCS and Azure use obstore's own chain: ``GOOGLE_APPLICATION_CREDENTIALS`` or
    ``GOOGLE_SERVICE_ACCOUNT`` and the metadata server; ``AZURE_STORAGE_ACCOUNT_KEY``,
    a SAS token, client credentials or IMDS, with the account in
    ``AZURE_STORAGE_ACCOUNT_NAME``.
    """
    from obstore.store import S3Store, from_url

    scheme, _, rest = url.partition("://")
    if scheme == "s3":
        import boto3
        from obstore.auth.boto3 import Boto3CredentialProvider

        session = boto3.Session(region_name=region or None)
        try:
            provider = Boto3CredentialProvider(session)
        except ValueError as e:
            raise RuntimeError(
                f"no AWS credentials resolved for bucket {url!r}: configure a profile "
                "(AWS_PROFILE), a role, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY"
            ) from e
        bucket, _, prefix = rest.partition("/")
        kwargs = {"region": region} if region else {}
        if prefix:
            kwargs["prefix"] = prefix
        return S3Store(bucket, credential_provider=provider, **kwargs)
    if scheme == "az":
        # obstore 0.11 does not pick the account up from the environment itself
        # (it panics on AZURE_STORAGE_ACCOUNT_NAME), so pass it explicitly.
        account = os.environ.get("AZURE_STORAGE_ACCOUNT_NAME", "")
        if not account:
            raise RuntimeError(
                f"no Azure storage account for {url!r}: set AZURE_STORAGE_ACCOUNT_NAME"
            )
        return from_url(url, account_name=account)
    # ponytail: GCS and Azure credentials come from obstore's env/metadata chain
    # only; a user `gcloud auth login` or `az login` needs obstore.auth.google /
    # obstore.auth.azure (optional google-auth / azure-identity dependencies).
    return from_url(url)


class GridlookProxy(Configurable):
    """Config for the gridlook object-store proxy (jupyter_server_config / CLI / env)."""

    allowed_buckets = List(
        Unicode(),
        help=(
            "Stores the proxy may read from, as `s3://bucket`, `gs://bucket` or "
            "`az://container` URLs, optionally with a `/prefix`; a bare name is an S3 "
            "bucket. Empty (the default) disables the proxy entirely. Env fallback: "
            "GRIDLOOK_ALLOWED_BUCKETS (comma-separated), used only when this trait is "
            "not configured."
        ),
    ).tag(config=True)

    region = Unicode(
        "",
        help=(
            "AWS region for the S3 stores. Empty defers to the ambient AWS "
            "configuration. Env fallback: GRIDLOOK_S3_REGION."
        ),
    ).tag(config=True)

    static_dir = Unicode(
        "",
        help=(
            "Directory holding the built gridlook SPA. Defaults to the static/ "
            "directory packaged in the wheel; point it at a repo dist/ for development."
        ),
    ).tag(config=True)

    @default("allowed_buckets")
    def _default_allowed_buckets(self):
        env = os.environ.get("GRIDLOOK_ALLOWED_BUCKETS", "")
        return [b.strip() for b in env.split(",") if b.strip()]

    @default("region")
    def _default_region(self):
        return os.environ.get("GRIDLOOK_S3_REGION", "")

    @default("static_dir")
    def _default_static_dir(self):
        return str(Path(__file__).parent / "static")

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Seam for tests: swap in e.g. an obstore LocalStore factory so the
        # proxy can be exercised without real buckets. Plain attribute, not a trait.
        self.store_factory = default_store_factory
        self._stores: dict[str, object] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.allowed_buckets)

    def match(self, url: str):
        """Split an object URL at the longest allowlisted store: ``(store_url, key)``, or None."""
        for entry in sorted(map(store_url, self.allowed_buckets), key=len, reverse=True):
            if url.startswith(entry + "/"):
                return entry, url[len(entry) + 1 :]
        return None

    def get_store(self, entry: str):
        """Return (building if needed) the store for an allowlisted store URL."""
        if entry not in self._stores:
            if len(self._stores) >= _MAX_CACHED_STORES:
                self._stores.clear()
            self._stores[entry] = self.store_factory(entry, self.region or None)
        return self._stores[entry]
