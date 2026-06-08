"""JiraQA MCP Server — exposes the agentic SDLC pipelines as MCP tools.

The whole project is two composed LangGraph pipelines + a provider registry.
Any LLM client that speaks Model Context Protocol (Claude Code, Cursor,
Windsurf, Claude Desktop, custom Anthropic Agent SDK clients) can now invoke
them as native tools.

Why expose this over MCP rather than (or in addition to) the existing
FastAPI HTTP routes?

* **Native developer surface.** A developer in Cursor can say
  "Generate Maestro tests for KAN-87" and the IDE's LLM picks the right
  tool, fills the JSON Schema, and calls our pipeline — no UI required.
* **The provider registry pays off.** Claude Code on the developer's
  machine drives Anthropic's Sonnet; the JiraQA server may be configured
  to call Gemini Flash or a local Ollama for the actual agentic work.
  Different families on each side, zero coupling.
* **No new auth surface.** stdio transport runs the server as a
  subprocess of the MCP client. Credentials (LLM keys, etc.) come from
  the host's environment via the same `python-dotenv` loader main.py uses.

Transport
─────────
Default is **stdio** — the IDE launches `python -m mcp_server` (or the
explicit path) as a subprocess and pipes JSON-RPC over stdin/stdout. This
is the most portable + zero-port setup; works on every MCP client.

For an HTTP-style transport (SSE / streamable HTTP), the FastMCP instance
also accepts `transport="sse"` or `transport="streamable-http"` — left
as a follow-up.

Quickstart
──────────
    # install the venv as usual via ./run-dev.sh, then:
    apps/api-python/.venv/bin/python apps/api-python/mcp_server.py

    # OR for ad-hoc development with the inspector:
    apps/api-python/.venv/bin/mcp dev apps/api-python/mcp_server.py
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any, Optional

# Load env (OPENAI_API_KEY, GEMINI_API_KEY, etc.) the same way main.py does so
# the agentic pipelines find their LLM credentials regardless of how this
# server was launched.
try:
    from dotenv import load_dotenv

    _HERE = Path(__file__).resolve().parent
    for _candidate in (
        _HERE / ".env",
        _HERE.parent.parent / ".env.local",
        _HERE.parent / "web" / ".env.local",
    ):
        if _candidate.is_file():
            load_dotenv(_candidate, override=False)
except Exception:
    pass

from mcp.server.fastmcp import FastMCP
from pydantic import ValidationError

# Make `api.*` imports work whether we're launched from the project root or
# from inside apps/api-python/.
_THIS = Path(__file__).resolve().parent
if str(_THIS) not in sys.path:
    sys.path.insert(0, str(_THIS))

from api.agentic_e2e_graph import run_e2e_codegen_pipeline  # noqa: E402
from api.agentic_graph import run_agentic_pipeline  # noqa: E402
from api.models import (  # noqa: E402
    JiraTicket,
    Platform,
    RepoContext,
    TestCase,
)
from api.validation import validate_ticket  # noqa: E402

logger = logging.getLogger("jiraqa.mcp")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))


# ────────────────────────────────────────────────────────────────────────────
# Server
# ────────────────────────────────────────────────────────────────────────────


mcp = FastMCP(
    "JiraQA",
    instructions=(
        "JiraQA exposes two multi-agent LangGraph pipelines as tools. "
        "Use `validate_jira_ticket` to check ticket readiness before generation. "
        "Use `generate_test_cases` to produce a structured QA test plan from a "
        "Jira ticket + optional repo context. Use `codegen_e2e_tests` to turn "
        "that plan into framework-specific E2E test files (Maestro / XCUITest / "
        "Espresso / Playwright)."
    ),
)


# Internal helper — coerces a JSON-like dict (as MCP tools receive) into a
# Pydantic JiraTicket, with a clear error if the shape is wrong.
def _parse_ticket(raw: dict[str, Any]) -> JiraTicket:
    try:
        return JiraTicket(**raw)
    except ValidationError as e:
        raise ValueError(f"`ticket` is not a valid JiraTicket: {e.errors()}") from e


def _parse_platform(raw: str) -> Platform:
    try:
        return Platform(raw)
    except ValueError as e:
        raise ValueError(
            f"`platform` must be one of ios/android/web — got '{raw}'"
        ) from e


# ────────────────────────────────────────────────────────────────────────────
# Tool 1 — Validate a Jira ticket
# ────────────────────────────────────────────────────────────────────────────


@mcp.tool()
async def validate_jira_ticket(
    ticket: dict[str, Any],
    platform: str = "android",
    use_llm_rubric: bool = False,
    provider: Optional[str] = None,
) -> dict[str, Any]:
    """Check whether a Jira ticket is ready for QA test generation.

    Runs the deterministic readiness rules (summary length, description
    length, ≥2 acceptance criteria, no placeholder text, bug-specific
    rules) and optionally an LLM rubric for semantic testability.

    Args:
        ticket: A JiraTicket-shaped object. Must include at least
            `ticket_id`, `summary`, `description`. Acceptance criteria
            are a list of strings under `acceptance_criteria`.
        platform: One of "ios" | "android" | "web".
        use_llm_rubric: When True, also runs a semantic LLM check.
            Costs one LLM call. Default False.
        provider: Override the default LLM provider for the rubric.
            One of "openai" | "gemini" | "anthropic" — or omit to use
            the JiraQA server's default.

    Returns:
        A dict with `passed: bool`, `issues: list`, and (when the rubric
        ran) `rubric_score: int` + `rubric_summary: str`.
    """
    parsed_ticket = _parse_ticket(ticket)
    parsed_platform = _parse_platform(platform)
    result = await validate_ticket(
        parsed_ticket,
        parsed_platform,
        use_llm_rubric=use_llm_rubric,
        provider=provider,
    )
    return result.model_dump(mode="json")


# ────────────────────────────────────────────────────────────────────────────
# Tool 2 — Run the agentic-generate pipeline
# ────────────────────────────────────────────────────────────────────────────


@mcp.tool()
async def generate_test_cases(
    ticket: dict[str, Any],
    platform: str = "android",
    repo_context: Optional[dict[str, Any]] = None,
    count_hint: int = 5,
    provider: Optional[str] = None,
) -> dict[str, Any]:
    """Run the 5-agent SDLC pipeline to generate QA test cases.

    The pipeline composes: readiness gate → requirements extractor →
    test generator → quality reviewer (with bounded repair loop) →
    cross-family scorer. Output is grounded in the ticket + optional
    repo context and validated against a Pydantic schema.

    Args:
        ticket: A JiraTicket-shaped object (see validate_jira_ticket).
        platform: One of "ios" | "android" | "web".
        repo_context: Optional structured repo grounding — README,
            file tree sample, key files. When omitted the agents fall
            back to ticket-only generation.
        count_hint: Approximate number of test cases to produce
            (3–8 enforced server-side).
        provider: Override the LLM provider.

    Returns:
        On readiness failure: `{ "code": "ticket_validation_failed",
        "error": "...", "validation": {...} }`.
        On success: `{ "ticket_id", "summary", "platform", "provider",
        "backend", "generated_test_cases": [...], "requirements": {...},
        "repair_attempts": int, "lint_warnings": [...], "quality": {...} }`.
    """
    parsed_ticket = _parse_ticket(ticket)
    parsed_platform = _parse_platform(platform)
    parsed_ctx: Optional[RepoContext] = None
    if repo_context is not None:
        try:
            parsed_ctx = RepoContext(**repo_context)
        except ValidationError as e:
            raise ValueError(
                f"`repo_context` is not a valid RepoContext: {e.errors()}"
            ) from e
    return await run_agentic_pipeline(
        parsed_ticket,
        parsed_platform,
        repo_context=parsed_ctx,
        provider=provider,
        count_hint=count_hint,
    )


# ────────────────────────────────────────────────────────────────────────────
# Tool 3 — Run the agentic-e2e-codegen pipeline
# ────────────────────────────────────────────────────────────────────────────


@mcp.tool()
async def codegen_e2e_tests(
    ticket: dict[str, Any],
    test_cases: list[dict[str, Any]],
    platform: str = "android",
    framework: str = "maestro",
    existing_test_excerpts: Optional[list[dict[str, str]]] = None,
    e2e_repo_name: str = "",
    main_repo: str = "",
    provider: Optional[str] = None,
) -> dict[str, Any]:
    """Run the 4-agent E2E codegen pipeline to turn test cases into runnable files.

    Pipeline: convention scanner → code generator → static reviewer
    (with bounded repair loop) → PR narrator. Returns framework-specific
    files ready to commit, plus a PR title + Markdown description.

    Args:
        ticket: A JiraTicket-shaped object.
        test_cases: A list of TestCase dicts — typically the
            `generated_test_cases` array from `generate_test_cases`.
        platform: One of "ios" | "android" | "web".
        framework: One of "maestro" | "xcuitest" | "espresso" | "playwright".
        existing_test_excerpts: Optional list of
            `{path, excerpt}` dicts. The convention scanner reads these
            to match the team's house style. Empty list = framework defaults.
        e2e_repo_name: Name of the target E2E repo (used by the PR narrator).
        main_repo: "owner/name" of the source repo (used by the PR narrator).
        provider: Override the LLM provider.

    Returns:
        `{ "ok": bool, "files": [{"path", "content"}], "house_style": {...},
           "review_issues": [...], "repair_attempts": int,
           "pr_title": str, "pr_description": str }`.
    """
    parsed_ticket = _parse_ticket(ticket)
    parsed_platform = _parse_platform(platform)
    parsed_cases: list[TestCase] = []
    for i, tc in enumerate(test_cases):
        try:
            parsed_cases.append(TestCase(**tc))
        except ValidationError as e:
            raise ValueError(
                f"test_cases[{i}] is not a valid TestCase: {e.errors()}"
            ) from e

    return await run_e2e_codegen_pipeline(
        parsed_ticket,
        parsed_cases,
        parsed_platform,
        framework,
        existing_test_excerpts=existing_test_excerpts or [],
        e2e_repo_name=e2e_repo_name,
        main_repo=main_repo,
        provider=provider,
    )


# ────────────────────────────────────────────────────────────────────────────
# Tool 4 — Discoverable enumeration of supported frameworks
# ────────────────────────────────────────────────────────────────────────────


@mcp.tool()
def list_supported_frameworks() -> dict[str, list[str]]:
    """List the E2E frameworks the codegen pipeline knows how to produce."""
    return {
        "frameworks": ["maestro", "xcuitest", "espresso", "playwright"],
        "platforms": ["ios", "android", "web"],
    }


# ────────────────────────────────────────────────────────────────────────────
# Entry point
# ────────────────────────────────────────────────────────────────────────────


def main() -> None:
    """Run the MCP server over stdio.

    MCP clients (Claude Code, Cursor, Windsurf, Claude Desktop) launch this
    as a subprocess and communicate via JSON-RPC over stdin/stdout. See the
    README in this directory for client-specific configuration snippets.
    """
    mcp.run()


if __name__ == "__main__":
    main()
