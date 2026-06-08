"""Agentic E2E codegen pipeline — second multi-agent stage of the SDLC.

Takes the test-case batch produced by /pyapi/agentic-generate (or any
upstream source) and turns it into framework-specific E2E test files +
a high-quality PR description, ready for the TypeScript orchestrator
(/api/e2e/generate-pr) to commit and open as a PR.

Pipeline (supervisor-worker with a bounded repair loop)

    [ ConventionScanner ] ──> [ CodeGenerator ] ──> [ StaticReviewer ]
                                       ▲                      │
                                       └─── repair ◄──────────┤
                                                              │
                                                              ▼
                                                      [ PRNarrator ]
                                                              │
                                                              ▼
                                                            END

Why each agent exists
─────────────────────
1. ConventionScanner — reads 3-8 existing test file excerpts from the
                       target E2E repo and extracts the "house style"
                       (locator strategy, helper imports, file naming,
                       page-object layout). Output is a structured dict
                       the generator can ground on.

2. CodeGenerator     — produces 1-N framework-specific files from
                       test_cases × house_style × platform × framework.
                       Reuses the existing provider registry.

3. StaticReviewer    — deterministic, framework-aware sanity checks:
                       file extension matches framework, required
                       imports present, identifier-based selectors used,
                       no banned APIs. On failure → routes back to the
                       generator with structured repair guidance, bounded
                       by MAX_REPAIRS so token spend stays predictable.

4. PRNarrator        — drafts a PR title + Markdown description that
                       maps each generated test to the ticket's
                       acceptance criteria, notes which conventions were
                       followed, and surfaces suggested reviewers.

Design choices that match the rest of the codebase
──────────────────────────────────────────────────
* State is a TypedDict; each agent writes only its own keys.
* Async end-to-end via the existing LLMProvider.complete coroutine.
* Repair is a conditional edge, not in-node mutation — keeps the graph
  conceptually acyclic except for one bounded loop edge.
* All LLM/parse failures degrade gracefully with structured fallbacks.
  The pipeline never crashes the FastAPI worker; the route handler
  returns whatever was assembled with an `error` flag if relevant.

Public entry point: ``run_e2e_codegen_pipeline``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import tempfile
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from .llm import LLMCompletionRequest, resolve_llm_provider
from .models import JiraTicket, Platform, TestCase

logger = logging.getLogger("jiraqa.python.agentic_e2e")


# ────────────────────────────────────────────────────────────────────────────
# Tunables — mirror the patterns in agentic_graph.py
# ────────────────────────────────────────────────────────────────────────────

MAX_REPAIRS = 2
SCANNER_TEMPERATURE = 0.1
GENERATOR_TEMPERATURE = 0.2
REPAIR_TEMPERATURE = 0.15
NARRATOR_TEMPERATURE = 0.3

# Frameworks the pipeline knows how to lint. The TS orchestrator passes
# `framework` based on the user's RepoConventions; we keep the names
# normalised so the static reviewer rules can branch cleanly.
SUPPORTED_FRAMEWORKS = {"maestro", "xcuitest", "espresso", "playwright"}

# Extension contract — used both to suggest file names AND by R1 below.
_EXT_BY_FRAMEWORK = {
    "maestro": ".yaml",
    "xcuitest": ".swift",
    "espresso": ".kt",
    "playwright": ".ts",
}


# ────────────────────────────────────────────────────────────────────────────
# Graph state
# ────────────────────────────────────────────────────────────────────────────


class HouseStyle(TypedDict, total=False):
    """The convention-scanner's structured artefact."""

    summary: str
    locator_strategy: str       # e.g. "accessibilityIdentifier", "data-testid"
    helper_imports: list[str]   # one-per-line, raw import strings
    naming_convention: str      # file/class naming pattern with examples
    page_object_pattern: str    # short description of the layout
    test_method_pattern: str    # how individual tests are organised
    notes: list[str]            # anything else worth telling the generator


class GeneratedFile(TypedDict, total=False):
    path: str
    content: str


class ReviewIssue(TypedDict, total=False):
    file: str
    code: str
    severity: str               # "error" | "warning"
    message: str
    hint: str


