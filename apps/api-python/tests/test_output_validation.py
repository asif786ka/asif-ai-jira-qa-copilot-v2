"""Tests for the generated-test-case linter (Layer 1 of output quality)."""

from __future__ import annotations

from api.models import Platform, Priority, TestCase
from api.output_validation import errors_only, lint_generated_cases


# ────────────────────────────────────────────────────────────────────────────
# Fixtures
# ────────────────────────────────────────────────────────────────────────────


def _case(
    *,
    id_: str = "TC-001",
    steps: list[str] | None = None,
    expected: str = "The Home screen appears with the user's name displayed.",
    tags: list[str] | None = None,
    preconditions: list[str] | None = None,
    framework: str = "Espresso",
    platform: Platform = Platform.android,
) -> TestCase:
    return TestCase(
        test_case_id=id_,
        test_scenario="Test scenario",
        platform=platform,
        preconditions=preconditions if preconditions is not None else ["User is logged in"],
        test_steps=steps or ["Tap the Profile tab", "Verify the screen loads"],
        test_data=[],
        expected_result=expected,
        priority=Priority.medium,
        automation_candidate=True,
        automation_framework_hint=framework,
        tags=tags or ["happy-path", "smoke"],
    )


def _good_batch() -> list[TestCase]:
    return [
        _case(id_="TC-001", tags=["happy-path", "smoke"]),
        _case(
            id_="TC-002",
            tags=["negative", "validation"],
            expected="An error message 'Invalid password' appears below the field.",
        ),
        _case(
            id_="TC-003",
            tags=["edge", "boundary"],
            expected="The form accepts exactly 100 characters and rejects the 101st.",
        ),
    ]


def _codes(issues) -> list[str]:
    return [i.code for i in issues]


# ────────────────────────────────────────────────────────────────────────────
# R1 — unique IDs
# ────────────────────────────────────────────────────────────────────────────


def test_good_batch_has_no_errors():
    issues = lint_generated_cases(_good_batch(), Platform.android)
    assert errors_only(issues) == []


def test_duplicate_tc_id_caught():
    cases = _good_batch()
    cases[1] = _case(id_="TC-001", tags=["negative"], expected="Error 'X' appears.")
    codes = _codes(lint_generated_cases(cases, Platform.android))
    assert "tc_id_duplicate" in codes


def test_malformed_tc_id_caught():
    cases = _good_batch()
    cases[0] = _case(id_="case1")
    codes = _codes(lint_generated_cases(cases, Platform.android))
    assert "tc_id_format" in codes


# ────────────────────────────────────────────────────────────────────────────
# R2 — atomic steps
# ────────────────────────────────────────────────────────────────────────────


def test_non_atomic_step_caught():
    cases = _good_batch()
    cases[0] = _case(
        id_="TC-001",
        steps=["Tap Login and verify the home screen appears"],
        tags=["happy-path"],
    )
    codes = _codes(lint_generated_cases(cases, Platform.android))
    assert "step_not_atomic" in codes


def test_then_join_caught():
    cases = _good_batch()
    cases[0] = _case(
        id_="TC-001",
        steps=["Open the app then navigate to Profile", "Verify it loads"],
    )
    codes = _codes(lint_generated_cases(cases, Platform.android))
    assert "step_not_atomic" in codes


def test_and_the_does_not_false_positive():
    # "Tap the Profile tab and the Avatar button" would still be two actions,
    # but "Verify the screen loads" with "and the" elsewhere should be fine.
    # The current regex uses negative lookahead for "the" — that handles common
    # English noun phrases like "tap the button and the screen".
    cases = _good_batch()
    cases[0] = _case(steps=["Tap the button", "Verify the result"])
    codes = _codes(lint_generated_cases(cases, Platform.android))
    assert "step_not_atomic" not in codes


# ────────────────────────────────────────────────────────────────────────────
# R3 — measurable expected_result
# ────────────────────────────────────────────────────────────────────────────


def test_vague_expected_caught():
    cases = _good_batch()
    cases[0] = _case(expected="It works as expected.")
    codes = _codes(lint_generated_cases(cases, Platform.android))
    assert "expected_vague" in codes


def test_non_specific_expected_caught():
    cases = _good_batch()
    # No assertion verb, no number, no quoted string — too generic.
    cases[0] = _case(expected="The result. The end.")
    codes = _codes(lint_generated_cases(cases, Platform.android))
    assert "expected_not_specific" in codes


def test_expected_with_number_passes():
    cases = _good_batch()
    cases[0] = _case(expected="Counter increments to 5 within 2 seconds.")
    codes = _codes(lint_generated_cases(cases, Platform.android))
    assert "expected_not_specific" not in codes
    assert "expected_vague" not in codes


def test_expected_with_quoted_string_passes():
    cases = _good_batch()
    cases[0] = _case(expected='The toast "File too large" is shown.')
    codes = _codes(lint_generated_cases(cases, Platform.android))
    assert "expected_not_specific" not in codes


# ────────────────────────────────────────────────────────────────────────────
# R4 — coverage tags
# ────────────────────────────────────────────────────────────────────────────


def test_missing_happy_path_caught():
    cases = [_case(tags=["negative", "validation"], expected="'Bad' appears.")]
    codes = _codes(lint_generated_cases(cases, Platform.android))
    assert "coverage_missing_happy_path" in codes


def test_missing_negative_caught():
    cases = [_case(tags=["happy-path", "smoke"])]
    codes = _codes(lint_generated_cases(cases, Platform.android))
    assert "coverage_missing_negative" in codes


