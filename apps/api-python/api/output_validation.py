"""Output linter — runs over LLM-generated TestCase batches.

This is the symmetric counterpart to api/validation.py:
  - validation.py    → gates BAD INPUT tickets before generation.
  - output_validation → gates BAD OUTPUT test cases after generation.

Why a linter rather than just trusting Pydantic? The Pydantic schema only
checks shape (field exists, right type, list of strings). It does not check
content quality: vague expected_results, two actions crammed into one step,
missing coverage of negative paths, duplicate IDs. Those are LLM failure
modes that show up at runtime even when the JSON parses cleanly.

The linter produces a list of TicketValidationIssue (re-using the same shape
so the UI panel works for both phases). The /generate handler decides what
to do with non-empty results — currently: hard-reject with HTTP 422 and the
same `validation` envelope as input failures. The UI scrolls the user to a
clear "regenerate" affordance.

Rules:
  R1 — Each test_case_id is unique and matches /^TC-\\d{3,}$/.
  R2 — Each test step is atomic: no " and ", no " then ", no two action verbs.
  R3 — expected_result is specific: not in the dead-phrase list AND contains
       at least one of (number, quoted-string, screen reference, assertion verb).
  R4 — Coverage: the batch tags include ≥1 happy-path AND ≥1 negative tag.
       Edge/boundary missing is a WARNING (severity=warning) not an error.
  R5 — Sanity: ≥1 precondition, ≥2 steps, automation_framework_hint within
       the allowed set for the platform.
"""

from __future__ import annotations

import re
from typing import Iterable

from .models import Platform, TestCase, TicketValidationIssue


# ────────────────────────────────────────────────────────────────────────────
# Tunables
# ────────────────────────────────────────────────────────────────────────────

TC_ID_RE = re.compile(r"^TC-\d{3,}$")

# "Dead phrases" — phrases that mean nothing. expected_result must avoid these.
DEAD_PHRASES = (
    "it works",
    "works fine",
    "works correctly",
    "as expected",
    "no issues",
    "no problems",
    "behaves correctly",
    "function correctly",
    "functions correctly",
    "works as intended",
)
_DEAD_RE = re.compile(
    r"\b(" + "|".join(re.escape(p) for p in DEAD_PHRASES) + r")\b",
    flags=re.IGNORECASE,
)

# Verbs that signal a real assertion (vs. a vague claim).
_ASSERTION_VERB_RE = re.compile(
    r"\b(appears?|shows?|displays?|equals?|contains?|returns?|matches?|"
    r"opens?|navigates?|redirects?|increments?|decrements?|"
    r"is (visible|hidden|enabled|disabled|selected|focused|present|absent)|"
    r"updates? to|reflects?|persists?|loads?|reads?)\b",
    flags=re.IGNORECASE,
)

# A number (with optional units), a quoted string, or a $/% value.
_NUMBER_OR_QUOTE_RE = re.compile(
    r"(\d+(?:\.\d+)?|\"[^\"]+\"|'[^']+'|\$\d|%)",
)

# Heuristic for "two actions in one step": the joining word ` and ` between
# two imperative-looking phrases. We ALSO bail out on " then " mid-sentence.
_AND_JOIN_RE = re.compile(r"\s+\band\b\s+(?!the)", flags=re.IGNORECASE)
_THEN_JOIN_RE = re.compile(r"\s+\bthen\b\s+", flags=re.IGNORECASE)

# Coverage tag sets — we accept synonyms for each bucket.
HAPPY_TAGS = {"happy-path", "happy_path", "happypath", "positive", "smoke"}
NEGATIVE_TAGS = {"negative", "invalid", "validation", "error", "failure"}
EDGE_TAGS = {"edge", "edge-case", "boundary", "limit", "performance", "race"}

