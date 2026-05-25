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
