/**
 * @module @jiraqa/core/prompts
 * Platform-aware prompt builders. Pure functions — easy to unit test and
 * easy to port to Python (same structure mirrored in apps/api-python/api/prompt.py).
 */

import type { JiraTicket, Platform, RepoContext } from "../types";

// ────────────────────────────────────────────────────────────────────────────
// Platform-specific QA flavour
// ────────────────────────────────────────────────────────────────────────────

const PLATFORM_GUIDE: Record<Platform, string> = {
  android: `
You are testing an ANDROID application.
- Prefer Espresso / UI Automator framework conventions for steps.
- Cover lifecycle events: process death, configuration changes, screen rotation.
- Cover Android-specific concerns: runtime permissions, deep links, intents, back-stack, dark mode.
- Reference accessibility content descriptions and TalkBack where relevant.
- Consider device fragmentation: small phones, foldables, tablets, low-end devices.
- Mention API level boundaries when behaviour differs (e.g. scoped storage on API 29+).`,

  ios: `
You are testing an iOS application.
- Prefer XCUITest framework conventions for steps.
- Reference accessibility identifiers (not labels) for stable element location.
- Cover iOS-specific concerns: dynamic type, dark mode, VoiceOver, Face ID/Touch ID, push notifications, universal links.
- Cover device matrix: iPhone SE (small), iPhone Pro Max (large), iPad.
- Mention iOS version boundaries when behaviour differs (e.g. iOS 17+).`,

  web: `
You are testing a WEB application.
- Prefer Playwright or Cypress framework conventions for steps.
- Cover responsive breakpoints: mobile (375px), tablet (768px), desktop (1280px+).
- Cover cross-browser matrix: Chromium, Firefox, WebKit.
- Cover accessibility: WCAG 2.1 AA, keyboard navigation, ARIA roles.
- Cover web-specific concerns: page refresh persistence, browser back/forward, deep linking, slow network throttling.
- Prefer data-testid attributes for selectors.`,
};

// ────────────────────────────────────────────────────────────────────────────
// System prompt
// ────────────────────────────────────────────────────────────────────────────

export function buildSystemPrompt(platform: Platform, countHint = 5): string {
  return `You are a senior QA engineer and test architect with deep expertise in mobile and web testing.

${PLATFORM_GUIDE[platform].trim()}

YOUR JOB
Given a Jira ticket and (optionally) repository context, generate ${countHint} well-structured
test cases — but always return between 3 and 8 cases. Coverage MUST include:
  • positive / happy-path scenarios
  • negative / invalid-input scenarios
  • edge cases (boundaries, limits, race conditions)

RULES
1. Each test_step must be atomic — exactly one user action per step.
2. Each expected_result must be specific and measurable — never "it works".
3. Prefer automation_candidate=true unless the case requires human judgement
   (e.g. visual aesthetics, exploratory testing).
4. Suggest an automation_framework_hint that matches the platform (e.g. "Espresso",
   "XCUITest", "Playwright").
5. Use the tag taxonomy: smoke, regression, negative, ui, api, validation, boundary,
   happy-path, security, performance, accessibility.
6. Each test_case_id must be unique and follow the pattern TC-001, TC-002, ...

OUTPUT
Return ONLY a single JSON object matching exactly this shape:
{
  "ticket_id": "<the ticket id from the input>",
  "summary": "<the ticket summary from the input>",
  "platform": "${platform}",
  "generated_test_cases": [
    {
      "test_case_id": "TC-001",
      "test_scenario": "<short scenario name>",
      "platform": "${platform}",
      "preconditions": ["<precondition>", ...],
      "test_steps": ["<step>", ...],
      "test_data": ["<data note>", ...],
      "expected_result": "<specific measurable outcome>",
      "priority": "low" | "medium" | "high" | "critical",
      "automation_candidate": true,
      "automation_framework_hint": "<framework>",
      "tags": ["<tag>", ...]
    }
  ]
}
No prose, no markdown fences, no commentary. JSON only.`;
}

// ────────────────────────────────────────────────────────────────────────────
// User prompt
// ────────────────────────────────────────────────────────────────────────────

export function buildUserPrompt(
  ticket: JiraTicket,
  platform: Platform,
  repoContext?: RepoContext,
): string {
  const lines: string[] = [];
  lines.push(`# JIRA TICKET`);
  lines.push(`Ticket ID: ${ticket.ticket_id}`);
  lines.push(`Summary: ${ticket.summary}`);
  if (ticket.description) lines.push(`Description: ${ticket.description}`);
  if (ticket.issue_type) lines.push(`Issue Type: ${ticket.issue_type}`);
  if (ticket.priority) lines.push(`Priority: ${ticket.priority}`);
  if (ticket.component) lines.push(`Component: ${ticket.component}`);
  if (ticket.labels && ticket.labels.length)
    lines.push(`Labels: ${ticket.labels.join(", ")}`);
  if (ticket.environment) lines.push(`Environment: ${ticket.environment}`);
  if (ticket.acceptance_criteria && ticket.acceptance_criteria.length) {
    lines.push(`Acceptance Criteria:`);
    ticket.acceptance_criteria.forEach((ac, i) => lines.push(`  ${i + 1}. ${ac}`));
  }

  lines.push("");
  lines.push(`# TARGET PLATFORM`);
  lines.push(platform);

  if (repoContext) {
    lines.push("");
    lines.push(`# REPOSITORY CONTEXT`);
    lines.push(`Repo: ${repoContext.owner}/${repoContext.repo}`);
    lines.push(`Default branch: ${repoContext.default_branch}`);
    if (repoContext.detected_platforms.length)
      lines.push(`Detected platforms: ${repoContext.detected_platforms.join(", ")}`);
    if (repoContext.language_breakdown) {
      const top = Object.entries(repoContext.language_breakdown)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([lang, bytes]) => `${lang}:${bytes}`)
        .join(", ");
      if (top) lines.push(`Languages (top 5 bytes): ${top}`);
    }
    if (repoContext.readme_excerpt) {
      lines.push(`README excerpt:`);
      lines.push("```");
      lines.push(repoContext.readme_excerpt.slice(0, 4000));
      lines.push("```");
    }
    if (repoContext.file_tree_sample?.length) {
      lines.push(`File tree sample (top entries):`);
      repoContext.file_tree_sample.slice(0, 60).forEach((p) => lines.push(`  - ${p}`));
    }
    if (repoContext.key_files?.length) {
      lines.push(`Key files:`);
      for (const kf of repoContext.key_files.slice(0, 6)) {
        lines.push(`### ${kf.path}`);
        lines.push("```");
        lines.push(kf.excerpt.slice(0, 1500));
        lines.push("```");
      }
    }
  }

  lines.push("");
  lines.push(`Return ONLY the JSON object as specified in the system prompt.`);
  return lines.join("\n");
}
