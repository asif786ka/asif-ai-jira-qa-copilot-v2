"""Vercel Python entry — proxies all /pyapi/* requests to the FastAPI app.

Vercel routing:
  vercel.json rewrites: /pyapi/(.*) → /api/python
  → Vercel serves this file as the function at /api/python
  → The original request URL (e.g. /pyapi/generate) is preserved in the ASGI scope
  → FastAPI matches routes defined under the /pyapi prefix in apps/api-python/api/main.py

We load the FastAPI app via importlib + an explicit file path because the
sidecar directory is `apps/api-python` (hyphenated, not a legal Python
module name) AND there's a sibling `api/` package at the repo root that
would otherwise shadow `apps/api-python/api/` on PYTHONPATH.
"""

from __future__ import annotations

import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_PY_APP_DIR = os.path.join(_ROOT, "apps", "api-python")


def _load_fastapi_app():
    """Load apps/api-python/api/main.py as a uniquely-named module."""
    # Register the sidecar package under a non-conflicting name so the
    # relative imports inside (`from .models import ...`) still resolve.
    pkg_name = "_jiraqa_sidecar"

    # 1. Create the package itself.
    pkg_init = os.path.join(_PY_APP_DIR, "api", "__init__.py")
    spec = importlib.util.spec_from_file_location(
        pkg_name,
        pkg_init,
        submodule_search_locations=[os.path.join(_PY_APP_DIR, "api")],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load FastAPI sidecar package spec.")
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[pkg_name] = pkg
    spec.loader.exec_module(pkg)

    # 2. Now load main.py as a submodule of that package.
    main_path = os.path.join(_PY_APP_DIR, "api", "main.py")
    sub_spec = importlib.util.spec_from_file_location(
        f"{pkg_name}.main", main_path
    )
    if sub_spec is None or sub_spec.loader is None:
        raise RuntimeError("Could not load FastAPI sidecar main module.")
    main_mod = importlib.util.module_from_spec(sub_spec)
    sys.modules[f"{pkg_name}.main"] = main_mod
    sub_spec.loader.exec_module(main_mod)

    return main_mod.app


app = _load_fastapi_app()

__all__ = ["app"]
