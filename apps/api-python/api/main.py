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
from pathlib import Path
from typing import Any

# Load .env files BEFORE any provider import — otherwise the LLM provider
# constructors run with an empty environment in local dev. We look in three
# locations (first hit wins): apps/api-python/.env, repo-root/.env.local,
# apps/web/.env.local. The Next.js side already loads apps/web/.env.local
# automatically; this just teaches the Python sidecar to do the same so
# both processes share one source of truth.
try:
    from dotenv import load_dotenv

    _HERE = Path(__file__).resolve().parent
    for _candidate in (
        _HERE.parent / ".env",                          # apps/api-python/.env
        _HERE.parent.parent.parent / ".env.local",      # repo root .env.local
        _HERE.parent.parent / "web" / ".env.local",     # apps/web/.env.local
    ):
        if _candidate.is_file():
            load_dotenv(_candidate, override=False)
except Exception:
    # python-dotenv is in requirements.txt, but we never want a missing
    # .env file or import to crash boot — the explicit RuntimeError from
    # the provider is a clearer signal to the user.
    pass

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
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
    ValidateTicketRequest,
)
from .agentic_e2e_graph import run_e2e_codegen_pipeline
from .agentic_graph import run_agentic_pipeline, run_agentic_pipeline_stream
from .judge import judge_generated_cases
from .output_validation import errors_only, lint_generated_cases
from .prompt import build_system_prompt, build_user_prompt
from .validation import validate_ticket

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


@router.post("/validate-ticket")
async def validate_ticket_endpoint(payload: dict[str, Any]) -> JSONResponse:
    """Run the ticket-readiness validator standalone.

    Returns 200 even when the ticket fails — the request itself is valid, the
    *ticket* is what's bad. UI consumers branch on `result.passed`. We reserve
    4xx for actual request errors (missing fields, wrong shape).
    """
    try:
        req = ValidateTicketRequest(**payload)
    except ValidationError as e:
        return JSONResponse(
            status_code=400,
            content=ErrorResponse(
                error="Invalid request body", details=e.json()
            ).model_dump(mode="json"),
        )

    result = await validate_ticket(
        req.ticket,
        req.platform,
        use_llm_rubric=req.use_llm_rubric,
        provider=req.provider,
    )
    return JSONResponse(content=result.model_dump(mode="json"))


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

    # 1b. Gate on ticket quality. If the ticket fails the QA-readiness rules,
    # short-circuit with 422 BEFORE spending an LLM call. The rubric pass is
    # opt-in here via the request body so callers can pay for the extra
    # semantic check if they want it (default off to keep /generate cheap —
    # /validate-ticket is the explicit way to opt in).
    validation = await validate_ticket(
        req.ticket,
        req.platform,
        use_llm_rubric=False,
        provider=req.provider,
    )
    if not validation.passed:
        return JSONResponse(
            status_code=422,
            content={
                "error": "Ticket failed validation",
                "code": "ticket_validation_failed",
                "validation": validation.model_dump(mode="json"),
            },
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

    # 6. Output linter — checks CONTENT quality, not just shape. If the LLM
    # produced cases that violate atomicity / measurability / coverage, we
    # reject the batch so the QA reviewer doesn't waste time copy-editing
    # bad tests. Warnings (e.g. missing edge coverage) are surfaced alongside
    # the response but do not cause rejection.
    lint_issues = lint_generated_cases(
        response.generated_test_cases, response.platform
    )
    hard_failures = errors_only(lint_issues)
    if hard_failures:
        return JSONResponse(
            status_code=422,
            content={
                "error": "Generated test cases failed quality lint",
                "code": "output_validation_failed",
                "validation": {
                    "passed": False,
                    "issues": [i.model_dump(mode="json") for i in lint_issues],
                },
                "partial_response": response.model_dump(mode="json"),
            },
        )

    # Attach lint warnings (e.g. coverage_missing_edge) as a side-channel so
    # the UI can show them without blocking. Pydantic round-trip via dict.
    payload = response.model_dump(mode="json")
    if lint_issues:
        payload["lint_warnings"] = [i.model_dump(mode="json") for i in lint_issues]

    # 7. LLM-as-judge — only when requested. Adds a `quality` field with score
    # + per-case flags. Failures here are silently swallowed; the user still
    # gets their test cases back. The score is informational, not gating.
    if req.judge:
        quality = await judge_generated_cases(
            req.ticket,
            response.platform,
            response.generated_test_cases,
            generator_provider=llm.name,
        )
        payload["quality"] = quality.model_dump(mode="json")

    return JSONResponse(content=payload)


# ────────────────────────────────────────────────────────────────────────────
# Agentic SDLC pipeline — multi-agent LangGraph workflow.
# Same request shape as /generate, but the graph runs five specialised
# agents: readiness → requirements → generator → reviewer → scorer, with a
# bounded repair loop between reviewer and generator. See agentic_graph.py
# for the full state machine.
# ────────────────────────────────────────────────────────────────────────────


@router.post("/agentic-generate")
async def agentic_generate(payload: dict[str, Any]) -> JSONResponse:
    try:
        req = GenerateRequest(**payload)
    except ValidationError as e:
        return JSONResponse(
            status_code=400,
            content=ErrorResponse(
                error="Invalid request body", details=e.json()
            ).model_dump(mode="json"),
        )

    try:
        result = await run_agentic_pipeline(
            req.ticket,
            req.platform,
            repo_context=req.repo_context,
            provider=req.provider,
            count_hint=req.count_hint,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("Agentic pipeline crashed")
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                error=f"Agentic pipeline failed: {e}"
            ).model_dump(mode="json"),
        )

    # Map terminal-error payloads to the right HTTP status. Readiness
    # failures stay 422 (same as /generate) so existing UI handlers work.
    code = result.get("code") or ""
    if code == "ticket_validation_failed":
        return JSONResponse(status_code=422, content=result)
    if code in {"agentic_pipeline_failed", "agentic_pipeline_empty"}:
        return JSONResponse(status_code=500, content=result)

    return JSONResponse(content=result)


