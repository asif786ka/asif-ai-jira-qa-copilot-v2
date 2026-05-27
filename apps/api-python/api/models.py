"""Pydantic models — Python mirror of @jiraqa/core/types.

These are the exact same shapes the TS layer uses, ported to Pydantic v2.
The OpenAPI spec in packages/api-spec is the single source of truth — both
this file and the TS Zod schemas should be regenerated from it when it changes.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, model_validator


class Platform(str, Enum):
    android = "android"
    ios = "ios"
    web = "web"


class Priority(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


class IssueType(str, Enum):
    story = "story"
    bug = "bug"
    task = "task"
    epic = "epic"
    subtask = "subtask"


class JiraTicket(BaseModel):
    ticket_id: str
    summary: str
    description: str = ""
    acceptance_criteria: list[str] = Field(default_factory=list)
    issue_type: IssueType = IssueType.story
    priority: Priority = Priority.medium
    component: str = ""
    labels: list[str] = Field(default_factory=list)
    environment: str = ""


class KeyFile(BaseModel):
    path: str
    excerpt: str


class RepoContext(BaseModel):
    owner: str
    repo: str
    default_branch: str = "main"
    detected_platforms: list[Platform] = Field(default_factory=list)
    language_breakdown: Optional[dict[str, int]] = None
    readme_excerpt: str = ""
    file_tree_sample: list[str] = Field(default_factory=list)
    key_files: list[KeyFile] = Field(default_factory=list)


class TestCase(BaseModel):
    test_case_id: str
    test_scenario: str
    platform: Platform
    preconditions: list[str] = Field(default_factory=list)
    test_steps: list[str] = Field(default_factory=list)
    test_data: list[str] = Field(default_factory=list)
    expected_result: str
    priority: Optional[Priority] = Priority.medium
    automation_candidate: bool = True
    automation_framework_hint: Optional[str] = None
    tags: list[str] = Field(default_factory=list)


class GenerateRequest(BaseModel):
    ticket: JiraTicket
    platform: Platform
    repo_context: Optional[RepoContext] = None
    provider: Optional[str] = None  # "openai" | "gemini"
    count_hint: int = Field(default=5, ge=3, le=8)
    # Layer 2 — opt-in LLM-as-judge quality score. Off by default to keep
    # /generate cheap; the UI flips it on for interactive sessions.
    judge: bool = False


class GenerateResponse(BaseModel):
    ticket_id: str
    summary: str
    platform: Platform
    provider: str
    backend: str = "python"
    generated_test_cases: list[TestCase]

    @model_validator(mode="after")
    def check_count(self) -> "GenerateResponse":
        n = len(self.generated_test_cases)
        if n < 3 or n > 8:
            raise ValueError(f"Expected 3-8 test cases, got {n}")
        return self


class ErrorResponse(BaseModel):
    error: str
    details: Optional[str] = None
    code: Optional[str] = None


# ────────────────────────────────────────────────────────────────────────────
# Ticket validation (Phase: QA-readiness gate)
#
# These models are the wire shape for /pyapi/validate-ticket and for the
# `validation` envelope returned by /pyapi/generate when a ticket is rejected.
#
# Design notes:
#   - We keep `severity` as a plain string ("error" | "warning") instead of an
#     Enum so the field stays forward-compatible if we later add "info" or
#     "blocker" without breaking older clients.
#   - `code` is a stable machine-readable identifier (e.g. "summary_too_short")
#     so the UI can localise messages or link to a docs page per code.
#   - `field` points at the JiraTicket field the issue is about, or "ticket"
#     for cross-field / whole-ticket issues. This lets the UI scroll to /
#     highlight the right input.
# ────────────────────────────────────────────────────────────────────────────


class TicketValidationIssue(BaseModel):
    field: str  # "summary" | "description" | "acceptance_criteria" | "ticket"
    code: str  # stable identifier, e.g. "summary_too_short"
    severity: str = "error"  # "error" | "warning"
    message: str  # human-readable description of what's wrong
    hint: Optional[str] = None  # actionable suggestion for how to fix it


class TicketValidationResult(BaseModel):
    passed: bool
    issues: list[TicketValidationIssue] = Field(default_factory=list)
    # Populated only when the LLM rubric ran. None means rubric was skipped
    # (use_llm_rubric=False) or failed silently (we never block on rubric
    # infra errors — see validation.py for the fallback path).
    rubric_score: Optional[int] = None
    rubric_summary: Optional[str] = None


class ValidateTicketRequest(BaseModel):
    ticket: JiraTicket
    platform: Platform
    # Opt-in second pass. UI sends True by default; CI / batch jobs that just
    # want the deterministic rules can pass False to skip the LLM cost.
    use_llm_rubric: bool = True
    provider: Optional[str] = None  # mirrors GenerateRequest.provider
