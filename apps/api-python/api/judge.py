"""LLM-as-judge — second-pass quality score over generated test cases.

This is Layer 2 of the output-quality stack. After the deterministic linter
in output_validation.py runs, we optionally ask an LLM to score the batch
on COVERAGE, ATOMICITY, MEASURABILITY, GROUNDEDNESS and flag any individual
weak cases by test_case_id.

The judge is NOT a hard gate. The linter blocks; the judge informs. A
sub-threshold score is surfaced in the UI as "Quality score: 64/100" with
the flagged cases highlighted, but the response is still returned. This
matches the contract from validation.py: rubric / judge infra failures
NEVER block the user.

Design notes:
  - Different model than the generator when possible (set via JUDGE_PROVIDER
    env var, falls back to the generator's provider).
  - Low temperature for repeatability.
  - All errors swallowed and logged — judge is enrichment, not gating.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from pydantic import BaseModel, Field

from .llm import LLMCompletionRequest, resolve_llm_provider
from .models import JiraTicket, Platform, TestCase
from .prompt import build_judge_system_prompt, build_judge_user_prompt

logger = logging.getLogger("jiraqa.python.judge")


# ────────────────────────────────────────────────────────────────────────────
# Result shape — embedded in GenerateResponse as `quality`
# ────────────────────────────────────────────────────────────────────────────


class PerCaseFlag(BaseModel):
    test_case_id: str
    code: str
    message: str
    hint: str | None = None


class QualityScore(BaseModel):
    """Judge verdict. None for `score` means the judge was unavailable."""

    score: int | None = None
    summary: str | None = None
    judge_provider: str | None = None
    per_case_flags: list[PerCaseFlag] = Field(default_factory=list)


# ────────────────────────────────────────────────────────────────────────────
# Public entry point
# ────────────────────────────────────────────────────────────────────────────


async def judge_generated_cases(
    ticket: JiraTicket,
    platform: Platform,
    cases: list[TestCase],
    *,
    generator_provider: str | None = None,
) -> QualityScore:
    """Score the batch. Never raises — returns an empty QualityScore on any error."""
    # Prefer a different provider than the generator (cross-judging catches
    # more than self-judging). JUDGE_PROVIDER env var pins it; otherwise we
    # let resolve_llm_provider's default-resolution path pick.
    explicit = os.environ.get("JUDGE_PROVIDER")
    try:
        llm = resolve_llm_provider(explicit)
    except Exception as e:  # noqa: BLE001
        logger.info("Judge skipped — no LLM provider: %s", e)
        return QualityScore()

    system = build_judge_system_prompt()
    cases_payload: list[dict[str, Any]] = [c.model_dump(mode="json") for c in cases]
    user = build_judge_user_prompt(ticket, platform, cases_payload)

    try:
        resp = await llm.complete(
            LLMCompletionRequest(
                system_prompt=system,
                user_prompt=user,
                temperature=0.1,
                json_mode=True,
                max_tokens=1200,
            )
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("Judge call failed (continuing): %s", e)
        return QualityScore(judge_provider=llm.name)

    try:
        parsed = json.loads(resp.text)
    except json.JSONDecodeError as e:
        logger.warning("Judge returned non-JSON (continuing): %s", e)
        return QualityScore(judge_provider=llm.name)

    score_raw = parsed.get("score")
    try:
        score = int(score_raw) if score_raw is not None else None
    except (TypeError, ValueError):
        score = None
    summary = parsed.get("summary") if isinstance(parsed.get("summary"), str) else None

    flags: list[PerCaseFlag] = []
    for it in parsed.get("per_case_flags") or []:
        if not isinstance(it, dict):
            continue
        try:
            flags.append(
                PerCaseFlag(
                    test_case_id=str(it.get("test_case_id", "")),
                    code=str(it.get("code", "judge_flag")),
                    message=str(it.get("message", "")),
                    hint=it.get("hint") if isinstance(it.get("hint"), str) else None,
                )
            )
        except Exception as e:  # noqa: BLE001
            logger.debug("Skipping malformed judge flag: %s (%s)", it, e)

    return QualityScore(
        score=score,
        summary=summary,
        judge_provider=llm.name,
        per_case_flags=flags,
    )
