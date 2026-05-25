"""Vercel Python entry point.

Vercel's Python runtime auto-detects an ASGI `app` exported from this file
and routes /api/py/* to it (Vercel rewrites our /pyapi/* prefix).
"""

from .main import app  # noqa: F401  (re-export for Vercel)

# Local convenience: `python -m apps.api-python.api.index` runs the server.
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(__import__("os").environ.get("PORT", "5001")))