class E2ECodegenState(TypedDict, total=False):
    # ── Inputs (set once by the entry point)
    ticket: JiraTicket
    test_cases: list[TestCase]
    platform: Platform
    framework: str
    existing_test_excerpts: list[dict]   # [{"path": "...", "excerpt": "..."}]
    e2e_repo_name: str
    main_repo: str                       # "owner/name" for context
    provider_name: str | None

    # ── Populated by ConventionScanner
    house_style: HouseStyle

    # ── Populated by CodeGenerator (per attempt)
    candidate_files: list[GeneratedFile]
    repair_attempts: int
    repair_feedback: list[ReviewIssue]

    # ── Populated by StaticReviewer
    review_issues: list[ReviewIssue]

    # ── Populated by PRNarrator
    pr_title: str
    pr_description: str

    # ── Final
    final_payload: dict[str, Any]
    error: str


# ────────────────────────────────────────────────────────────────────────────
# Agent 1 — ConventionScanner
# ────────────────────────────────────────────────────────────────────────────


_SCANNER_SYSTEM = """You are an experienced mobile/web QA engineer reverse-engineering a team's
test conventions. Given excerpts from existing E2E test files, return a JSON
object that captures the house style so a code generator can match it exactly.

Return ONLY this exact JSON shape:
{
  "summary": "one-paragraph overview of the conventions",
  "locator_strategy": "the dominant selector approach (testID, accessibilityIdentifier, data-testid, xpath, etc.)",
  "helper_imports": ["...", "..."],
  "naming_convention": "file/class naming pattern with an example",
  "page_object_pattern": "short description of how screens/components are wrapped",
  "test_method_pattern": "how individual test functions are organised",
  "notes": ["anything else worth telling the generator"]
}
"""


def _excerpts_as_text(excerpts: list[dict]) -> str:
    if not excerpts:
        return "(no existing test files were supplied — infer sensible defaults for the framework)"
    blocks = []
    for ex in excerpts[:8]:  # cap context budget
        path = ex.get("path", "<unknown>")
        body = ex.get("excerpt") or ex.get("content") or ""
        body = body[:1500]  # per-file cap
        blocks.append(f"--- {path} ---\n{body}")
    return "\n\n".join(blocks)


async def convention_scanner_agent(state: E2ECodegenState) -> E2ECodegenState:
    llm = resolve_llm_provider(state.get("provider_name"))
    user = (
        f"Framework: {state.get('framework')}\n"
        f"Platform: {state.get('platform')}\n"
        f"Target E2E repo: {state.get('e2e_repo_name')}\n"
        f"Source main repo: {state.get('main_repo')}\n\n"
        "Existing test files in the E2E repo:\n"
        + _excerpts_as_text(state.get("existing_test_excerpts") or [])
    )
    try:
        resp = await llm.complete(
            LLMCompletionRequest(
                system_prompt=_SCANNER_SYSTEM,
                user_prompt=user,
                temperature=SCANNER_TEMPERATURE,
                json_mode=True,
                max_tokens=900,
            )
        )
        parsed = json.loads(resp.text)
    except Exception as e:  # noqa: BLE001
        logger.warning("Convention scanner failed; using framework defaults: %s", e)
        parsed = {}

    house_style: HouseStyle = {
        "summary": parsed.get("summary") or _default_summary(state.get("framework", "")),
        "locator_strategy": parsed.get("locator_strategy")
        or _default_locator(state.get("framework", "")),
        "helper_imports": list(parsed.get("helper_imports") or []),
        "naming_convention": parsed.get("naming_convention") or "",
        "page_object_pattern": parsed.get("page_object_pattern") or "",
        "test_method_pattern": parsed.get("test_method_pattern") or "",
        "notes": list(parsed.get("notes") or []),
    }
    return {"house_style": house_style}


