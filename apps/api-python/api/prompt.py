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