# ────────────────────────────────────────────────────────────────────────────
# Streaming variant — server-sent events driven by LangGraph's astream.
# The wizard subscribes and renders a real progress bar with stage labels
# (no fake timer). One terminal event ("result") carries the final payload
# so the client never needs a second round-trip.
# ────────────────────────────────────────────────────────────────────────────


@router.post("/agentic-generate-stream")
async def agentic_generate_stream(payload: dict[str, Any]):
    try:
        req = GenerateRequest(**payload)
    except ValidationError as e:
        return JSONResponse(
            status_code=400,
            content=ErrorResponse(
                error="Invalid request body", details=e.json()
            ).model_dump(mode="json"),
        )

    async def event_source():
        try:
            async for event_name, data in run_agentic_pipeline_stream(
                req.ticket,
                req.platform,
                repo_context=req.repo_context,
                provider=req.provider,
                count_hint=req.count_hint,
            ):
                yield f"event: {event_name}\ndata: {json.dumps(data)}\n\n"
        except Exception as e:  # noqa: BLE001
            logger.exception("Stream pipeline crashed")
            yield (
                "event: result\n"
                f"data: {json.dumps({'error': str(e), 'code': 'agentic_pipeline_failed'})}\n\n"
            )

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            # Disable any buffering proxies in between (nginx etc).
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ────────────────────────────────────────────────────────────────────────────
# Agentic E2E PR codegen — second multi-agent stage. The TS orchestrator at
# /api/e2e/generate-pr calls this for the LLM-heavy code synthesis +
# convention-conformance + PR narration. All GitHub I/O stays in TS.
# ────────────────────────────────────────────────────────────────────────────


@router.post("/agentic-e2e-codegen")
async def agentic_e2e_codegen(payload: dict[str, Any]) -> JSONResponse:
    try:
        ticket = JiraTicket(**(payload.get("ticket") or {}))
    except ValidationError as e:
        return JSONResponse(
            status_code=400,
            content=ErrorResponse(
                error="Invalid ticket in request body", details=e.json()
            ).model_dump(mode="json"),
        )

    raw_cases = payload.get("test_cases") or []
    try:
        from .models import TestCase
        cases = [TestCase(**c) if not isinstance(c, TestCase) else c for c in raw_cases]
    except ValidationError as e:
        return JSONResponse(
            status_code=400,
            content=ErrorResponse(
                error="Invalid test_cases in request body", details=e.json()
            ).model_dump(mode="json"),
        )

    platform_raw = payload.get("platform")
    try:
        from .models import Platform as PlatformEnum
        platform = PlatformEnum(platform_raw)
    except Exception:  # noqa: BLE001
        return JSONResponse(
            status_code=400,
            content=ErrorResponse(
                error=f"Invalid platform '{platform_raw}' — expected one of ios/android/web"
            ).model_dump(mode="json"),
        )

    framework = payload.get("framework") or ""
    existing_excerpts = payload.get("existing_test_excerpts") or []
    e2e_repo_name = payload.get("e2e_repo_name") or ""
    main_repo = payload.get("main_repo") or ""
    provider = payload.get("provider")

    try:
        result = await run_e2e_codegen_pipeline(
            ticket,
            cases,
            platform,
            framework,
            existing_test_excerpts=existing_excerpts,
            e2e_repo_name=e2e_repo_name,
            main_repo=main_repo,
            provider=provider,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("Agentic E2E codegen crashed")
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                error=f"Agentic E2E codegen failed: {e}"
            ).model_dump(mode="json"),
        )

    code = result.get("code") or ""
    if code == "unsupported_framework":
        return JSONResponse(status_code=400, content=result)
    if code == "agentic_e2e_failed" or code == "agentic_e2e_empty":
        return JSONResponse(status_code=500, content=result)

    return JSONResponse(content=result)


# ────────────────────────────────────────────────────────────────────────────
# RAG — bulk index a repo's test files. The TS orchestrator calls this
# before /agentic-e2e-codegen so the ConventionScanner can retrieve
# semantically similar tests via hybrid search (vector + keyword + RRF).
#
# Body: { "repo": "owner/repo", "files": [{"path", "content", "metadata?"}] }
# Response: { "indexed": int }
# ────────────────────────────────────────────────────────────────────────────


@router.post("/rag/index")
async def rag_index(payload: dict[str, Any]) -> JSONResponse:
    repo = str(payload.get("repo") or "").strip()
    files = payload.get("files") or []
    if not repo or not isinstance(files, list):
        return JSONResponse(
            status_code=400,
            content=ErrorResponse(
                error="`repo` (str) and `files` (list) are required."
            ).model_dump(mode="json"),
        )
    try:
        from .rag import index_repo_files

        wrote = await index_repo_files(repo, files)
        return JSONResponse(content={"indexed": wrote, "repo": repo})
    except Exception as e:  # noqa: BLE001
        logger.exception("RAG index failed")
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(error=f"RAG index failed: {e}").model_dump(mode="json"),
        )


app.include_router(router)