# Allowed automation framework hints per platform (lowercased). Empty set = any.
_ALLOWED_FRAMEWORKS: dict[Platform, set[str]] = {
    Platform.android: {
        "espresso", "ui automator", "uiautomator", "maestro", "appium",
        "compose ui test", "compose test",
    },
    Platform.ios: {
        "xcuitest", "xctest", "maestro", "appium", "earlgrey",
    },
    Platform.web: {
        "playwright", "cypress", "selenium", "webdriverio", "puppeteer",
        "testcafe",
    },
}


# ────────────────────────────────────────────────────────────────────────────
# Rule implementations
#
# Each returns a list of TicketValidationIssue keyed by the test_case_id of
# the offending case (via `field` like "generated_test_cases[2].test_steps").
# We DON'T short-circuit; we collect every issue so the prompt engineer /
# QA reviewer sees the full picture at once.
# ────────────────────────────────────────────────────────────────────────────


def _r1_unique_ids(cases: list[TestCase]) -> list[TicketValidationIssue]:
    issues: list[TicketValidationIssue] = []
    seen: dict[str, int] = {}
    for i, tc in enumerate(cases):
        if not TC_ID_RE.match(tc.test_case_id or ""):
            issues.append(
                TicketValidationIssue(
                    field=f"generated_test_cases[{i}].test_case_id",
                    code="tc_id_format",
                    message=f"test_case_id '{tc.test_case_id}' does not match TC-### pattern.",
                    hint="Use TC-001, TC-002, etc.",
                )
            )
        seen[tc.test_case_id] = seen.get(tc.test_case_id, 0) + 1
    for tc_id, count in seen.items():
        if count > 1:
            issues.append(
                TicketValidationIssue(
                    field="generated_test_cases",
                    code="tc_id_duplicate",
                    message=f"test_case_id '{tc_id}' appears {count} times.",
                    hint="Every case must have a unique ID.",
                )
            )
    return issues


def _r2_atomic_steps(cases: list[TestCase]) -> list[TicketValidationIssue]:
    issues: list[TicketValidationIssue] = []
    for i, tc in enumerate(cases):
        for j, step in enumerate(tc.test_steps):
            text = (step or "").strip()
            # `and the` is fine ("tap the X and the Y appears" is shaky, but
            # avoid false-positives on normal English noun phrases). The regex
            # uses negative lookahead for "the".
            if _AND_JOIN_RE.search(text) or _THEN_JOIN_RE.search(text):
                issues.append(
                    TicketValidationIssue(
                        field=f"generated_test_cases[{i}].test_steps[{j}]",
                        code="step_not_atomic",
                        message=f"Step '{text[:80]}...' looks like two actions.",
                        hint="Split into one step per user action.",
                    )
                )
    return issues


def _r3_measurable_expected(cases: list[TestCase]) -> list[TicketValidationIssue]:
    issues: list[TicketValidationIssue] = []
    for i, tc in enumerate(cases):
        text = (tc.expected_result or "").strip()
        if not text:
            issues.append(
                TicketValidationIssue(
                    field=f"generated_test_cases[{i}].expected_result",
                    code="expected_missing",
                    message="expected_result is empty.",
                    hint="State what the user / system should observe after the steps.",
                )
            )
            continue
        dead = _DEAD_RE.search(text)
        if dead:
            issues.append(
                TicketValidationIssue(
                    field=f"generated_test_cases[{i}].expected_result",
                    code="expected_vague",
                    message=f"expected_result contains vague phrase '{dead.group(1)}'.",
                    hint="Replace with a measurable outcome (specific UI text, number, screen).",
                )
            )
        has_specificity = bool(
            _NUMBER_OR_QUOTE_RE.search(text) or _ASSERTION_VERB_RE.search(text)
        )
        if not has_specificity:
            issues.append(
                TicketValidationIssue(
                    field=f"generated_test_cases[{i}].expected_result",
                    code="expected_not_specific",
                    message=f"expected_result '{text[:80]}' has no concrete assertion.",
                    hint="Use an assertion verb (appears/shows/equals) or a specific value.",
                )
            )
    return issues