def _default_summary(framework: str) -> str:
    return {
        "maestro": "Maestro flows in YAML, one file per ticket, locator by id/text.",
        "xcuitest": "XCUITest cases as XCTestCase subclasses in Swift, AccessibilityIdentifier-based locators.",
        "espresso": "Espresso tests in Kotlin with @Test annotations, view-matcher locators by R.id.",
        "playwright": "Playwright TypeScript spec files, locator(role/testId)-based selectors.",
    }.get(framework, "Framework defaults — no existing tests supplied.")


def _default_locator(framework: str) -> str:
    return {
        "maestro": "id (resource-id on Android, accessibilityIdentifier on iOS)",
        "xcuitest": "accessibilityIdentifier",
        "espresso": "withId(R.id.…)",
        "playwright": "data-testid via getByTestId() preferred over text/role",
    }.get(framework, "id-based selectors")


# ────────────────────────────────────────────────────────────────────────────
# Agent 2 — CodeGenerator
# ────────────────────────────────────────────────────────────────────────────


_GENERATOR_SYSTEM = """You are a senior mobile/web SDET. Generate framework-specific E2E test
files from a structured test plan. Match the team's house style exactly.

Output STRICT JSON with this exact shape — nothing else, no prose, no markdown fences:

{
  "files": [
    { "path": "tests/login/empty_password.yaml", "content": "<full file contents>" },
    ...
  ]
}

Hard requirements per framework:
- maestro    : YAML file, MUST start with `appId:` line, MUST include a `- launchApp` step.
- xcuitest   : Swift, MUST `import XCTest`, MUST define a `class XYZ: XCTestCase`.
- espresso   : Kotlin, MUST `import org.junit.Test`, every test method annotated with `@Test`.
- playwright : TypeScript, MUST `import { test, expect } from '@playwright/test'`.

Always use the locator strategy from the house style. Prefer atomic steps —
one user action per assertion. expected_result must contain a concrete assertion
(`appears`, `equals`, a quoted value, a number, or a screen reference).
"""


def _ticket_block(ticket: JiraTicket) -> str:
    lines = [
        f"Ticket: {ticket.ticket_id}",
        f"Summary: {ticket.summary}",
        f"Description:\n{ticket.description}",
    ]
    if ticket.acceptance_criteria:
        lines.append("Acceptance Criteria:")
        for i, ac in enumerate(ticket.acceptance_criteria, 1):
            lines.append(f"  {i}. {ac}")
    return "\n".join(lines)


def _test_cases_block(cases: list[TestCase]) -> str:
    out = []
    for tc in cases:
        out.append(f"\n### {tc.test_case_id} — {tc.test_scenario}")
        if tc.preconditions:
            out.append("Preconditions:")
            for p in tc.preconditions:
                out.append(f"  - {p}")
        if tc.test_steps:
            out.append("Steps:")
            for i, s in enumerate(tc.test_steps, 1):
                out.append(f"  {i}. {s}")
        if tc.test_data:
            out.append("Test data: " + "; ".join(tc.test_data))
        out.append(f"Expected: {tc.expected_result}")
        if tc.tags:
            out.append("Tags: " + ", ".join(tc.tags))
    return "\n".join(out)


def _house_style_block(style: HouseStyle) -> str:
    lines = ["House style (match this exactly):"]
    if style.get("summary"):
        lines.append(f"- Summary: {style['summary']}")
    if style.get("locator_strategy"):
        lines.append(f"- Locator strategy: {style['locator_strategy']}")
    if style.get("naming_convention"):
        lines.append(f"- Naming: {style['naming_convention']}")
    if style.get("page_object_pattern"):
        lines.append(f"- Page-object pattern: {style['page_object_pattern']}")
    if style.get("test_method_pattern"):
        lines.append(f"- Test method pattern: {style['test_method_pattern']}")
    if style.get("helper_imports"):
        lines.append("- Helper imports:")
        for imp in style["helper_imports"]:
            lines.append(f"    {imp}")
    if style.get("notes"):
        lines.append("- Additional notes:")
        for n in style["notes"]:
            lines.append(f"    - {n}")
    return "\n".join(lines)


