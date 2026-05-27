"""Tests for the LLM-as-judge layer."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from api import judge as judge_module
from api.judge import judge_generated_cases
from api.llm import LLMCompletionRequest, LLMCompletionResponse, LLMProvider
from api.models import IssueType, JiraTicket, Platform, Priority, TestCase


def _ticket() -> JiraTicket:
    return JiraTicket(
        ticket_id="KAN-9",
        summary="Validate file-size limit on profile upload",
        description="On the Profile screen, large images must be rejected with a toast.",
        acceptance_criteria=[
            "Given a 10 MB image, when the user uploads, a toast appears.",
            "Given a 4 MB image, when the user uploads, the avatar updates.",
        ],
        issue_type=IssueType.story,
    )


def _case(id_: str, tags: list[str], expected: str) -> TestCase:
    return TestCase(
        test_case_id=id_,
        test_scenario="Test",
        platform=Platform.android,
        preconditions=["User on Profile screen"],
        test_steps=["Tap upload", "Select 10 MB image"],
        test_data=[],
        expected_result=expected,
        priority=Priority.medium,
        automation_candidate=True,
        automation_framework_hint="Espresso",
        tags=tags,
    )


class _StubProvider(LLMProvider):
    name = "judge-stub"
    default_model = "stub"

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


def test_judge_returns_parsed_score(monkeypatch):
    stub = _StubProvider(
        payload={
            "score": 88,
            "summary": "Solid coverage, atomic steps.",
            "per_case_flags": [
                {
                    "test_case_id": "TC-002",
                    "code": "redundant",
                    "message": "Duplicate of TC-001.",
                    "hint": "Drop or rewrite.",
                }
            ],
        }
    )
    monkeypatch.setattr(judge_module, "resolve_llm_provider", lambda _=None: stub)

    cases = [
        _case("TC-001", ["happy-path"], "Toast 'File too large' appears."),
        _case("TC-002", ["negative"], "Error message 'Bad' appears."),
    ]
    result = asyncio.run(
        judge_generated_cases(_ticket(), Platform.android, cases)
    )
    assert result.score == 88
    assert result.summary == "Solid coverage, atomic steps."
    assert len(result.per_case_flags) == 1
    assert result.per_case_flags[0].test_case_id == "TC-002"
    assert result.judge_provider == "judge-stub"
    assert len(stub.calls) == 1


def test_judge_swallows_bad_json(monkeypatch):
    class _BadJson(LLMProvider):
        name = "bad"
        default_model = "bad"

        def is_available(self) -> bool:
            return True

        async def complete(self, req):  # noqa: ARG002
            return LLMCompletionResponse(text="not json", model="bad", provider="bad")

    monkeypatch.setattr(judge_module, "resolve_llm_provider", lambda _=None: _BadJson())

    cases = [_case("TC-001", ["happy-path"], "'OK' appears.")]
    result = asyncio.run(judge_generated_cases(_ticket(), Platform.android, cases))
    assert result.score is None
    assert result.judge_provider == "bad"


def test_judge_swallows_call_failure(monkeypatch):
    class _Broken(LLMProvider):
        name = "broken"
        default_model = "broken"

        def is_available(self) -> bool:
            return True

        async def complete(self, req):  # noqa: ARG002
            raise RuntimeError("boom")

    monkeypatch.setattr(judge_module, "resolve_llm_provider", lambda _=None: _Broken())

    result = asyncio.run(
        judge_generated_cases(_ticket(), Platform.android, [_case("TC-001", ["happy-path"], "'OK' appears.")])
    )
    assert result.score is None


def test_judge_skipped_when_no_provider(monkeypatch):
    def _no_provider(_=None):
        raise RuntimeError("no providers registered")

    monkeypatch.setattr(judge_module, "resolve_llm_provider", _no_provider)

    result = asyncio.run(
        judge_generated_cases(_ticket(), Platform.android, [_case("TC-001", ["happy-path"], "'OK' appears.")])
    )
    assert result.score is None
    assert result.judge_provider is None