def _r4_coverage(cases: list[TestCase]) -> list[TicketValidationIssue]:
    """Batch-level rule: across all cases, do we have positive AND negative?"""
    issues: list[TicketValidationIssue] = []
    all_tags: set[str] = set()
    for tc in cases:
        for t in tc.tags:
            all_tags.add((t or "").strip().lower())
    if not (all_tags & HAPPY_TAGS):
        issues.append(
            TicketValidationIssue(
                field="generated_test_cases",
                code="coverage_missing_happy_path",
                message="Batch has no happy-path / positive / smoke test case.",
                hint="Add at least one positive scenario tagged 'happy-path' or 'positive'.",
            )
        )
    if not (all_tags & NEGATIVE_TAGS):
        issues.append(
            TicketValidationIssue(
                field="generated_test_cases",
                code="coverage_missing_negative",
                message="Batch has no negative / validation / error case.",
                hint="Add at least one negative scenario tagged 'negative' or 'validation'.",
            )
        )
    if not (all_tags & EDGE_TAGS):
        # Warning only — not all features have meaningful edge cases.
        issues.append(
            TicketValidationIssue(
                field="generated_test_cases",
                code="coverage_missing_edge",
                severity="warning",
                message="Batch has no edge / boundary case.",
                hint="Consider adding a 'boundary' or 'edge' tagged case if relevant.",
            )
        )
    return issues


def _r5_sanity(cases: list[TestCase], platform: Platform) -> list[TicketValidationIssue]:
    issues: list[TicketValidationIssue] = []
    allowed = _ALLOWED_FRAMEWORKS.get(platform, set())
    for i, tc in enumerate(cases):
        if len(tc.test_steps) < 2:
            issues.append(
                TicketValidationIssue(
                    field=f"generated_test_cases[{i}].test_steps",
                    code="too_few_steps",
                    message=f"Case '{tc.test_case_id}' has only {len(tc.test_steps)} step(s).",
                    hint="A meaningful test usually has at least 2 steps.",
                )
            )
        if not tc.preconditions:
            issues.append(
                TicketValidationIssue(
                    field=f"generated_test_cases[{i}].preconditions",
                    code="missing_preconditions",
                    severity="warning",
                    message=f"Case '{tc.test_case_id}' has no preconditions.",
                    hint="Specify the starting state ('User is logged in', 'On Home screen').",
                )
            )
        if allowed and tc.automation_framework_hint:
            hint_norm = tc.automation_framework_hint.strip().lower()
            if not any(a in hint_norm for a in allowed):
                issues.append(
                    TicketValidationIssue(
                        field=f"generated_test_cases[{i}].automation_framework_hint",
                        code="framework_mismatch",
                        severity="warning",
                        message=(
                            f"automation_framework_hint '{tc.automation_framework_hint}' "
                            f"is not a typical {platform.value} framework."
                        ),
                        hint=f"For {platform.value}, prefer: {', '.join(sorted(allowed))}.",
                    )
                )
    return issues


# ────────────────────────────────────────────────────────────────────────────
# Public entry point
# ────────────────────────────────────────────────────────────────────────────


def lint_generated_cases(
    cases: list[TestCase], platform: Platform
) -> list[TicketValidationIssue]:
    """Run every rule and return aggregated issues. Errors and warnings mixed."""
    issues: list[TicketValidationIssue] = []
    issues.extend(_r1_unique_ids(cases))
    issues.extend(_r2_atomic_steps(cases))
    issues.extend(_r3_measurable_expected(cases))
    issues.extend(_r4_coverage(cases))
    issues.extend(_r5_sanity(cases, platform))
    return issues


def errors_only(issues: Iterable[TicketValidationIssue]) -> list[TicketValidationIssue]:
    """Filter to severity=error. Used to decide HTTP 422 vs pass-with-warnings."""
    return [i for i in issues if i.severity == "error"]
