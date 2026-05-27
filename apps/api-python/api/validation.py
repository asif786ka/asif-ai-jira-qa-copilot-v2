"""Ticket-readiness validator — the QA-input quality gate.

The /pyapi/generate endpoint and the /pyapi/validate-ticket endpoint both
delegate here. The flow is two-phase:

  1. Deterministic rules (cheap, fast, no LLM) — empty/short summary, empty
     or placeholder description, too few acceptance criteria, bug tickets
     missing repro/expected. Any rule failure produces a TicketValidationIssue
     and the rubric is SKIPPED (no point asking an LLM to score a ticket that
     already failed the obvious checks).
  2. LLM rubric (semantic) — only runs when rules pass and `use_llm_rubric`
     is True. The LLM acts as a senior QA reviewer and decides if the ticket
     is actually testable. See prompt.build_rubric_*_prompt for the contract.

Design contract: rubric infra failures (network, parse, schema) MUST NOT
block. We log, then return rules-only `passed=True`. This way a flaky model
provider never stops a structurally valid ticket from being generated.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Iterable

from .llm import LLMCompletionRequest, LLMProvider, resolve_llm_provider
from .models import (
    IssueType,
    JiraTicket,
    Platform,
    TicketValidationIssue,
    TicketValidationResult,
)
from .prompt import build_rubric_system_prompt, build_rubric_user_prompt

logger = logging.getLogger("jiraqa.python.validation")


# ────────────────────────────────────────────────────────────────────────────
# Tunables
# ────────────────────────────────────────────────────────────────────────────

MIN_SUMMARY_LEN = 10
MIN_DESCRIPTION_LEN = 30
MIN_ACCEPTANCE_CRITERIA = 2
MIN_ACCEPTANCE_CRITERION_LEN = 5
RUBRIC_PASS_THRESHOLD = 70

# Whole-word placeholder tokens that signal an unfinished ticket. We match
# these as standalone words / phrases (case-insensitive) so a real word like
# "tba" inside a longer sentence wouldn't false-positive (`\b` boundaries).
_PLACEHOLDER_TOKENS = (
    "tbd",
    "todo",
    "tba",
    "n/a",
    "fill in later",
    "fill this in",
    "to be determined",
    "to be added",
)
_PLACEHOLDER_RE = re.compile(
    r"\b(" + "|".join(re.escape(t) for t in _PLACEHOLDER_TOKENS) + r")\b",
    flags=re.IGNORECASE,
)

# Words / phrases that indicate a bug ticket has steps-to-reproduce.
_REPRO_RE = re.compile(
    r"\b(steps? to reproduce|reproduce|reproduction|how to reproduce|repro steps?)\b",
    flags=re.IGNORECASE,
)
# Two halves of expected-vs-actual. We require BOTH to be present.
_EXPECTED_RE = re.compile(r"\b(expected|should|must)\b", flags=re.IGNORECASE)
_ACTUAL_RE = re.compile(
    r"\b(actual|got|but instead|currently|observed|happens)\b",
    flags=re.IGNORECASE,
)

# Summary "junk" patterns — single words / nonsense that are technically
# >= MIN_SUMMARY_LEN if you pad them, but obviously not a real ticket title.
_SUMMARY_JUNK_RE = re.compile(r"^(?:tbd|todo|test|asdf|xxx+|placeholder)$", re.IGNORECASE)


# ────────────────────────────────────────────────────────────────────────────
# Deterministic rules
#
# Each rule is a small pure function returning a list of issues. We collect
# them all in one pass so the QA team sees every problem at once instead of
# fixing-then-resubmitting-then-finding-the-next-one.
# ────────────────────────────────────────────────────────────────────────────


def _rule_summary(ticket: JiraTicket) -> list[TicketValidationIssue]:
    issues: list[TicketValidationIssue] = []
    s = (ticket.summary or "").strip()
    if not s:
        issues.append(
            TicketValidationIssue(
                field="summary",
                code="summary_missing",
                message="Summary is required.",
                hint="Add a one-line description of the change, e.g. 'Login screen rejects empty password with inline error'.",
            )
        )
        return issues
    if len(s) < MIN_SUMMARY_LEN:
        issues.append(
            TicketValidationIssue(
                field="summary",
                code="summary_too_short",
                message=f"Summary must be at least {MIN_SUMMARY_LEN} characters (got {len(s)}).",
                hint="Describe what changes and where, not just 'fix' or 'bug'.",
            )
        )
    if _SUMMARY_JUNK_RE.match(s):
        issues.append(
            TicketValidationIssue(
                field="summary",
                code="summary_placeholder",
                message=f"Summary '{s}' looks like a placeholder.",
                hint="Replace with a real one-line description of the change.",
            )
        )
    return issues


def _rule_description(ticket: JiraTicket) -> list[TicketValidationIssue]:
    issues: list[TicketValidationIssue] = []
    d = (ticket.description or "").strip()
    if not d:
        issues.append(
            TicketValidationIssue(
                field="description",
                code="description_missing",
                message="Description is required.",
                hint="Explain the desired behaviour, screen/component, and any constraints.",
            )
        )
        return issues
    if len(d) < MIN_DESCRIPTION_LEN:
        issues.append(
            TicketValidationIssue(
                field="description",
                code="description_too_short",
                message=f"Description must be at least {MIN_DESCRIPTION_LEN} characters (got {len(d)}).",
                hint="Add context: what changes, where, why, and any edge cases to consider.",
            )
        )
    placeholder = _PLACEHOLDER_RE.search(d)
    if placeholder:
        issues.append(
            TicketValidationIssue(
                field="description",
                code="description_placeholder",
                message=f"Description contains placeholder text ('{placeholder.group(1)}'). Replace it with the actual behaviour.",
                hint="What should happen? Where? Under what conditions?",
            )
        )
    return issues


def _rule_acceptance_criteria(ticket: JiraTicket) -> list[TicketValidationIssue]:
    issues: list[TicketValidationIssue] = []
    acs = [a.strip() for a in (ticket.acceptance_criteria or []) if a and a.strip()]
    if len(acs) < MIN_ACCEPTANCE_CRITERIA:
        issues.append(
            TicketValidationIssue(
                field="acceptance_criteria",
                code="ac_too_few",
                message=f"Need at least {MIN_ACCEPTANCE_CRITERIA} acceptance criteria (got {len(acs)}).",
                hint="Add at least a happy-path case and a negative / edge case.",
            )
        )
    # Per-criterion minimum length — catches ["x", "y"] passing the count.
    short = [a for a in acs if len(a) < MIN_ACCEPTANCE_CRITERION_LEN]
    if short:
        issues.append(
            TicketValidationIssue(
                field="acceptance_criteria",
                code="ac_too_short",
                message=f"{len(short)} acceptance criteria are too short to be testable.",
                hint="Use Given/When/Then phrasing with concrete inputs and outputs.",
            )
        )
    return issues


def _rule_bug_specifics(ticket: JiraTicket) -> list[TicketValidationIssue]:
    """Bugs need both 'steps to reproduce' and 'expected vs actual'.

    Skipped for non-bug issue types. We look in the description only — the
    summary is too short to carry both halves of expected-vs-actual.
    """
    if ticket.issue_type != IssueType.bug:
        return []
    issues: list[TicketValidationIssue] = []
    d = ticket.description or ""
    if not _REPRO_RE.search(d):
        issues.append(
            TicketValidationIssue(
                field="description",
                code="bug_missing_repro",
                message="Bug tickets must include steps to reproduce.",
                hint="Add a 'Steps to reproduce:' section with numbered steps.",
            )
        )
    if not (_EXPECTED_RE.search(d) and _ACTUAL_RE.search(d)):
        issues.append(
            TicketValidationIssue(
                field="description",
                code="bug_missing_expected_vs_actual",
                message="Bug tickets must describe expected vs actual behaviour.",
                hint="Add 'Expected: ...' and 'Actual: ...' lines.",
            )
        )
    return issues


_ALL_RULES = (
    _rule_summary,
    _rule_description,
    _rule_acceptance_criteria,
    _rule_bug_specifics,
)


def run_deterministic_rules(ticket: JiraTicket) -> list[TicketValidationIssue]:
    """Run every rule and aggregate issues. Order is stable so tests can rely on it."""
    issues: list[TicketValidationIssue] = []
    for rule in _ALL_RULES:
        issues.extend(rule(ticket))
    return issues


# ────────────────────────────────────────────────────────────────────────────
# LLM rubric pass
# ────────────────────────────────────────────────────────────────────────────


async def _run_rubric(
    ticket: JiraTicket,
    platform: Platform,
    llm: LLMProvider,
) -> tuple[int | None, str | None, list[TicketValidationIssue]]:
    """Call the LLM rubric and parse its JSON response.

    Returns (score, summary, issues). On any infra/parse error returns
    (None, None, []) — callers treat that as "rubric skipped" and don't block.
    """
    system = build_rubric_system_prompt()
    user = build_rubric_user_prompt(ticket, platform)
    try:
        resp = await llm.complete(
            LLMCompletionRequest(
                system_prompt=system,
                user_prompt=user,
                temperature=0.1,  # rubric scoring should be stable across runs
                json_mode=True,
                max_tokens=800,
            )
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("Rubric LLM call failed (continuing without rubric): %s", e)
        return None, None, []

    try:
        parsed = json.loads(resp.text)
    except json.JSONDecodeError as e:
        logger.warning("Rubric LLM returned invalid JSON (continuing without rubric): %s", e)
        return None, None, []

    score_raw = parsed.get("score")
    try:
        score = int(score_raw) if score_raw is not None else None
    except (TypeError, ValueError):
        score = None
    summary = parsed.get("summary") if isinstance(parsed.get("summary"), str) else None

    raw_issues: Iterable[dict] = parsed.get("issues") or []
    parsed_issues: list[TicketValidationIssue] = []
    for it in raw_issues:
        if not isinstance(it, dict):
            continue
        try:
            parsed_issues.append(
                TicketValidationIssue(
                    field=str(it.get("field", "ticket")),
                    code=str(it.get("code", "rubric_issue")),
                    severity=str(it.get("severity", "error")),
                    message=str(it.get("message", "")),
                    hint=it.get("hint") if isinstance(it.get("hint"), str) else None,
                )
            )
        except Exception as e:  # noqa: BLE001
            logger.debug("Skipping malformed rubric issue: %s (%s)", it, e)

    # Trust the threshold, not the LLM's `passed` flag — keeps behaviour
    # consistent if the model returns score=65 but passed=true.
    if score is not None and score < RUBRIC_PASS_THRESHOLD and not parsed_issues:
        # Score is low but no issues listed — synthesize one so the user
        # at least sees the verdict instead of a silent rejection.
        parsed_issues.append(
            TicketValidationIssue(
                field="ticket",
                code="rubric_low_score",
                message=summary or f"Ticket scored {score}/100 on the QA-readiness rubric.",
                hint="Tighten expected behaviour, add measurable thresholds, and include edge cases.",
            )
        )

    return score, summary, parsed_issues


# ────────────────────────────────────────────────────────────────────────────
# Public entry point
# ────────────────────────────────────────────────────────────────────────────


async def validate_ticket(
    ticket: JiraTicket,
    platform: Platform,
    *,
    use_llm_rubric: bool = True,
    provider: str | None = None,
) -> TicketValidationResult:
    """Run the full validation pipeline. See module docstring for the contract."""
    # Phase 1 — deterministic rules.
    rule_issues = run_deterministic_rules(ticket)
    if rule_issues:
        # Don't waste an LLM call on a ticket that already failed obvious checks.
        return TicketValidationResult(passed=False, issues=rule_issues)

    # Phase 2 — optional LLM rubric.
    if not use_llm_rubric:
        return TicketValidationResult(passed=True, issues=[])

    try:
        llm = resolve_llm_provider(provider)
    except Exception as e:  # noqa: BLE001
        # No provider configured. Treat as rubric-skipped, NOT as failure.
        logger.info("Rubric skipped — no LLM provider available: %s", e)
        return TicketValidationResult(passed=True, issues=[])

    score, summary, rubric_issues = await _run_rubric(ticket, platform, llm)

    passed = True
    if score is not None and score < RUBRIC_PASS_THRESHOLD:
        passed = False
    if rubric_issues:
        # Belt-and-braces: even if score is None or high, surface any issues
        # the rubric explicitly raised.
        passed = False

    return TicketValidationResult(
        passed=passed,
        issues=rubric_issues,
        rubric_score=score,
        rubric_summary=summary,
    )