async def code_generator_agent(state: E2ECodegenState) -> E2ECodegenState:
    llm = resolve_llm_provider(state.get("provider_name"))
    style = state.get("house_style") or {}
    framework = state.get("framework", "")
    repair = state.get("repair_feedback") or []

    user_parts = [
        f"Framework: {framework}",
        f"Platform: {state.get('platform')}",
        f"Target E2E repo: {state.get('e2e_repo_name')}",
        "",
        _house_style_block(style),  # type: ignore[arg-type]
        "",
        "Ticket:",
        _ticket_block(state["ticket"]),
        "",
        "Test cases to translate into code:",
        _test_cases_block(state.get("test_cases") or []),
    ]
    if repair:
        user_parts.append("")
        user_parts.append("Reviewer feedback from previous attempt — fix every item:")
        for it in repair:
            line = f"  [{it.get('code')}] {it.get('message')}"
            if it.get("file"):
                line += f" (file: {it['file']})"
            if it.get("hint"):
                line += f"  hint: {it['hint']}"
            user_parts.append(line)

    user = "\n".join(user_parts)
    try:
        completion = await llm.complete(
            LLMCompletionRequest(
                system_prompt=_GENERATOR_SYSTEM,
                user_prompt=user,
                temperature=REPAIR_TEMPERATURE if repair else GENERATOR_TEMPERATURE,
                json_mode=True,
                max_tokens=4000,
            )
        )
    except Exception as e:  # noqa: BLE001
        return {"error": f"Code generator LLM call failed: {e}"}

    try:
        parsed = json.loads(completion.text)
    except json.JSONDecodeError as e:
        return {"error": f"Code generator returned invalid JSON: {e}"}

    files_raw = parsed.get("files") or []
    files: list[GeneratedFile] = []
    for f in files_raw:
        if not isinstance(f, dict):
            continue
        path = str(f.get("path", "")).strip()
        content = str(f.get("content", ""))
        if path and content:
            files.append({"path": path, "content": content})

    if not files:
        return {"error": "Code generator produced no files"}

    return {"candidate_files": files}


# ────────────────────────────────────────────────────────────────────────────
# Agent 3 — StaticReviewer (deterministic — no LLM call)
# ────────────────────────────────────────────────────────────────────────────


def _lint_one(file: GeneratedFile, framework: str) -> list[ReviewIssue]:
    issues: list[ReviewIssue] = []
    path = file.get("path", "")
    content = file.get("content", "") or ""

    expected_ext = _EXT_BY_FRAMEWORK.get(framework)
    if expected_ext and not path.endswith(expected_ext):
        issues.append({
            "file": path,
            "code": "wrong_extension",
            "severity": "error",
            "message": f"Path must end with '{expected_ext}' for {framework}.",
            "hint": f"Rename to a {expected_ext} file.",
        })

    if framework == "maestro":
        if not re.search(r"^\s*appId\s*:", content, flags=re.MULTILINE):
            issues.append({
                "file": path,
                "code": "maestro_missing_appid",
                "severity": "error",
                "message": "Maestro flow must start with an 'appId:' line.",
                "hint": "Add 'appId: com.example.app' at the top of the file.",
            })
        if not re.search(r"-\s*launchApp\b", content):
            issues.append({
                "file": path,
                "code": "maestro_missing_launchapp",
                "severity": "error",
                "message": "Maestro flow must include a '- launchApp' step.",
                "hint": "Add a '- launchApp' step before interactions.",
            })

    elif framework == "xcuitest":
        if "import XCTest" not in content:
            issues.append({
                "file": path,
                "code": "xcuitest_missing_import",
                "severity": "error",
                "message": "XCUITest file must `import XCTest`.",
                "hint": "Add `import XCTest` at the top.",
            })
        if not re.search(r"class\s+\w+\s*:\s*XCTestCase", content):
            issues.append({
                "file": path,
                "code": "xcuitest_missing_class",
                "severity": "error",
                "message": "Must define a class inheriting from XCTestCase.",
                "hint": "Wrap your tests in `class XYZTests: XCTestCase { ... }`.",
            })

    elif framework == "espresso":
        if "import org.junit.Test" not in content:
            issues.append({
                "file": path,
                "code": "espresso_missing_import",
                "severity": "error",
                "message": "Espresso test must `import org.junit.Test`.",
                "hint": "Add `import org.junit.Test` and annotate every test method with `@Test`.",
            })
        if "@Test" not in content:
            issues.append({
                "file": path,
                "code": "espresso_missing_test_annotation",
                "severity": "error",
                "message": "At least one method must be annotated with `@Test`.",
                "hint": "Mark each test method `@Test`.",
            })

    elif framework == "playwright":
        if "@playwright/test" not in content or "import" not in content:
            issues.append({
                "file": path,
                "code": "playwright_missing_import",
                "severity": "error",
                "message": "Playwright spec must import `{ test, expect }` from '@playwright/test'.",
                "hint": "Add `import { test, expect } from '@playwright/test';` at the top.",
            })

    # Cross-framework banned APIs (R5 — sanity).
    if re.search(r"\bsleep\s*\(\s*\d{4,}\s*\)", content):
        issues.append({
            "file": path,
            "code": "long_sleep",
            "severity": "warning",
            "message": "Long sleep() detected — prefer explicit waits / expectations.",
            "hint": "Use the framework's built-in wait helpers instead of fixed sleeps over 1s.",
        })

    return issues


