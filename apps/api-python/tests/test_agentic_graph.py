"""Tests for the multi-agent SDLC pipeline in api/agentic_graph.py.

These tests stub the LLM provider so the graph runs offline. We exercise
three paths:

  1. Happy path — readiness passes, generator produces clean output, no
     repair needed, scorer runs, payload contains all expected sections.

  2. Repair loop — first generator output trips an R1–R5 lint error; the
     reviewer routes back to the generator; the second attempt is clean.

  3. Readiness rejection — bad ticket short-circuits before any LLM call.
"""

from __future__ import annotations

import pytest

from api import agentic_graph as ag
from api.llm import LLMCompletionResponse, register_llm_provider
from api.models import JiraTicket, Platform, IssueType, Priority


# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────


def _good_ticket() -> JiraTicket:
    return JiraTicket(
        ticket_id="KAN-100",
        summary="Login screen rejects empty password with inline error and disabled submit",
        description=(
            "On the Login screen, when the user taps Sign In while the Password field is "
            "empty, the app must block submission, display an inline error 'Password is "
            "required' under the Password field, and keep the Sign In button disabled until "
            "the user types at least one character. Email validation is unchanged. No network "
            "request must be made while the form is invalid."
        ),
        acceptance_criteria=[
            "Given the Password field is empty, when the user taps Sign In, then no network request is sent and an inline error appears.",
            "Given a non-empty Password, when the field changes, then the error clears and Sign In is enabled.",
        ],
        issue_type=IssueType.story,
        priority=Priority.medium,
        component="auth",
        labels=["login"],
        environment="iOS 17, Android 14",
    )


def _bad_ticket() -> JiraTicket:
    return JiraTicket(
        ticket_id="KAN-1",
        summary="bug",
        description="TBD",
        acceptance_criteria=[],
        issue_type=IssueType.story,
        priority=Priority.medium,
        component="",
        labels=[],
        environment="",
    )


class _StubProvider:
    """Drop-in LLM stub. Responds based on a small script keyed by call order."""

    def __init__(self, name: str, script: list[str], model: str = "stub-1") -> None:
        self.name = name
        self.defaultModel = model
        self._script = list(script)
        self._i = 0
        self.last_usage = {"model": model, "input_tokens": 100, "output_tokens": 100}

    def isAvailable(self) -> bool:  # noqa: N802 — mirrors interface
        return True

    async def complete(self, req):  # noqa: ANN001 — uses LLMCompletionRequest
        text = self._script[min(self._i, len(self._script) - 1)]
        self._i += 1
        return LLMCompletionResponse(
            text=text, model=self.defaultModel, provider=self.name,
        )


def _install_stub(monkeypatch, script: list[str]) -> _StubProvider:
    stub = _StubProvider("stub", script)
    monkeypatch.setattr(ag, "resolve_llm_provider", lambda name=None: stub)
    # Also force the validator / judge code paths to resolve the same stub.
    import api.validation as v
    import api.judge as j
    monkeypatch.setattr(v, "resolve_llm_provider", lambda name=None: stub)
    monkeypatch.setattr(j, "resolve_llm_provider", lambda name=None: stub)
    return stub


def _good_test_batch_json(ticket_id: str = "KAN-100") -> str:
    """A schema-valid, lint-clean batch the generator can emit."""
    cases = [
        {
            "test_case_id": "TC-001",
            "test_scenario": "Empty password blocks submit on Login screen",
            "platform": "android",
            "preconditions": ["App installed", "Login screen open"],
            "test_steps": [
                "Open the Login screen.",
                "Leave Password empty.",
                "Tap Sign In.",
            ],
            "test_data": ["password='' (empty string)"],
            "expected_result": "Inline error 'Password is required' appears within 100 ms; no network request is sent.",
            "priority": "high",
            "automation_candidate": True,
            "automation_framework_hint": "espresso",
            "tags": ["happy-path", "auth"],
        },
        {
            "test_case_id": "TC-002",
            "test_scenario": "Whitespace-only password treated as empty",
            "platform": "android",
            "preconditions": ["Login screen open"],
            "test_steps": [
                "Type three spaces into the Password field.",
                "Tap Sign In.",
            ],
            "test_data": ["password='   ' (three spaces)"],
            "expected_result": "Same inline error 'Password is required' is shown; Sign In stays disabled.",
            "priority": "medium",
            "automation_candidate": True,
            "automation_framework_hint": "espresso",
            "tags": ["negative", "auth"],
        },
        {
            "test_case_id": "TC-003",
            "test_scenario": "Typing a character clears the inline error",
            "platform": "android",
            "preconditions": ["Login screen with error visible"],
            "test_steps": [
                "Type the character 'a' into the Password field.",
                "Observe the Sign In button state.",
            ],
            "test_data": ["password='a'"],
            "expected_result": "Inline error disappears within 100 ms; Sign In button becomes enabled.",
            "priority": "medium",
            "automation_candidate": True,
            "automation_framework_hint": "espresso",
            "tags": ["happy-path", "auth"],
        },
    ]
    import json
    return json.dumps({
        "ticket_id": ticket_id,
        "summary": "Login screen rejects empty password",
        "generated_test_cases": cases,
    })


