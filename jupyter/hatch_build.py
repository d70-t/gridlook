"""Hatchling build hook: build both frontend halves into the wheel.

The SPA (the Vite app at the repo root) is packaged as gridlook_jupyter/static/; the
JupyterLab extension (labextension/) is built with jlpm and packaged through the wheel's
shared-data as share/jupyter/labextensions/jupyterlab-gridlook/. The SPA step is skipped when
its output is already present; the labextension is always rebuilt (`jlpm build:prod`) when its
sources are here, so a dev build or a stale bundle never ships, and a prebuilt output is used
only without sources. Source maps and build_log.json are stripped from it either way. Each step
refuses to ship a wheel without its half.

Wheel builds therefore need node/npm on PATH plus the sources (the frontend one directory
up, labextension/ here) and jupyterlab in the build environment (build-system.requires) for
jlpm. Editable installs skip the hook — point GridlookProxy.static_dir at a dev dist/ and
`jupyter labextension develop` the built labextension instead (see README).
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

# Development-build outputs of `jupyter labextension build`; a wheel never needs them.
DEV_FILES = ("*.map", "build_log.json")


def _tool(name: str) -> str | None:
    """Find a console script next to the build environment's python, else on PATH."""
    candidate = Path(sys.executable).parent / name
    return str(candidate) if candidate.exists() else shutil.which(name)


def _strip_dev_files(out: Path) -> None:
    for pattern in DEV_FILES:
        for path in out.rglob(pattern):
            path.unlink()


class FrontendBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version, build_data):
        if self.target_name != "wheel" or version == "editable":
            return
        pkg_root = Path(self.root)
        self._build_spa(pkg_root)
        self._build_labextension(pkg_root)

    def _build_spa(self, pkg_root: Path) -> None:
        static = pkg_root / "gridlook_jupyter" / "static"
        if (static / "index.html").exists():
            self.app.display_info(f"gridlook-jupyter: packaging pre-built SPA from {static}")
            return

        repo_root = pkg_root.parent
        if not (repo_root / "package.json").exists():
            raise RuntimeError(
                "gridlook-jupyter: gridlook_jupyter/static/ is empty and the frontend "
                "sources are not present one directory up (no package.json). Build the "
                "wheel from a repository checkout, not from the sdist (`uv build --wheel "
                "jupyter`), or pre-populate gridlook_jupyter/static/ with a built dist/. "
                "Refusing to ship a wheel without the SPA."
            )
        npm = shutil.which("npm")
        if npm is None:
            raise RuntimeError(
                "gridlook-jupyter: gridlook_jupyter/static/ is empty and npm is not on "
                "PATH. Install node >= 24 and retry, or pre-populate "
                "gridlook_jupyter/static/ with a built dist/. Refusing to ship a wheel "
                "without the SPA."
            )

        self.app.display_info("gridlook-jupyter: running npm ci && npm run build")
        subprocess.run([npm, "ci"], cwd=repo_root, check=True)
        subprocess.run([npm, "run", "build"], cwd=repo_root, check=True)
        dist = repo_root / "dist"
        if not (dist / "index.html").exists():
            raise RuntimeError(f"gridlook-jupyter: npm run build produced no {dist}/index.html")
        if static.exists():
            shutil.rmtree(static)
        # vite.config.ts keeps sourcemaps on for dev/standalone builds; the wheel is a
        # server-extension artifact that never needs them, so drop *.map on the way in.
        shutil.copytree(dist, static, ignore=shutil.ignore_patterns("*.map"))
        self.app.display_info(
            f"gridlook-jupyter: packaged {dist} -> {static} (source maps excluded)"
        )

    def _build_labextension(self, pkg_root: Path) -> None:
        src = pkg_root / "labextension"
        out = pkg_root / "gridlook_jupyter" / "labextension"
        built = (out / "package.json").exists() and (out / "static").is_dir()
        if not (src / "package.json").exists():
            if not built:
                raise RuntimeError(
                    f"gridlook-jupyter: {out} is empty and labextension/ sources are absent. "
                    "Refusing to ship a wheel without the JupyterLab extension."
                )
            _strip_dev_files(out)
            self.app.display_info(f"gridlook-jupyter: packaging pre-built labextension from {out}")
            return
        jlpm = _tool("jlpm")
        if jlpm is None:
            raise RuntimeError(
                "gridlook-jupyter: jlpm is not available to build labextension/. jlpm ships "
                "with jupyterlab, which is in build-system.requires; build with an "
                "isolated build (pip wheel / uv build) or install jupyterlab >= 4 into "
                "the build environment. Refusing to ship a wheel without the JupyterLab "
                "extension."
            )
        # `jlpm build:prod` runs `jupyter labextension build`: put the build
        # environment's console scripts first on PATH so it resolves there.
        env = {
            **os.environ,
            "PATH": os.pathsep.join([str(Path(sys.executable).parent), os.environ.get("PATH", "")]),
        }
        self.app.display_info("gridlook-jupyter: running jlpm install && jlpm build:prod")
        subprocess.run([jlpm, "install"], cwd=src, check=True, env=env)
        subprocess.run([jlpm, "build:prod"], cwd=src, check=True, env=env)
        if not (out / "package.json").exists() or not (out / "static").is_dir():
            raise RuntimeError(
                f"gridlook-jupyter: jlpm build:prod produced no {out}/package.json + static/"
            )
        _strip_dev_files(out)
        self.app.display_info(f"gridlook-jupyter: packaged labextension -> {out}")
