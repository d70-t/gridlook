"""Traitlets config surface for the gridlook extension."""

import os
from pathlib import Path

from traitlets import List, Unicode, default
from traitlets.config import Configurable

#: Bounded per-process cache of bucket -> store (buckets come from the allowlist,
#: so this stays tiny; the bound is belt-and-braces).
_MAX_CACHED_STORES = 64


def default_store_factory(bucket: str, region: str | None):
    """Build an obstore store for *bucket*, resolving credentials through botocore.

    botocore's chain covers every setup a hub or a laptop uses -- ``AWS_PROFILE``
    and the shared config, SSO caches, pod/instance roles, web identity, plain
    ``AWS_*`` env -- and refreshes expiring tokens. obstore's own Rust chain reads
    only env keys, web identity, container and instance-metadata credentials, so
    a hub run with a profile fell through to the metadata endpoint and hung.
    A bucket the chain cannot sign for fails here, loudly, rather than as an
    unsigned request: public buckets do not need the proxy at all.
    """
    import boto3
    from obstore.auth.boto3 import Boto3CredentialProvider
    from obstore.store import S3Store

    session = boto3.Session(region_name=region or None)
    try:
        provider = Boto3CredentialProvider(session)
    except ValueError as e:
        raise RuntimeError(
            f"no AWS credentials resolved for bucket {bucket!r}: configure a profile "
            "(AWS_PROFILE), a role, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY"
        ) from e
    kwargs = {"region": region} if region else {}
    return S3Store(bucket, credential_provider=provider, **kwargs)


class GridlookProxy(Configurable):
    """Config for the gridlook S3 proxy (jupyter_server_config / CLI / env)."""

    allowed_buckets = List(
        Unicode(),
        help=(
            "Buckets the proxy may read from. Empty (the default) disables the "
            "proxy entirely. Env fallback: GRIDLOOK_ALLOWED_BUCKETS (comma-separated), "
            "used only when this trait is not configured."
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
        # proxy can be exercised without real S3. Plain attribute, not a trait.
        self.store_factory = default_store_factory
        self._stores: dict[str, object] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.allowed_buckets)

    def get_store(self, bucket: str):
        """Return (building if needed) the store for an allowlisted bucket."""
        if bucket not in self._stores:
            if len(self._stores) >= _MAX_CACHED_STORES:
                self._stores.clear()
            self._stores[bucket] = self.store_factory(bucket, self.region or None)
        return self._stores[bucket]
