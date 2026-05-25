"""FastAPI sidecar — same /generate contract as the TS backend.

URL prefix: routes are mounted at /pyapi so they line up with the
Vercel rewrite (/pyapi/(.*)  →  /api/python). FastAPI sees the original
request path (/pyapi/...) and matches against routes declared on a router
with `prefix="/pyapi"`.

For local dev: `uvicorn api.main:app --port 5001` will serve at
http://localhost:5001/pyapi/healthz and http://localhost:5001/pyapi/generate.
Next.js dev rewrites /pyapi/* to that.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .llm import (
    LLMCompletionRequest,
    list_llm_providers,
    resolve_llm_provider,
)
from .models import (
    ErrorResponse,
    GenerateRequest,
    GenerateResponse,
)
from .prompt import build_system_prompt, build_user_prompt

logger = logging.getLogger("jiraqa.python")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

app = FastAPI(title="AI Jira QA Copilot — Python sidecar", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# All routes live under /pyapi so they match the URL Vercel hands to us
# (rewrites preserve the original request path).
router = APIRouter(prefix="/pyapi")


@router.get("/healthz")
async def healthz() -> dict[str, Any]:
    """Health probe — mirrors /api/healthz on the TS side."""
    llm_available = False
    llm_name: str | None = None
    try:
        p = resolve_llm_provider()
        llm_available = p.is_available()
        llm_name = p.name
    except Exception:  # noqa: BLE001
        pass
    return {
        "ok": True,
        "backend": "python",
        "llm": {
            "available": llm_available,
            "default_provider": llm_name,
            "registered": list_llm_providers(),
        },
    }


@router.post("/generate")
async def generate(payload: dict[str, Any]) -> JSONResponse:
    # 1. Validate request
    try:
        req = GenerateRequest(**payload)
    except ValidationError as e:
        return JSONResponse(
            status_code=400,
            content=ErrorResponse(
                error="Invalid request body", details=e.json()
            ).model_dump(mode="json"),
        )

    # 2. Resolve provider
    try:
        llm = resolve_llm_provider(req.provider)
    except Exception as e:  # noqa: BLE001
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(error=str(e)).model_dump(mode="json"),
        )

    # 3. Build prompts
    system_prompt = build_system_prompt(req.platform, req.count_hint)
    user_prompt = build_user_prompt(req.ticket, req.platform, req.repo_context)

    # 4. Call LLM
    try:
        completion = await llm.complete(
            LLMCompletionRequest(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=0.3,
                json_mode=True,
            )
        )
    except Exception as e:  # noqa: BLE001
        return JSONResponse(
            status_code=502,
            content=ErrorResponse(
                error=f"LLM call failed: {e}"
            ).model_dump(mode="json"),
        )

    # 5. Parse + validate output
    try:
        parsed = json.loads(completion.text)
    except json.JSONDecodeError:
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                error="LLM returned invalid JSON",
                details="Try again or switch provider.",
            ).model_dump(mode="json"),
        )

    candidate = {
        "ticket_id": parsed.get("ticket_id") or req.ticket.ticket_id,
        "summary": parsed.get("summary") or req.ticket.summary,
        "platform": req.platform,
        "provider": llm.name,
        "backend": "python",
        "generated_test_cases": parsed.get("generated_test_cases", []),
    }

    try:
        response = GenerateResponse(**candidate)
    except ValidationError as e:
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                error="LLM output failed schema validation", details=e.json()
            ).model_dump(mode="json"),
        )

    return JSONResponse(content=response.model_dump(mode="json"))


app.include_router(router)