async def static_reviewer_agent(state: E2ECodegenState) -> E2ECodegenState:
    """Deterministic per-file lint + optional `maestro check` parse-time validation.

    The regex rules in `_lint_one` always run. If the framework is maestro
    AND the `maestro` binary is on PATH (set MAESTRO_CHECK=1 to enable),
    we additionally write each YAML to a temp file and shell out to
    `maestro check` to validate against the official Maestro spec — catches
    spec violations our regex can't (indentation, unknown commands, malformed
    keys). This is "parse-time" validation; no device required.
    """
    framework = state.get("framework", "")
    files = state.get("candidate_files") or []
    issues: list[ReviewIssue] = []
    for f in files:
        issues.extend(_lint_one(f, framework))

    if framework == "maestro" and _maestro_check_enabled():
        try:
            cli_issues = await _run_maestro_check(files)
            issues.extend(cli_issues)
        except Exception as e:  # noqa: BLE001
            logger.info("maestro check skipped: %s", e)

    return {"review_issues": issues}


def _maestro_check_enabled() -> bool:
    """Off by default to avoid surprising users on machines without maestro.
    Enable by setting MAESTRO_CHECK=1 in the env (run-dev.sh + .env.local).
    """
    if os.environ.get("MAESTRO_CHECK") not in ("1", "true", "yes"):
        return False
    return shutil.which("maestro") is not None