def _bad_test_batch_json(ticket_id: str = "KAN-100") -> str:
    """A batch that violates R2 (atomicity — 'and' in a step)."""
    import json
    return json.dumps({
        "ticket_id": ticket_id,
        "summary": "Login screen rejects empty password",
        "generated_test_cases": [
            {
                "test_case_id": "TC-001",
                "test_scenario": "Empty password shows error",
                "platform": "android",
                "preconditions": ["App installed"],
                "test_steps": [
                    "Open the Login screen and tap Sign In and wait for error.",
                    "Confirm the error is visible.",
                ],
                "test_data": ["password=''"],
                "expected_result": "Inline error 'Password is required' appears within 100 ms.",
                "priority": "high",
                "automation_candidate": True,
                "automation_framework_hint": "espresso",
                "tags": ["happy-path"],
            },
            {
                "test_case_id": "TC-002",
                "test_scenario": "Whitespace-only acts as empty",
                "platform": "android",
                "preconditions": ["Login screen open"],
                "test_steps": [
                    "Type three spaces into the Password field.",
                    "Tap Sign In.",
                ],
                "test_data": ["password='   '"],
                "expected_result": "Inline error 'Password is required' appears within 100 ms.",
                "priority": "medium",
                "automation_candidate": True,
                "automation_framework_hint": "espresso",
                "tags": ["negative"],
            },
            {
                "test_case_id": "TC-003",
                "test_scenario": "Typing clears the error",
                "platform": "android",
                "preconditions": ["Login screen open"],
                "test_steps": [
                    "Type 'a' into the Password field.",
                    "Observe the Sign In button state.",
                ],
                "test_data": ["password='a'"],
                "expected_result": "Sign In button becomes enabled within 100 ms.",
                "priority": "medium",
                "automation_candidate": True,
                "automation_framework_hint": "espresso",
                "tags": ["happy-path"],
            },
        ],
    })


def _requirements_json() -> str:
    import json
    return json.dumps({
        "primary_behaviour": "Login form must validate empty password client-side.",
        "happy_paths": ["Empty submit shows inline error"],
        "negative_paths": ["Whitespace-only password is rejected"],
        "edge_cases": ["Deep-link entry from notification"],
        "non_functional": ["Error must appear within 100 ms"],
        "out_of_scope": ["Email validation"],
    })


def _rubric_pass_json() -> str:
    import json
    return json.dumps({
        "score": 88,
        "passed": True,
        "summary": "Ticket is testable.",
        "issues": [],
    })


def _judge_pass_json() -> str:
    import json
    return json.dumps({
        "score": 84,
        "summary": "Good coverage; steps atomic.",
        "per_case_flags": [],
    })


# ────────────────────────────────────────────────────────────────────────────
# Tests
# ────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_agentic_happy_path(monkeypatch):
    """Readiness pass → requirements → generator OK → no repair → scorer → payload."""
    script = [
        _rubric_pass_json(),          # readiness rubric
        _requirements_json(),         # BA agent
        _good_test_batch_json(),      # generator
        _judge_pass_json(),           # scorer
    ]
    _install_stub(monkeypatch, script)

    result = await ag.run_agentic_pipeline(_good_ticket(), Platform.android)
    assert "error" not in result, result
    assert result["repair_attempts"] == 0
    assert len(result["generated_test_cases"]) >= 3
    assert "requirements" in result and result["requirements"]["primary_behaviour"]
    assert "quality" in result
    assert result["quality"]["score"] == 84


@pytest.mark.asyncio
async def test_agentic_repair_loop(monkeypatch):
    """First gen has an atomicity violation; second attempt is clean."""
    script = [
        _rubric_pass_json(),          # readiness
        _requirements_json(),         # BA
        _bad_test_batch_json(),       # generator attempt 1 (violates R2)
        _good_test_batch_json(),      # generator attempt 2 (clean)
        _judge_pass_json(),           # scorer
    ]
    _install_stub(monkeypatch, script)

    result = await ag.run_agentic_pipeline(_good_ticket(), Platform.android)
    assert "error" not in result, result
    assert result["repair_attempts"] == 1
    assert "quality" in result


@pytest.mark.asyncio
async def test_agentic_short_circuits_on_bad_ticket(monkeypatch):
    """Deterministic readiness rules block before any LLM call (no scripted responses needed)."""
    _install_stub(monkeypatch, [_rubric_pass_json()])  # rubric never used here

    result = await ag.run_agentic_pipeline(_bad_ticket(), Platform.android)
    assert result.get("code") == "ticket_validation_failed"
    assert "validation" in result