def test_missing_edge_is_warning_not_error():
    """No edge case = warning, not a hard failure."""
    cases = [
        _case(tags=["happy-path"]),
        _case(id_="TC-002", tags=["negative"], expected="Error 'X' appears."),
    ]
    issues = lint_generated_cases(cases, Platform.android)
    codes = _codes(issues)
    assert "coverage_missing_edge" in codes
    # Should NOT appear in errors_only since it's a warning.
    assert "coverage_missing_edge" not in _codes(errors_only(issues))


# ────────────────────────────────────────────────────────────────────────────
# R5 — sanity
# ────────────────────────────────────────────────────────────────────────────


def test_too_few_steps_caught():
    cases = _good_batch()
    cases[0] = _case(steps=["Tap login"])  # only 1
    codes = _codes(lint_generated_cases(cases, Platform.android))
    assert "too_few_steps" in codes


def test_missing_preconditions_is_warning():
    cases = _good_batch()
    cases[0] = _case(preconditions=[])
    issues = lint_generated_cases(cases, Platform.android)
    assert "missing_preconditions" in _codes(issues)
    assert "missing_preconditions" not in _codes(errors_only(issues))


def test_framework_mismatch_is_warning():
    cases = _good_batch()
    cases[0] = _case(framework="Playwright")  # web tool on android
    issues = lint_generated_cases(cases, Platform.android)
    assert "framework_mismatch" in _codes(issues)
    assert "framework_mismatch" not in _codes(errors_only(issues))


def test_ios_framework_accepted():
    cases = [
        _case(platform=Platform.ios, framework="XCUITest", tags=["happy-path"]),
        _case(
            id_="TC-002",
            platform=Platform.ios,
            framework="XCUITest",
            tags=["negative"],
            expected="Error 'X' appears.",
        ),
    ]
    issues = lint_generated_cases(cases, Platform.ios)
    assert "framework_mismatch" not in _codes(issues)


# ────────────────────────────────────────────────────────────────────────────
# Endpoint integration — /pyapi/generate rejects bad LLM output with 422
# ────────────────────────────────────────────────────────────────────────────


import json
import asyncio
from api.llm import LLMCompletionResponse, LLMProvider


class _CannedLLMProvider(LLMProvider):
    """LLM stub that returns a pre-baked completion."""

    name = "canned"
    default_model = "canned"

    def __init__(self, payload: dict):
        self._payload = payload

    def is_available(self) -> bool:
        return True

    async def complete(self, req):  # noqa: ARG002
        return LLMCompletionResponse(
            text=json.dumps(self._payload),
            model=self.default_model,
            provider=self.name,
        )


def test_generate_endpoint_rejects_lint_failures(monkeypatch):
    """End-to-end: a deliberately bad LLM response is rejected with 422 + envelope."""
    from fastapi.testclient import TestClient

    from api.main import app

    bad_payload = {
        "ticket_id": "KAN-7",
        "summary": "Test login screen displays empty-state correctly",
        "generated_test_cases": [
            # All happy-path, all vague — should be rejected on coverage AND
            # expected_vague / expected_not_specific.
            {
                "test_case_id": "TC-001",
                "test_scenario": "happy path",
                "platform": "android",
                "preconditions": ["User opens app"],
                "test_steps": ["Open app", "Tap login"],
                "test_data": [],
                "expected_result": "It works as expected.",
                "automation_candidate": True,
                "automation_framework_hint": "Espresso",
                "tags": ["happy-path"],
            },
            {
                "test_case_id": "TC-002",
                "test_scenario": "happy path 2",
                "platform": "android",
                "preconditions": ["User opens app"],
                "test_steps": ["Open app", "Tap settings"],
                "test_data": [],
                "expected_result": "Works fine.",
                "automation_candidate": True,
                "automation_framework_hint": "Espresso",
                "tags": ["happy-path"],
            },
            {
                "test_case_id": "TC-003",
                "test_scenario": "happy path 3",
                "platform": "android",
                "preconditions": ["User opens app"],
                "test_steps": ["Open app", "Tap home"],
                "test_data": [],
                "expected_result": "Behaves correctly.",
                "automation_candidate": True,
                "automation_framework_hint": "Espresso",
                "tags": ["happy-path"],
            },
        ],
    }

    stub = _CannedLLMProvider(bad_payload)
    monkeypatch.setattr("api.main.resolve_llm_provider", lambda _=None: stub)

    client = TestClient(app)
    res = client.post(
        "/pyapi/generate",
        json={
            "ticket": {
                "ticket_id": "KAN-7",
                "summary": "Test login screen displays empty-state correctly",
                "description": (
                    "When the user has no recent searches, the login screen "
                    "should display a placeholder message inviting them to start typing."
                ),
                "acceptance_criteria": [
                    "Given the user has no recent searches, the placeholder is visible.",
                    "Given the user types, the placeholder disappears.",
                ],
                "issue_type": "story",
            },
            "platform": "android",
        },
    )
    assert res.status_code == 422
    body = res.json()
    assert body["code"] == "output_validation_failed"
    error_codes = [i["code"] for i in body["validation"]["issues"] if i["severity"] == "error"]
    # Vague expected_result on at least one case AND missing negative coverage.
    assert any("expected_vague" in c or "expected_not_specific" in c for c in error_codes)
    assert "coverage_missing_negative" in error_codes
