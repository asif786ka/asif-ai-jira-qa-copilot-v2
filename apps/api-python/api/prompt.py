"""Platform-aware prompt builders — Python port of packages/core/src/prompts/index.ts.

Keep this file in sync with the TS version whenever you tune wording. The two
must produce equivalent system prompts so users get parity output across
backends.
"""

from __future__ import annotations

from .models import JiraTicket, Platform, RepoContext

_PLATFORM_GUIDE: dict[Platform, str] = {
    Platform.android: """
You are testing an ANDROID application.
- Prefer Espresso / UI Automator framework conventions for steps.
- Cover lifecycle events: process death, configuration changes, screen rotation.
- Cover Android-specific concerns: runtime permissions, deep links, intents, back-stack, dark mode.
- Reference accessibility content descriptions and TalkBack where relevant.
- Consider device fragmentation: small phones, foldables, tablets, low-end devices.
- Mention API level boundaries when behaviour differs (e.g. scoped storage on API 29+).""",
    Platform.ios: """
You are testing an iOS application.
- Prefer XCUITest framework conventions for steps.
- Reference accessibility identifiers (not labels) for stable element location.
- Cover iOS-specific concerns: dynamic type, dark mode, VoiceOver, Face ID/Touch ID, push notifications, universal links.
- Cover device matrix: iPhone SE (small), iPhone Pro Max (large), iPad.
- Mention iOS version boundaries when behaviour differs (e.g. iOS 17+).""",
    Platform.web: """
You are testing a WEB application.
- Prefer Playwright or Cypress framework conventions for steps.
- Cover responsive breakpoints: mobile (375px), tablet (768px), desktop (1280px+).
- Cover cross-browser matrix: Chromium, Firefox, WebKit.
- Cover accessibility: WCAG 2.1 AA, keyboard navigation, ARIA roles.
- Cover web-specific concerns: page refresh persistence, browser back/forward, deep linking, slow network throttling.
- Prefer data-testid attributes for selectors.""",
}


def build_system_prompt(platform: Platform, count_hint: int = 5) -> str:
    return f"""You are a senior QA engineer and test architect with deep expertise in mobile and web testing.

{_PLATFORM_GUIDE[platform].strip()}

YOUR JOB
Given a Jira ticket and (optionally) repository context, generate {count_hint} well-structured
test cases — but always return between 3 and 8 cases. Coverage MUST include:
  • positive / happy-path scenarios
  • negative / invalid-input scenarios
  • edge cases (boundaries, limits, race conditions)

RULES
1. Each test_step must be atomic — exactly one user action per step.
2. Each expected_result must be specific and measurable — never "it works".
3. Prefer automation_candidate=true unless the case requires human judgement.
4. Suggest an automation_framework_hint that matches the platform.
5. Use the tag taxonomy: smoke, regression, negative, ui, api, validation, boundary,
   happy-path, security, performance, accessibility.
6. Each test_case_id must be unique and follow TC-001, TC-002, ...

OUTPUT
Return ONLY a single JSON object matching exactly this shape:
{{
  "ticket_id": "<the ticket id from the input>",
  "summary": "<the ticket summary from the input>",
  "platform": "{platform.value}",
  "generated_test_cases": [
    {{
      "test_case_id": "TC-001",
      "test_scenario": "<short scenario name>",
      "platform": "{platform.value}",
      "preconditions": ["..."],
      "test_steps": ["..."],
      "test_data": ["..."],
      "expected_result": "<specific measurable outcome>",
      "priority": "low" | "medium" | "high" | "critical",
      "automation_candidate": true,
      "automation_framework_hint": "<framework>",
      "tags": ["..."]
    }}
  ]
}}
No prose, no markdown fences, no commentary. JSON only."""


