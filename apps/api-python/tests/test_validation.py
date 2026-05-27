"""Unit tests for the ticket-readiness validator.

Run from repo root:
  cd apps/api-python && python -m pytest -q

Covers:
  - Each deterministic rule's happy path and failure modes.
  - The bug-specific repro / expected-vs-actual check.
  - The rubric integration with a stubbed LLM provider (passing and failing).
  - The /pyapi/generate gate (422 with structured envelope, no LLM call made).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from api import validation as v
from api.llm import LLMCompletionRequest, LLMCompletionResponse, LLMProvider
from api.models import IssueType, JiraTicket, Platform


# ────────────────────────────────────────────────────────────────────────────
# Test ticket builders — keep the test bodies tiny by composing from a base.
# ────────────────────────────────────────────────────────────────────────────


def _good_ticket(**overrides: Any) -> JiraTicket:
    base = dict(
        ticket_id="KAN-101",
        summary="Upload profile picture validates file size",
        description=(
            "On the Profile Settings screen, when the user taps 'Change picture' "
            "and selects an image larger than 5 MB, the app must reject the upload, "
            "show a toast 'File too large, max 5 MB', and leave the existing avatar unchanged."
        ),
        acceptance_criteria=[
            "Given user is on Profile Settings, when they pick a 10 MB image, then a toast appears.",
            "Given user is on Profile Settings, when they pick a 4 MB image, then the avatar updates.",
        ],
        issue_type=IssueType.story,
    )
    base.update(overrides)
    return JiraTicket(**base)


def _codes(issues: list) -> list[str]:
    return [i.code for i in issues]


# ────────────────────────────────────────────────────────────────────────────
# Rule 1 — Summary
# ────────────────────────────────────────────────────────────────────────────


def test_summary_too_short():
    t = _good_ticket(summary="fix")
    codes = _codes(v.run_deterministic_rules(t))
    assert "summary_too_short" in codes


def test_summary_placeholder():
    # Exactly 10 chars so length check passes but junk regex catches it.
    t = _good_ticket(summary="placeholder")
    codes = _codes(v.run_deterministic_rules(t))
    assert "summary_placeholder" in codes


def test_summary_passes_when_clean():
    t = _good_ticket()
    codes = _codes(v.run_deterministic_rules(t))
    assert "summary_too_short" not in codes
    assert "summary_missing" not in codes
    assert "summary_placeholder" not in codes


# ────────────────────────────────────────────────────────────────────────────
# Rule 2 — Description
# ────────────────────────────────────────────────────────────────────────────


def test_description_too_short():
    t = _good_ticket(description="short")
    codes = _codes(v.run_deterministic_rules(t))
    assert "description_too_short" in codes


def test_description_placeholder_TBD():
    # Long enough to pass length, but contains TBD as a standalone token.
    t = _good_ticket(
        description="This needs work. TBD — designer will fill this in. Pending.",
    )
    codes = _codes(v.run_deterministic_rules(t))
    assert "description_placeholder" in codes


def test_description_with_tbd_in_word_not_flagged():
    # "stbd" should NOT match — the regex uses word boundaries.
    t = _good_ticket(
        description="The starboard (stbd) sensor reads angle and reports it back to the app.",
    )
    codes = _codes(v.run_deterministic_rules(t))
    assert "description_placeholder" not in codes


# ────────────────────────────────────────────────────────────────────────────
# Rule 3 — Acceptance criteria
# ────────────────────────────────────────────────────────────────────────────


def test_ac_too_few():
    t = _good_ticket(acceptance_criteria=["only one criterion that is long enough"])
    codes = _codes(v.run_deterministic_rules(t))
    assert "ac_too_few" in codes


def test_ac_too_short():
    t = _good_ticket(acceptance_criteria=["x", "y"])
    codes = _codes(v.run_deterministic_rules(t))
    # Either of these is fine — depends on whether we count tokens before or after
    # filtering. The current impl strips and keeps short ones, so we expect both.
    assert "ac_too_short" in codes


def test_ac_whitespace_only_filtered():
    # Whitespace entries shouldn't count toward the minimum.
    t = _good_ticket(acceptance_criteria=["   ", "real criterion that is long"])
    codes = _codes(v.run_deterministic_rules(t))
    assert "ac_too_few" in codes


# ────────────────────────────────────────────────────────────────────────────
# Rule 4 — Bug-specific
# ────────────────────────────────────────────────────────────────────────────


def test_bug_missing_repro_and_expected_actual():
    t = _good_ticket(
        issue_type=IssueType.bug,
        description="App crashes occasionally. Needs investigation by the team.",
    )
    codes = _codes(v.run_deterministic_rules(t))
    assert "bug_missing_repro" in codes
    assert "bug_missing_expected_vs_actual" in codes


def test_bug_with_repro_and_expected_actual_passes():
    t = _good_ticket(
        issue_type=IssueType.bug,
        description=(
            "Steps to reproduce: 1) Open app 2) Tap profile. "
            "Expected: profile screen opens. Actual: app crashes."
        ),
    )
    codes = _codes(v.run_deterministic_rules(t))
    assert "bug_missing_repro" not in codes
    assert "bug_missing_expected_vs_actual" not in codes


def test_story_not_subject_to_bug_rules():
    # The bug rule should not fire on stories even with a thin description.
    t = _good_ticket(issue_type=IssueType.story)
    codes = _codes(v.run_deterministic_rules(t))
    assert "bug_missing_repro" not in codes
    assert "bug_missing_expected_vs_actual" not in codes


# ────────────────────────────────────────────────────────────────────────────
# Full pipeline — rules pass + rubric stub
# ────────────────────────────────────────────────────────────────────────────


class _StubProvider(LLMProvider):
    """Test double — captures the request and replays a canned JSON response."""

    name = "stub"
    default_model = "stub-model"

    def __init__(self, payload: dict[str, Any]):
        self._payload = payload
        self.calls: list[LLMCompletionRequest] = []

    def is_available(self) -> bool:
        return True

    async def complete(self, req: LLMCompletionRequest) -> LLMCompletionResponse:
        self.calls.append(req)
        return LLMCompletionResponse(
            text=json.dumps(self._payload),
            model=self.default_model,
            provider=self.name,
        )


def test_validate_ticket_rules_only_passes_clean_ticket():
    result = asyncio.run(
        v.validate_ticket(_good_ticket(), Platform.android, use_llm_rubric=False)
    )
    assert result.passed is True
    assert result.issues == []
    assert result.rubric_score is None


def test_validate_ticket_with_rubric_failure(monkeypatch):
    """Rules pass, but the rubric scores it low — overall result is failed."""
    stub = _StubProvider(
        payload={
            "score": 42,
            "passed": False,
            "summary": "Outcomes are subjective; nothing measurable to test.",
            "issues": [
                {
                    "field": "description",
                    "code": "ambiguous_expected_behavior",
                    "severity": "error",
                    "message": "'Snappier' has no measurable definition.",
                    "hint": "Define thresholds, e.g. 'p95 < 2.5s on 3G'.",
                }
            ],
        }
    )
    monkeypatch.setattr(v, "resolve_llm_provider", lambda _=None: stub)

    result = asyncio.run(
        v.validate_ticket(_good_ticket(), Platform.web, use_llm_rubric=True)
    )
    assert result.passed is False
    assert result.rubric_score == 42
    assert _codes(result.issues) == ["ambiguous_expected_behavior"]
    assert len(stub.calls) == 1


def test_validate_ticket_with_rubric_success(monkeypatch):
    stub = _StubProvider(
        payload={
            "score": 88,
            "passed": True,
            "summary": "Testable, measurable, clear ACs.",
            "issues": [],
        }
    )
    monkeypatch.setattr(v, "resolve_llm_provider", lambda _=None: stub)

    result = asyncio.run(
        v.validate_ticket(_good_ticket(), Platform.android, use_llm_rubric=True)
    )
    assert result.passed is True
    assert result.rubric_score == 88
    assert result.issues == []


def test_validate_ticket_rubric_infra_failure_does_not_block(monkeypatch):
    """If the LLM call blows up, we MUST NOT block — return rules-only pass."""

    class _BrokenProvider(LLMProvider):
        name = "broken"
        default_model = "broken"

        def is_available(self) -> bool:
            return True

        async def complete(self, req):  # noqa: ARG002
            raise RuntimeError("LLM provider on fire")

    monkeypatch.setattr(v, "resolve_llm_provider", lambda _=None: _BrokenProvider())

    result = asyncio.run(
        v.validate_ticket(_good_ticket(), Platform.android, use_llm_rubric=True)
    )
    assert result.passed is True
    assert result.issues == []
    assert result.rubric_score is None


def test_validate_ticket_skips_rubric_when_rules_fail(monkeypatch):
    """Don't spend an LLM call on a ticket that already failed obvious checks."""
    stub = _StubProvider(payload={"score": 90, "passed": True, "issues": []})
    monkeypatch.setattr(v, "resolve_llm_provider", lambda _=None: stub)

    t = _good_ticket(summary="fix")  # too short — rule 1 fails
    result = asyncio.run(v.validate_ticket(t, Platform.android, use_llm_rubric=True))
    assert result.passed is False
    assert "summary_too_short" in _codes(result.issues)
    assert stub.calls == []  # rubric was not called