async def _run_maestro_check(files: list[GeneratedFile]) -> list[ReviewIssue]:
    """For each generated YAML, run `maestro check` and parse the output.

    Returns one ReviewIssue per CLI-flagged problem, mapping the file back
    to the original path so the generator's repair feedback names it.
    """
    out: list[ReviewIssue] = []
    with tempfile.TemporaryDirectory(prefix="maestro-check-") as tmp:
        for f in files:
            if not f.get("path", "").endswith(".yaml"):
                continue
            content = f.get("content", "") or ""
            disk_path = os.path.join(tmp, os.path.basename(f["path"]))
            try:
                with open(disk_path, "w", encoding="utf-8") as fh:
                    fh.write(content)
            except OSError as e:
                logger.warning("maestro check: cannot write temp file: %s", e)
                continue

            try:
                proc = await asyncio.create_subprocess_exec(
                    "maestro", "check", disk_path,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
            except (asyncio.TimeoutError, FileNotFoundError) as e:
                logger.info("maestro check timed out or missing: %s", e)
                continue

            text = (stdout.decode(errors="replace") + "\n" + stderr.decode(errors="replace")).strip()
            if proc.returncode == 0:
                continue  # passed

            # The CLI prints multiple lines per error; we surface the first
            # 3 as separate review items so the generator gets focused feedback.
            error_lines = [
                ln.strip()
                for ln in text.splitlines()
                if ln.strip() and not ln.startswith("Maestro")
            ][:3] or [text[:200]]
            for ln in error_lines:
                out.append({
                    "file": f["path"],
                    "code": "maestro_check_failed",
                    "severity": "error",
                    "message": f"maestro check rejected the flow: {ln}",
                    "hint": "Fix the spec violation reported by the Maestro CLI.",
                })
    return out


def _errors_only(issues: list[ReviewIssue]) -> list[ReviewIssue]:
    return [i for i in issues if (i.get("severity") or "error") == "error"]


def route_after_review(state: E2ECodegenState) -> str:
    if state.get("error"):
        return "narrate"  # still narrate so the route gets a coherent payload
    errors = _errors_only(state.get("review_issues") or [])
    if not errors:
        return "narrate"
    if state.get("repair_attempts", 0) >= MAX_REPAIRS:
        return "narrate"
    return "repair"


def repair_prep_node(state: E2ECodegenState) -> E2ECodegenState:
    return {
        "repair_attempts": state.get("repair_attempts", 0) + 1,
        "repair_feedback": _errors_only(state.get("review_issues") or []),
    }


# ────────────────────────────────────────────────────────────────────────────
# Agent 4 — PRNarrator
# ────────────────────────────────────────────────────────────────────────────


_NARRATOR_SYSTEM = """You write GitHub pull request descriptions for AI-generated E2E test PRs.
The PR is auto-opened on a sister 'e2e' repo. The audience is the SDET / mobile
team that owns the tests.

Return ONLY this JSON shape:
{
  "title": "short imperative PR title (<= 72 chars)",
  "description": "Markdown body — see structure below"
}

The description MUST include, in order:
  1. A one-sentence summary tied to the ticket.
  2. A bullet list mapping each generated file → which acceptance criteria it covers.
  3. A 'House style followed' section quoting the locator strategy + key conventions.
  4. A 'How to run locally' section with the right command for the framework.
  5. A 'Reviewer checklist' with 3-5 concrete items.

Use second-person, concise prose. No emoji. No invented stats.
"""


async def pr_narrator_agent(state: E2ECodegenState) -> E2ECodegenState:
    llm = resolve_llm_provider(state.get("provider_name"))
    files = state.get("candidate_files") or []
    style = state.get("house_style") or {}
    framework = state.get("framework", "")

    user_parts = [
        f"Framework: {framework}",
        f"Platform: {state.get('platform')}",
        f"E2E repo: {state.get('e2e_repo_name')}",
        f"Source repo: {state.get('main_repo')}",
        "",
        "Ticket:",
        _ticket_block(state["ticket"]),
        "",
        "Generated files:",
    ]
    for f in files:
        user_parts.append(f"  - {f.get('path')}")
    user_parts.append("")
    user_parts.append(_house_style_block(style))  # type: ignore[arg-type]
    user_parts.append("")
    user_parts.append("Test cases covered:")
    user_parts.append(_test_cases_block(state.get("test_cases") or []))

    try:
        resp = await llm.complete(
            LLMCompletionRequest(
                system_prompt=_NARRATOR_SYSTEM,
                user_prompt="\n".join(user_parts),
                temperature=NARRATOR_TEMPERATURE,
                json_mode=True,
                max_tokens=1200,
            )
        )
        parsed = json.loads(resp.text)
    except Exception as e:  # noqa: BLE001
        logger.info("PR narrator failed; using deterministic fallback: %s", e)
        parsed = {}

    title = parsed.get("title") or _fallback_title(state["ticket"])
    description = parsed.get("description") or _fallback_description(state, files)
    return {"pr_title": title, "pr_description": description}


def _fallback_title(ticket: JiraTicket) -> str:
    base = f"E2E tests for {ticket.ticket_id}: {ticket.summary}"
    return base[:72]


def _fallback_description(state: E2ECodegenState, files: list[GeneratedFile]) -> str:
    ticket = state["ticket"]
    lines = [
        f"Auto-generated E2E tests for {ticket.ticket_id} — {ticket.summary}.",
        "",
        "## Files",
    ]
    for f in files:
        lines.append(f"- `{f['path']}`")
    lines.append("")
    lines.append("## Reviewer checklist")
    lines.append("- [ ] Selectors match the team's locator strategy.")
    lines.append("- [ ] All acceptance criteria are covered.")
    lines.append("- [ ] No long sleeps / flaky waits.")
    lines.append("- [ ] Tests run locally against a current build.")
    return "\n".join(lines)


# ────────────────────────────────────────────────────────────────────────────
# Final assembly
# ────────────────────────────────────────────────────────────────────────────


def finalize_node(state: E2ECodegenState) -> E2ECodegenState:
    if state.get("error") and not state.get("candidate_files"):
        return {
            "final_payload": {
                "ok": False,
                "error": state.get("error"),
                "code": "agentic_e2e_failed",
            }
        }
    payload: dict[str, Any] = {
        "ok": True,
        "files": list(state.get("candidate_files") or []),
        "house_style": state.get("house_style", {}),
        "review_issues": list(state.get("review_issues") or []),
        "repair_attempts": state.get("repair_attempts", 0),
        "pr_title": state.get("pr_title", _fallback_title(state["ticket"])),
        "pr_description": state.get("pr_description")
        or _fallback_description(state, state.get("candidate_files") or []),
    }
    if state.get("error"):
        payload["partial_error"] = state["error"]
    return {"final_payload": payload}


# ────────────────────────────────────────────────────────────────────────────
# Graph assembly
# ────────────────────────────────────────────────────────────────────────────


def _build_graph():
    g = StateGraph(E2ECodegenState)

    g.add_node("agent_scanner", convention_scanner_agent)
    g.add_node("agent_generator", code_generator_agent)
    g.add_node("agent_reviewer", static_reviewer_agent)
    g.add_node("repair_prep", repair_prep_node)
    g.add_node("agent_narrator", pr_narrator_agent)
    g.add_node("finalize_ok", finalize_node)

    g.add_edge(START, "agent_scanner")
    g.add_edge("agent_scanner", "agent_generator")
    g.add_edge("agent_generator", "agent_reviewer")
    g.add_conditional_edges(
        "agent_reviewer",
        route_after_review,
        {"repair": "repair_prep", "narrate": "agent_narrator"},
    )
    g.add_edge("repair_prep", "agent_generator")
    g.add_edge("agent_narrator", "finalize_ok")
    g.add_edge("finalize_ok", END)

    return g.compile()


E2E_CODEGEN_GRAPH = _build_graph()


# ────────────────────────────────────────────────────────────────────────────
# Public entry point
# ────────────────────────────────────────────────────────────────────────────


async def run_e2e_codegen_pipeline(
    ticket: JiraTicket,
    test_cases: list[TestCase],
    platform: Platform,
    framework: str,
    *,
    existing_test_excerpts: list[dict] | None = None,
    e2e_repo_name: str | None = None,
    main_repo: str | None = None,
    provider: str | None = None,
) -> dict[str, Any]:
    """Run the full 4-agent codegen pipeline. Returns the JSON payload directly.

    The TS orchestrator at /api/e2e/generate-pr calls this, then handles all
    GitHub I/O (repo creation, branch, commit, PR). We deliberately do not
    touch GitHub from Python — keeping LLMs out of the git plumbing path.
    """
    fw = (framework or "").strip().lower()
    if fw not in SUPPORTED_FRAMEWORKS:
        return {
            "ok": False,
            "code": "unsupported_framework",
            "error": (
                f"Framework '{framework}' is not supported. "
                f"Choose one of: {sorted(SUPPORTED_FRAMEWORKS)}"
            ),
        }

    initial: E2ECodegenState = {
        "ticket": ticket,
        "test_cases": test_cases,
        "platform": platform,
        "framework": fw,
        "existing_test_excerpts": existing_test_excerpts or [],
        "e2e_repo_name": e2e_repo_name or "",
        "main_repo": main_repo or "",
        "provider_name": provider,
        "repair_attempts": 0,
        "repair_feedback": [],
    }
    final = await E2E_CODEGEN_GRAPH.ainvoke(initial)
    return final.get("final_payload") or {
        "ok": False,
        "code": "agentic_e2e_empty",
        "error": "Pipeline ended without a payload",
    }