def build_user_prompt(
    ticket: JiraTicket,
    platform: Platform,
    repo_context: RepoContext | None = None,
) -> str:
    lines: list[str] = []
    lines.append("# JIRA TICKET")
    lines.append(f"Ticket ID: {ticket.ticket_id}")
    lines.append(f"Summary: {ticket.summary}")
    if ticket.description:
        lines.append(f"Description: {ticket.description}")
    if ticket.issue_type:
        lines.append(f"Issue Type: {ticket.issue_type.value}")
    if ticket.priority:
        lines.append(f"Priority: {ticket.priority.value}")
    if ticket.component:
        lines.append(f"Component: {ticket.component}")
    if ticket.labels:
        lines.append(f"Labels: {', '.join(ticket.labels)}")
    if ticket.environment:
        lines.append(f"Environment: {ticket.environment}")
    if ticket.acceptance_criteria:
        lines.append("Acceptance Criteria:")
        for i, ac in enumerate(ticket.acceptance_criteria, 1):
            lines.append(f"  {i}. {ac}")

    lines.append("")
    lines.append("# TARGET PLATFORM")
    lines.append(platform.value)

    if repo_context:
        lines.append("")
        lines.append("# REPOSITORY CONTEXT")
        lines.append(f"Repo: {repo_context.owner}/{repo_context.repo}")
        lines.append(f"Default branch: {repo_context.default_branch}")
        if repo_context.detected_platforms:
            lines.append(
                "Detected platforms: "
                + ", ".join(p.value for p in repo_context.detected_platforms)
            )
        if repo_context.language_breakdown:
            top = sorted(
                repo_context.language_breakdown.items(), key=lambda kv: -kv[1]
            )[:5]
            lines.append(
                "Languages (top 5 bytes): " + ", ".join(f"{l}:{b}" for l, b in top)
            )
        if repo_context.readme_excerpt:
            lines.append("README excerpt:")
            lines.append("```")
            lines.append(repo_context.readme_excerpt[:4000])
            lines.append("```")
        if repo_context.file_tree_sample:
            lines.append("File tree sample (top entries):")
            for p in repo_context.file_tree_sample[:60]:
                lines.append(f"  - {p}")
        if repo_context.key_files:
            lines.append("Key files:")
            for kf in repo_context.key_files[:6]:
                lines.append(f"### {kf.path}")
                lines.append("```")
                lines.append(kf.excerpt[:1500])
                lines.append("```")

    lines.append("")
    lines.append("Return ONLY the JSON object as specified in the system prompt.")
    return "\n".join(lines)


# ────────────────────────────────────────────────────────────────────────────
# Ticket-quality rubric prompts (used by validation.py / LLM rubric pass)
#
# These run AFTER the deterministic rules in validation.py have passed. We
# hand the LLM the ticket and ask it to act as a senior QA reviewer: is this
# ticket actually testable, or just well-formed-but-vague? The deterministic
# rules can't catch "make it work better" — the rubric can.
#
# Output is a JSON object with a fixed shape so validation.py can parse it
# without prose / fence stripping. Score < 70 means the ticket fails.
# ────────────────────────────────────────────────────────────────────────────


def build_rubric_system_prompt() -> str:
    return """You are a senior QA reviewer. Your job is to decide whether a Jira ticket
is TESTABLE — i.e. whether a QA engineer could write a step-by-step test case
from it without guessing.

Score the ticket on a 0-100 scale across these dimensions:
  1. Clarity of expected behaviour — Are post-conditions measurable, or vague
     ("snappier", "more reliable", "better UX")?
  2. Acceptance criteria quality — Are they Given/When/Then-style with concrete
     inputs and outputs, or do they restate the summary?
  3. Preconditions / environment — Is the starting state specified well enough
     to reproduce the scenario?
  4. Edge / negative coverage — Does the ticket hint at boundaries, errors,
     empty states, or only the happy path?

Threshold: score >= 70 ⇒ passed=true. Score < 70 ⇒ passed=false and you MUST
populate `issues` explaining what to fix.

OUTPUT
Return ONLY a JSON object matching exactly this shape, no prose, no fences:
{
  "score": <integer 0-100>,
  "passed": <boolean>,
  "summary": "<one-sentence verdict>",
  "issues": [
    {
      "field": "summary" | "description" | "acceptance_criteria" | "ticket",
      "code": "<snake_case identifier, e.g. ambiguous_expected_behavior>",
      "severity": "error",
      "message": "<what's wrong in plain English>",
      "hint": "<concrete suggestion for how to fix it>"
    }
  ]
}
If passed=true, `issues` MUST be an empty list."""