# ────────────────────────────────────────────────────────────────────────────
# Endpoint-level — /pyapi/generate gate
# ────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from api.main import app

    return TestClient(app)


def test_generate_rejects_bad_ticket_with_422(client, monkeypatch):
    """The gate must short-circuit before any LLM call."""

    class _ShouldNotBeCalled(LLMProvider):
        name = "trap"
        default_model = "trap"

        def is_available(self) -> bool:
            return True

        async def complete(self, req):  # noqa: ARG002
            raise AssertionError(
                "LLM was called despite ticket failing validation gate."
            )

    monkeypatch.setattr(
        "api.main.resolve_llm_provider", lambda _=None: _ShouldNotBeCalled()
    )

    res = client.post(
        "/pyapi/generate",
        json={
            "ticket": {
                "ticket_id": "KAN-bad",
                "summary": "fix",
                "description": "TBD",
                "acceptance_criteria": ["it works"],
                "issue_type": "bug",
            },
            "platform": "android",
        },
    )
    assert res.status_code == 422
    body = res.json()
    assert body["code"] == "ticket_validation_failed"
    assert body["validation"]["passed"] is False
    codes = [i["code"] for i in body["validation"]["issues"]]
    assert "summary_too_short" in codes
    # Note: description "TBD" is 3 chars, so it fails description_too_short
    # before the placeholder check runs — that's the order in run_deterministic_rules.
    assert "description_too_short" in codes
    assert "ac_too_few" in codes


def test_validate_ticket_endpoint_returns_200_on_failure(client):
    """/validate-ticket returns 200 even when the ticket is rejected."""
    res = client.post(
        "/pyapi/validate-ticket",
        json={
            "ticket": {
                "ticket_id": "KAN-bad",
                "summary": "fix",
                "description": "",
                "acceptance_criteria": [],
                "issue_type": "story",
            },
            "platform": "android",
            "use_llm_rubric": False,
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["passed"] is False
    assert len(body["issues"]) > 0
