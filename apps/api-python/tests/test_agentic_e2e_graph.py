"""Tests for the multi-agent E2E codegen pipeline.

We stub the LLM provider end-to-end so the graph runs offline. Three paths
are exercised:

  1. Happy path — scanner returns a style, generator emits a clean Maestro
     YAML, reviewer finds no errors, narrator writes a PR title + body.
  2. Repair loop — generator first emits a YAML missing `appId:`, reviewer
     flags it, second attempt is clean.
  3. Unsupported framework — rejected at the entry point with code
     'unsupported_framework'.
"""

from __future__ import annotations

import json

import pytest

from api import agentic_e2e_graph as ag
from api.llm import LLMCompletionResponse
from api.models import IssueType, JiraTicket, Platform, Priority, TestCase


# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────


def _ticket() -> JiraTicket:
    return JiraTicket(
        ticket_id="KAN-123",
        summary="Login screen rejects empty password with inline error",
        description=(
            "On the Login screen, tapping Sign In while Password is empty must show "
            "an inline error within 100 ms and keep the button disabled."
        ),
        acceptance_criteria=[
            "Given empty password when tap Sign In then inline error appears within 100 ms",
            "Given non-empty password when typing then error clears and Sign In enables",
        ],
        issue_type=IssueType.story,
        priority=Priority.medium,
        component="auth",
        labels=["login"],
        environment="Android 14",
    )


def _cases() -> list[TestCase]:
    base = dict(
        platform=Platform.android,
        automation_candidate=True,
        automation_framework_hint="maestro",
    )
    return [
        TestCase(
            test_case_id="TC-001",
            test_scenario="Empty password blocks submit",
            preconditions=["Login screen open"],
            test_steps=["Leave Password empty.", "Tap Sign In."],
            test_data=["password=''"],
            expected_result="Inline error 'Password is required' appears within 100 ms.",
            tags=["happy-path"],
            **base,
        ),
        TestCase(
            test_case_id="TC-002",
            test_scenario="Typed character clears error",
            preconditions=["Login screen with error visible"],
            test_steps=["Type 'a' into Password.", "Observe Sign In button."],
            test_data=["password='a'"],
            expected_result="Inline error disappears and Sign In becomes enabled.",
            tags=["happy-path"],
            **base,
        ),
    ]


class _StubProvider:
    """Drop-in LLM stub. Responds based on a small script keyed by call order."""

    def __init__(self, script: list[str]) -> None:
        self.name = "stub"
        self.defaultModel = "stub-1"
        self._script = list(script)
        self._i = 0
        self.last_usage = {"model": "stub-1", "input_tokens": 100, "output_tokens": 100}

    def isAvailable(self) -> bool:  # noqa: N802
        return True

    async def complete(self, req):  # noqa: ANN001
        text = self._script[min(self._i, len(self._script) - 1)]
        self._i += 1
        return LLMCompletionResponse(text=text, model=self.defaultModel, provider=self.name)


def _install_stub(monkeypatch, script: list[str]) -> _StubProvider:
    stub = _StubProvider(script)
    monkeypatch.setattr(ag, "resolve_llm_provider", lambda name=None: stub)
    return stub


def _scanner_json() -> str:
    return json.dumps({
        "summary": "Maestro flows in tests/, locators by id, helpers in helpers/common.yaml.",
        "locator_strategy": "id",
        "helper_imports": ["- runFlow: helpers/common.yaml"],
        "naming_convention": "tests/<area>/<scenario>.yaml",
        "page_object_pattern": "n/a — Maestro is declarative",
        "test_method_pattern": "one flow per file",
        "notes": ["always launchApp at the top", "no long sleeps"],
    })


def _good_maestro_files() -> str:
    yaml_body = (
        "appId: com.example.eventrickymorty\n"
        "---\n"
        "- launchApp\n"
        "- assertVisible: \"Sign In\"\n"
        "- tapOn: \"Sign In\"\n"
        "- assertVisible: \"Password is required\"\n"
    )
    return json.dumps({
        "files": [
            {"path": "tests/auth/empty_password.yaml", "content": yaml_body},
        ]
    })


def _bad_maestro_files_missing_appid() -> str:
    yaml_body = (
        "# Oops — missing appId:\n"
        "---\n"
        "- launchApp\n"
        "- assertVisible: \"Sign In\"\n"
    )
    return json.dumps({
        "files": [
            {"path": "tests/auth/empty_password.yaml", "content": yaml_body},
        ]
    })


def _narrator_json() -> str:
    return json.dumps({
        "title": "E2E: empty password rejected with inline error",
        "description": (
            "Auto-generated tests for KAN-123.\n\n"
            "## Files\n- `tests/auth/empty_password.yaml` — covers AC1, AC2\n\n"
            "## House style\nLocators by id; one flow per file.\n\n"
            "## How to run locally\n```\nmaestro test tests/auth/empty_password.yaml\n```\n\n"
            "## Reviewer checklist\n"
            "- [ ] Selectors match.\n"
            "- [ ] No long sleeps.\n"
            "- [ ] Coverage matches all AC.\n"
        ),
    })


# ────────────────────────────────────────────────────────────────────────────
# Tests
# ────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_e2e_happy_path(monkeypatch):
    """Scanner → Generator (clean) → Reviewer (no errors) → Narrator → payload."""
    _install_stub(monkeypatch, [
        _scanner_json(),
        _good_maestro_files(),
        _narrator_json(),
    ])

    result = await ag.run_e2e_codegen_pipeline(
        _ticket(),
        _cases(),
        Platform.android,
        "maestro",
        existing_test_excerpts=[{"path": "tests/sample.yaml", "excerpt": "appId: example"}],
        e2e_repo_name="EventRickyMorty-android-e2e",
        main_repo="asif786ka/EventRickyMorty",
    )
    assert result["ok"] is True, result
    assert result["repair_attempts"] == 0
    assert len(result["files"]) == 1
    assert result["files"][0]["path"].endswith(".yaml")
    assert "appId:" in result["files"][0]["content"]
    assert result["pr_title"].startswith("E2E")
    assert "## Reviewer checklist" in result["pr_description"]


@pytest.mark.asyncio
async def test_e2e_repair_loop(monkeypatch):
    """First gen misses `appId:`; reviewer flags it; second attempt is clean."""
    _install_stub(monkeypatch, [
        _scanner_json(),
        _bad_maestro_files_missing_appid(),  # attempt 1 — bad
        _good_maestro_files(),                # attempt 2 — clean
        _narrator_json(),
    ])

    result = await ag.run_e2e_codegen_pipeline(
        _ticket(),
        _cases(),
        Platform.android,
        "maestro",
    )
    assert result["ok"] is True, result
    assert result["repair_attempts"] == 1
    # Only the final attempt's files should be present, and they should be clean.
    assert all("appId:" in f["content"] for f in result["files"])


@pytest.mark.asyncio
async def test_e2e_unsupported_framework(monkeypatch):
    # Stub installed for safety, but the entry-point check rejects before any LLM call.
    _install_stub(monkeypatch, [_scanner_json()])
    result = await ag.run_e2e_codegen_pipeline(
        _ticket(),
        _cases(),
        Platform.android,
        "appium",  # not in the supported set
    )
    assert result["ok"] is False
    assert result["code"] == "unsupported_framework"