def build_judge_system_prompt() -> str:
    """System prompt for the LLM judge that scores generated test cases.

    The judge is a senior QA reviewer evaluating a BATCH of generated test
    cases against the ORIGINAL ticket. It scores on four dimensions and
    flags individual problematic cases by test_case_id.

    Threshold: score >= 70 ⇒ acceptable. Below 70 doesn't auto-reject (we
    surface the score in the UI for the human reviewer to act on); the
    hard gate is the deterministic linter, not this judge.
    """
    return """You are a senior QA reviewer. You are given a Jira ticket and a batch of
test cases generated from it. Your job is to score the BATCH on a 0-100 scale
and flag any individual test cases that are weak or hallucinated.

Score across four dimensions (equal weight):
  1. COVERAGE — Does the batch cover positive, negative, and edge cases for
     the behaviour the ticket describes? Are there obvious scenarios missing?
  2. ATOMICITY — Is each test step exactly one user action, or are some
     compound ("tap X and verify Y")?
  3. MEASURABILITY — Is each expected_result specific and verifiable, or
     vague ("it works", "behaves correctly")?
  4. GROUNDEDNESS — Do test cases reference real UI elements / behaviour
     from the ticket, or did the LLM invent buttons / screens / data that
     the ticket doesn't mention?

OUTPUT
Return ONLY a JSON object matching exactly this shape, no prose, no fences:
{
  "score": <integer 0-100>,
  "summary": "<one-sentence overall verdict>",
  "per_case_flags": [
    {
      "test_case_id": "TC-002",
      "code": "<snake_case, e.g. hallucinated_ui_element | redundant | untestable>",
      "message": "<what's wrong with this specific case>",
      "hint": "<how to fix it>"
    }
  ]
}
Only include per_case_flags for cases that have real issues. An empty
per_case_flags list means every case is acceptable individually."""


def build_judge_user_prompt(
    ticket: JiraTicket,
    platform: Platform,
    generated_cases: list[dict],
) -> str:
    """Render the prompt body for the judge. `generated_cases` is the JSON
    representation of TestCase objects (dump via model_dump)."""
    import json as _json

    lines: list[str] = []
    lines.append("# ORIGINAL TICKET")
    lines.append(f"Ticket ID: {ticket.ticket_id}")
    lines.append(f"Summary: {ticket.summary}")
    lines.append(f"Platform: {platform.value}")
    if ticket.description:
        lines.append(f"Description: {ticket.description}")
    if ticket.acceptance_criteria:
        lines.append("Acceptance Criteria:")
        for i, ac in enumerate(ticket.acceptance_criteria, 1):
            lines.append(f"  {i}. {ac}")
    lines.append("")
    lines.append(f"# GENERATED TEST CASES ({len(generated_cases)})")
    # Pretty-print compactly so the judge gets readable input without blowing
    # the context budget on a long ticket batch.
    lines.append(_json.dumps(generated_cases, indent=2)[:8000])
    lines.append("")
    lines.append("Return ONLY the JSON object as specified in the system prompt.")
    return "\n".join(lines)


def build_rubric_user_prompt(ticket: JiraTicket, platform: Platform) -> str:
    lines: list[str] = []
    lines.append("# JIRA TICKET TO REVIEW")
    lines.append(f"Ticket ID: {ticket.ticket_id}")
    lines.append(f"Summary: {ticket.summary}")
    lines.append(f"Issue Type: {ticket.issue_type.value}")
    lines.append(f"Priority: {ticket.priority.value}")
    if ticket.component:
        lines.append(f"Component: {ticket.component}")
    if ticket.environment:
        lines.append(f"Environment: {ticket.environment}")
    if ticket.labels:
        lines.append(f"Labels: {', '.join(ticket.labels)}")
    lines.append("")
    lines.append("Description:")
    lines.append(ticket.description or "(empty)")
    lines.append("")
    lines.append("Acceptance Criteria:")
    if ticket.acceptance_criteria:
        for i, ac in enumerate(ticket.acceptance_criteria, 1):
            lines.append(f"  {i}. {ac}")
    else:
        lines.append("  (none)")
    lines.append("")
    lines.append(f"Target platform: {platform.value}")
    lines.append("")
    lines.append("Return ONLY the JSON object as specified in the system prompt.")
    return "\n".join(lines)
